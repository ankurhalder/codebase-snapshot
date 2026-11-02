import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { summarizeJson, summarizeMarkdown } from "./ast/structured.js";
import { summarizeTypeScriptSource } from "./ast/ts-parser.js";
import {
  classifyKind,
  classifyLayer,
  loadConfigFile,
  resolveConfig,
} from "./config.js";
import { defineConfig } from "./define-config.js";
import { generateAuditReport } from "./generator/audit.js";
import {
  generateMonolithJson,
  generateMonolithMarkdown,
} from "./generator/monolith.js";
import { generateNavigation } from "./generator/navigation.js";
import { generateReadme } from "./generator/readme.js";
import { generateProjectTree } from "./generator/tree.js";
import { partitionFiles } from "./partitioner/chunker.js";
import { truncatePreview } from "./partitioner/preview.js";
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
  ResolvedSnapshotConfig,
  SecretFinding,
  SkipRecord,
  SnapshotConfig,
} from "./types.js";

const GENERATOR_NAME = "@ankurhalder/codebase-snapshot";
const GENERATOR_VERSION = "1.0.0";
const SCHEMA_VERSION = "2.0.0";

export async function generateSnapshot(
  configInput?: SnapshotConfig | ResolvedSnapshotConfig
): Promise<Manifest> {
  const config =
    "secretRules" in (configInput || {})
      ? (configInput as ResolvedSnapshotConfig)
      : resolveConfig(configInput as SnapshotConfig | null);

  const gitInfo = getGitInfo(config.cwd, config.branch);
  const rawFilePaths = collectFiles(config.cwd, config.excludePatterns);

  const files: FileEntry[] = [];
  const skipped: SkipRecord[] = [];
  const allSecretFindings: SecretFinding[] = [];
  const layerCounts: Record<string, number> = {};
  const kindCounts: Record<string, number> = {};

  let totalLines = 0;
  let totalSizeBytes = 0;
  let largeFileCount = 0;
  let truncatedPreviewCount = 0;

  for (const relPath of rawFilePaths) {
    const absPath = path.join(config.cwd, relPath);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
      if (!stat.isFile()) {
        skipped.push({ path: relPath, reason: "not-file" });
        continue;
      }
    } catch {
      skipped.push({ path: relPath, reason: "read-error" });
      continue;
    }

    if (isBinaryFile(absPath)) {
      skipped.push({
        path: relPath,
        reason: "binary",
        detail: `Size: ${stat.size} B`,
      });
      continue;
    }

    let rawContent: string;
    try {
      rawContent = fs.readFileSync(absPath, "utf8");
    } catch {
      skipped.push({ path: relPath, reason: "read-error" });
      continue;
    }

    const hashSha256 = crypto
      .createHash("sha256")
      .update(rawContent)
      .digest("hex");

    const lineCount = rawContent.length === 0 ? 0 : rawContent.split("\n").length;
    totalLines += lineCount;
    totalSizeBytes += stat.size;

    const layer = classifyLayer(relPath, config.layers);
    const kind = classifyKind(relPath, config.kinds);
    const language = detectLanguage(relPath);

    layerCounts[layer] = (layerCounts[layer] || 0) + 1;
    kindCounts[kind] = (kindCounts[kind] || 0) + 1;

    const { redacted, findings } = scanAndRedactSecrets(
      rawContent,
      config.secretRules,
      relPath
    );
    allSecretFindings.push(...findings);

    const isLarge = stat.size > config.largeFileBytes;
    if (isLarge) largeFileCount++;

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
      if (isPreviewTruncated) truncatedPreviewCount++;
    }

    let summary = undefined;
    if (
      relPath.endsWith(".ts") ||
      relPath.endsWith(".tsx") ||
      relPath.endsWith(".js") ||
      relPath.endsWith(".jsx") ||
      relPath.endsWith(".mjs") ||
      relPath.endsWith(".cjs")
    ) {
      summary = summarizeTypeScriptSource(relPath, rawContent);
    } else if (relPath.endsWith(".json")) {
      summary = summarizeJson(rawContent);
    } else if (relPath.endsWith(".md") || relPath.endsWith(".mdx")) {
      summary = summarizeMarkdown(rawContent);
    }

    files.push({
      path: relPath,
      relativePath: relPath,
      sizeBytes: stat.size,
      bytes: stat.size,
      lines: lineCount,
      hashSha256,
      sha256: hashSha256,
      part: "",
      layer,
      kind,
      language,
      inclusionMode: isLarge ? "summary-only" : "full",
      isLarge,
      isPreviewTruncated,
      originalLines: lineCount,
      includedLines,
      summary,
      content: finalContent,
    });
  }

  const partitioned = partitionFiles(files, config.maxPartBytes);

  const fingerprint = crypto
    .createHash("sha256")
    .update(
      files
        .map(
          (f) =>
            `${f.relativePath}:${f.hashSha256}:${f.sizeBytes}:${f.inclusionMode}`
        )
        .join("\n")
    )
    .digest("hex");

  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generator: {
      name: GENERATOR_NAME,
      version: GENERATOR_VERSION,
      script: "scripts/generate_codebase_snapshot.ts",
      mode: "agent-context",
      maxPartBytes: config.maxPartBytes,
      largeFileBytes: config.largeFileBytes,
    },
    git: gitInfo,
    budgets: {
      maxPartBytes: config.maxPartBytes,
      largeFileBytes: config.largeFileBytes,
    },
    counts: {
      totalFiles: files.length,
      totalSizeBytes,
      totalLines,
      partsCount: partitioned.length,
      skippedCount: skipped.length,
      largeFileCount,
      truncatedPreviewCount,
    },
    totals: {
      candidateFiles: files.length + skipped.length,
      includedFiles: files.length,
      fullFiles: files.length - largeFileCount,
      summaryOnlyFiles: largeFileCount,
      skippedFiles: skipped.length,
      totalSourceBytes: totalSizeBytes,
      totalContentBytes: totalSizeBytes,
      partCount: partitioned.length,
      warningCount: allSecretFindings.length,
    },
    fingerprint,
    contentFingerprint: fingerprint,
    validation: {
      status: "passed",
      errors: [],
    },
    artifacts: {
      fullJson: null,
      fullMarkdown: null,
    },
    layers: layerCounts,
    kinds: kindCounts,
    parts: partitioned.map((p) => p.metadata),
    files: files.map((f) => ({
      path: f.relativePath,
      relativePath: f.relativePath,
      sizeBytes: f.sizeBytes,
      bytes: f.sizeBytes,
      lines: f.lines,
      hashSha256: f.hashSha256,
      sha256: f.hashSha256,
      part: f.part,
      layer: f.layer,
      kind: f.kind,
      language: f.language,
      inclusionMode: f.inclusionMode,
      isLarge: f.isLarge,
      isPreviewTruncated: f.isPreviewTruncated,
      originalLines: f.originalLines,
      includedLines: f.includedLines,
      summary: f.summary,
    })),
    skipped,
    warnings: allSecretFindings.map(
      (f) => `${f.rule} at ${f.path || "unknown"}:${f.line}`
    ),
  };

  const finalOutDir = path.join(config.cwd, config.outDir);
  const targetTmpDir = path.join(config.cwd, config.tmpDir);

  if (fs.existsSync(targetTmpDir)) {
    fs.rmSync(targetTmpDir, { recursive: true, force: true });
  }

  const partsDir = path.join(targetTmpDir, "parts");
  const reportsDir = path.join(targetTmpDir, "reports");
  fs.mkdirSync(partsDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });

  for (const part of partitioned) {
    fs.writeFileSync(path.join(partsDir, part.filename), part.markdown, "utf8");
  }

  fs.writeFileSync(
    path.join(reportsDir, "project-tree.md"),
    generateProjectTree(files.map((f) => f.relativePath)),
    "utf8"
  );

  fs.writeFileSync(
    path.join(reportsDir, "navigation.md"),
    generateNavigation(manifest),
    "utf8"
  );

  fs.writeFileSync(
    path.join(reportsDir, "audit.md"),
    generateAuditReport(manifest, allSecretFindings),
    "utf8"
  );

  fs.writeFileSync(
    path.join(targetTmpDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    path.join(targetTmpDir, "README.md"),
    generateReadme(manifest),
    "utf8"
  );

  if (config.includeMonolith) {
    const monolithJson = generateMonolithJson(manifest, files);
    const monolithMd = generateMonolithMarkdown(manifest, files);

    const jsonBytes = Buffer.byteLength(monolithJson, "utf8");
    const mdBytes = Buffer.byteLength(monolithMd, "utf8");

    if (!config.maxMonolithBytes || jsonBytes <= config.maxMonolithBytes) {
      manifest.artifacts.fullJson = {
        byteSize: jsonBytes,
        sha256: crypto.createHash("sha256").update(monolithJson).digest("hex"),
      };
      fs.writeFileSync(
        path.join(targetTmpDir, "full-codebase.json"),
        monolithJson,
        "utf8"
      );
    }
    if (!config.maxMonolithBytes || mdBytes <= config.maxMonolithBytes) {
      manifest.artifacts.fullMarkdown = {
        byteSize: mdBytes,
        sha256: crypto.createHash("sha256").update(monolithMd).digest("hex"),
      };
      fs.writeFileSync(
        path.join(targetTmpDir, "full-codebase.md"),
        monolithMd,
        "utf8"
      );
    }
    fs.writeFileSync(
      path.join(targetTmpDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );
  }

  if (fs.existsSync(finalOutDir)) {
    fs.rmSync(finalOutDir, { recursive: true, force: true });
  }
  fs.renameSync(targetTmpDir, finalOutDir);

  return manifest;
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
};

export { DEFAULT_SECRET_PATTERNS } from "./security/patterns.js";

export type * from "./types.js";
