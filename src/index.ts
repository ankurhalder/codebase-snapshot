import * as crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { hookStdoutScope, installStdoutRouter } from "./stdout.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { profileForPath, summarizeWithProfile } from "./ast/profiles/index.js";
import { importsOfText, SUMMARY_MAX_SOURCE_BYTES as SUMMARY_MAX_SOURCE_BYTES_SHARED } from "./ast/imports.js";
import { summarizeJson, summarizeMarkdown } from "./ast/structured.js";
import { isSkeletonizable, skeletonizeTypeScript } from "./ast/skeleton.js";
import { summarizeTypeScriptSource } from "./ast/ts-parser.js";
import {
  ARTIFACT_NAMES,
  assertUsableConfigInput,
  classifyKind,
  configDigest,
  classifyLayer,
  isResolvedConfig,
  loadConfigFile,
  normalizeResolvedConfig,
  resolveConfig,
} from "./config.js";
import { defineConfig } from "./define-config.js";
import { generateAuditReport } from "./generator/audit.js";
import { generateSarifReport } from "./generator/sarif.js";
import { generateMonolithJson, generateMonolithMarkdown } from "./generator/monolith.js";
import { generateNavigation } from "./generator/navigation.js";
import { generateReadme } from "./generator/readme.js";
import { generateProjectTree } from "./generator/tree.js";
import { anchorForPath, partitionFiles, partitionFilesForBuckets } from "./partitioner/chunker.js";
import type { PartitionedPart } from "./partitioner/chunker.js";
import { countLines, truncatePreview } from "./partitioner/preview.js";
import { detectPreset, getPreset, listPresetNames } from "./presets/index.js";
import {
  BINARY_SCAN_BYTES,
  countInvalidUtf8Bytes,
  decodeText,
  isBinaryBuffer,
  isBinaryExtension,
  isBinaryFile,
} from "./scanner/binary.js";
import { readStagedBlob, resolveChangedScope } from "./scanner/changed.js";
import {
  buildImportResolver,
  importsChangedFile,
  resolveSpecifier,
  tsconfigPathsFor,
} from "./scanner/dependents.js";
import { collectFiles, findSecretInPath, getGitInfo, maskSkipPaths } from "./scanner/files.js";
import { detectLanguage } from "./scanner/language.js";
import { scanAndRedactSecrets } from "./security/redact.js";
import { validateSnapshot } from "./validator/validate.js";
import { GENERATOR_NAME, GENERATOR_VERSION, SCHEMA_VERSION, isOurGeneratorName } from "./version.js";
import type {
  FileEntry,
  InclusionMode,
  JsonSummary,
  Manifest,
  ManifestArtifact,
  ManifestIndexes,
  MarkdownSummary,
  ResolvedArtifacts,
  ResolvedSnapshotConfig,
  SecretFinding,
  SecretRule,
  SkipRecord,
  SnapshotConfig,
  SourceSummary,
  SummaryQuality,
  TextEncoding,
} from "./types.js";

export { GENERATOR_NAME, GENERATOR_VERSION, SCHEMA_VERSION } from "./version.js";

/**
 * The update check, exported because it is useful on its own: an embedder that wraps this package
 * can ask whether a newer release exists without reimplementing the cache or the comparison, and
 * the tests need the same functions the CLI runs.
 */
export {
  CHECK_INTERVAL_MS,
  FAILURE_INTERVAL_MS,
  PACKAGE_LATEST_URL,
  REQUEST_TIMEOUT_MS,
  cacheDirectory,
  cacheFilePath,
  checkForUpdate,
  fetchLatestVersion,
  formatUpdateNotice,
  installKind,
  isNewer,
  shouldCheck,
  updateCommand,
} from "./update-check.js";
export type { InstallKind, UpdateCheckOptions, UpdateNotice } from "./update-check.js";

/**
 * Files whose UTF-8 body is larger than this are not parsed for a structural summary.
 *
 * The parser's AST costs far more than the text it reads — a 50 MB source file peaked at 3.3 GB
 * resident — and a file this large is emitted as a head/tail preview, so a summary of it would
 * describe something the snapshot does not contain. Two megabytes is well above every hand-written
 * source file and below the point where parsing becomes the dominant cost.
 *
 * The comparison is in bytes, not UTF-16 code units: a 3-byte-per-character file of 2 M characters
 * is 6 MB, and measuring characters let it through the ceiling the warning claims to enforce.
 *
 * Defined in `ast/imports.ts` and imported: `validate` and `explain` read imports from disk, and
 * they have to refuse exactly the files this run refused to parse. Two constants would be two
 * ceilings, and the day they disagree a file is a dependent for one command and not the other.
 */
const SUMMARY_MAX_SOURCE_BYTES = SUMMARY_MAX_SOURCE_BYTES_SHARED;

/**
 * What the generator derives from one file's bytes.
 *
 * Everything here is a pure function of (bytes, settings, path) except `findings[].path`, which is
 * the path itself. That is what makes it cacheable: a second run that sees the same hash for the
 * same path under the same settings must produce the same values, so `--watch` can skip the
 * redaction pass and the TypeScript parse for every file the last run already read.
 *
 * The operations it covers are the expensive ones. On a 3 000-file repository a regeneration
 * spends nearly all of its wall time in them — masking every line of every file against 31 rules,
 * and building an AST per source file — and almost none of it reading bytes or writing parts, which
 * are all that changed when the watcher fired for one file.
 */
interface Derivation {
  redacted: string;
  findings: SecretFinding[];
  lineCount: number;
  finalContent: string;
  inclusionMode: InclusionMode;
  isPreviewTruncated: boolean;
  includedLines: number;
  isLarge: boolean;
  summary: FileEntry["summary"];
  summaryQuality: SummaryQuality | undefined;
  summarySkip: "oversize" | "preview" | null;
  summaryWarning: string | null;
  dependentImports: string[] | null;
}

/**
 * Derivations kept between runs, in one process.
 *
 * In memory and not on disk, deliberately: `.codebase-snapshot` is the record of what was *written*
 * and adding a cache to it would make the ownership marker describe state the user did not ask for.
 * A cache that dies with the process cannot go stale in a way the next run has to detect.
 *
 * Validity is the content hash, not `mtime`. A file rewritten with the same length inside the same
 * timestamp tick — which is exactly what a `git checkout` or a formatter run does — would defeat an
 * mtime check and produce a snapshot of content that is no longer on disk. The hash is already
 * computed to record the manifest, so comparing it costs nothing and cannot be wrong.
 */
const FILE_DERIVATIONS = new Map<string, Derivation & { hash: string; settings: string; bytes: number }>();
const FILE_DERIVATION_LIMIT_BYTES = 64 * 1024 * 1024;
let fileDerivationBytes = 0;

function takeDerivation(path: string, hash: string, settings: string): Derivation | undefined {
  const cached = FILE_DERIVATIONS.get(path);
  if (cached === undefined || cached.hash !== hash || cached.settings !== settings) return undefined;
  // Recency on a hit: Map iteration is insertion order, so a frequently used entry must move to
  // the end or a cold file inserted earlier outlives it and the cache behaves as FIFO.
  FILE_DERIVATIONS.delete(path);
  FILE_DERIVATIONS.set(path, cached);
  return cached;
}

function rememberDerivation(
  path: string,
  hash: string,
  settings: string,
  derivation: Derivation
): void {
  // The two bodies are frequently the same string object (no skeleton, no preview), and counting
  // it twice would halve the effective cache.
  const bodyBytes =
    derivation.finalContent === derivation.redacted
      ? derivation.redacted.length
      : derivation.redacted.length + derivation.finalContent.length;
  const bytes = bodyBytes * 2 + 512;
  // One enormous file must not evict the rest of the repository to cache itself.
  if (bytes > FILE_DERIVATION_LIMIT_BYTES / 4) return;

  // A path inserted again (a file edited between runs in one process) replaces its entry. The
  // old code added the new bytes without subtracting the old ones, so the accounting drifted
  // upward and the eviction loop removed live entries to make room for a total that was too large.
  const previous = FILE_DERIVATIONS.get(path);
  if (previous !== undefined) {
    FILE_DERIVATIONS.delete(path);
    fileDerivationBytes -= previous.bytes;
  } else {
    FILE_DERIVATIONS.delete(path);
  }

  while (fileDerivationBytes + bytes > FILE_DERIVATION_LIMIT_BYTES) {
    const oldest = FILE_DERIVATIONS.keys().next();
    if (oldest.done === true) break;
    const evicted = FILE_DERIVATIONS.get(oldest.value);
    FILE_DERIVATIONS.delete(oldest.value);
    if (evicted !== undefined) fileDerivationBytes -= evicted.bytes;
  }

  FILE_DERIVATIONS.set(path, { ...derivation, hash, settings, bytes });
  fileDerivationBytes += bytes;
}

/**
 * A digest of everything that can change a derivation.
 *
 * The configuration digest covers the settings a manifest records; the secret rules are appended
 * because a custom rule set is not part of it, and a rule change alters every redacted body without
 * altering any recorded setting.
 */
function derivationSettings(config: ResolvedSnapshotConfig): string {
  const rules = config.secretRules
    .map(
      (rule) =>
        `${rule.rule}\u0000${rule.pattern.source}\u0000${rule.pattern.flags}\u0000${rule.valueGroup ?? ""}`
    )
    .join("\u0001");
  return `${GENERATOR_VERSION}\u0002${configDigest(config)}\u0002${sha256Hex(rules)}`;
}

/**
 * Everything one file contributes to the snapshot, from its decoded text.
 *
 * Extracted from the scan loop so it can be cached whole. The warnings it produces are returned
 * rather than pushed, because the caller has to be able to drop them again when a changed-files
 * scope removes the file.
 */
function deriveFile(
  relativePath: string,
  rawContent: string,
  sizeBytes: number,
  config: ResolvedSnapshotConfig
): Derivation {
  const lineCount = countLines(rawContent);
  const { redacted, findings } = scanAndRedactSecrets(rawContent, config.secretRules, relativePath);

  const isLarge = sizeBytes > config.largeFileBytes;
  /** Computed once: the skeleton decision and the summary decision must use the same ceiling. */
  const oversizeForSummary =
    Buffer.byteLength(rawContent, "utf8") > SUMMARY_MAX_SOURCE_BYTES;
  let finalContent = redacted;
  let isPreviewTruncated = false;
  let includedLines = lineCount;
  let inclusionMode: InclusionMode = "full";

  // Signature compression comes before the preview decision: a body-less file is small, so
  // previewing it afterwards would throw away the structure this mode exists to keep.
  // The summary is still built from the whole text below, so `exports` and `imports`
  // describe the real file rather than the compressed one.
  //
  // The size ceiling is checked *first*: the TypeScript parser costs more memory than the file
  // itself (a 50 MB source peaked at 3.3 GB RSS), and `--skeleton` parsed files that the summary
  // guard below exists to avoid. A file this large is emitted as a preview, so a skeleton of it
  // would describe lines the snapshot does not contain anyway.
  if (config.skeleton === true && isSkeletonizable(relativePath) && !oversizeForSummary) {
    const skeleton = skeletonizeTypeScript(redacted, relativePath);
    if (skeleton.collapsed > 0) {
      finalContent = skeleton.text;
      inclusionMode = "signatures";
      includedLines = countLines(skeleton.text);
    }
  }

  if (isLarge && inclusionMode !== "signatures") {
    const preview = truncatePreview(redacted, config.previewHeadLines, config.previewTailLines);
    finalContent = preview.content;
    isPreviewTruncated = preview.isTruncated;
    includedLines = preview.includedLines;
    inclusionMode = isPreviewTruncated ? "preview" : "full";
  }

  let summary: FileEntry["summary"];
  let summaryQuality: SummaryQuality | undefined;
  let summarySkip: "oversize" | "preview" | null = null;
  let summaryWarning: string | null = null;
  let dependentImports: string[] | null = null;

  // Size first, then preview: a 3 MB file is both, and "exceeds 2 MB" is the more useful of the
  // two true statements — it names the ceiling that kept the run bounded. The preview rule then
  // covers the 200 KB–2 MB band, where the file is small enough to have been parsed before.
  if (oversizeForSummary) {
    // A structural summary of a file this size costs far more memory than the file itself — the
    // TypeScript parser builds an AST whose nodes dwarf the text, and a 50 MB source file peaked
    // at 3.3 GB RSS. The body is a head/tail preview at this size anyway, so the summary would
    // describe a file the snapshot does not contain. Recorded, never silent.
    summarySkip = "oversize";
    // `[]` here, from the same helper and the same ceiling `validate` and `explain` apply.
    dependentImports = [];
  } else if (SKIP_PREVIEW_SUMMARIES && isPreviewTruncated && hasStructuralSummary(relativePath)) {
    // The body in the snapshot is a head/tail preview, so a whole-file summary
    // would describe lines no artifact carries. Skipping it is also the single
    // largest cost saving on a big source file: masking tens of thousands of
    // identifiers for a summary the partitioner discards.
    summarySkip = "preview";
    // The *imports* are still needed, and they are the cheap half of the summary: module
    // specifiers live at the top of the file, which the head of a preview keeps.
    dependentImports = importsOfText(relativePath, rawContent);
  } else {
    try {
      // Always parse the original source. Masking a credential-shaped identifier such as
      // `const secret = previousSecrets[i]` produced syntactically invalid code, so the
      // parser reported parse errors on files that are perfectly valid TypeScript.
      const outcome = summarizeFile(relativePath, rawContent);
      // Parse the raw source (masking an identifier can make valid TypeScript
      // unparsable), but never let a raw string reach the summary: a secret in a
      // heading, key or export name is emitted into the manifest and the parts.
      summary = outcome?.summary
        ? (maskSummaryStrings(outcome.summary, config.secretRules) as FileEntry["summary"])
        : undefined;
      summaryQuality = outcome?.quality;
      if (isSourceSummary(summary) && summary.parseErrors) {
        summaryWarning = `Parse errors in ${maskPathText(relativePath, config.secretRules)} (${summary.parseErrors}); its summary is incomplete.`;
      }
    } catch (err) {
      // A single pathological file used to abort the whole run.
      summaryWarning =
        `Summary skipped for ${maskPathText(relativePath, config.secretRules)}: ${(err as Error).message}`.replace(
          /\s+/g,
          " "
        );
    }
  }

  return {
    redacted,
    findings,
    lineCount,
    finalContent,
    inclusionMode,
    isPreviewTruncated,
    includedLines,
    isLarge,
    summary,
    summaryQuality,
    summarySkip,
    summaryWarning,
    dependentImports,
  };
}


function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export interface GenerateOptions {
  /** Compute the full manifest but write nothing to disk. */
  dryRun?: boolean;
}

const TS_EXTENSIONS = [
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
];

interface SummaryOutcome {
  summary: SourceSummary | JsonSummary | MarkdownSummary;
  quality: SummaryQuality;
}

function summarizeFile(relativePath: string, redactedContent: string): SummaryOutcome | undefined {
  const lower = relativePath.toLowerCase();

  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) {
    return { summary: summarizeJson(redactedContent), quality: "structural" };
  }
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) {
    return { summary: summarizeMarkdown(redactedContent), quality: "structural" };
  }

  // Summaries are built from the REDACTED text: a secret inside a Markdown
  // heading used to be masked in the body but emitted verbatim in the summary.
  if (TS_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return { summary: summarizeTypeScriptSource(relativePath, redactedContent), quality: "ast" };
  }

  // Every other language goes through the heuristic profile registry.
  const profiled = summarizeWithProfile(relativePath, redactedContent);
  return profiled ? { summary: profiled.summary, quality: profiled.quality } : undefined;
}

function isSourceSummary(summary: FileEntry["summary"]): summary is SourceSummary {
  return Boolean(summary && typeof summary === "object" && "imports" in summary);
}

/**
 * True when this path's language produces a structural summary at all.
 *
 * Only used to decide whether skipping a summary for a preview is worth a
 * warning: a `.log` or `.txt` never had one, so listing it would be noise.
 */
function hasStructuralSummary(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) return true;
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return true;
  if (TS_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true;
  return profileForPath(relativePath) !== null;
}

type LayerOrKindCounts = Record<string, number>;

function bump(counts: LayerOrKindCounts, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Drops every item `keep` rejects, in place, preserving order.
 *
 * The changed-scope filter runs after several arrays have been filled; rebuilding each one at
 * the call site meant five near-identical `filter` assignments and five chances to forget one.
 */
function retain<T>(items: T[], keep: (item: T) => boolean): void {
  let write = 0;
  for (const item of items) {
    if (keep(item)) {
      items[write] = item;
      write += 1;
    }
  }
  items.length = write;
}

/**
 * A previewed file is not parsed for a structural summary.
 *
 * Its body in the snapshot is head/tail only, so a whole-file summary describes
 * lines no artifact carries; building one anyway meant masking every identifier in
 * the file for a summary the partitioner discards. Named so the before/after
 * measurement stays reproducible by flipping this one value.
 */
const SKIP_PREVIEW_SUMMARIES = true;

function buildIndexes(files: FileEntry[], tsconfigPaths: ReturnType<typeof tsconfigPathsFor>): ManifestIndexes {
  const resolver = buildImportResolver(files, { tsconfig: tsconfigPaths });
  const importerCounts = new Map<string, number>();

  const byFile = files.filter((file) => isSourceSummary(file.summary)).map((file) => {
    const summary = file.summary as SourceSummary;
    return {
      path: file.relativePath,
      imports: summary.imports,
      exports: summary.exports,
    };
  });

  for (const entry of byFile) {
    for (const specifier of entry.imports) {
      const resolved = resolveSpecifier(entry.path, specifier, resolver);
      if (resolved) importerCounts.set(resolved, (importerCounts.get(resolved) ?? 0) + 1);
    }
  }

  const featureCounts = new Map<string, number>();
  for (const file of files) {
    const match = /(?:^|\/)features\/([^/]+)\//.exec(file.relativePath);
    if (match) featureCounts.set(match[1], (featureCounts.get(match[1]) ?? 0) + 1);
  }

  return {
    routes: files
      .filter((file) => file.kind === "route")
      .map((file) => ({
        path: file.relativePath,
        methods: isSourceSummary(file.summary) ? file.summary.routeHandlers : [],
        part: file.part,
      })),
    components: files
      .filter((file) => file.kind === "component")
      .map((file) => ({
        path: file.relativePath,
        symbols: isSourceSummary(file.summary) ? file.summary.reactComponents : [],
        part: file.part,
        layer: file.layer,
      })),
    handlers: files
      .filter((file) => file.kind === "handler")
      .map((file) => ({
        path: file.relativePath,
        exports: isSourceSummary(file.summary) ? file.summary.exports : [],
        part: file.part,
      })),
    features: Array.from(featureCounts.entries())
      .map(([name, count]) => ({ name, files: count }))
      .sort((a, b) => b.files - a.files || (a.name < b.name ? -1 : 1)),
    imports: {
      byFile,
      centralFiles: Array.from(importerCounts.entries())
        .map(([filePath, importedByCount]) => ({ path: filePath, importedByCount }))
        .sort((a, b) => b.importedByCount - a.importedByCount || (a.path < b.path ? -1 : 1))
        .slice(0, 50),
    },
    directives: files
      .filter((file) => isSourceSummary(file.summary) && file.summary.directives.length > 0)
      .map((file) => ({
        path: file.relativePath,
        directives: (file.summary as SourceSummary).directives,
      })),
  };
}

/**
 * Verifies the artefacts that are about to be written: every file is assigned to
 * a part, every part hashes to its recorded digest, and no part exceeds budget.
 *
 * This replaces the hardcoded `validation.status: "passed"`.
 */
function verifyInMemory(
  files: FileEntry[],
  parts: ReturnType<typeof partitionFiles>
): string[] {
  const errors: string[] = [];
  const partNames = new Set(parts.map((part) => part.filename));

  for (const file of files) {
    if (!file.part || !partNames.has(file.part)) {
      errors.push(`${file.relativePath} was not assigned to a snapshot part.`);
    }
  }

  for (const part of parts) {
    if (sha256Hex(part.markdown) !== part.metadata.sha256) {
      errors.push(`${part.filename} content does not match its recorded sha256.`);
    }
    const actualBytes = Buffer.byteLength(part.markdown, "utf8");
    if (actualBytes !== part.metadata.byteSize) {
      errors.push(`${part.filename} byteSize ${part.metadata.byteSize} != actual ${actualBytes}.`);
    }
    // Each part is checked against the budget it was built for. With per-layer budgets
    // "the part budget" is not one number, and testing every part against the largest of
    // them passed a part that was twice over its own.
    const partBudget = part.metadata.budgetBytes;
    if (actualBytes > partBudget) {
      errors.push(
        `${part.filename} (${actualBytes} B) exceeds its part budget of ${partBudget} B.`
      );
    }
    if (part.metadata.includedFiles.length !== part.metadata.fileCount) {
      errors.push(`${part.filename} fileCount does not match its included files.`);
    }
  }

  const filesInParts = parts.reduce((total, part) => total + part.metadata.fileCount, 0);
  if (filesInParts !== files.length) {
    errors.push(`Parts contain ${filesInParts} file(s) but ${files.length} were scanned.`);
  }

  return errors;
}

/**
 * Resolves and validates the output directories.
 *
 * `outDir` was previously deleted with `rmSync` before the replacement was
 * renamed into place, so `outDir: "."` erased the whole repository and a
 * nested `tmpDir` erased its own parent. These guards make that impossible.
 */
export function resolveSafeOutputDirs(config: {
  cwd: string;
  outDir: string;
  tmpDir: string;
}): { outDir: string; tmpDir: string } {
  const cwd = path.resolve(config.cwd);
  const outDir = path.resolve(cwd, config.outDir);
  const tmpDir = path.resolve(cwd, config.tmpDir);
  const root = path.parse(cwd).root;

  const contains = (parent: string, child: string): boolean =>
    child === parent || child.startsWith(`${parent}${path.sep}`);

  const reject = (reason: string): never => {
    throw new Error(
      `Refusing to generate: ${reason}. outDir=${outDir} tmpDir=${tmpDir} cwd=${cwd}`
    );
  };

  if (outDir === root) reject("outDir resolves to the filesystem root");
  if (outDir === cwd || contains(outDir, cwd)) {
    reject("outDir is the working directory or one of its ancestors");
  }
  if (tmpDir === root) reject("tmpDir resolves to the filesystem root");
  if (tmpDir === cwd || contains(tmpDir, cwd)) {
    reject("tmpDir is the working directory or one of its ancestors");
  }
  if (tmpDir === outDir) reject("outDir and tmpDir are the same directory");
  if (contains(outDir, tmpDir)) reject("tmpDir is inside outDir");
  if (contains(tmpDir, outDir)) reject("outDir is inside tmpDir");

  return { outDir, tmpDir };
}

/**
 * The one entry an otherwise-empty output directory may hold and still be replaced.
 *
 * `.DS_Store` is written by Finder, carries no user intent and is recreated on demand, so
 * discarding it loses nothing. `.gitkeep` and `.gitignore` used to be tolerated in the same way,
 * and that tolerance was a data-loss bug rather than a convenience: both are files a *user*
 * creates, this generator never writes either into an output directory, and a snapshot directory
 * holding one was replaced — with a valid ownership marker behind it — while the file was deleted
 * without a word. They are foreign entries like any other now, so the run refuses and names them.
 */
const IGNORABLE_ENTRIES = new Set([".DS_Store"]);

/**
 * Prefix of a per-run staging directory inside `tmpDir`.
 *
 * Staging used to *be* the `tmpDir` path, so two concurrent runs — even with
 * different `outDir`s — deleted and rewrote the same files, and one of them
 * could ship a manifest whose parts the other had removed. Every run now gets
 * its own directory under the (scanner-ignored) `tmpDir` root, so two runs can
 * never share a staging path.
 */
const RUN_DIR_PREFIX = "run-";

/** A staging directory older than this is a crash leftover, not a live run. */
const STALE_RUN_MS = 60 * 60 * 1000;

/** Masks one path with the default rules plus the caller's custom rules. */
/** Masks every string inside a summary object, recursively. */
function maskSummaryStrings(value: unknown, secretRules: readonly SecretRule[]): unknown {
  if (typeof value === "string") return maskPathText(value, secretRules);
  if (Array.isArray(value)) return value.map((item) => maskSummaryStrings(item, secretRules));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = maskSummaryStrings(item, secretRules);
    }
    return out;
  }
  return value;
}

function maskPathText(value: string, secretRules?: readonly SecretRule[]): string {
  return findSecretInPath(value, secretRules)?.masked ?? value;
}

/**
 * Masks skip-record paths.
 *
 * `maskSkipPaths` applies the default rules plus the caller's custom rules; this
 * wrapper keeps every shipped skip list on one path, so a future in-memory-only
 * field cannot leak into `manifest.json` unnoticed.
 */
function maskSkipRecords(
  records: readonly SkipRecord[],
  secretRules?: readonly SecretRule[]
): SkipRecord[] {
  return maskSkipPaths(records, secretRules);
}

/** True when `pid` names a process that still exists (EPERM means it does). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Marks a directory as written by this generator.
 *
 * The marker is *evidence*, not a filename: it has to parse as JSON, name this
 * generator, carry a schema version this build understands, a random per-run id,
 * the run state, the digest of the manifest it shipped and the inventory of
 * entries it wrote. A zero-byte file called `.codebase-snapshot`, or a three-key
 * forgery next to somebody's documents, used to count as proof and made
 * `generate --out-dir` delete the directory.
 */
const OWNERSHIP_MARKER = ".codebase-snapshot";

/** `staging` while a snapshot is being written, `complete` once it is whole. */
type MarkerState = "staging" | "complete";

interface OwnershipMarker {
  generator: string;
  version: string;
  schemaVersion: string;
  createdAt: string;
  state: MarkerState;
  /** Random per-snapshot value; a hand-written marker has no reason to carry one. */
  id: string;
  /** Process that wrote the marker; used to spot stale staging runs. */
  pid?: number;
  /** sha256 of the shipped `manifest.json`, when one was written. */
  manifestSha256?: string;
  /** Every entry the snapshot wrote, POSIX-relative, including hook artifacts. */
  entries?: string[];
  /**
   * sha256 and byte length of every regular file written, POSIX-relative.
   *
   * This is what turns the marker from a filename into evidence. A hand-written marker can
   * list any entries it likes; matching these digests means the bytes on disk are the bytes
   * a completed run recorded, so a marker copied from somewhere else (or written by hand)
   * cannot authorise deleting whatever happens to be in the directory.
   *
   * Optional for **legacy** markers: snapshots written before this field existed are accepted
   * on their manifest digest instead (present, matching, and naming this generator), so an
   * upgrade never refuses the output directory a user already has. A marker that carries the
   * field is verified file by file — see {@link verifyMarkerInventory}. Markers written from
   * now on always carry it.
   */
  files?: MarkerFileDigest[];
}

/** One file the marker recorded, with what the next run can verify it against. */
interface MarkerFileDigest {
  /** POSIX-relative path inside the snapshot directory. */
  path: string;
  /** Byte length this file had when the marker was written. */
  bytes: number;
  /** sha256 of those bytes. */
  sha256: string;
}

/** Schema versions whose ownership evidence this build understands. */
const SUPPORTED_MARKER_SCHEMAS = new Set([SCHEMA_VERSION]);

const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The digest shape recorded for one file in the marker's inventory. */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Lists every entry under `dir` as sorted, POSIX-relative paths. */
function listEntries(dir: string): string[] {
  const entries: string[] = [];
  const walk = (absolute: string, prefix: string): void => {
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const relative = prefix === "" ? child.name : `${prefix}/${child.name}`;
      entries.push(relative);
      // Symlinks are recorded but not followed: the inventory describes this
      // directory, not wherever a link points.
      if (child.isDirectory()) walk(path.join(absolute, child.name), relative);
    }
  };
  walk(dir, "");
  return entries.sort();
}

/**
 * Lists everything in `dir` and digests every regular file.
 *
 * The digest pass is what the ownership check verifies on the next run. It reads each file
 * once, immediately after this run wrote those same bytes, so it costs a sequential read of
 * the snapshot rather than anything proportional to the repository.
 */
/** A file this run wrote, with the metadata that lets a later marker skip re-reading it. */
interface WrittenArtifact {
  digest: MarkerFileDigest;
  mtimeMs: number;
}

/** Every artifact this run wrote, by entry name, so the marker need not hash its own output. */
type WrittenLedger = Map<string, WrittenArtifact>;

function markerInventory(
  dir: string,
  written?: WrittenLedger
): { entries: string[]; files: MarkerFileDigest[] } {
  const entries = listEntries(dir);
  const files: MarkerFileDigest[] = [];
  for (const entry of entries) {
    // The marker cannot record its own digest: writing the record would change it.
    if (entry === OWNERSHIP_MARKER) continue;
    // Finder noise is tolerated by the ownership check and is not part of the record.
    if (IGNORABLE_ENTRIES.has(entry.slice(entry.lastIndexOf("/") + 1))) continue;
    const full = path.join(dir, ...entry.split("/"));
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(full);
    } catch {
      // The entry keeps its name in `entries` but gets no digest; the next ownership
      // check then refuses rather than deleting something it cannot account for.
      continue;
    }
    if (!stats.isFile()) continue;
    // This run wrote the file and recorded its digest; re-reading it costs the snapshot's own
    // size on every run for bytes that are already in memory. A size or mtime that changed since
    // the write — a `hooks.afterGenerate` edit, a rename across devices — falls through to the
    // read, which is what makes the shortcut safe rather than an assumption.
    const recorded = written?.get(entry);
    if (recorded !== undefined && recorded.digest.bytes === stats.size && recorded.mtimeMs === stats.mtimeMs) {
      files.push(recorded.digest);
      continue;
    }
    let digest: string;
    try {
      digest = sha256Hex(fs.readFileSync(full));
    } catch {
      continue;
    }
    files.push({ path: entry, bytes: stats.size, sha256: digest });
  }
  return { entries, files };
}

/** Builds the marker payload for `dir` as it stands right now. */
function markerPayload(
  dir: string,
  state: MarkerState,
  id: string,
  createdAt: string,
  written?: WrittenLedger
): OwnershipMarker {
  const { entries, files } = markerInventory(dir, written);
  const marker: OwnershipMarker = {
    generator: GENERATOR_NAME,
    version: GENERATOR_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt,
    state,
    id,
    pid: process.pid,
    entries,
    files,
  };
  const manifestPath = path.join(dir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    marker.manifestSha256 = sha256Hex(fs.readFileSync(manifestPath));
  }
  return marker;
}

function writeOwnershipMarker(dir: string, marker: OwnershipMarker): void {
  fs.writeFileSync(
    path.join(dir, OWNERSHIP_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8"
  );
}

/**
 * True when `dir`'s marker still records the run `id`.
 *
 * Used by the post-hook re-ship, which can run long after the run's lock was released. A missing or
 * unreadable marker answers `true`: the directory is this run's output and rewriting the marker is
 * the repair, not the damage. A marker naming a *different* run answers `false`, because then the
 * directory has moved on and this run's bookkeeping no longer describes it.
 */
function markerBelongsTo(dir: string, id: string): boolean {
  const evidence = readOwnershipMarker(dir);
  if (evidence.marker === null) return true;
  return evidence.marker.id === id;
}

interface MarkerEvidence {
  marker: OwnershipMarker | null;
  /** Why the marker is not evidence, when it is not. */
  problem: string | null;
}

/** Reads and validates `.codebase-snapshot`. A malformed marker is not evidence. */
function readOwnershipMarker(dir: string): MarkerEvidence {
  const markerPath = path.join(dir, OWNERSHIP_MARKER);
  if (!fs.existsSync(markerPath)) {
    return { marker: null, problem: "it holds no .codebase-snapshot marker" };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(markerPath, "utf8");
  } catch {
    return { marker: null, problem: "its .codebase-snapshot marker could not be read" };
  }
  if (raw.trim().length === 0) {
    return { marker: null, problem: "its .codebase-snapshot marker is empty" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { marker: null, problem: "its .codebase-snapshot marker is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { marker: null, problem: "its .codebase-snapshot marker is not a JSON object" };
  }

  const candidate = parsed as Record<string, unknown>;
  if (!isOurGeneratorName(candidate.generator)) {
    return { marker: null, problem: "its .codebase-snapshot marker names a different generator" };
  }
  if (
    typeof candidate.schemaVersion !== "string" ||
    !SUPPORTED_MARKER_SCHEMAS.has(candidate.schemaVersion)
  ) {
    return {
      marker: null,
      problem: `its .codebase-snapshot marker has a schema version this build does not understand (${String(candidate.schemaVersion)})`,
    };
  }
  if (typeof candidate.id !== "string" || !SNAPSHOT_ID_PATTERN.test(candidate.id)) {
    return { marker: null, problem: "its .codebase-snapshot marker carries no snapshot id" };
  }
  if (candidate.state !== "staging" && candidate.state !== "complete") {
    return { marker: null, problem: "its .codebase-snapshot marker records no run state" };
  }

  const rawFiles = candidate.files;
  let files: MarkerFileDigest[] | undefined;
  if (rawFiles !== undefined) {
    if (!Array.isArray(rawFiles)) {
      return {
        marker: null,
        problem: "its .codebase-snapshot marker's file inventory is not an array",
      };
    }
    files = [];
    for (const item of rawFiles) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return {
          marker: null,
          problem: "its .codebase-snapshot marker's file inventory holds an entry that is not an object",
        };
      }
      const record = item as Record<string, unknown>;
      if (
        typeof record.path !== "string" ||
        typeof record.bytes !== "number" ||
        !Number.isInteger(record.bytes) ||
        record.bytes < 0 ||
        typeof record.sha256 !== "string" ||
        !SHA256_HEX_PATTERN.test(record.sha256)
      ) {
        return {
          marker: null,
          problem: "its .codebase-snapshot marker's file inventory holds an entry this build cannot read",
        };
      }
      files.push({ path: record.path, bytes: record.bytes, sha256: record.sha256 });
    }
  }

  return {
    marker: {
      generator: GENERATOR_NAME,
      version: typeof candidate.version === "string" ? candidate.version : "unknown",
      schemaVersion: candidate.schemaVersion,
      createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : "unknown",
      state: candidate.state,
      id: candidate.id,
      pid: typeof candidate.pid === "number" ? candidate.pid : undefined,
      manifestSha256:
        typeof candidate.manifestSha256 === "string" ? candidate.manifestSha256 : undefined,
      entries:
        Array.isArray(candidate.entries) &&
        candidate.entries.every((entry) => typeof entry === "string")
          ? (candidate.entries as string[])
          : undefined,
      files,
    },
    problem: null,
  };
}

/** Why a parsed value is not a manifest this generator wrote. */
function describeManifestProblem(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "is not a JSON object";
  const candidate = value as Record<string, unknown>;
  const generator = candidate.generator as { name?: unknown } | null | undefined;
  if (typeof generator !== "object" || generator === null || !isOurGeneratorName(generator.name)) {
    return "was not written by this generator";
  }
  if (!Array.isArray(candidate.files)) return "has no files array";
  return null;
}

interface DirectoryVerdict {
  owned: boolean;
  /** Why it is not owned, when that is a property of the evidence itself. */
  problem: string | null;
  /** Entries present in the directory but absent from the recorded inventory. */
  foreignEntries: string[];
  marker: OwnershipMarker | null;
}

/**
 * Checks the marker's per-file digests against the bytes that are on disk now.
 *
 * A marker filename proves nothing; this is the part that makes ownership *evidence*. Every
 * regular file in the directory must be recorded in the marker with the sha256 and byte
 * length a completed run wrote, and both must still match. So a hand-written marker (or one
 * copied out of another snapshot) cannot authorise deleting whatever happens to be in the
 * directory: to pass, it has to enumerate every user file and carry digests that match those
 * files exactly. Directories and links are recorded by name only — a link is never followed,
 * and an empty directory holds nothing to lose. `.DS_Store` is ignored because Finder
 * rewrites it and it carries no user intent.
 *
 * A residual hole is unavoidable on a local filesystem: a program with write access to the
 * directory can compute real digests too. This raises the bar from "write one JSON file" to
 * "reproduce the exact evidence of a completed run"; it cannot prove who ran it.
 *
 * Only called for markers that carry the inventory. A legacy marker (no `files`) is accepted
 * on its manifest digest instead, which keeps an upgraded user's existing output replaceable;
 * see {@link assessSnapshotDirectory}.
 */
function verifyMarkerInventory(
  dir: string,
  entries: readonly string[],
  files: readonly MarkerFileDigest[]
): string | null {
  const diskEntries = new Set(entries);
  const recorded = new Map<string, MarkerFileDigest>();
  for (const record of files) {
    if (recorded.has(record.path)) {
      return `its .codebase-snapshot inventory records ${record.path} twice`;
    }
    if (!diskEntries.has(record.path)) {
      return `its .codebase-snapshot inventory records ${record.path}, which is missing from the directory`;
    }
    recorded.set(record.path, record);
  }

  for (const entry of entries) {
    // The marker cannot record its own digest, and Finder noise is not user data.
    if (entry === OWNERSHIP_MARKER) continue;
    if (IGNORABLE_ENTRIES.has(entry.slice(entry.lastIndexOf("/") + 1))) continue;
    const full = path.join(dir, ...entry.split("/"));
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(full);
    } catch {
      return `its .codebase-snapshot inventory lists ${entry}, which cannot be read`;
    }
    if (stats.isDirectory()) {
      if (recorded.has(entry)) {
        return `its .codebase-snapshot inventory records the directory ${entry} as a file`;
      }
      continue;
    }
    if (!stats.isFile()) {
      // A link or special file is recorded by name; it is never followed, so there is no
      // digest to compare — and replacing the directory moves or deletes the link itself.
      if (recorded.has(entry)) {
        return `its .codebase-snapshot inventory records ${entry} as a regular file, but it is not one`;
      }
      continue;
    }
    const record = recorded.get(entry);
    if (record === undefined) {
      return `its .codebase-snapshot inventory does not record the file ${entry}`;
    }
    if (record.bytes !== stats.size) {
      return `its .codebase-snapshot inventory records ${entry} as ${record.bytes} B, but it is ${stats.size} B`;
    }
    let digest: string;
    try {
      digest = sha256Hex(fs.readFileSync(full));
    } catch {
      return `its .codebase-snapshot inventory cannot verify ${entry}: the file could not be read`;
    }
    if (digest !== record.sha256) {
      return `its .codebase-snapshot inventory's digest for ${entry} does not match the file`;
    }
  }

  return null;
}

/**
 * Decides whether `dir` is a snapshot this generator wrote and may replace.
 *
 * Ownership needs *consistent* evidence: a marker that parses and names this
 * generator, a run that completed, no entry the recorded inventory does not account
 * for, and bytes that match what was recorded. Two evidence shapes are accepted:
 *
 *  - a marker with a per-file digest inventory (every run from this release on) must
 *    match every regular file's byte length and sha256;
 *  - a legacy marker without that inventory (snapshots written before it existed) must
 *    carry a manifest digest that is present and matches the `manifest.json` beside it.
 *    That keeps an upgraded user's existing output replaceable while still refusing the
 *    hand-written marker with no manifest — the case the inventory was added for.
 *
 * Any unknown entry means the directory holds something we did not write, whatever the
 * marker says.
 */
function assessSnapshotDirectory(dir: string): DirectoryVerdict {
  const { marker, problem } = readOwnershipMarker(dir);
  if (!marker) return { owned: false, problem, foreignEntries: [], marker: null };

  if (marker.state !== "complete") {
    return {
      owned: false,
      problem: "its .codebase-snapshot marker records a run that never finished writing it",
      foreignEntries: [],
      marker,
    };
  }

  const manifestPath = path.join(dir, "manifest.json");
  const hasManifest = fs.existsSync(manifestPath);
  if (hasManifest) {
    let raw: string;
    try {
      raw = fs.readFileSync(manifestPath, "utf8");
    } catch {
      return {
        owned: false,
        problem: "its manifest.json could not be read",
        foreignEntries: [],
        marker,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        owned: false,
        problem: "its manifest.json is not valid JSON",
        foreignEntries: [],
        marker,
      };
    }
    const manifestProblem = describeManifestProblem(parsed);
    if (manifestProblem) {
      return {
        owned: false,
        problem: `its manifest.json ${manifestProblem}`,
        foreignEntries: [],
        marker,
      };
    }
    if (!marker.manifestSha256) {
      return {
        owned: false,
        problem: "its .codebase-snapshot marker records no manifest digest",
        foreignEntries: [],
        marker,
      };
    }
    if (sha256Hex(raw) !== marker.manifestSha256) {
      return {
        owned: false,
        problem:
          "its manifest.json does not match the digest recorded in its .codebase-snapshot marker",
        foreignEntries: [],
        marker,
      };
    }
  } else if (marker.manifestSha256) {
    return {
      owned: false,
      problem: "its manifest.json is missing although its marker records one",
      foreignEntries: [],
      marker,
    };
  }

  // Legacy evidence. Markers written before the per-file inventory existed carry no `files`,
  // so the only proof they can offer is the manifest digest checked above. Requiring it keeps
  // the forged marker with no manifest — the case this hardening exists for — refused, while a
  // genuine snapshot from an earlier release, which always ships a manifest and its digest in
  // the marker, stays replaceable after an upgrade. A legacy snapshot generated with
  // `artifacts.manifest` disabled cannot prove itself and is refused, like any other
  // unverifiable directory: the documented recovery is to remove it once.
  if (marker.files === undefined && !hasManifest) {
    return {
      owned: false,
      problem:
        "its .codebase-snapshot marker records neither per-file digests nor a manifest digest, " +
        "so it cannot prove this generator wrote the directory",
      foreignEntries: [],
      marker,
    };
  }

  const recorded = new Set(marker.entries ?? []);
  if (recorded.size === 0) {
    return {
      owned: false,
      problem: "its .codebase-snapshot marker records no contents",
      foreignEntries: [],
      marker,
    };
  }

  const entries = listEntries(dir);
  const foreignEntries = entries.filter(
    (entry) => !recorded.has(entry) && !IGNORABLE_ENTRIES.has(entry)
  );
  if (foreignEntries.length > 0) {
    // Named separately so the refusal can list exactly what stops it.
    return { owned: false, problem: null, foreignEntries, marker };
  }
  const inventoryProblem =
    marker.files === undefined ? null : verifyMarkerInventory(dir, entries, marker.files);
  return {
    owned: inventoryProblem === null,
    problem: inventoryProblem,
    foreignEntries: [],
    marker,
  };
}

function describeEntries(entries: string[], limit = 5): string {
  const shown = entries.slice(0, limit).join(", ");
  return entries.length > limit ? `${shown}, and ${entries.length - limit} more` : shown;
}

/**
 * True when `dir` holds no regular file at any depth — only directories, possibly nested.
 *
 * Replacing such a tree cannot destroy anything, so it is treated like an empty one. The walk is
 * iterative for the same reason the project-tree walker is: a deep directory chain must not
 * overflow the stack of an ownership check. A symlink is counted as content (it is neither
 * `isDirectory()` nor ignorable), so a link is never quietly deleted.
 */
function containsNoFiles(dir: string): boolean {
  const pending: string[] = [dir];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // Unreadable: assume it may hold something and let the caller refuse.
      return false;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pending.push(path.join(current, entry.name));
      } else if (!IGNORABLE_ENTRIES.has(entry.name)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Refuses to replace a directory that this generator did not write.
 *
 * Path checks alone cannot make the swap safe: `outDir: "src"` is a plausible
 * typo, and a user directory that happens to contain a `.codebase-snapshot` file
 * or a manifest-shaped JSON document is not a snapshot. The staging root is
 * checked separately by {@link assertStagingRootUsable}, because it holds one
 * directory per run rather than a single snapshot.
 */
export function assertReplaceable(
  target: string,
  label: "outDir" | "tmpDir",
  secretRules?: readonly SecretRule[]
): void {
  if (!fs.existsSync(target)) return;

  if (!fs.statSync(target).isDirectory()) {
    throw new Error(
      `Refusing to write into ${label} ${target}: it exists but is not a directory.`
    );
  }

  const entries = fs.readdirSync(target);
  if (entries.length === 0) return;
  // Tolerated: replacing a directory that holds nothing but Finder noise loses nothing.
  if (entries.every((name) => IGNORABLE_ENTRIES.has(name))) return;
  // Also tolerated: directories with no file at any depth. Replacing them destroys nothing, and a
  // skeleton left behind by a killed run, an emptied snapshot or a hand-made `parts/`+`reports/`
  // used to leave the tool refusing with "remove the directory yourself" when there was nothing to
  // remove — a dead end reached by following our own cleanup instructions.
  if (containsNoFiles(target)) return;

  const { problem } = readOwnershipMarker(target);
  const verdict = assessSnapshotDirectory(target);
  if (verdict.owned) return;

  // Entry names are user data and may themselves carry a token; the refusal is
  // printed to stderr and read by an agent like every other artifact.
  const shownForeign = verdict.foreignEntries.map((name) => maskPathText(name, secretRules));
  const shownEntries = entries.map((name) => maskPathText(name, secretRules));

  if (verdict.foreignEntries.length > 0) {
    throw new Error(
      `Refusing to replace ${label} ${target}: it carries this generator's ownership marker, but ` +
        `these entries are not part of the snapshot it recorded: ${describeEntries(shownForeign)}. ` +
        `Remove them yourself, or point ${label} at a new or empty directory.`
    );
  }

  const reason =
    verdict.problem ?? problem ?? "it does not look like a snapshot this generator wrote";
  throw new Error(
    `Refusing to replace ${label} ${target}: ${reason} (found ${describeEntries(shownEntries)}). ` +
      `Remove the directory yourself, or point ${label} at a new or empty directory.`
  );
}

/**
 * Refuses a staging root that holds anything this generator did not write.
 *
 * `tmpDir` is a container: each run creates its own `run-*` directory inside it,
 * so a concurrent run's staging area is expected here. Anything that is not a
 * `run-*` directory, or a `run-*` directory without our marker and with content
 * in it, is somebody else's data and nothing is touched.
 */
function assertStagingRootUsable(
  tmpDir: string,
  secretRules: readonly SecretRule[] | undefined
): void {
  if (!fs.existsSync(tmpDir)) return;
  if (!fs.statSync(tmpDir).isDirectory()) {
    throw new Error(`Refusing to write into tmpDir ${tmpDir}: it exists but is not a directory.`);
  }

  const entries = fs.readdirSync(tmpDir);
  if (entries.length === 0) return;

  const foreign = entries.filter((name) => {
    const full = path.join(tmpDir, name);
    if (!name.startsWith(RUN_DIR_PREFIX)) return true;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(full);
    } catch {
      return true;
    }
    if (!stats.isDirectory()) return true;
    const { marker } = readOwnershipMarker(full);
    if (marker) return false;
    try {
      return fs.readdirSync(full).length > 0;
    } catch {
      return true;
    }
  });

  if (foreign.length > 0) {
    const shown = describeEntries(foreign.map((name) => maskPathText(name, secretRules)));
    throw new Error(
      `Refusing to replace tmpDir ${tmpDir}: it holds ${shown}, which this generator did not ` +
        `write. Point tmpDir at a new or empty directory, or remove those files yourself.`
    );
  }
}

/**
 * Removes staging directories left behind by runs that died.
 *
 * A `run-*` directory whose marker names a live process is left alone (the lock
 * normally prevents that situation); one whose process is gone, or whose marker
 * is older than {@link STALE_RUN_MS}, is a crash leftover and may be cleared.
 */
function cleanStaleRunDirs(tmpDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(RUN_DIR_PREFIX)) continue;
    const full = path.join(tmpDir, name);
    const { marker } = readOwnershipMarker(full);
    if (marker) {
      const created = Date.parse(marker.createdAt);
      const aged = !Number.isFinite(created) || Date.now() - created > STALE_RUN_MS;
      const abandoned = typeof marker.pid === "number" && !isProcessAlive(marker.pid);
      if (aged || abandoned) {
        try {
          fs.rmSync(full, { recursive: true, force: true });
        } catch {
          // A leftover that cannot be removed is reported by the next write.
        }
      }
      continue;
    }
    // No marker: only a directory left by a crash between `mkdir` and the first
    // write is ours. Anything with content in it is not provably ours.
    try {
      if (fs.readdirSync(full).length === 0) fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // Ignored: the staging-root guard refuses unreadable entries.
    }
  }
}

/** Removes `dir` when it is empty; `tmpDir` is the staging container. */
function removeIfEmpty(dir: string): void {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Not empty, already gone, or not ours to remove: leave it.
  }
}

/**
 * Creates the parents of an output path.
 *
 * The atomic swap renames into `outDir`, which requires its parent to exist:
 * `--out-dir nested/deep/out` used to fail with a raw ENOENT from `rename`.
 * An ancestor that is a file is a refusal, not something to paper over.
 */
function ensureParentDirectory(target: string, label: "outDir" | "tmpDir"): void {
  const parent = path.dirname(target);
  if (fs.existsSync(parent) && !fs.statSync(parent).isDirectory()) {
    throw new Error(
      `Refusing to create ${label} ${target}: ${parent} exists but is not a directory.`
    );
  }
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (err) {
    throw new Error(
      `Refusing to create ${label} ${target}: its parent ${parent} could not be created (${(err as Error).message}).`
    );
  }
}

/** How often the lock owner refreshes the heartbeat while the run is alive. */
const LOCK_HEARTBEAT_MS = 5_000;

/**
 * How old a heartbeat may be before the lock is treated as a corpse.
 *
 * A live run — even one inside a synchronous 50 MB parse — refreshes it from a worker thread
 * every {@link LOCK_HEARTBEAT_MS}. Two minutes is 24 missed beats: long enough to survive a
 * suspended laptop or a pathological pause, short enough that a crashed CI job recovers without
 * a human. The old rule was the lock file's *creation* mtime and a one-hour window, so a process
 * killed between `openSync` and `writeSync` wedged every later run for an hour, and a pid reused
 * by an unrelated process wedged it forever.
 */
const LOCK_STALE_HEARTBEAT_MS = 120_000;

/**
 * Worker source that refreshs the lock's mtime.
 *
 * A worker thread, not `setInterval` in this process: `generateSnapshot` is synchronous, so the
 * main event loop is blocked for the whole run and a timer would never fire. The worker is
 * `unref`ed and dies with the parent, so a crashed run cannot leave a heartbeat behind.
 */
const LOCK_HEARTBEAT_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { lockPath, intervalMs } = workerData;
const timer = setInterval(() => {
  try {
    const now = new Date();
    fs.utimesSync(lockPath, now, now);
  } catch (err) {
    // The lock was reclaimed or removed; nothing left to keep alive.
  }
}, intervalMs);
timer.unref();
if (parentPort) {
  parentPort.on("message", (message) => {
    if (message === "stop") {
      clearInterval(timer);
      process.exit(0);
    }
  });
}
`;

/** Starts the heartbeat and returns the function that stops it. */
function startLockHeartbeat(lockPath: string): () => void {
  try {
    const worker = new Worker(LOCK_HEARTBEAT_SOURCE, {
      eval: true,
      workerData: { lockPath, intervalMs: LOCK_HEARTBEAT_MS },
    });
    worker.unref();
    return () => {
      void worker.terminate().catch(() => undefined);
    };
  } catch {
    // The lock still has a fresh mtime from acquisition, and refusing the run over an optional
    // safety net would be worse than losing the heartbeat for one run.
    return () => undefined;
  }
}

/**
 * Serialises runs that share a staging root.
 *
 * The lock is keyed on the resolved `tmpDir`, not on `outDir`: staging lives
 * under `tmpDir`, so two runs with different `outDir`s used to take different
 * locks and then delete each other's staging files. Runs that share a staging
 * root are serialised; runs with distinct roots proceed independently. The lock
 * lives in the OS temp directory — never inside the repository, where it could
 * be scanned — and carries a heartbeat so a crashed run's lock does not block
 * forever.
 */
function acquireRunLock(stagingRoot: string): () => void {
  const lockPath = lockPathFor(stagingRoot);
  const payload = `${JSON.stringify({
    pid: process.pid,
    stagingRoot,
    host: os.hostname(),
    runId: crypto.randomUUID(),
    heartbeatMs: LOCK_HEARTBEAT_MS,
    startedAt: new Date().toISOString(),
  })}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(handle, payload);
      } finally {
        fs.closeSync(handle);
      }
      const stopHeartbeat = startLockHeartbeat(lockPath);
      return () => {
        stopHeartbeat();
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // A lock that cannot be removed is detected as stale by the next run
          // (dead pid or a stale heartbeat) or reported to the user; the snapshot itself is fine.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (attempt === 0 && reclaimStaleLock(lockPath)) continue;
      throw new Error(
        `Another generate run is already using the staging directory ${stagingRoot} ` +
          `(lock ${lockPath}, heartbeat ${Math.round(lockHeartbeatAgeMs(lockPath) / 1000)}s old). ` +
          `Wait for it to finish, or delete the lock if no other run is active.`
      );
    }
  }

  throw new Error(`Could not acquire the generate lock for ${stagingRoot}.`);
}

/**
 * Stable lock-file key for a staging root.
 *
 * The real path is used so `Snapshot.Tmp` and `snapshot.tmp` cannot take different locks on a
 * case-insensitive filesystem, and so a symlinked checkout cannot take one lock through the link
 * and another through the target.
 *
 * Resolving the root itself was not enough, because the root frequently does not exist yet when
 * the lock is taken — the run creates it afterwards. `realpathSync` then threw, the unresolved
 * path was hashed instead, and the two processes disagreed:
 *
 * - process 1 takes the lock before creating `tmpDir`, hashing `/var/folders/…/snapshot.tmp`;
 * - process 1 creates `tmpDir`;
 * - process 2 takes the lock while process 1 is still writing, `realpathSync` now succeeds and
 *   resolves `/var` to `/private/var` (macOS), so it hashes a different string;
 * - the two locks are different files, mutual exclusion does not exist, and both write.
 *
 * Resolving the nearest *existing* ancestor and re-joining the missing segments gives the same
 * answer before and after the directory exists.
 */
function lockKeyFor(stagingRoot: string): string {
  let key = canonicalLockTarget(stagingRoot);
  if (process.platform === "win32" || process.platform === "darwin") key = key.toLowerCase();
  return sha256Hex(key).slice(0, 16);
}

/**
 * The path with every existing ancestor's real path resolved.
 *
 * `realpathSync` on a path that does not exist throws, so the walk stops at the first ancestor that
 * does and the unresolved remainder is appended to its real path.
 */
function canonicalLockTarget(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  let existing = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...tail);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return resolved;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Where the run lock for a staging root lives.
 *
 * Exported because the lock is the one piece of state that can outlive a crashed run and
 * wedge the next one, and the error the user sees names this path — a diagnostic that
 * has to be transcribed from a hash by hand is not a diagnostic.
 */
export function lockPathFor(stagingRoot: string): string {
  return path.join(os.tmpdir(), `codebase-snapshot-${lockKeyFor(stagingRoot)}.lock`);
}

/** Milliseconds since the lock was last refreshed, or `Infinity` when it cannot be read. */
function lockHeartbeatAgeMs(lockPath: string): number {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * True only when the lock's owner is certainly gone, proven by its pid or its heartbeat.
 *
 * The pid check alone could not distinguish a live run from an unrelated process that reused the
 * pid, and a truncated lock carried no pid at all — so "not provably dead" meant "refuse for an
 * hour". Every live run now refreshes the lock from a worker thread, so a heartbeat older than
 * {@link LOCK_STALE_HEARTBEAT_MS} is positive evidence that no run owns it. A pid that no longer
 * exists is still immediate evidence; the heartbeat bounds the reused-pid case.
 */
function lockOwnerIsGone(lockPath: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return false;
  }
  let pid: unknown;
  try {
    pid = (JSON.parse(raw) as { pid?: unknown }).pid;
  } catch {
    // A zero-byte or truncated lock file is the record of a process that died between
    // `openSync(…, "wx")` and `writeSync` — the file exists, so it was never cleaned up,
    // and it carries no pid, so only age could prove it dead. It now recovers in minutes, not
    // an hour, because the heartbeat window is the heartbeat interval's business.
    return lockFileIsAncient(lockPath);
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return lockFileIsAncient(lockPath);
  try {
    process.kill(pid, 0);
    // The pid exists. It may be the owner or an unrelated process that reused the number; the
    // heartbeat is the only portable way to tell them apart.
    return lockFileIsAncient(lockPath);
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") return lockFileIsAncient(lockPath);
    return true;
  }
}

/**
 * Removes a lock whose owner is certainly dead, and only that lock.
 *
 * `lockOwnerIsGone` answers a question and removing the file acts on the answer, and between the
 * two another process can replace the stale lock with its own. Two runs that both find the same
 * dead lock both delete it, the slower one deletes the lock the faster one has just created, and
 * both proceed — the mutual exclusion the lock exists for, silently absent.
 *
 * There is no portable "unlink only this inode", so the identity is re-checked as late as
 * possible: the file's inode and creation time are compared immediately before the delete. That
 * narrows the window from "read, parse, probe the pid, unlink" to "stat, unlink", and a lock that
 * changed hands in between is left alone — the caller reports "another run is active", which is
 * true and safe, rather than deleting a live lock.
 */
function reclaimStaleLock(lockPath: string): boolean {
  let before: fs.Stats;
  try {
    before = fs.statSync(lockPath);
  } catch {
    // It vanished on its own; the caller may try to create it again.
    return true;
  }
  if (!lockOwnerIsGone(lockPath)) return false;
  try {
    const current = fs.statSync(lockPath);
    const sameFile =
      current.ino === before.ino &&
      current.birthtimeMs === before.birthtimeMs &&
      current.mtimeMs === before.mtimeMs;
    if (!sameFile) return false;
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the lock's heartbeat is older than {@link LOCK_STALE_HEARTBEAT_MS}.
 *
 * Used when the lock's contents cannot prove an owner dead: an unreadable payload is not proof
 * of a live run, and a pid alone cannot rule out reuse. A lock older than the heartbeat window
 * has no run behind it, because a live run refreshes it every few seconds.
 */
function lockFileIsAncient(lockPath: string): boolean {
  return lockHeartbeatAgeMs(lockPath) > LOCK_STALE_HEARTBEAT_MS;
}

/**
 * Rewrites `manifest.json` in the shipped directory, atomically.
 *
 * Used after `hooks.afterGenerate`: the hook runs against the finished snapshot,
 * so its warning can only reach the manifest after the fact. Writing through a
 * temporary file and renaming means a crash leaves either the old manifest or
 * the new one, never a truncated file.
 */
function writeManifestAtomically(manifestPath: string, manifest: Manifest): void {
  const tempPath = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2), "utf8");
  try {
    fs.renameSync(tempPath, manifestPath);
  } catch (err) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // The rename failure is the one worth reporting.
    }
    throw err;
  }
}

/**
 * Moves the staging directory into place, keeping the previous output until the
 * new one is fully in place. Falls back to a recursive copy across devices
 * (EXDEV).
 *
 * Two runs can still target the same `outDir` through different staging roots
 * (e.g. two `--tmp-dir` values), so the swap is retried briefly when it loses
 * that race instead of failing with a raw ENOENT/ENOTEMPTY from `rename`.
 */
function swapIntoPlace(stagingDir: string, outDir: string, beforeSwap?: () => void): void {
  ensureParentDirectory(outDir, "outDir");
  const deadline = Date.now() + 3_000;
  let delay = 25;

  // The loop was capped at ten 50 ms attempts, so the 3 s deadline was never reached and a
  // directory held open for a moment longer — the normal case on Windows when a virus scanner
  // or an editor has a handle — failed at 500 ms. The deadline is now the bound, and the
  // delay backs off so a genuinely busy directory is not hammered.
  for (;;) {
    try {
      swapOnce(stagingDir, outDir, beforeSwap);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable =
        code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM";
      const remaining = deadline - Date.now();
      if (!retryable || remaining <= 0) throw err;
      sleepSync(Math.min(delay, remaining));
      delay = Math.min(delay * 2, 400);
    }
  }
}

/**
 * Restores `outDir` from the one backup an interrupted publish left behind.
 *
 * A run killed between "move the old snapshot aside" and "rename the new one in" leaves `outDir`
 * missing and a single `<outDir>.backup-*`. The next run used to read that as a first run, write a
 * fresh snapshot, and leave the previous one under a name nobody looks for. The backup is restored
 * only when it is the only one, it carries a complete marker of this tool's, and `outDir` is
 * absent — otherwise there is nothing unambiguous to recover.
 */
function recoverInterruptedPublish(outDir: string): void {
  if (fs.existsSync(outDir)) return;
  const parent = path.dirname(outDir);
  const base = path.basename(outDir);
  let backups: string[];
  try {
    backups = fs
      .readdirSync(parent)
      .filter((name) => name.startsWith(`${base}.backup-`));
  } catch {
    return;
  }
  if (backups.length !== 1) return;
  const backupDir = path.join(parent, backups[0] as string);
  const { marker, problem } = readOwnershipMarker(backupDir);
  if (problem !== null || marker === null || marker.state !== "complete") return;
  try {
    fs.renameSync(backupDir, outDir);
    process.stderr.write(
      `⚠ Recovered ${outDir} from ${backupDir}, left by an interrupted run. ` +
        `That snapshot is the one from before the interrupted run.\n`
    );
  } catch {
    // Leave the backup where it is: refusing to generate is safer than deleting the only copy.
  }
}

function swapOnce(stagingDir: string, outDir: string, beforeSwap?: () => void): void {
  const backupDir = `${outDir}.backup-${process.pid}-${Date.now()}`;
  const hadPrevious = fs.existsSync(outDir);

  // The guard ran before staging; the directory may have changed while the snapshot was
  // generated. Re-check immediately before the rename, when the window is as small as it gets.
  if (hadPrevious) beforeSwap?.();

  if (hadPrevious) fs.renameSync(outDir, backupDir);

  try {
    try {
      fs.renameSync(stagingDir, outDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      // Across devices a rename is impossible, so the snapshot has to be copied. Copying straight
      // into `outDir` was the bug: when the copy failed halfway — a full disk is the usual way —
      // `outDir` was left holding a *partial* snapshot whose `.codebase-snapshot` marker said
      // "complete" and whose inventory named files that were never written. Copy beside the target
      // and rename that into place instead; the rename is same-device, and a rename either lands
      // whole or not at all.
      const partialDir = `${outDir}.partial-${process.pid}-${Date.now()}`;
      try {
        fs.cpSync(stagingDir, partialDir, { recursive: true });
        fs.renameSync(partialDir, outDir);
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch (copyErr) {
        try {
          fs.rmSync(partialDir, { recursive: true, force: true });
        } catch {
          // The copy error is the one that explains the failure; a cleanup error must not mask it.
        }
        throw copyErr;
      }
    }
  } catch (err) {
    // Roll back so the previous snapshot survives a failed swap.
    if (hadPrevious && fs.existsSync(backupDir)) {
      if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
      fs.renameSync(backupDir, outDir);
    }
    throw err;
  }

  // Removing the backup is **not** part of the transaction, and running it inside the `try` was a
  // destructive bug: `rmSync` can throw EPERM or EBUSY on Windows and network filesystems when an
  // indexer, an antivirus or an editor is holding a handle inside the old snapshot — and the catch
  // block that exists to restore the previous snapshot would then delete the new one that is
  // already fully in place, restore the old one, and rethrow. `swapIntoPlace` retries on EPERM and
  // the staging directory no longer exists, so the retry fails with ENOENT and the user is told
  // the run failed with the snapshot they just generated deleted.
  //
  // Once `outDir` holds the new snapshot the swap has succeeded. A leftover backup is a directory
  // to clean up later (the scanner ignores `<outDir>.backup-*`); losing the run is not. It is
  // reported rather than hidden, because a read-only output directory leaves one on **every** run
  // and a silent pile of them is its own problem.
  if (hadPrevious) {
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(
        `⚠ The previous snapshot could not be removed from ${backupDir} (${(err as Error).message}). ` +
          `The new snapshot is in place; delete that directory by hand when convenient.\n`
      );
    }
  }
}

/** Blocking sleep used between swap retries; `generate` is synchronous anyway. */
function sleepSync(milliseconds: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}

/**
 * Flags artifact combinations that leave a snapshot a consumer cannot fully use.
 *
 * These are warnings rather than errors: switching an artifact off is a
 * legitimate choice, but a disabled manifest silently breaks `validate`/`report`,
 * and navigation links into parts that were never written.
 */
function artifactWarnings(artifacts: ResolvedArtifacts, sarif: boolean): string[] {
  const messages: string[] = [];
  if (!artifacts.manifest) {
    messages.push("manifest.json is disabled: `validate` and `report` cannot inspect this snapshot.");
  }
  if (!artifacts.parts && artifacts.navigation) {
    messages.push(
      "parts are disabled but navigation.md is enabled: its links point at part files that were not written."
    );
  }
  // `sarif` is deliberately not an entry in `artifacts` (it is a second rendering of the audit,
  // not a fourth report), so the "nothing was written" claim has to ask about it separately.
  // `--skip-artifacts readme,manifest,parts,navigation,projectTree,audit --sarif` wrote
  // `reports/audit.sarif` and then told the reader it had written only the marker.
  if (!sarif && ARTIFACT_NAMES.every((name) => artifacts[name] === false)) {
    messages.push(
      "every artifact is disabled: only the .codebase-snapshot ownership marker will be written."
    );
  }
  return messages;
}

/**
 * Runs `hooks.afterGenerate`, downgrading a throwing hook to a warning.
 *
 * The snapshot is already written by this point; losing a good artefact because user code threw
 * would be the worse outcome. Two further rules:
 *
 *  - **stdout is the payload channel.** A hook is user code and user code prints: a single log
 *    line from a hook in `--format json` mode produced a document no parser could read. Writes made
 *    inside the hook's async context are routed to stderr — including the ones that arrive after an
 *    `await`, which is where the previous blanket redirect stopped working. The caller's own writes
 *    (the JSON payload) happen outside that context and keep going to stdout.
 *  - **a returned promise is tracked, never awaited — but the process still waits for it.** This is
 *    a synchronous API, so the promise cannot be awaited here; the caller attaches a rejection
 *    handler, which records the failure as a warning and re-ships the manifest and marker. Left
 *    alone, a rejected async hook became an unhandled rejection that killed the process *after* it
 *    had printed "Snapshot generated … Integrity: passed" and written its JSON payload. Note what
 *    "not awaited" does *not* mean: Node will not exit while the hook's own timers, sockets or
 *    pending I/O are alive, so a hook that schedules an hour of work delays the command by an hour.
 *    That is a property of the event loop, not of this function, and the docs say so.
 */
/**
 * The stdout diversion used by `hooks.afterGenerate`.
 *
 * The scope and the router live in `stdout.ts`, because `setup --format json` borrows stdout too
 * and the two used to patch `process.stdout.write` independently — with the result that whichever
 * finished second restored a function belonging to the one that had already finished. See that
 * module for the whole account.
 */
function installHookStdoutRedirect(): () => void {
  return installStdoutRouter();
}

function runAfterGenerate(config: ResolvedSnapshotConfig, manifest: Manifest): Promise<unknown> | null {
  const hook = config.hooks.afterGenerate;
  if (!hook) return null;

  // AsyncLocalStorage tells the hook's writes apart from the caller's without a
  // time window: a continuation after an `await` is still inside `hookScope`,
  // while the payload the CLI prints right after this call is not.
  const releaseRedirect = installHookStdoutRedirect();
  let returned: unknown;

  try {
    returned = hookStdoutScope.run(true, () => hook(manifest));
  } catch (err) {
    releaseRedirect();
    // The message is user code and can quote a credential (an error string from an
    // HTTP client carries the URL, a key reference carries the key). It is the one
    // repo-adjacent string that used to reach the manifest unmasked.
    const message = maskPathText((err as Error).message, config.secretRules);
    manifest.warnings.push(`hooks.afterGenerate failed: ${message}`);
    manifest.totals.warningCount = manifest.warnings.length;
    return null;
  }

  const thenable = returned as { then?: unknown } | null | undefined;
  if (!thenable || typeof thenable.then !== "function") {
    releaseRedirect();
    return null;
  }
  // The redirection stays installed until the hook settles; only writes made in
  // the hook's context are diverted, so the caller's payload is unaffected.
  return Promise.resolve(returned).finally(releaseRedirect);
}

/**
 * Partitions files under the configured per-layer budgets.
 *
 * Files sharing an effective budget are packed together, and every part is rendered once, against
 * the numbering the whole run will use. The previous arrangement partitioned each budget
 * separately and then re-numbered the merged set, which rewrote headers that had already been
 * fitted to a budget — and then had to re-apply the byte bound to the rewritten text. Deciding the
 * numbering before rendering removes that whole after-the-fact repair.
 */
function partitionByBudget(
  files: FileEntry[],
  config: ResolvedSnapshotConfig,
  fingerprint: string
): PartitionedPart[] {
  const budgetFor = (file: FileEntry): number =>
    config.budgets.byLayer[file.layer] ?? config.budgets.default;

  const buckets = new Map<number, FileEntry[]>();
  for (const file of files) {
    const budget = budgetFor(file);
    const bucket = buckets.get(budget);
    if (bucket) bucket.push(file);
    else buckets.set(budget, [file]);
  }

  if (buckets.size === 0) return [];
  if (buckets.size === 1) {
    return partitionFiles(files, Array.from(buckets.keys())[0] as number, fingerprint);
  }

  return partitionFilesForBuckets(
    Array.from(buckets.entries())
      .sort(([left], [right]) => left - right)
      .map(([budgetBytes, bucketFiles]) => ({ files: bucketFiles, budgetBytes })),
    fingerprint
  );
}

/**
 * Generates the snapshot.
 *
 * Synchronous by design: it previously carried an `async` signature while doing
 * only blocking I/O, which promised concurrency that did not exist. Existing
 * `await generateSnapshot(...)` call sites continue to work.
 */
export function generateSnapshot(
  configInput?: SnapshotConfig | ResolvedSnapshotConfig | null,
  options?: GenerateOptions
): Manifest {
  // A resolved config is normalised even when it arrives branded: a spread copy
  // (`{ ...resolvedConfig, override }`) loses the brand, and its secret rules
  // must never be dropped on the floor.
  assertUsableConfigInput(configInput);

  const config = isResolvedConfig(configInput)
    ? normalizeResolvedConfig(configInput)
    : resolveConfig((configInput as SnapshotConfig | null | undefined) ?? null);
  const dryRun = options?.dryRun ?? false;

  const gitInfo = getGitInfo(config.cwd, config.branch);

  /**
   * The changed-files scope, resolved once, or `null` when the run is not scoped.
   *
   * Resolved *before* the scan rather than after it. The old code narrowed `files` once every
   * candidate had been read, decoded, secret-scanned and TypeScript-parsed, which cost a full
   * repository scan to keep a handful of files — and, because every aggregate was bumped inside
   * that scan, left `manifest.layers`, `manifest.kinds`, `counts.largeFileCount`, the redaction
   * findings and the encoding/preview warnings describing the repository instead of the
   * snapshot. A snapshot of five files that reports the layer counts of ten thousand is a
   * document that lies about itself.
   */
  const changedScope =
    config.changedSince !== undefined || config.staged === true
      ? resolveChangedScope(config.cwd, {
          ...(config.changedSince === undefined ? {} : { changedSince: config.changedSince }),
          ...(config.staged === true ? { staged: true } : {}),
        })
      : null;
  const changedPaths = changedScope === null ? null : new Set(changedScope.paths);
  const stagedPaths = changedScope?.stagedPaths ?? new Set<string>();
  const stagedDeletedPaths = changedScope?.deletedPaths ?? new Set<string>();

  const collection = collectFiles(config.cwd, {
    includePatterns: config.include,
    excludePatterns: [...config.excludePatterns, ...config.presetExclude],
    includeSensitiveFiles: config.includeSensitiveFiles,
    secretRules: config.secretRules,
    discovery: config.discovery,
    // The output and staging directories this run is about to write, relative to the root. A
    // first run cannot have marked them yet, so the name alone keeps a run from recording its own
    // output — but only at these exact paths, not at every directory that shares the name.
    toolOwnedPaths: [config.outDir, config.tmpDir]
      .map((directory) =>
        path.relative(config.cwd, path.resolve(config.cwd, directory)).replace(/\\/g, "/")
      )
      .filter((relative) => relative.length > 0 && !relative.startsWith("..")),
    // A staged path can be absent from the working tree while its index blob exists. Discovery
    // lists the working tree, so those paths would never reach the scan at all.
    ...(stagedPaths.size > 0 ? { extraPaths: [...stagedPaths] } : {}),
  });

  /** Paths the scope removed before the scan; recorded in `skipped[]` after the loop. */
  const unchangedPaths: string[] = [];

  // Without `--with-dependents` the scope is a plain path set, so it is applied to the candidate
  // list and the dropped files are never opened. `--with-dependents` cannot be answered from a
  // path — the closure needs each file's imports — so that case still scans and narrows below.
  const candidateFiles =
    changedPaths !== null && config.withDependents !== true
      ? collection.files.filter((relativePath) => {
          if (changedPaths.has(relativePath)) return true;
          unchangedPaths.push(relativePath);
          return false;
        })
      : collection.files;

  const files: FileEntry[] = [];
  /** Everything that can change a cached derivation, computed once for the whole run. */
  const derivationKey = derivationSettings(config);
  /** Full redacted bodies of large files, kept for the monolith only. */
  const monolithBodies = new Map<string, string>();
  const skipped: SkipRecord[] = maskSkipRecords([...collection.skipped], config.secretRules);
  const secretFindings: SecretFinding[] = [];
  const warnings: string[] = [];
  // A part budget below `largeFileBytes` is the configuration that cuts a file by
  // the partitioner's byte budget while `isLarge` stays false, so nothing in the
  // snapshot explains why the body is incomplete. Reported at the end of the run, and only when a
  // file was actually cut by the part budget: several presets recommend a part budget below the
  // default large-file threshold (node-lib is 120 KB against 200 KB), so warning on the
  // configuration alone fired on every one of their repositories, truncation or not.
  const budgetOrderCutsFiles = (): boolean => {
    if (config.maxPartBytes >= config.largeFileBytes) return false;
    return files.some((file) => file.isPreviewTruncated && !file.isLarge);
  };
  /** Files that were not plain UTF-8, grouped into one warning after the scan. */
  const encodingNotes: { path: string; encoding: TextEncoding; invalidBytes: number }[] = [];
  /**
   * Warnings produced while scanning one file, held until the changed-scope filter has run.
   *
   * They carry their path so a file the scope drops takes its warning with it — the message has
   * the path masked, so the list cannot be filtered by string after the fact.
   */
  const fileWarnings: { path: string; message: string }[] = [];
  /** Files too large to parse for a structural summary, grouped into one warning after the scan. */
  const oversizeSummaryPaths: string[] = [];
  /**
   * Previewed files whose language would otherwise get a structural summary.
   *
   * A preview carries only head/tail lines, so a whole-file summary describes
   * lines the snapshot does not contain — and masking every identifier in one for
   * a summary the partitioner then discards dominated the run (a 1.9 MB `.ts` spent
   * ~70 % of its wall time in `findSecretInPath` over summary strings). Recorded in
   * one grouped warning, exactly like the oversize case.
   */
  const previewSummaryPaths: string[] = [];
  /**
   * Import specifiers of the files whose summary was skipped.
   *
   * `--with-dependents` is decided from `file.summary.imports`, and a previewed or oversized file
   * has no summary — so an importer that happened to be large was dropped from the snapshot as
   * "unchanged" while `validate` and `explain`, which read the file from disk, called it a
   * dependent. Both of those commands got the answer right; the generator lost a file the change
   * genuinely affects. Imports are cheap to extract from text already in hand (they are module
   * specifiers at the top of the file), so they are collected here even when the structural
   * summary is refused.
   */
  const skippedSummaryImports = new Map<string, string[]>();
  // Null-prototype registries: a config may name a layer or kind `constructor` or `__proto__`,
  // both valid identifiers, and indexing a plain object with either read `Object` or assigned the
  // prototype instead of creating an own key.
  const layerCounts: LayerOrKindCounts = Object.create(null) as LayerOrKindCounts;
  const kindCounts: LayerOrKindCounts = Object.create(null) as LayerOrKindCounts;

  let totalLines = 0;
  let totalSizeBytes = 0;
  let largeFileCount = 0;

  for (const relativePath of candidateFiles) {
    const absolutePath = path.join(config.cwd, relativePath);
    // `--staged` selects index paths, so the bytes must come from the index too. Reading the
    // working tree described a different revision whenever a staged file had later unstaged
    // edits, which is exactly the state a pre-commit run is in.
    const fromIndex = stagedPaths.has(relativePath);
    /** The bytes this file contributes: the index blob when staged, else the working tree. */
    let buffer: Buffer;
    /** Its size in the same domain, so every recorded size describes the bytes actually read. */
    let sizeBytes: number;

    if (fromIndex && stagedDeletedPaths.has(relativePath)) {
      skipped.push({
        path: relativePath,
        reason: "deleted",
        detail: "staged for deletion; it is not part of the next commit",
      });
      continue;
    }

    if (fromIndex) {
      const staged = readStagedBlob(config.cwd, relativePath);
      if (staged === null) {
        // No index object: either a staged deletion `--diff-filter=D` did not report (a rename
        // source, a submodule) or an unreadable object. Recording it is the point.
        skipped.push({
          path: relativePath,
          reason: "deleted",
          detail: "staged path has no blob in the index; it is not part of the next commit",
        });
        continue;
      }
      if (isBinaryExtension(absolutePath)) {
        skipped.push({ path: relativePath, reason: "binary", detail: `Size: ${staged.length} B` });
        continue;
      }
      buffer = staged;
      sizeBytes = staged.length;
    } else {
      let stats: fs.Stats;
      try {
        stats = fs.statSync(absolutePath);
        if (!stats.isFile()) {
          // A submodule is a single gitlink, so git lists a path where a file is expected and the
          // stat answers "directory". Reporting that as `not-file` implied a socket or a FIFO; a
          // nested checkout is a different fact, and one the reader needs to know: the contents
          // exist and are simply somebody else's history.
          const nestedRepository =
            stats.isDirectory() && fs.existsSync(path.join(absolutePath, ".git"));
          skipped.push(
            nestedRepository
              ? {
                  path: relativePath,
                  reason: "nested-repository" as const,
                  detail:
                    "a directory belonging to another repository (nested checkout or submodule); its contents are not scanned",
                }
              : { path: relativePath, reason: "not-file" }
          );
          continue;
        }
      } catch (err) {
        // A tracked file deleted without staging reaches this branch: `git ls-files` lists it and
        // `statSync` answers ENOENT. Calling it `read-error` with no detail left the operator
        // unable to tell a missing file from a permission problem.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          skipped.push({
            path: relativePath,
            reason: "missing",
            detail: "tracked but absent from disk (deleted without staging)",
          });
        } else {
          skipped.push({
            path: relativePath,
            reason: "read-error",
            detail: String((err as Error).message).replace(/\s+/g, " "),
          });
        }
        continue;
      }

      // One read, not three.
      //
      // This used to call `isBinaryFile(absolutePath)`, which opened a descriptor, allocated a
      // 64 KB buffer and read the file in chunks looking for a NUL — and then read the *same*
      // bytes again with `readFileSync`, and then scanned them again with `decodeText`. Every
      // included file under the 8 MB scan cap was opened twice and read twice.
      //
      // A binary extension needs no read at all, and below the cap `decodeText` already answers
      // the question on the buffer the generator had to hold anyway — it checks for a NUL
      // anywhere in the buffer, so it is stricter than the head scan it replaces. Above the cap
      // the chunked scan stays, because that is the case it exists for: the file may be far too
      // large to load, and a head check is better than reading a gigabyte of noise.
      if (isBinaryExtension(absolutePath)) {
        skipped.push({ path: relativePath, reason: "binary", detail: `Size: ${stats.size} B` });
        continue;
      }
      if (stats.size > BINARY_SCAN_BYTES && isBinaryFile(absolutePath)) {
        skipped.push({ path: relativePath, reason: "binary", detail: `Size: ${stats.size} B` });
        continue;
      }

      try {
        buffer = fs.readFileSync(absolutePath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        skipped.push({
          path: relativePath,
          reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "read-error",
          detail: String((err as Error).message).replace(/\s+/g, " "),
        });
        continue;
      }
      sizeBytes = stats.size;
    }

    // The pre-read NUL scan gives up after BINARY_SCAN_BYTES so a huge blob is never pulled into
    // memory; this is the complete check, on the buffer that had to be read anyway. A file of
    // 8 MB of text with a NUL at byte 8 388 672 used to be emitted as text.
    let decoded: ReturnType<typeof decodeText>;
    try {
      decoded = decodeText(buffer);
    } catch (err) {
      // V8 refuses to materialise a string past roughly 512 MiB, and the failure
      // (a plain RangeError with no path in it) used to abort the whole run. One
      // enormous text file must not take the snapshot down; record it and keep
      // going, exactly like any other unreadable file.
      skipped.push({
        path: relativePath,
        reason: "read-error",
        detail: `Size: ${sizeBytes} B; could not be decoded: ${(err as Error).message}`.replace(
          /\s+/g,
          " "
        ),
      });
      continue;
    }
    if (decoded.binary) {
      skipped.push({
        path: relativePath,
        reason: "binary",
        detail: `Size: ${sizeBytes} B; ${decoded.binaryReason ?? "binary content"}`,
      });
      continue;
    }

    // One read, one hash domain: the validator hashes the raw buffer too, so a
    // file with invalid UTF-8 no longer produces unfixable phantom drift.
    const hashSha256 = sha256Hex(buffer);
    const rawContent = decoded.text;

    totalSizeBytes += sizeBytes;

    if (decoded.encoding !== "utf-8") {
      encodingNotes.push({
        path: relativePath,
        encoding: decoded.encoding,
        invalidBytes: decoded.invalidBytes,
      });
    }

    // Masked at the source: a layer or kind name supplied in the config can look like
    // a credential, and every derived field (files[].layer, part headers, README, audit,
    // navigation, manifest.layers) is built from this value.
    const layer = maskPathText(classifyLayer(relativePath, config.layers), config.secretRules);
    const kind = maskPathText(classifyKind(relativePath, config.kinds), config.secretRules);
    const language = detectLanguage(relativePath);
    bump(layerCounts, layer);
    bump(kindCounts, kind);

    // Same bytes, same settings, same path: the derivation is the one from the previous run. This
    // is what makes `--watch` regenerate in milliseconds instead of re-parsing the repository for
    // every keystroke.
    const derivation =
      takeDerivation(absolutePath, hashSha256, derivationKey) ??
      (() => {
        const fresh = deriveFile(relativePath, rawContent, sizeBytes, config);
        rememberDerivation(absolutePath, hashSha256, derivationKey, fresh);
        return fresh;
      })();

    const { lineCount } = derivation;
    totalLines += lineCount;
    secretFindings.push(...derivation.findings);
    if (derivation.isLarge) largeFileCount += 1;

    if (derivation.summarySkip === "oversize") oversizeSummaryPaths.push(relativePath);
    else if (derivation.summarySkip === "preview") previewSummaryPaths.push(relativePath);
    if (derivation.dependentImports !== null) {
      skippedSummaryImports.set(relativePath, derivation.dependentImports);
    }
    if (derivation.summaryWarning !== null) {
      fileWarnings.push({ path: relativePath, message: derivation.summaryWarning });
    }

    // `file.content` is deliberately whatever the parts carry, but the monolith is documented as
    // the whole repository. Keep the full *redacted* body here so `full-codebase.*` cannot inherit
    // a head/tail preview **or a skeleton** — only pay that memory cost when a monolith was
    // actually requested.
    //
    // The skeleton case is the one that used to lie: `--skeleton --include-monolith` wrote a body
    // without any function bodies into `full-codebase.json` and labelled it
    // `inclusionMode: "full"`, so the monolith claimed to contain code it had deleted.
    if (
      config.includeMonolith &&
      (derivation.isPreviewTruncated || derivation.inclusionMode === "signatures")
    ) {
      monolithBodies.set(relativePath, derivation.redacted);
    }

    files.push({
      relativePath,
      sizeBytes,
      lines: lineCount,
      hashSha256,
      part: "",
      layer,
      kind,
      language,
      inclusionMode: derivation.inclusionMode,
      isLarge: derivation.isLarge,
      isPreviewTruncated: derivation.isPreviewTruncated,
      originalLines: lineCount,
      includedLines: derivation.includedLines,
      includedBytes: Buffer.byteLength(derivation.finalContent, "utf8"),
      summary: derivation.summary,
      summaryQuality: derivation.summaryQuality,
      ...(decoded.encoding === "utf-8" ? {} : { encoding: decoded.encoding }),
      content: derivation.finalContent,
    });
  }

  // `--with-dependents` can only be decided once every import has been parsed, so its filter
  // stays after the scan — and everything the scan accumulated for a dropped file is undone
  // with it. Totals were recomputed here already; the layer and kind counts, the large-file
  // count, the redaction findings and the warning lists were not, so a two-file snapshot
  // reported the layer distribution and the secret count of the whole repository.
  if (changedScope !== null && changedPaths !== null && config.withDependents === true) {
    const keep = new Set(changedPaths);
    const resolver = buildImportResolver(files, {
      extraPaths: changedPaths,
      tsconfig: tsconfigPathsFor(config.cwd),
    });
    // One hop, and only one hop — `importsChangedFile` is the shared test, so `explain` and
    // `validate` answer this question with the same rule the generator applies here.
    for (const file of files) {
      const fileImports = isSourceSummary(file.summary)
        ? file.summary.imports
        : (skippedSummaryImports.get(file.relativePath) ?? []);
      if (fileImports.length === 0) continue;
      if (importsChangedFile(file.relativePath, fileImports, changedPaths, resolver)) {
        keep.add(file.relativePath);
      }
    }

    for (const file of files) {
      if (!keep.has(file.relativePath)) unchangedPaths.push(file.relativePath);
    }

    const kept = files.filter((file) => keep.has(file.relativePath));
    files.length = 0;
    files.push(...kept);

    // The totals describe the snapshot, not the scan, so they are recomputed from what survived.
    totalLines = files.reduce((total, file) => total + file.lines, 0);
    totalSizeBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
    largeFileCount = 0;
    for (const key of Object.keys(layerCounts)) delete layerCounts[key];
    for (const key of Object.keys(kindCounts)) delete kindCounts[key];
    for (const file of files) {
      bump(layerCounts, file.layer);
      bump(kindCounts, file.kind);
      if (file.isLarge) largeFileCount += 1;
    }
    retain(
      secretFindings,
      (finding) => finding.path === undefined || keep.has(finding.path)
    );
    retain(encodingNotes, (note) => keep.has(note.path));
    retain(oversizeSummaryPaths, (path) => keep.has(path));
    retain(previewSummaryPaths, (path) => keep.has(path));
    retain(fileWarnings, (warning) => keep.has(warning.path));
    for (const path of [...monolithBodies.keys()]) {
      if (!keep.has(path)) monolithBodies.delete(path);
    }
    for (const path of [...skippedSummaryImports.keys()]) {
      if (!keep.has(path)) skippedSummaryImports.delete(path);
    }
  }

  // Files the scope removed are recorded the same way whether they were filtered before the scan
  // or after it. `unchanged` is deliberately a different statement from `excluded`: the file is
  // includable and simply did not move.
  if (changedScope !== null) {
    for (const relativePath of unchangedPaths) {
      skipped.push({
        path: relativePath,
        reason: "unchanged",
        detail: `not ${changedScope.detail}`,
      });
    }
  }

  // Per-file warnings are held back until the scope has finished dropping files, so a warning
  // about a file the snapshot does not contain never reaches the manifest.
  for (const warning of fileWarnings) warnings.push(warning.message);

  if (changedScope !== null && files.length === 0) {
    warnings.push(
      `No file is ${changedScope.detail}, so the snapshot is empty. ` +
        "Check the ref, or run without --changed-since to scan the whole repository."
    );
  }

  // One warning per encoding class, not per file: a repository with 400 Latin-1 files must not
  // produce 400 warnings that bury everything else.
  const encodingBuckets = new Map<TextEncoding, { paths: string[]; invalidBytes: number }>();
  for (const note of encodingNotes) {
    const bucket = encodingBuckets.get(note.encoding) ?? { paths: [], invalidBytes: 0 };
    bucket.paths.push(note.path);
    bucket.invalidBytes += note.invalidBytes;
    encodingBuckets.set(note.encoding, bucket);
  }
  const ENCODING_PATHS_SHOWN = 5;
  if (previewSummaryPaths.length > 0) {
    const shown = previewSummaryPaths
      .slice(0, ENCODING_PATHS_SHOWN)
      .map((entry) => maskPathText(entry, config.secretRules));
    const hidden = previewSummaryPaths.length - ENCODING_PATHS_SHOWN;
    warnings.push(
      `${previewSummaryPaths.length} file(s) are emitted as head/tail previews and were not parsed for a ` +
        `structural summary: ${shown.join(", ")}${hidden > 0 ? ` and ${hidden} more` : ""}. ` +
        "A whole-file summary would describe lines the snapshot does not carry; `explain <path>` names the preview budget."
    );
  }
  if (oversizeSummaryPaths.length > 0) {
    const shown = oversizeSummaryPaths
      .slice(0, ENCODING_PATHS_SHOWN)
      .map((entry) => maskPathText(entry, config.secretRules));
    const hidden = oversizeSummaryPaths.length - ENCODING_PATHS_SHOWN;
    warnings.push(
      `${oversizeSummaryPaths.length} file(s) exceed ${Math.round(SUMMARY_MAX_SOURCE_BYTES / (1024 * 1024))} MB and were not parsed for a structural summary: ` +
        `${shown.join(", ")}${hidden > 0 ? ` and ${hidden} more` : ""}. Their bodies are emitted as head/tail previews.`
    );
  }
  for (const [encoding, bucket] of encodingBuckets) {
    const maskedPaths = bucket.paths.map((entry) => maskPathText(entry, config.secretRules));
    const shown = maskedPaths.slice(0, ENCODING_PATHS_SHOWN).join(", ");
    const hidden = maskedPaths.length - ENCODING_PATHS_SHOWN;
    const listing = hidden > 0 ? `${shown} and ${hidden} more` : shown;
    if (encoding === "utf-8-lossy") {
      warnings.push(
        `${bucket.paths.length} file(s) are not valid UTF-8; ${bucket.invalidBytes} undecodable byte(s) became U+FFFD: ${listing}.`
      );
    } else {
      warnings.push(
        `${bucket.paths.length} file(s) are ${encoding.toUpperCase()} and were transcoded to UTF-8: ${listing}.`
      );
    }
  }

  // The fingerprint identifies the snapshot a reader is handed, so it hashes the resolved
  // settings as well as the files. Hashing the files alone made two runs with different part
  // budgets (or preview thresholds, redaction rules, artifact selection) share a fingerprint
  // while their bytes differed — the manifest then said "same content" about two different
  // artifact sets. `configDigest` is the one canonical digest of every setting that changes
  // what is written (it canonicalises per-layer budget and rule order, so it is stable for
  // unchanged settings), and folding it in keeps the value a sha256. It is a trailing line so
  // the file list stays shaped as it was; it also means a truncated part does not move the
  // fingerprint, because this is still computed before partitioning.
  //
  // The per-file line deliberately omits `inclusionMode`: the partitioner can change a file's
  // mode after this point (a body clipped by the part budget becomes `preview`), so including it
  // made the value impossible to reproduce from the manifest `validate` reads. The mode is a
  // function of the file list, the file's size and the settings, all of which are already here —
  // and `validate` can now recompute the fingerprint instead of trusting its shape.
  const fingerprint = sha256Hex(
    [
      ...files.map(
        (file) => `${file.relativePath}:${file.hashSha256}:${file.sizeBytes}`
      ),
      `settings:${configDigest(config)}`,
    ].join("\n")
  );

  // Built before partitioning: the partitioner overwrites `file.content` when it
  // byte-truncates a section. Large files take their full body from
  // `monolithBodies` — their `content` is the parts preview, and a monolith made
  // of previews was not the codebase it claimed to contain.
  //
  // Only when a monolith was asked for. This map held a reference to every file's pre-partition
  // body on every run, including the 99 % that wrote no monolith: once the partitioner replaced
  // `file.content` with a truncated string, the multi-megabyte original stayed reachable here and
  // could not be collected. The two strings are the same object when nothing truncates them, so
  // the map cost a pointer per file — and pinned the expensive case exactly.
  const fullContents = new Map<string, string>();
  if (config.includeMonolith) {
    for (const file of files) {
      fullContents.set(
        file.relativePath,
        monolithBodies.get(file.relativePath) ?? file.content ?? ""
      );
    }
  }

  const parts = partitionByBudget(files, config, fingerprint);
  // Byte-budget truncation happens inside the partitioner, so preview counts
  // must be derived from the final state of `files`, not from the scan loop.
  const truncatedPreviewCount = files.filter((file) => file.isPreviewTruncated).length;
  const validationErrors = verifyInMemory(files, parts);

  const totalContentBytes = files.reduce((total, file) => total + file.includedBytes, 0);

  // Config values are recorded in the manifest so `validate` can detect drift,
  // and they can themselves contain a credential-shaped string (an exclude
  // pattern, a layer name). The manifest is an artifact, so they are masked.
  const maskName = (value: string): string => maskPathText(value, config.secretRules);

  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generator: {
      name: GENERATOR_NAME,
      version: GENERATOR_VERSION,
    },
    // A branch name is user input and can carry a token: it reaches the manifest,
    // the README and the audit report.
    git: { ...gitInfo, branch: maskPathText(gitInfo.branch, config.secretRules) },
    budgets: {
      maxPartBytes: config.maxPartBytes,
      largeFileBytes: config.largeFileBytes,
    },
    config: {
      digest: configDigest(config),
      maxPartBytes: config.maxPartBytes,
      // The ceiling the user named, in their own unit. `maxPartBytes` above is what the
      // partitioner enforced; both are recorded so the manifest can explain the gap.
      ...(config.maxPartTokens === undefined ? {} : { maxPartTokens: config.maxPartTokens }),
      largeFileBytes: config.largeFileBytes,
      previewHeadLines: config.previewHeadLines,
      previewTailLines: config.previewTailLines,
      includeMonolith: config.includeMonolith,
      // A ceiling that decides whether `full-codebase.*` is written at all, so it belongs
      // in the record of what the run enforced. Omitting it left `--max-monolith-bytes`
      // invisible in the manifest that is supposed to describe the run.
      maxMonolithBytes: config.maxMonolithBytes ?? null,
      includeSensitiveFiles: config.includeSensitiveFiles,
      discovery: config.discovery ?? "auto",
      // A changed-files scope decides which files are in the snapshot, so the manifest that
      // describes the run has to name it.
      ...(config.changedSince === undefined ? {} : { changedSince: config.changedSince }),
      ...(config.staged === true ? { staged: true } : {}),
      ...(config.withDependents === true ? { withDependents: true } : {}),
      ...(config.skeleton === true ? { skeleton: true } : {}),
      ...(config.sarif === true ? { sarif: true } : {}),
      artifacts: { ...config.artifacts },
      include: [...config.include].map(maskName),
      preset: config.preset,
      layersMode: config.layersMode,
      budgets: {
        default: config.budgets.default,
        byLayer: Object.fromEntries(
          Object.entries(config.budgets.byLayer).map(([name, bytes]) => [maskName(name), bytes])
        ),
      },
      excludePatterns: [...config.excludePatterns].map(maskName),
      layers: config.layers.map((layer) => maskName(layer.name)),
      kinds: config.kinds.map((kind) => maskName(kind.kind)),
    },
    counts: {
      totalFiles: files.length,
      totalSizeBytes,
      totalLines,
      partsCount: parts.length,
      skippedCount: skipped.length,
      largeFileCount,
      truncatedPreviewCount,
    },
    totals: {
      candidateFiles: files.length + skipped.length,
      includedFiles: files.length,
      fullFiles: files.filter((file) => !file.isPreviewTruncated).length,
      previewFiles: files.filter((file) => file.isPreviewTruncated).length,
      skippedFiles: skipped.length,
      totalSourceBytes: totalSizeBytes,
      totalContentBytes,
      sourceLines: totalLines,
      emittedLines: files.reduce((total, file) => total + file.includedLines, 0),
      // The parts are what a model is handed, so the estimate is over the parts rather than
      // over the sources: previews and the byte budget both shrink the number.
      estimatedTokens: parts.reduce((total, part) => total + part.metadata.estimatedTokens, 0),
      partCount: parts.length,
      warningCount: 0,
      redactedLines: 0,
    },
    fingerprint,
    validation: {
      status: validationErrors.length === 0 ? "passed" : "failed",
      errors: validationErrors,
    },
    artifacts: {
      fullJson: null,
      fullMarkdown: null,
    },
    layers: layerCounts,
    kinds: kindCounts,
    indexes: buildIndexes(files, tsconfigPathsFor(config.cwd)),
    parts: parts.map((part) => part.metadata),
    files: files.map((file) => {
      const { content: _content, ...rest } = file;
      return rest;
    }),
    skipped: maskSkipRecords(skipped, config.secretRules),
    warnings,
  };

  // Redaction is not a warning. Every masked line used to be appended to `warnings` as
  // `<rule> at <path>:<line>`, so a repository with nothing wrong with it reported
  // `Warnings: 156` — twice per line, because one line can match two rules — and the CLI's
  // ten-row preview looked like a truncated list of problems. The count is its own total and
  // the per-line detail lives in `reports/audit.md`, where an auditor looks for it.
  manifest.totals.redactedLines = secretFindings.length;
  manifest.totals.warningCount = manifest.warnings.length;

  // Reported here, where the truncation counts exist: the configuration alone is not enough to
  // justify a warning (see `budgetOrderCutsFiles`).
  if (budgetOrderCutsFiles()) {
    manifest.warnings.push(
      `maxPartBytes (${config.maxPartBytes} B) is below largeFileBytes (${config.largeFileBytes} B), ` +
        "so files cut by the part budget are not marked as large previews. " +
        "Increase maxPartBytes or lower largeFileBytes."
    );
    manifest.totals.warningCount = manifest.warnings.length;
  }

  // A preview threshold at or below the part budget means a file that would fit in one part is
  // still emitted as head/tail only. That is the 0.9.16 report's 252 KB route module: 121 of 6,731
  // lines, with `maxPartBytes` and `largeFileBytes` set to the same number. Naming the two
  // settings is actionable; silently previewing is not.
  if (
    files.some((file) => file.isPreviewTruncated) &&
    config.largeFileBytes <= config.maxPartBytes
  ) {
    manifest.warnings.push(
      `${files.filter((file) => file.isPreviewTruncated).length} file(s) were previewed because ` +
        `largeFileBytes (${config.largeFileBytes} B) is not above maxPartBytes ` +
        `(${config.maxPartBytes} B). Raise largeFileBytes if a whole file is wanted.`
    );
    manifest.totals.warningCount = manifest.warnings.length;
  }

  // A token budget is converted to bytes at 4 bytes/token, and the partitioner enforces only the
  // byte ceiling. The estimate can still exceed the number the user named, so say so: presenting
  // an estimate as a guarantee was the defect, not the estimate itself.
  if (config.maxPartTokens !== undefined) {
    const overTokenBudget = parts.filter(
      (part) => part.metadata.estimatedTokens > (config.maxPartTokens ?? 0)
    );
    if (overTokenBudget.length > 0) {
      manifest.warnings.push(
        `${overTokenBudget.length} part(s) exceed the estimated token ceiling of ` +
          `${config.maxPartTokens}: the partitioner enforces the equivalent byte budget ` +
          "(" +
          "tokens × 4), and estimatedTokens is an estimate, not a hard bound."
      );
      manifest.totals.warningCount = manifest.warnings.length;
    }
  }

  // The per-line detail lives only in `reports/audit.md`. With that artifact disabled the count
  // would be the only trace left, so the manifest says so instead of losing it silently.
  if (secretFindings.length > 0 && !config.artifacts.audit) {
    manifest.warnings.push(
      `${secretFindings.length} line(s) contain redacted values; reports/audit.md is disabled, so the ` +
        "per-line detail was not written."
    );
    manifest.totals.warningCount = manifest.warnings.length;
  }

  for (const message of artifactWarnings(config.artifacts, config.sarif === true)) {
    manifest.warnings.push(message);
  }
  manifest.totals.warningCount = manifest.warnings.length;

  // The project tree is depth-capped (src/generator/tree.ts). When the cap bit, the
  // artifact carries the marker but a reader of the manifest learns nothing, so the
  // truncation is also a warning. Built here — before the monolith embeds this
  // manifest — so both views agree.
  let projectTree: string | null = null;
  if (config.artifacts.projectTree) {
    projectTree = generateProjectTree(files.map((file) => file.relativePath));
    const depthMarker = /\[tree truncated at (\d+) levels\]/.exec(projectTree);
    if (depthMarker) {
      manifest.warnings.push(
        `reports/project-tree.md was truncated at the ${depthMarker[1]}-level depth cap: ` +
          "deeper directories are not listed there."
      );
      manifest.totals.warningCount = manifest.warnings.length;
    }
  }

  // The SARIF log is rendered here — before the monolith embeds this manifest — and written
  // later, once staging exists. It used to be built in the write phase, so with
  // `--include-monolith --sarif` the manifest inside `full-codebase.json` had no
  // `artifacts.sarif` while the shipped `manifest.json` did: two copies of one document that
  // disagreed about what the run produced.
  const sarifText =
    config.sarif === true
      ? generateSarifReport(manifest, secretFindings, config.secretRules, GENERATOR_VERSION)
      : null;
  if (sarifText !== null) {
    manifest.artifacts.sarif = {
      byteSize: Buffer.byteLength(sarifText, "utf8"),
      sha256: sha256Hex(sarifText),
    };
  }

  /**
   * The digest of one artifact's exact text.
   *
   * Recorded before the manifest is serialised, so `validate` can require the README, the
   * navigation index, the project tree and the audit report to exist and match. Only the
   * monoliths and SARIF were recorded before, so deleting any of these four left `validate`
   * green — for the first files a reader opens.
   */
  const artifacts = config.artifacts;
  const artifactRecord = (text: string): ManifestArtifact => ({
    byteSize: Buffer.byteLength(text, "utf8"),
    sha256: sha256Hex(text),
  });

  // Rendered before the monolith so the manifest it embeds already records them. None of these
  // four depends on the monolith's own bytes, only on the file/part lists that are final here.
  const navigationText = artifacts.navigation ? generateNavigation(manifest) : null;
  if (navigationText !== null) manifest.artifacts.navigation = artifactRecord(navigationText);
  const auditText = artifacts.audit
    ? generateAuditReport(manifest, secretFindings, config.secretRules)
    : null;
  if (auditText !== null) manifest.artifacts.audit = artifactRecord(auditText);
  const readmeText = artifacts.readme ? generateReadme(manifest, artifacts) : null;
  if (readmeText !== null) manifest.artifacts.readme = artifactRecord(readmeText);
  if (projectTree !== null) manifest.artifacts.projectTree = artifactRecord(projectTree);

  // Monolith artefacts are serialised LAST, after every warning they have to
  // describe and after the markdown digest they embed, so the manifest inside
  // full-codebase.json agrees with the shipped one. The JSON cannot record its own
  // sha256 (a file containing its own digest has no fixed point), so its embedded
  // copy keeps `artifacts.fullJson: null`; the shipped manifest records the real
  // digest and both files are written from these exact strings.
  let monolithJson: string | null = null;
  let monolithMarkdown: string | null = null;
  if (config.includeMonolith) {
    // Built from the pre-partition contents so the monolith really is the whole
    // codebase, not whatever survived the per-part byte budget. A file that the
    // parts carry as a head/tail preview is emitted in full here, and its
    // inclusion fields describe what this artifact actually contains.
    const fullFiles: FileEntry[] = files.map((file) => {
      const content = fullContents.get(file.relativePath) ?? "";
      return {
        ...file,
        content,
        inclusionMode: "full",
        isPreviewTruncated: false,
        includedBytes: Buffer.byteLength(content, "utf8"),
        includedLines: countLines(content),
      };
    });

    // A body that already exceeds the ceiling cannot fit once headers and escaping are added,
    // so refusing from `includedBytes` avoids building the whole string first. The exact check
    // below still runs for every body that might fit: this only short-circuits the impossible.
    const bodyBytes = fullFiles.reduce((total, file) => total + file.includedBytes, 0);
    const definitelyTooLarge =
      config.maxMonolithBytes !== null && bodyBytes > config.maxMonolithBytes;
    if (definitelyTooLarge) {
      // One warning per artifact, with the same prefixes as the exact check below, so the reason
      // a reader looks for does not change just because the decision was made before serialising.
      const reason =
        `their bodies total ${bodyBytes} B, which already exceeds ` +
        `maxMonolithBytes ${config.maxMonolithBytes ?? 0} B`;
      manifest.warnings.push(`full-codebase.md skipped: ${reason}`);
      manifest.warnings.push(`full-codebase.json skipped: ${reason}`);
    }

    const markdown = definitelyTooLarge ? null : generateMonolithMarkdown(manifest, fullFiles);
    const markdownBytes = markdown === null ? 0 : Buffer.byteLength(markdown, "utf8");
    if (markdown !== null && (!config.maxMonolithBytes || markdownBytes <= config.maxMonolithBytes)) {
      monolithMarkdown = markdown;
      manifest.artifacts.fullMarkdown = {
        byteSize: markdownBytes,
        sha256: sha256Hex(markdown),
      };
    } else if (!definitelyTooLarge) {
      manifest.warnings.push(
        `full-codebase.md skipped: ${markdownBytes} B exceeds maxMonolithBytes ${config.maxMonolithBytes} B`
      );
    }
    manifest.totals.warningCount = manifest.warnings.length;

    // Last: the JSON embeds the manifest, so it now carries the markdown digest and
    // every warning produced above (artifact warnings, monolith skips).
    const json = definitelyTooLarge ? null : generateMonolithJson(manifest, fullFiles);
    const jsonBytes = json === null ? 0 : Buffer.byteLength(json, "utf8");
    if (json !== null && (!config.maxMonolithBytes || jsonBytes <= config.maxMonolithBytes)) {
      monolithJson = json;
      manifest.artifacts.fullJson = { byteSize: jsonBytes, sha256: sha256Hex(json) };
    } else if (!definitelyTooLarge) {
      manifest.warnings.push(
        `full-codebase.json skipped: ${jsonBytes} B exceeds maxMonolithBytes ${config.maxMonolithBytes} B`
      );
    }
    manifest.totals.warningCount = manifest.warnings.length;
  }

  const { outDir, tmpDir } = resolveSafeOutputDirs(config);

  // The guards run for a dry run too: a dry run exists to predict the real one,
  // and it used to exit 0 with "Would write 1 part(s)" for an outDir the real
  // run refused.
  assertReplaceable(outDir, "outDir", config.secretRules);
  assertStagingRootUsable(tmpDir, config.secretRules);

  if (dryRun) {
    // "Dry run — nothing was written" has to be literally true: the hook can write
    // files and delete parts, and it used to run anyway.
    return manifest;
  }

  // Serialise runs that share this staging root *before* staging is touched.
  // The key is `tmpDir`, not `outDir`: two runs with different `outDir`s used to
  // take different locks and then delete each other's staging files.
  // Two runs with different tmpDirs but the same outDir used to take different locks
  // and both exit 0, the loser's snapshot silently gone. Lock both, in sorted order.
  const lockKeys = Array.from(new Set([tmpDir, outDir])).sort();
  const releases: Array<() => void> = [];
  try {
    for (const key of lockKeys) releases.push(acquireRunLock(key));
  } catch (error) {
    // A run refused by the second lock must not keep the first: the leftover names
    // this live pid, so the next run refuses it too instead of reclaiming it as stale.
    for (const release of [...releases].reverse()) release();
    throw error;
  }
  const releaseLock = (): void => {
    // A copy: `reverse()` on the array itself reordered the list of locks this run
    // holds, which is the kind of state that turns a second `finally` into a bug.
    for (const release of [...releases].reverse()) release();
  };

  // Only now that no other run can be mid-swap is a missing `outDir` with one backup
  // unambiguous: it is a run that died, not a run that is working. The re-check that follows is
  // the one that matters — it validates what recovery put back instead of trusting the marker.
  recoverInterruptedPublish(outDir);
  assertReplaceable(outDir, "outDir", config.secretRules);
  let stagingDir: string | null = null;
  /**
   * When an async hook is running, the lock is released when *it* settles rather than here.
   *
   * `generateSnapshot` is synchronous and returns while the hook is still pending. Releasing the
   * lock at that point let a second run publish into the same output directory, and the first
   * run's slow hook could then append to, or delete from, a snapshot it no longer owned. Holding
   * the lock until the hook settles makes the two runs serialise; the heartbeat (FS-06) keeps a
   * hung hook from wedging the directory forever.
   */
  let releaseDeferred = false;

  try {
    ensureParentDirectory(outDir, "outDir");

    fs.mkdirSync(tmpDir, { recursive: true });
    cleanStaleRunDirs(tmpDir);

    const snapshotId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    // Unique per run, so two runs can never share a staging path even if one
    // holds a stale lock.
    stagingDir = path.join(tmpDir, `${RUN_DIR_PREFIX}${process.pid}-${snapshotId.slice(0, 8)}`);
    fs.mkdirSync(stagingDir);
    // Written before any artifact: if this run dies mid-write, the leftover
    // staging directory is still provably ours and may be cleared next time.
    writeOwnershipMarker(stagingDir, {
      generator: GENERATOR_NAME,
      version: GENERATOR_VERSION,
      schemaVersion: SCHEMA_VERSION,
      createdAt,
      state: "staging",
      id: snapshotId,
      pid: process.pid,
    });

    const partsDir = path.join(stagingDir, "parts");
    const reportsDir = path.join(stagingDir, "reports");
    if (artifacts.parts) fs.mkdirSync(partsDir, { recursive: true });
    if (artifacts.navigation || artifacts.projectTree || artifacts.audit || config.sarif === true) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    /**
     * Writes one artifact and records what the ownership marker will need.
     *
     * The marker used to walk the finished snapshot and re-read every file it had just written,
     * once for staging and again after an `afterGenerate` hook — two or three whole-snapshot
     * reads for bytes still in memory. Recording the digest here makes the marker's inventory
     * O(artifacts); the walk still catches anything a hook added.
     */
    const writtenArtifacts: WrittenLedger = new Map();
    const writeArtifact = (targetDir: string, relativeEntry: string, data: string): void => {
      const full = path.join(targetDir, ...relativeEntry.split("/"));
      fs.writeFileSync(full, data, "utf8");
      const stats = fs.statSync(full);
      writtenArtifacts.set(relativeEntry, {
        digest: { path: relativeEntry, bytes: stats.size, sha256: sha256Hex(data) },
        mtimeMs: stats.mtimeMs,
      });
    };
    /** Re-records a file that was written by another helper (the post-hook manifest). */
    const recordArtifact = (targetDir: string, relativeEntry: string): void => {
      const full = path.join(targetDir, ...relativeEntry.split("/"));
      const stats = fs.statSync(full);
      writtenArtifacts.set(relativeEntry, {
        digest: {
          path: relativeEntry,
          bytes: stats.size,
          sha256: sha256Hex(fs.readFileSync(full)),
        },
        mtimeMs: stats.mtimeMs,
      });
    };

    if (artifacts.parts) {
      for (const part of parts) {
        writeArtifact(partsDir, part.filename, part.markdown);
      }
    }

    if (projectTree !== null) {
      writeArtifact(reportsDir, "project-tree.md", projectTree);
    }
    if (navigationText !== null) {
      writeArtifact(reportsDir, "navigation.md", navigationText);
    }
    if (auditText !== null) {
      writeArtifact(reportsDir, "audit.md", auditText);
    }
    if (sarifText !== null) {
      // Written beside audit.md rather than instead of it: a human reads one and a CI gate
      // reads the other, and asking which one you want is a false choice.
      writeArtifact(reportsDir, "audit.sarif", sarifText);
    }
    if (readmeText !== null) {
      writeArtifact(stagingDir, "README.md", readmeText);
    }
    if (artifacts.manifest) {
      writeArtifact(stagingDir, "manifest.json", JSON.stringify(manifest, null, 2));
    }

    if (monolithJson !== null) {
      writeArtifact(stagingDir, "full-codebase.json", monolithJson);
    }
    if (monolithMarkdown !== null) {
      writeArtifact(stagingDir, "full-codebase.md", monolithMarkdown);
    }

    // The snapshot is whole in staging: record its inventory and manifest digest
    // before the swap, so a crash right after the swap still leaves a directory
    // the next run can prove it wrote.
    writeOwnershipMarker(
      stagingDir,
      markerPayload(stagingDir, "complete", snapshotId, createdAt, writtenArtifacts)
    );

    swapIntoPlace(stagingDir, outDir, () => assertReplaceable(outDir, "outDir", config.secretRules));
    // The rename consumed the staging directory; there is nothing left to clean.
    stagingDir = null;

    const warningsBeforeHook = manifest.warnings.length;
    const pendingHook = runAfterGenerate(config, manifest);

    // The hook runs against the finished snapshot and may write its own
    // artifacts. A warning it produced can only reach the shipped manifest by
    // writing that manifest again — atomically, so a crash cannot truncate it.
    // The marker is rewritten after the hook for the same reason: its inventory
    // must include what the hook added, or the next run refuses the directory.
    const shipHookState = (): void => {
      // A hook outlives the lock: the run's own lock is released when this function returns, so
      // by the time a slow async hook settles another `generate` may have replaced the directory.
      // Writing this run's marker over that one would attach the wrong inventory to somebody
      // else's snapshot — so the marker is only re-shipped while it still records *this* run.
      if (!markerBelongsTo(outDir, snapshotId)) return;
      if (artifacts.manifest && manifest.warnings.length !== warningsBeforeHook) {
        writeManifestAtomically(path.join(outDir, "manifest.json"), manifest);
        recordArtifact(outDir, "manifest.json");
      }
      writeOwnershipMarker(
        outDir,
        markerPayload(outDir, "complete", snapshotId, createdAt, writtenArtifacts)
      );
    };
    // With no hook, nothing after the swap can add a file or a warning, and the staging
    // marker already records this directory's exact inventory — skip a second full digest
    // pass over the snapshot.
    if (config.hooks.afterGenerate) shipHookState();

    if (pendingHook) {
      // An async hook is still running when this function returns. Two things have to happen when
      // it settles, and only the second one was wired up before:
      //
      // - **Success**: re-ship the marker. Its inventory is read from the directory, so it must
      //   be taken *after* the hook has written whatever it writes. `docs/configuration.md`
      //   documents writing a custom artifact from an `afterGenerate` hook, and doing that from
      //   an async hook left the file out of `.codebase-snapshot` — so the very next `generate`
      //   refused the directory with "Refusing to replace outDir", because the directory held
      //   something the marker did not account for. The re-ship also picks up a warning the hook
      //   pushed without failing.
      // - **Failure**: record it as a warning and re-ship, so a rejection never becomes an
      //   unhandled rejection that kills the process after "Snapshot generated … Integrity:
      //   passed" has already been printed.
      const tracked = pendingHook
        .then(
          () => {
            try {
              shipHookState();
            } catch {
              // The snapshot is already written and correct; a bookkeeping rewrite that fails must
              // not turn a successful run into a crash. The next run re-creates the marker.
            }
          },
          (err: unknown) => {
            // Hook messages are user code and can quote a credential; mask before it
            // becomes a warning in the manifest and on stdout.
            const message = maskPathText(
              err instanceof Error ? err.message : String(err),
              config.secretRules
            );
            manifest.warnings.push(`hooks.afterGenerate failed: ${message}`);
            manifest.totals.warningCount = manifest.warnings.length;
            try {
              shipHookState();
            } catch {
              // The run already succeeded and the failure is recorded in memory; a write error here
              // must not turn a warning into a crash.
            }
          }
        )
        // Removed when it settles, not only when `generateSnapshotAsync` consumes it: a synchronous
        // caller never consumes it, so this map kept one settled promise per output directory for
        // the life of the process. The identity check keeps a newer run's entry from being dropped
        // by an older run that settles later.
        .finally(() => {
          if (pendingHooks.get(outDir) === tracked) pendingHooks.delete(outDir);
        });
      pendingHooks.set(outDir, tracked);
      // The hook owns this run's lock now; the outer `finally` must not release it early.
      releaseDeferred = true;
      void tracked.finally(() => {
        removeIfEmpty(tmpDir);
        releaseLock();
      });
    }

    return manifest;
  } catch (err) {
    if (stagingDir !== null) {
      // Nothing this run staged may survive a failure. The staging directory is
      // this run's own (`run-<pid>-<id>`), so clearing it cannot touch another
      // run's files.
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // The original failure is the one worth reporting.
      }
    }
    throw err;
  } finally {
    // Remove the staging container when this run left nothing in it; an async hook releases the
    // lock itself when it settles, so that no other run can publish over its writes.
    if (!releaseDeferred) {
      removeIfEmpty(tmpDir);
      releaseLock();
    }
  }
}

/**
 * `hooks.afterGenerate` promises still running, keyed by the output directory they write into.
 *
 * `generateSnapshot` is synchronous and cannot await them; `generateSnapshotAsync` can, and
 * should: a caller that awaited the async form used to get control back while the hook was still
 * writing files into the snapshot it had just been told was finished.
 */
/**
 * `hooks.afterGenerate` promises still running, keyed by the output directory they write into.
 *
 * `generateSnapshot` is synchronous and cannot await them; `generateSnapshotAsync` can, and
 * should: a caller that awaited the async form used to get control back while the hook was still
 * writing files into the snapshot it had just been told was finished.
 *
 * The entry is removed when the hook settles, not only when `generateSnapshotAsync` consumes it. A
 * synchronous caller never consumed it, so a long-lived process kept one settled promise per output
 * directory forever. The guard on the delete keeps a newer run's entry from being removed by an
 * older run that happened to settle later.
 */
const pendingHooks = new Map<string, Promise<unknown>>();

/** Promise-returning wrapper for consumers that prefer an async call site. */
export async function generateSnapshotAsync(
  configInput?: SnapshotConfig | ResolvedSnapshotConfig | null,
  options?: GenerateOptions
): Promise<Manifest> {
  // Resolved once, and the resolved object is what `generateSnapshot` generates from. The previous
  // form resolved the input a second time after generating, purely to learn `outDir` — two full
  // preset detections and config normalisations per call, and a second chance for the two
  // answers to differ.
  assertUsableConfigInput(configInput);
  const config = isResolvedConfig(configInput)
    ? normalizeResolvedConfig(configInput)
    : resolveConfig((configInput as SnapshotConfig | null | undefined) ?? null);
  const manifest = generateSnapshot(config, options);
  const { outDir } = resolveSafeOutputDirs(config);
  const pending = pendingHooks.get(outDir);
  if (pending !== undefined) {
    // A rejection is not rethrown: the snapshot is written, and the failure is recorded in
    // `manifest.warnings` exactly as it is for the synchronous caller. Throwing here would make
    // a *successful* generation look like a failed one.
    await pending.catch(() => undefined);
  }
  return manifest;
}

export {
  defineConfig,
  validateSnapshot,
  resolveConfig,
  loadConfigFile,
  detectPreset,
  getPreset,
  listPresetNames,
  scanAndRedactSecrets,
  detectLanguage,
  isBinaryExtension,
  isBinaryBuffer,
  isBinaryFile,
  decodeText,
  countInvalidUtf8Bytes,
  truncatePreview,
  partitionFiles,
  generateProjectTree,
  summarizeJson,
  summarizeMarkdown,
  summarizeTypeScriptSource,
  anchorForPath,
  countLines,
};

export { DEFAULT_SECRET_PATTERNS } from "./security/patterns.js";
export { explainPath, renderExplainText } from "./explain.js";
export type { ExplainResult } from "./explain.js";
export { compareManifests, loadManifest, renderDiffText } from "./diff.js";
export type { ManifestDiff } from "./diff.js";
export { stripJsonComments } from "./ast/structured.js";
export { appendGitignoreEntries, gitignorePath } from "./gitignore.js";
export { runInit } from "./wizard/init.js";
export type { InitDependency, InitOptions, InitResult } from "./wizard/init.js";
export {
  firstRunMessage,
  hasPriorSnapshot,
  isEffectivelyEmpty,
  planFirstRun,
} from "./wizard/autopilot.js";
export type { FirstRunFacts, FirstRunPlan, FirstRunRefusal } from "./wizard/autopilot.js";
export { DEFAULT_ANSWERS, renderConfig } from "./wizard/config-template.js";
export type { WizardAnswers } from "./wizard/config-template.js";
export {
  PromptBack,
  PromptCancelled,
  displayWidth,
  isInteractive,
  wrapLines,
} from "./wizard/prompts.js";
export { PRESETS } from "./presets/index.js";
export { LANGUAGE_PROFILES, profileForPath, summarizeWithProfile } from "./ast/profiles/index.js";
export type { HeuristicResult, LanguageProfile } from "./ast/profiles/index.js";
export { enforceBudget, renumberParts, displayPath } from "./partitioner/chunker.js";
export {
  collectFiles,
  findSecretInPath,
  getGitInfo,
  isSensitivePath,
  matchesExclude,
  globToRegExp,
} from "./scanner/files.js";
export {
  ARTIFACT_NAMES,
  classifyKind,
  classifyLayer,
  configDigest,
  loadConfigFileDetailed,
  parseByteSize,
  supportsTypeScriptImports,
  matchRule,
  markResolvedConfig,
  isResolvedConfig,
  MIN_MAX_PART_BYTES,
  MIN_MAX_PART_TOKENS,
  CONFIG_KEYS,
  normalizeResolvedConfig,
  assertUsableConfigInput,
} from "./config.js";
export { truncateToBytes } from "./partitioner/preview.js";
export { estimateTokens, bytesForTokens, formatTokens } from "./tokenize.js";
export { HOOK_MARKER, installPreCommitHook } from "./agent/hook.js";
export type { HookInstallResult } from "./agent/hook.js";
export { resolveChangedScope } from "./scanner/changed.js";
// The import graph moved to its own module so `explain` and `validate` can apply the same
// `--with-dependents` hop the generator applies; it stays on the public surface from here.
export {
  buildImportResolver,
  importsChangedFile,
  resolveSpecifier,
  tsconfigPathsFor,
} from "./scanner/dependents.js";
export type { ImportCandidate, ImportResolver } from "./scanner/dependents.js";
export { importsOfFile, importsOfText } from "./ast/imports.js";
export { isSkeletonizable, isTsxFileName, skeletonizeTypeScript } from "./ast/skeleton.js";
export { generateSarifReport } from "./generator/sarif.js";
export { workerEntry } from "./mcp/generate-worker.js";
export type { ChangedScope, ChangedScopeRequest } from "./scanner/changed.js";
export { fenceForContent, fenceForText } from "./partitioner/chunker.js";

export type * from "./types.js";
