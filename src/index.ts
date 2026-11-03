import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { summarizeWithProfile } from "./ast/profiles/index.js";
import { summarizeJson, summarizeMarkdown } from "./ast/structured.js";
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
import { generateMonolithJson, generateMonolithMarkdown } from "./generator/monolith.js";
import { generateNavigation } from "./generator/navigation.js";
import { generateReadme } from "./generator/readme.js";
import { generateProjectTree } from "./generator/tree.js";
import { anchorForPath, partitionFiles, renumberParts } from "./partitioner/chunker.js";
import type { PartitionedPart } from "./partitioner/chunker.js";
import { countLines, truncatePreview } from "./partitioner/preview.js";
import { detectPreset, getPreset, listPresetNames } from "./presets/index.js";
import {
  countInvalidUtf8Bytes,
  decodeText,
  isBinaryBuffer,
  isBinaryExtension,
  isBinaryFile,
} from "./scanner/binary.js";
import { collectFiles, findSecretInPath, getGitInfo, maskSkipPaths } from "./scanner/files.js";
import { detectLanguage } from "./scanner/language.js";
import { scanAndRedactSecrets } from "./security/redact.js";
import { validateSnapshot } from "./validator/validate.js";
import type {
  FileEntry,
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

export const GENERATOR_NAME = "@ankurhalder/codebase-snapshot";
export const GENERATOR_VERSION = "4.0.9";
export const SCHEMA_VERSION = "3.0.0";

/**
 * Files larger than this are not parsed for a structural summary.
 *
 * The parser's AST costs far more than the text it reads — a 50 MB source file peaked at 3.3 GB
 * resident — and a file this large is emitted as a head/tail preview, so a summary of it would
 * describe something the snapshot does not contain. Two megabytes is well above every hand-written
 * source file and below the point where parsing becomes the dominant cost.
 */
const SUMMARY_MAX_SOURCE_CHARS = 2 * 1024 * 1024;


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

type LayerOrKindCounts = Record<string, number>;

function bump(counts: LayerOrKindCounts, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

const RELATIVE_SPECIFIER = /^\.{1,2}\//;
const IMPORT_CANDIDATE_SUFFIXES = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.mjs",
];

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/**
 * One-pass lookup tables for relative-import resolution.
 *
 * `resolveSpecifier` used to fall back to scanning every known file for every
 * unresolved import — 100k files × 100k imports — and built a RegExp from the
 * candidate path, so a directory named `[unmatched` aborted the run and `[id]`
 * matched unrelated files. Both are gone: every candidate is a map lookup, and
 * no path is ever used as a pattern.
 */
interface ImportResolver {
  byPath: Map<string, string>;
  byPathFolded: Map<string, string>;
  byStem: Map<string, string>;
  byStemFolded: Map<string, string>;
}

function buildImportResolver(files: FileEntry[]): ImportResolver {
  const byPath = new Map<string, string>();
  const byPathFolded = new Map<string, string>();
  const byStem = new Map<string, string>();
  const byStemFolded = new Map<string, string>();
  // First writer wins, so ambiguity resolves to the lexicographically first
  // path (the scanner hands files over sorted) and stays deterministic.
  const remember = (map: Map<string, string>, key: string, value: string): void => {
    if (!map.has(key)) map.set(key, value);
  };

  for (const file of files) {
    const relativePath = file.relativePath;
    remember(byPath, relativePath, relativePath);
    remember(byPathFolded, relativePath.toLowerCase(), relativePath);

    const extension = path.posix.extname(relativePath);
    if (!SOURCE_EXTENSIONS.has(extension)) continue;
    const stem = relativePath.slice(0, -extension.length);
    remember(byStem, stem, relativePath);
    remember(byStemFolded, stem.toLowerCase(), relativePath);
    // `import "./dir"` resolves to `dir/index.ts`.
    if (path.posix.basename(stem) === "index") {
      const directory = path.posix.dirname(stem);
      remember(byStem, directory, relativePath);
      remember(byStemFolded, directory.toLowerCase(), relativePath);
    }
  }

  return { byPath, byPathFolded, byStem, byStemFolded };
}

/** Best-effort resolution of a relative import to an included file. */
function resolveSpecifier(
  fromFile: string,
  specifier: string,
  resolver: ImportResolver
): string | null {
  if (!RELATIVE_SPECIFIER.test(specifier)) return null;
  const joined = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier)
  );

  const exact = (key: string): string | null =>
    resolver.byPath.get(key) ?? resolver.byPathFolded.get(key.toLowerCase()) ?? null;

  const direct = exact(joined);
  if (direct) return direct;

  for (const suffix of IMPORT_CANDIDATE_SUFFIXES) {
    const hit = exact(`${joined}${suffix}`);
    if (hit) return hit;
  }

  // An extensionless import (`./x`), a directory import (`./dir` → index), or a
  // TypeScript-style `./x.js` that actually lives in `./x.ts`.
  const stem = joined.replace(/\.(?:js|mjs|cjs|jsx)$/, "");
  const byStem = (key: string): string | null =>
    resolver.byStem.get(key) ?? resolver.byStemFolded.get(key.toLowerCase()) ?? null;
  return byStem(joined) ?? byStem(stem);
}

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
  parts: ReturnType<typeof partitionFiles>,
  maxPartBytes: number
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
    if (actualBytes > maxPartBytes) {
      errors.push(`${part.filename} (${actualBytes} B) exceeds the part budget of ${maxPartBytes} B.`);
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
  if (candidate.generator !== GENERATOR_NAME) {
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
  if (typeof generator !== "object" || generator === null || generator.name !== GENERATOR_NAME) {
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
  const key = lockKeyFor(stagingRoot);
  const lockPath = path.join(os.tmpdir(), `codebase-snapshot-${key}.lock`);
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

/** True only when the lock names a pid that certainly no longer exists. */
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
    return false;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "ESRCH";
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
function artifactWarnings(artifacts: ResolvedArtifacts): string[] {
  const messages: string[] = [];
  if (!artifacts.manifest) {
    messages.push("manifest.json is disabled: `validate` and `report` cannot inspect this snapshot.");
  }
  if (!artifacts.parts && artifacts.navigation) {
    messages.push(
      "parts are disabled but navigation.md is enabled: its links point at part files that were not written."
    );
  }
  if (ARTIFACT_NAMES.every((name) => artifacts[name] === false)) {
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
 *    line from a hook in `--format json` mode produced a document no parser could read. Everything
 *    a hook writes to stdout is redirected to stderr for the duration of the call.
 *  - **a returned promise is tracked, never awaited.** This is a synchronous API, so the promise
 *    cannot be awaited here; the caller attaches a rejection handler, which records the failure as
 *    a warning and re-ships the manifest and marker. Left alone, a rejected async hook became an
 *    unhandled rejection that killed the process *after* it had printed "Snapshot generated …
 *    Integrity: passed" and written its JSON payload.
 */
function runAfterGenerate(config: ResolvedSnapshotConfig, manifest: Manifest): Promise<unknown> | null {
  const hook = config.hooks.afterGenerate;
  if (!hook) return null;

  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  let returned: unknown;

  try {
    process.stdout.write = stderrWrite as typeof process.stdout.write;
    returned = hook(manifest);
  } catch (err) {
    manifest.warnings.push(`hooks.afterGenerate failed: ${(err as Error).message}`);
    manifest.totals.warningCount = manifest.warnings.length;
    return null;
  } finally {
    process.stdout.write = stdoutWrite;
  }

  const thenable = returned as { then?: unknown } | null | undefined;
  if (!thenable || typeof thenable.then !== "function") return null;
  return Promise.resolve(returned);
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
    // The output and staging directories this run is about to write, relative to the root. A
    // first run cannot have marked them yet, so the name alone keeps a run from recording its own
    // output — but only at these exact paths, not at every directory that shares the name.
    toolOwnedPaths: [config.outDir, config.tmpDir]
      .map((directory) =>
        path.relative(config.cwd, path.resolve(config.cwd, directory)).replace(/\\/g, "/")
      )
      .filter((relative) => relative.length > 0 && !relative.startsWith("..")),
  });

  const files: FileEntry[] = [];
  /** Full redacted bodies of large files, kept for the monolith only. */
  const monolithBodies = new Map<string, string>();
  const skipped: SkipRecord[] = maskSkipRecords([...collection.skipped], config.secretRules);
  const secretFindings: SecretFinding[] = [];
  const warnings: string[] = [];
  /** Files that were not plain UTF-8, grouped into one warning after the scan. */
  const encodingNotes: { path: string; encoding: TextEncoding; invalidBytes: number }[] = [];
  /** Files too large to parse for a structural summary, grouped into one warning after the scan. */
  const oversizeSummaryPaths: string[] = [];
  const layerCounts: LayerOrKindCounts = {};
  const kindCounts: LayerOrKindCounts = {};

  let totalLines = 0;
  let totalSizeBytes = 0;
  let largeFileCount = 0;

  for (const relativePath of collection.files) {
    const absolutePath = path.join(config.cwd, relativePath);

    let stats: fs.Stats;
    try {
      stats = fs.statSync(absolutePath);
      if (!stats.isFile()) {
        skipped.push({ path: relativePath, reason: "not-file" });
        continue;
      }
    } catch {
      skipped.push({ path: relativePath, reason: "read-error" });
      continue;
    }

    if (isBinaryFile(absolutePath)) {
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
    const decoded = decodeText(buffer);
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

    if (isLarge) {
      const preview = truncatePreview(
        redacted,
        config.previewHeadLines,
        config.previewTailLines
      );
      finalContent = preview.content;
      isPreviewTruncated = preview.isTruncated;
      includedLines = preview.includedLines;
    }

    // `file.content` is deliberately the head/tail preview, but the monolith is
    // documented as the whole repository. Keep the full *redacted* body here so
    // `full-codebase.*` cannot inherit the preview; only pay that memory cost
    // when a monolith was actually requested.
    if (config.includeMonolith && isPreviewTruncated) {
      monolithBodies.set(relativePath, redacted);
    }

    let summary: FileEntry["summary"];
    let summaryQuality: SummaryQuality | undefined;
    if (rawContent.length > SUMMARY_MAX_SOURCE_CHARS) {
      // A structural summary of a file this size costs far more memory than the file itself — the
      // TypeScript parser builds an AST whose nodes dwarf the text, and a 50 MB source file peaked
      // at 3.3 GB RSS. The body is a head/tail preview at this size anyway, so the summary would
      // describe a file the snapshot does not contain. Recorded, never silent.
      oversizeSummaryPaths.push(relativePath);
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
          warnings.push(
            `Parse errors in ${maskPathText(relativePath, config.secretRules)} (${summary.parseErrors}); its summary is incomplete.`
          );
        }
      } catch (err) {
        // A single pathological file used to abort the whole run.
        warnings.push(
          `Summary skipped for ${maskPathText(relativePath, config.secretRules)}: ${(err as Error).message}`.replace(/\s+/g, " ")
        );
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
      inclusionMode: isPreviewTruncated ? "preview" : "full",
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
  if (oversizeSummaryPaths.length > 0) {
    const shown = oversizeSummaryPaths
      .slice(0, ENCODING_PATHS_SHOWN)
      .map((entry) => maskPathText(entry, config.secretRules));
    const hidden = oversizeSummaryPaths.length - ENCODING_PATHS_SHOWN;
    warnings.push(
      `${oversizeSummaryPaths.length} file(s) exceed ${Math.round(SUMMARY_MAX_SOURCE_CHARS / (1024 * 1024))} MB and were not parsed for a structural summary: ` +
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
  const maxEffectiveBudget = Math.max(
    config.maxPartBytes,
    config.budgets.default,
    ...Object.values(config.budgets.byLayer)
  );
  // Byte-budget truncation happens inside the partitioner, so preview counts
  // must be derived from the final state of `files`, not from the scan loop.
  const truncatedPreviewCount = files.filter((file) => file.isPreviewTruncated).length;
  const validationErrors = verifyInMemory(files, parts, maxEffectiveBudget);

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
      largeFileBytes: config.largeFileBytes,
      previewHeadLines: config.previewHeadLines,
      previewTailLines: config.previewTailLines,
      includeMonolith: config.includeMonolith,
      includeSensitiveFiles: config.includeSensitiveFiles,
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
      partCount: parts.length,
      warningCount: 0,
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

  manifest.warnings = [
    ...warnings,
    ...secretFindings.map((finding) => `${finding.rule} at ${maskPathText(finding.path ?? "unknown", config.secretRules)}:${finding.line}`),
  ];
  manifest.totals.warningCount = manifest.warnings.length;

  // Monolith artefacts are computed BEFORE the manifest is serialized, so the
  // manifest is written exactly once and already contains the artifact digests.
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
    const json = generateMonolithJson(manifest, fullFiles);
    const markdown = generateMonolithMarkdown(manifest, fullFiles);
    const jsonBytes = Buffer.byteLength(json, "utf8");
    const markdownBytes = Buffer.byteLength(markdown, "utf8");

    if (!config.maxMonolithBytes || jsonBytes <= config.maxMonolithBytes) {
      monolithJson = json;
      manifest.artifacts.fullJson = { byteSize: jsonBytes, sha256: sha256Hex(json) };
    } else {
      manifest.warnings.push(
        `full-codebase.json skipped: ${jsonBytes} B exceeds maxMonolithBytes ${config.maxMonolithBytes} B`
      );
    }
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
  }

  for (const message of artifactWarnings(config.artifacts)) manifest.warnings.push(message);
  manifest.totals.warningCount = manifest.warnings.length;

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
    for (const release of releases.reverse()) release();
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
    if (artifacts.navigation || artifacts.projectTree || artifacts.audit) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    if (artifacts.parts) {
      for (const part of parts) {
        fs.writeFileSync(path.join(partsDir, part.filename), part.markdown, "utf8");
      }
    }

    if (artifacts.projectTree) {
      const projectTree = generateProjectTree(files.map((file) => file.relativePath));
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
    if (artifacts.readme) {
      fs.writeFileSync(path.join(stagingDir, "README.md"), generateReadme(manifest), "utf8");
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
      if (artifacts.manifest && manifest.warnings.length !== warningsBeforeHook) {
        writeManifestAtomically(path.join(outDir, "manifest.json"), manifest);
      }
      writeOwnershipMarker(outDir, markerPayload(outDir, "complete", snapshotId, createdAt));
    };
    shipHookState();

    if (pendingHook) {
      // The hook is still running. A rejection cannot be awaited from here, so it is recorded and
      // re-shipped when it lands — never left to become an unhandled rejection.
      pendingHook.catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        manifest.warnings.push(`hooks.afterGenerate failed: ${message}`);
        manifest.totals.warningCount = manifest.warnings.length;
        try {
          shipHookState();
        } catch {
          // The run already succeeded and the failure is recorded in memory; a write error here
          // must not turn a warning into a crash.
        }
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
    // Remove the staging container when this run left nothing in it.
    removeIfEmpty(tmpDir);
    releaseLock();
  }
}

/** Promise-returning wrapper for consumers that prefer an async call site. */
export async function generateSnapshotAsync(
  configInput?: SnapshotConfig | ResolvedSnapshotConfig | null,
  options?: GenerateOptions
): Promise<Manifest> {
  return generateSnapshot(configInput, options);
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
export type { InitOptions, InitResult } from "./wizard/init.js";
export { DEFAULT_ANSWERS, renderConfig, renderMinimalConfig } from "./wizard/config-template.js";
export type { WizardAnswers } from "./wizard/config-template.js";
export { PromptCancelled, isInteractive } from "./wizard/prompts.js";
export { PRESETS } from "./presets/index.js";
export { LANGUAGE_PROFILES, profileForPath, summarizeWithProfile } from "./ast/profiles/index.js";
export type { HeuristicResult, LanguageProfile } from "./ast/profiles/index.js";
export { renumberParts } from "./partitioner/chunker.js";
export { collectFiles, isSensitivePath, matchesExclude, globToRegExp } from "./scanner/files.js";
export {
  ARTIFACT_NAMES,
  loadConfigFileDetailed,
  parseByteSize,
  supportsTypeScriptImports,
  matchRule,
  markResolvedConfig,
  isResolvedConfig,
  MIN_MAX_PART_BYTES,
  normalizeResolvedConfig,
  assertUsableConfigInput,
} from "./config.js";
export { truncateToBytes } from "./partitioner/preview.js";
export { fenceForContent, fenceForText } from "./partitioner/chunker.js";

export type * from "./types.js";
