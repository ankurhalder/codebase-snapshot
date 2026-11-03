import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { summarizeJson, summarizeMarkdown } from "./ast/structured.js";
import { summarizeTypeScriptSource } from "./ast/ts-parser.js";
import {
  assertUsableConfigInput,
  classifyKind,
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
import { anchorForPath, partitionFiles } from "./partitioner/chunker.js";
import { countLines, truncatePreview } from "./partitioner/preview.js";
import { detectPreset } from "./presets/index.js";
import {
  isBinaryBuffer,
  isBinaryExtension,
  isBinaryFile,
} from "./scanner/binary.js";
import { collectFiles, getGitInfo } from "./scanner/files.js";
import { detectLanguage } from "./scanner/language.js";
import { scanAndRedactSecrets } from "./security/redact.js";
import { validateSnapshot } from "./validator/validate.js";
import type {
  FileEntry,
  Manifest,
  ManifestIndexes,
  ResolvedSnapshotConfig,
  SecretFinding,
  SkipRecord,
  SnapshotConfig,
  SourceSummary,
} from "./types.js";

export const GENERATOR_NAME = "@ankurhalder/codebase-snapshot";
export const GENERATOR_VERSION = "2.0.0";
export const SCHEMA_VERSION = "3.0.0";


function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export interface GenerateOptions {
  /** Compute the full manifest but write nothing to disk. */
  dryRun?: boolean;
}

const SUMMARY_EXTENSIONS = [
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
];

function summarizeFile(
  relativePath: string,
  redactedContent: string
): FileEntry["summary"] | undefined {
  const lower = relativePath.toLowerCase();
  if (!SUMMARY_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return undefined;
  }
  if (lower.endsWith(".json") || lower.endsWith(".jsonc")) {
    return summarizeJson(redactedContent);
  }
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) {
    return summarizeMarkdown(redactedContent);
  }
  // Summaries are built from the REDACTED text: a secret inside a Markdown
  // heading used to be masked in the body but emitted verbatim in the summary.
  return summarizeTypeScriptSource(relativePath, redactedContent);
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
  "",
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

/** Best-effort resolution of a relative import to an included file. */
function resolveSpecifier(
  fromFile: string,
  specifier: string,
  knownFiles: Set<string>
): string | null {
  if (!RELATIVE_SPECIFIER.test(specifier)) return null;
  const baseDir = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(path.posix.join(baseDir, specifier));
  const candidate = joined.replace(/\.(?:js|mjs|cjs|jsx)$/, "");
  for (const suffix of IMPORT_CANDIDATE_SUFFIXES) {
    const withSuffix = `${joined}${suffix}`;
    if (knownFiles.has(withSuffix)) return withSuffix;
  }
  const extensionSwap = new RegExp(`${candidate}\\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$`);
  for (const file of knownFiles) {
    if (extensionSwap.test(file)) return file;
  }
  return null;
}

function buildIndexes(files: FileEntry[]): ManifestIndexes {
  const knownFiles = new Set(files.map((file) => file.relativePath));
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
      const resolved = resolveSpecifier(entry.path, specifier, knownFiles);
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
 * Moves `tmpDir` into place, keeping the previous output until the new one is
 * fully in place. Falls back to a recursive copy across devices (EXDEV).
 */
function swapIntoPlace(tmpDir: string, outDir: string): void {
  const backupDir = `${outDir}.backup-${process.pid}-${Date.now()}`;
  const hadPrevious = fs.existsSync(outDir);

  if (hadPrevious) fs.renameSync(outDir, backupDir);

  try {
    try {
      fs.renameSync(tmpDir, outDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        fs.cpSync(tmpDir, outDir, { recursive: true });
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } else {
        throw err;
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
    excludePatterns: config.excludePatterns,
    includeSensitiveFiles: config.includeSensitiveFiles,
  });

  const files: FileEntry[] = [];
  const skipped: SkipRecord[] = [...collection.skipped];
  const secretFindings: SecretFinding[] = [];
  const warnings: string[] = [];
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

    // One read, one hash domain: the validator hashes the raw buffer too, so a
    // file with invalid UTF-8 no longer produces unfixable phantom drift.
    const hashSha256 = sha256Hex(buffer);
    const rawContent = buffer.toString("utf8");
    const lineCount = countLines(rawContent);

    totalLines += lineCount;
    totalSizeBytes += stats.size;

    const layer = classifyLayer(relativePath, config.layers);
    const kind = classifyKind(relativePath, config.kinds);
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

    let summary: FileEntry["summary"];
    try {
      summary = summarizeFile(relativePath, redacted);
    } catch (err) {
      // A single pathological file used to abort the whole run.
      warnings.push(
        `Summary skipped for ${relativePath}: ${(err as Error).message}`.replace(/\s+/g, " ")
      );
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
      content: finalContent,
    });
  }

  const fingerprint = sha256Hex(
    files
      .map(
        (file) =>
          `${file.relativePath}:${file.hashSha256}:${file.sizeBytes}:${file.inclusionMode}`
      )
      .join("\n")
  );

  const parts = partitionFiles(files, config.maxPartBytes, fingerprint);
  // Byte-budget truncation happens inside the partitioner, so preview counts
  // must be derived from the final state of `files`, not from the scan loop.
  const truncatedPreviewCount = files.filter((file) => file.isPreviewTruncated).length;
  const validationErrors = verifyInMemory(files, parts, config.maxPartBytes);

  const totalContentBytes = files.reduce((total, file) => total + file.includedBytes, 0);

  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generator: {
      name: GENERATOR_NAME,
      version: GENERATOR_VERSION,
    },
    git: gitInfo,
    budgets: {
      maxPartBytes: config.maxPartBytes,
      largeFileBytes: config.largeFileBytes,
    },
    config: {
      maxPartBytes: config.maxPartBytes,
      largeFileBytes: config.largeFileBytes,
      previewHeadLines: config.previewHeadLines,
      previewTailLines: config.previewTailLines,
      includeMonolith: config.includeMonolith,
      includeSensitiveFiles: config.includeSensitiveFiles,
      excludePatterns: [...config.excludePatterns],
      layers: config.layers.map((layer) => layer.name),
      kinds: config.kinds.map((kind) => kind.kind),
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
    skipped,
    warnings,
  };

  manifest.warnings = [
    ...warnings,
    ...secretFindings.map((finding) => `${finding.rule} at ${finding.path ?? "unknown"}:${finding.line}`),
  ];
  manifest.totals.warningCount = manifest.warnings.length;

  // Monolith artefacts are computed BEFORE the manifest is serialized, so the
  // manifest is written exactly once and already contains the artifact digests.
  let monolithJson: string | null = null;
  let monolithMarkdown: string | null = null;
  if (config.includeMonolith) {
    const json = generateMonolithJson(manifest, files);
    const markdown = generateMonolithMarkdown(manifest, files);
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

  if (dryRun) return manifest;

  const { outDir, tmpDir } = resolveSafeOutputDirs(config);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  const partsDir = path.join(tmpDir, "parts");
  const reportsDir = path.join(tmpDir, "reports");
  fs.mkdirSync(partsDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });

  for (const part of parts) {
    fs.writeFileSync(path.join(partsDir, part.filename), part.markdown, "utf8");
  }

  const projectTree = generateProjectTree(files.map((file) => file.relativePath));
  fs.writeFileSync(path.join(reportsDir, "project-tree.md"), projectTree, "utf8");
  fs.writeFileSync(path.join(reportsDir, "navigation.md"), generateNavigation(manifest), "utf8");
  fs.writeFileSync(path.join(reportsDir, "audit.md"), generateAuditReport(manifest, secretFindings), "utf8");
  fs.writeFileSync(path.join(tmpDir, "README.md"), generateReadme(manifest), "utf8");
  fs.writeFileSync(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  if (monolithJson !== null) {
    fs.writeFileSync(path.join(tmpDir, "full-codebase.json"), monolithJson, "utf8");
  }
  if (monolithMarkdown !== null) {
    fs.writeFileSync(path.join(tmpDir, "full-codebase.md"), monolithMarkdown, "utf8");
  }

  swapIntoPlace(tmpDir, outDir);

  return manifest;
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
  scanAndRedactSecrets,
  detectLanguage,
  isBinaryExtension,
  isBinaryBuffer,
  isBinaryFile,
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
export { collectFiles, isSensitivePath, matchesExclude, globToRegExp } from "./scanner/files.js";
export {
  loadConfigFileDetailed,
  supportsTypeScriptImports,
  matchRule,
  markResolvedConfig,
  isResolvedConfig,
  MIN_MAX_PART_BYTES,
  normalizeResolvedConfig,
  assertUsableConfigInput,
} from "./config.js";
export { truncateToBytes } from "./partitioner/preview.js";
export { fenceForContent } from "./partitioner/chunker.js";

export type * from "./types.js";
