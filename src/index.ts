import * as crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { profileForPath, summarizeWithProfile } from "./ast/profiles/index.js";
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
import { anchorForPath, partitionFiles, renumberParts } from "./partitioner/chunker.js";
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
import { resolveChangedScope } from "./scanner/changed.js";
import { buildImportResolver, importsChangedFile, resolveSpecifier } from "./scanner/dependents.js";
import { collectFiles, findSecretInPath, getGitInfo, maskSkipPaths } from "./scanner/files.js";
import { detectLanguage } from "./scanner/language.js";
import { scanAndRedactSecrets } from "./security/redact.js";
import { validateSnapshot } from "./validator/validate.js";
import { GENERATOR_NAME, GENERATOR_VERSION, isOurGeneratorName } from "./version.js";
import type {
  FileEntry,
  InclusionMode,
  JsonSummary,
  Manifest,
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

export { GENERATOR_NAME, GENERATOR_VERSION } from "./version.js";
export const SCHEMA_VERSION = "3.0.0";

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
 */
const SUMMARY_MAX_SOURCE_BYTES = 2 * 1024 * 1024;


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

function buildIndexes(files: FileEntry[]): ManifestIndexes {
  const resolver = buildImportResolver(files);
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
}

/** Schema versions whose ownership evidence this build understands. */
const SUPPORTED_MARKER_SCHEMAS = new Set([SCHEMA_VERSION]);

const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Builds the marker payload for `dir` as it stands right now. */
function markerPayload(
  dir: string,
  state: MarkerState,
  id: string,
  createdAt: string
): OwnershipMarker {
  const marker: OwnershipMarker = {
    generator: GENERATOR_NAME,
    version: GENERATOR_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt,
    state,
    id,
    pid: process.pid,
    entries: listEntries(dir),
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
 * Decides whether `dir` is a snapshot this generator wrote and may replace.
 *
 * Ownership needs *consistent* evidence: a marker that parses and names this
 * generator, a run that completed, a manifest whose digest matches the marker,
 * and no entry the recorded inventory does not account for. Any unknown entry
 * means the directory holds something we did not write, whatever the marker says.
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
  if (fs.existsSync(manifestPath)) {
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

  const recorded = new Set(marker.entries ?? []);
  if (recorded.size === 0) {
    return {
      owned: false,
      problem: "its .codebase-snapshot marker records no contents",
      foreignEntries: [],
      marker,
    };
  }

  const foreignEntries = listEntries(dir).filter(
    (entry) => !recorded.has(entry) && !IGNORABLE_ENTRIES.has(entry)
  );
  return {
    owned: foreignEntries.length === 0,
    problem: null,
    foreignEntries,
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

/**
 * Serialises runs that share a staging root.
 *
 * The lock is keyed on the resolved `tmpDir`, not on `outDir`: staging lives
 * under `tmpDir`, so two runs with different `outDir`s used to take different
 * locks and then delete each other's staging files. Runs that share a staging
 * root are serialised; runs with distinct roots proceed independently. The lock
 * lives in the OS temp directory — never inside the repository, where it could
 * be scanned — and records the owning pid so a crashed run's lock does not block
 * forever.
 */
function acquireRunLock(stagingRoot: string): () => void {
  const lockPath = lockPathFor(stagingRoot);
  const payload = `${JSON.stringify({
    pid: process.pid,
    stagingRoot,
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
      return () => {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // A lock that cannot be removed is detected as stale by the next run
          // (dead pid) or reported to the user; the snapshot itself is fine.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (attempt === 0 && lockOwnerIsGone(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      throw new Error(
        `Another generate run is already using the staging directory ${stagingRoot}. Wait for ` +
          `it to finish, or delete ${lockPath} if no other run is active.`
      );
    }
  }

  throw new Error(`Could not acquire the generate lock for ${stagingRoot}.`);
}

/**
 * Stable lock-file key for a staging root.
 *
 * The real path is used when the root exists so `Snapshot.Tmp` and
 * `snapshot.tmp` cannot take different locks on a case-insensitive filesystem.
 */
function lockKeyFor(stagingRoot: string): string {
  let key = stagingRoot;
  try {
    key = fs.realpathSync(stagingRoot);
  } catch {
    // Not created yet: the resolved absolute path is already stable per checkout.
  }
  if (process.platform === "win32" || process.platform === "darwin") key = key.toLowerCase();
  return sha256Hex(key).slice(0, 16);
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

/** True only when the lock names a pid that certainly no longer exists, or is a corpse. */
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
    // and it carries no pid, so nothing could ever prove it dead. The run locked itself
    // out permanently and only deleting the file by hand recovered it. Age is the
    // remaining evidence: a lock older than any plausible run is a corpse.
    return lockFileIsAncient(lockPath);
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return lockFileIsAncient(lockPath);
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * True when the lock file is older than {@link STALE_RUN_MS}.
 *
 * Used only when the lock's contents cannot name an owner: an unreadable payload is not
 * proof of a live run, and treating it as one wedged every later run.
 */
function lockFileIsAncient(lockPath: string): boolean {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > STALE_RUN_MS;
  } catch {
    return false;
  }
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
function swapIntoPlace(stagingDir: string, outDir: string): void {
  ensureParentDirectory(outDir, "outDir");
  const deadline = Date.now() + 3_000;

  for (let attempt = 0; ; attempt += 1) {
    try {
      swapOnce(stagingDir, outDir);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const racy = code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM";
      if (!racy || attempt >= 10 || Date.now() > deadline) throw err;
      sleepSync(50);
    }
  }
}

function swapOnce(stagingDir: string, outDir: string): void {
  const backupDir = `${outDir}.backup-${process.pid}-${Date.now()}`;
  const hadPrevious = fs.existsSync(outDir);

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
    if (hadPrevious) fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (err) {
    // Roll back so the previous snapshot survives a failed swap.
    if (hadPrevious && fs.existsSync(backupDir)) {
      if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
      fs.renameSync(backupDir, outDir);
    }
    throw err;
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
function runAfterGenerate(config: ResolvedSnapshotConfig, manifest: Manifest): Promise<unknown> | null {
  const hook = config.hooks.afterGenerate;
  if (!hook) return null;

  const stdoutWrite = process.stdout.write.bind(process.stdout) as (
    ...args: unknown[]
  ) => boolean;
  const stderrWrite = process.stderr.write.bind(process.stderr) as (
    ...args: unknown[]
  ) => boolean;
  // AsyncLocalStorage tells the hook's writes apart from the caller's without a
  // time window: a continuation after an `await` is still inside `hookScope`,
  // while the payload the CLI prints right after this call is not.
  const hookScope = new AsyncLocalStorage<true>();
  const patchedWrite = ((...args: unknown[]): boolean =>
    hookScope.getStore() === true ? stderrWrite(...args) : stdoutWrite(...args)) as typeof process.stdout.write;
  const restoreStdout = (): void => {
    if (process.stdout.write === patchedWrite) process.stdout.write = stdoutWrite as typeof process.stdout.write;
  };
  let returned: unknown;

  try {
    process.stdout.write = patchedWrite;
    returned = hookScope.run(true, () => hook(manifest));
  } catch (err) {
    restoreStdout();
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
    restoreStdout();
    return null;
  }
  // The patched write stays installed until the hook settles; only writes made in
  // the hook's context are diverted, so the caller's payload is unaffected.
  return Promise.resolve(returned).finally(restoreStdout);
}

/**
 * Partitions files under the configured per-layer budgets.
 *
 * Files sharing an effective budget are packed together. More than one bucket
 * means more than one partition pass, and each pass numbers from `part-001`, so
 * the merged set is re-numbered before it is returned.
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

  if (buckets.size <= 1) {
    const only = buckets.size === 1 ? Array.from(buckets.keys())[0] : config.maxPartBytes;
    return partitionFiles(files, only, fingerprint);
  }

  const parts: PartitionedPart[] = [];
  for (const budget of Array.from(buckets.keys()).sort((a, b) => a - b)) {
    parts.push(...partitionFiles(buckets.get(budget) ?? [], budget, fingerprint));
  }

  const merged = renumberParts(parts, fingerprint);

  // Re-numbering renames the parts, so every file's back-pointer is stale.
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  for (const part of merged) {
    for (const included of part.metadata.includedFiles) {
      const file = byPath.get(included.relativePath);
      if (file) file.part = part.filename;
    }
  }
  return merged;
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
  });

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
  const layerCounts: LayerOrKindCounts = {};
  const kindCounts: LayerOrKindCounts = {};

  let totalLines = 0;
  let totalSizeBytes = 0;
  let largeFileCount = 0;

  for (const relativePath of candidateFiles) {
    const absolutePath = path.join(config.cwd, relativePath);

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
    } catch {
      skipped.push({ path: relativePath, reason: "read-error" });
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

    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(absolutePath);
    } catch {
      skipped.push({ path: relativePath, reason: "read-error" });
      continue;
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
        detail: `Size: ${stats.size} B; could not be decoded: ${(err as Error).message}`.replace(
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
        detail: `Size: ${stats.size} B; ${decoded.binaryReason ?? "binary content"}`,
      });
      continue;
    }

    // One read, one hash domain: the validator hashes the raw buffer too, so a
    // file with invalid UTF-8 no longer produces unfixable phantom drift.
    const hashSha256 = sha256Hex(buffer);
    const rawContent = decoded.text;
    const lineCount = countLines(rawContent);

    totalLines += lineCount;
    totalSizeBytes += stats.size;

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

    const { redacted, findings } = scanAndRedactSecrets(
      rawContent,
      config.secretRules,
      relativePath
    );
    secretFindings.push(...findings);

    const isLarge = stats.size > config.largeFileBytes;
    if (isLarge) largeFileCount += 1;

    let finalContent = redacted;
    let isPreviewTruncated = false;
    let includedLines = lineCount;
    let inclusionMode: InclusionMode = "full";

    // Signature compression comes before the preview decision: a body-less file is small, so
    // previewing it afterwards would throw away the structure this mode exists to keep.
    // The summary is still built from the whole text below, so `exports` and `imports`
    // describe the real file rather than the compressed one.
    if (config.skeleton === true && isSkeletonizable(relativePath)) {
      const skeleton = skeletonizeTypeScript(redacted, relativePath);
      if (skeleton.collapsed > 0) {
        finalContent = skeleton.text;
        inclusionMode = "signatures";
        includedLines = countLines(skeleton.text);
      }
    }

    if (isLarge && inclusionMode !== "signatures") {
      const preview = truncatePreview(
        redacted,
        config.previewHeadLines,
        config.previewTailLines
      );
      finalContent = preview.content;
      isPreviewTruncated = preview.isTruncated;
      includedLines = preview.includedLines;
      inclusionMode = isPreviewTruncated ? "preview" : "full";
    }

    // `file.content` is deliberately whatever the parts carry, but the monolith is documented as
    // the whole repository. Keep the full *redacted* body here so `full-codebase.*` cannot inherit
    // a head/tail preview **or a skeleton** — only pay that memory cost when a monolith was
    // actually requested.
    //
    // The skeleton case is the one that used to lie: `--skeleton --include-monolith` wrote a body
    // without any function bodies into `full-codebase.json` and labelled it
    // `inclusionMode: "full"`, so the monolith claimed to contain code it had deleted.
    if (config.includeMonolith && (isPreviewTruncated || inclusionMode === "signatures")) {
      monolithBodies.set(relativePath, redacted);
    }

    let summary: FileEntry["summary"];
    let summaryQuality: SummaryQuality | undefined;
    // Size first, then preview: a 3 MB file is both, and "exceeds 2 MB" is the more useful of the
    // two true statements — it names the ceiling that kept the run bounded. The preview rule then
    // covers the 200 KB–2 MB band, where the file is small enough to have been parsed before.
    if (Buffer.byteLength(rawContent, "utf8") > SUMMARY_MAX_SOURCE_BYTES) {
      // A structural summary of a file this size costs far more memory than the file itself — the
      // TypeScript parser builds an AST whose nodes dwarf the text, and a 50 MB source file peaked
      // at 3.3 GB RSS. The body is a head/tail preview at this size anyway, so the summary would
      // describe a file the snapshot does not contain. Recorded, never silent.
      oversizeSummaryPaths.push(relativePath);
    } else if (SKIP_PREVIEW_SUMMARIES && isPreviewTruncated && hasStructuralSummary(relativePath)) {
      // The body in the snapshot is a head/tail preview, so a whole-file summary
      // would describe lines no artifact carries. Skipping it is also the single
      // largest cost saving on a big source file: masking tens of thousands of
      // identifiers for a summary the partitioner discards.
      previewSummaryPaths.push(relativePath);
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
          fileWarnings.push({
            path: relativePath,
            message: `Parse errors in ${maskPathText(relativePath, config.secretRules)} (${summary.parseErrors}); its summary is incomplete.`,
          });
        }
      } catch (err) {
        // A single pathological file used to abort the whole run.
        fileWarnings.push({
          path: relativePath,
          message:
            `Summary skipped for ${maskPathText(relativePath, config.secretRules)}: ${(err as Error).message}`.replace(
              /\s+/g,
              " "
            ),
        });
      }
    }

    files.push({
      relativePath,
      sizeBytes: stats.size,
      lines: lineCount,
      hashSha256,
      part: "",
      layer,
      kind,
      language,
      inclusionMode,
      isLarge,
      isPreviewTruncated,
      originalLines: lineCount,
      includedLines,
      includedBytes: Buffer.byteLength(finalContent, "utf8"),
      summary,
      summaryQuality,
      ...(decoded.encoding === "utf-8" ? {} : { encoding: decoded.encoding }),
      content: finalContent,
    });
  }

  // `--with-dependents` can only be decided once every import has been parsed, so its filter
  // stays after the scan — and everything the scan accumulated for a dropped file is undone
  // with it. Totals were recomputed here already; the layer and kind counts, the large-file
  // count, the redaction findings and the warning lists were not, so a two-file snapshot
  // reported the layer distribution and the secret count of the whole repository.
  if (changedScope !== null && changedPaths !== null && config.withDependents === true) {
    const keep = new Set(changedPaths);
    const resolver = buildImportResolver(files);
    // One hop, and only one hop — `importsChangedFile` is the shared test, so `explain` and
    // `validate` answer this question with the same rule the generator applies here.
    for (const file of files) {
      if (!isSourceSummary(file.summary)) continue;
      if (importsChangedFile(file.relativePath, file.summary.imports, changedPaths, resolver)) {
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

  const fingerprint = sha256Hex(
    files
      .map(
        (file) =>
          `${file.relativePath}:${file.hashSha256}:${file.sizeBytes}:${file.inclusionMode}`
      )
      .join("\n")
  );

  // Built before partitioning: the partitioner overwrites `file.content` when it
  // byte-truncates a section. Large files take their full body from
  // `monolithBodies` — their `content` is the parts preview, and a monolith made
  // of previews was not the codebase it claimed to contain.
  const fullContents = new Map<string, string>();
  for (const file of files) {
    fullContents.set(
      file.relativePath,
      monolithBodies.get(file.relativePath) ?? file.content ?? ""
    );
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
    indexes: buildIndexes(files),
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

    const markdown = generateMonolithMarkdown(manifest, fullFiles);
    const markdownBytes = Buffer.byteLength(markdown, "utf8");
    if (!config.maxMonolithBytes || markdownBytes <= config.maxMonolithBytes) {
      monolithMarkdown = markdown;
      manifest.artifacts.fullMarkdown = {
        byteSize: markdownBytes,
        sha256: sha256Hex(markdown),
      };
    } else {
      manifest.warnings.push(
        `full-codebase.md skipped: ${markdownBytes} B exceeds maxMonolithBytes ${config.maxMonolithBytes} B`
      );
    }
    manifest.totals.warningCount = manifest.warnings.length;

    // Last: the JSON embeds the manifest, so it now carries the markdown digest and
    // every warning produced above (artifact warnings, monolith skips).
    const json = generateMonolithJson(manifest, fullFiles);
    const jsonBytes = Buffer.byteLength(json, "utf8");
    if (!config.maxMonolithBytes || jsonBytes <= config.maxMonolithBytes) {
      monolithJson = json;
      manifest.artifacts.fullJson = { byteSize: jsonBytes, sha256: sha256Hex(json) };
    } else {
      manifest.warnings.push(
        `full-codebase.json skipped: ${jsonBytes} B exceeds maxMonolithBytes ${config.maxMonolithBytes} B`
      );
    }
    manifest.totals.warningCount = manifest.warnings.length;
  }

  const { outDir, tmpDir } = resolveSafeOutputDirs(config);
  const { artifacts } = config;

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
  const releases = lockKeys.map((key) => acquireRunLock(key));
  const releaseLock = (): void => {
    // A copy: `reverse()` on the array itself reordered the list of locks this run
    // holds, which is the kind of state that turns a second `finally` into a bug.
    for (const release of [...releases].reverse()) release();
  };
  let stagingDir: string | null = null;

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

    if (artifacts.parts) {
      for (const part of parts) {
        fs.writeFileSync(path.join(partsDir, part.filename), part.markdown, "utf8");
      }
    }

    if (projectTree !== null) {
      fs.writeFileSync(path.join(reportsDir, "project-tree.md"), projectTree, "utf8");
    }
    if (artifacts.navigation) {
      fs.writeFileSync(path.join(reportsDir, "navigation.md"), generateNavigation(manifest), "utf8");
    }
    if (artifacts.audit) {
      fs.writeFileSync(
        path.join(reportsDir, "audit.md"),
        generateAuditReport(manifest, secretFindings, config.secretRules),
        "utf8"
      );
    }
    if (sarifText !== null) {
      // Written beside audit.md rather than instead of it: a human reads one and a CI gate
      // reads the other, and asking which one you want is a false choice.
      fs.writeFileSync(path.join(reportsDir, "audit.sarif"), sarifText, "utf8");
    }
    if (artifacts.readme) {
      fs.writeFileSync(path.join(stagingDir, "README.md"), generateReadme(manifest, artifacts), "utf8");
    }
    if (artifacts.manifest) {
      fs.writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    }

    if (monolithJson !== null) {
      fs.writeFileSync(path.join(stagingDir, "full-codebase.json"), monolithJson, "utf8");
    }
    if (monolithMarkdown !== null) {
      fs.writeFileSync(path.join(stagingDir, "full-codebase.md"), monolithMarkdown, "utf8");
    }

    // The snapshot is whole in staging: record its inventory and manifest digest
    // before the swap, so a crash right after the swap still leaves a directory
    // the next run can prove it wrote.
    writeOwnershipMarker(stagingDir, markerPayload(stagingDir, "complete", snapshotId, createdAt));

    swapIntoPlace(stagingDir, outDir);
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
      }
      writeOwnershipMarker(outDir, markerPayload(outDir, "complete", snapshotId, createdAt));
    };
    shipHookState();

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
      pendingHook.then(
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
      );
      pendingHooks.set(outDir, pendingHook);
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
    // Remove the staging container when this run left nothing in it.
    removeIfEmpty(tmpDir);
    releaseLock();
  }
}

/**
 * `hooks.afterGenerate` promises still running, keyed by the output directory they write into.
 *
 * `generateSnapshot` is synchronous and cannot await them; `generateSnapshotAsync` can, and
 * should: a caller that awaited the async form used to get control back while the hook was still
 * writing files into the snapshot it had just been told was finished.
 */
const pendingHooks = new Map<string, Promise<unknown>>();

/** Promise-returning wrapper for consumers that prefer an async call site. */
export async function generateSnapshotAsync(
  configInput?: SnapshotConfig | ResolvedSnapshotConfig | null,
  options?: GenerateOptions
): Promise<Manifest> {
  const manifest = generateSnapshot(configInput, options);
  const config = isResolvedConfig(configInput)
    ? normalizeResolvedConfig(configInput)
    : resolveConfig((configInput as SnapshotConfig | null | undefined) ?? null);
  const { outDir } = resolveSafeOutputDirs(config);
  const pending = pendingHooks.get(outDir);
  if (pending !== undefined) {
    pendingHooks.delete(outDir);
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
export { buildImportResolver, importsChangedFile, resolveSpecifier } from "./scanner/dependents.js";
export type { ImportCandidate, ImportResolver } from "./scanner/dependents.js";
export { importsOfFile, importsOfText } from "./ast/imports.js";
export { isSkeletonizable, isTsxFileName, skeletonizeTypeScript } from "./ast/skeleton.js";
export { generateSarifReport } from "./generator/sarif.js";
export { workerEntry } from "./mcp/generate-worker.js";
export type { ChangedScope, ChangedScopeRequest } from "./scanner/changed.js";
export { fenceForContent, fenceForText } from "./partitioner/chunker.js";

export type * from "./types.js";
