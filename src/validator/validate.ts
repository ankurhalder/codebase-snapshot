import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ARTIFACT_NAMES,
  assertUsableConfigInput,
  isResolvedConfig,
  normalizeResolvedConfig,
  resolveConfig,
} from "../config.js";
import { collectFiles, findSecretInPath, getGitInfo } from "../scanner/files.js";
import { isBinaryFile } from "../scanner/binary.js";
import type {
  Manifest,
  ResolvedSnapshotConfig,
  SnapshotConfig,
  SecretRule,
  ValidationDrift,
  ValidationResult,
} from "../types.js";

/**
 * Masks one path with the default rules plus the caller's custom rules.
 *
 * Drift lists are printed by `validate` and embedded in `--format json`, so a
 * `deleted: <path>` line must not reproduce a credential-bearing filename.
 * Masking happens only on the way out: matching a record against the filesystem
 * always uses the real path.
 */
function maskedPath(value: string, secretRules: readonly SecretRule[] | undefined): string {
  return findSecretInPath(value, secretRules)?.masked ?? value;
}

function emptyDrift(): ValidationDrift {
  return {
    missingInSnapshot: [],
    missingOnDisk: [],
    hashMismatches: [],
    partIssues: [],
    totalsMismatches: [],
    configMismatches: [],
  };
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * True when a path that was skipped at snapshot time would now be emitted.
 *
 * `collectFiles` has already applied the ignore/exclude/sensitive rules, so the
 * only decision left is the binary check that `generate` performs per file. A
 * skip is a record of that decision, not a permanent exemption: `data.bin` that
 * held NUL bytes then and is plain text now must surface as drift, otherwise
 * `generate` silently adds a file `validate` said was absent.
 */
function wouldNowBeIncluded(cwd: string, relativePath: string): boolean {
  const absolutePath = path.join(cwd, relativePath);
  try {
    if (!fs.statSync(absolutePath).isFile()) return false;
    return !isBinaryFile(absolutePath);
  } catch {
    return false;
  }
}

/**
 * Validates a generated snapshot against the working tree and against the
 * recorded configuration.
 *
 * Beyond source-file hashes this now also:
 * - refuses a manifest that does not have the expected shape (previously threw
 *   an uncaught `TypeError`),
 * - verifies every emitted `parts/*.md` against its recorded `byteSize`/`sha256`
 *   (previously a deleted or corrupted part still reported `valid: true`),
 * - re-checks the effective configuration and the part/file bookkeeping,
 * - verifies monolith artefact digests when present.
 */
export function validateSnapshot(
  configInput: ResolvedSnapshotConfig | SnapshotConfig
): ValidationResult {
  assertUsableConfigInput(configInput);

  const config = isResolvedConfig(configInput)
    ? normalizeResolvedConfig(configInput)
    : resolveConfig(configInput);
  // `path.resolve` so an absolute outDir is not appended to cwd.
  const manifestPath = path.resolve(config.cwd, config.outDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    return {
      valid: false,
      manifestPresent: false,
      drift: emptyDrift(),
      errors: [`Snapshot manifest not found at: ${manifestPath}`],
      warnings: [],
    };
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  } catch (err) {
    return {
      valid: false,
      manifestPresent: true,
      drift: emptyDrift(),
      errors: [`Failed to parse snapshot manifest: ${(err as Error).message}`],
      warnings: [],
    };
  }

  if (
    !manifest ||
    typeof manifest !== "object" ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.skipped) ||
    !Array.isArray(manifest.parts)
  ) {
    return {
      valid: false,
      manifestPresent: true,
      drift: emptyDrift(),
      errors: [
        `${manifestPath} is not a snapshot manifest v3: expected arrays for "files", "skipped" and "parts".`,
      ],
      warnings: [],
    };
  }

  const drift = emptyDrift();
  const warnings: string[] = [];
  const snapshotDir = path.resolve(config.cwd, config.outDir);

  // ---- source files -------------------------------------------------------
  const manifestFileMap = new Map<string, string>();
  for (const file of manifest.files) {
    if (file && typeof file.relativePath === "string") {
      manifestFileMap.set(file.relativePath, file.hashSha256);
    }
  }

  // Paths in the shipped manifest are already masked, so a disk path is matched
  // in both forms: raw (record predates masking) and masked (current records).
  const skippedSet = new Set(
    manifest.skipped.filter((entry) => entry && typeof entry.path === "string").map((entry) => entry.path)
  );
  const isSkippedOnDisk = (diskFile: string): boolean => {
    if (skippedSet.has(diskFile)) return true;
    return skippedSet.has(maskedPath(diskFile, config.secretRules));
  };

  const collection = collectFiles(config.cwd, {
    includePatterns: config.include,
    excludePatterns: [...config.excludePatterns, ...config.presetExclude],
    includeSensitiveFiles: config.includeSensitiveFiles,
    secretRules: config.secretRules,
  });

  for (const diskFile of collection.files) {
    const snapshotHash = manifestFileMap.get(diskFile);
    if (!snapshotHash) {
      // A path in `skipped[]` is not permanently exempt: re-evaluate it and
      // report drift when it would now be included.
      if (isSkippedOnDisk(diskFile) && !wouldNowBeIncluded(config.cwd, diskFile)) continue;
      drift.missingInSnapshot.push(diskFile);
      continue;
    }

    let diskHash: string;
    try {
      diskHash = sha256Hex(fs.readFileSync(path.join(config.cwd, diskFile)));
    } catch {
      drift.missingOnDisk.push(diskFile);
      continue;
    }
    if (diskHash !== snapshotHash) {
      drift.hashMismatches.push({ path: diskFile, diskHash, snapshotHash });
    }
  }

  for (const snapshotFile of manifestFileMap.keys()) {
    if (!fs.existsSync(path.join(config.cwd, snapshotFile))) {
      drift.missingOnDisk.push(snapshotFile);
    }
  }

  // A tracked-but-deleted file is seen by both loops above — the read fails, then
  // it is absent from disk — so it was reported (and counted) twice.
  drift.missingOnDisk = [...new Set(drift.missingOnDisk)];

  // With per-layer budgets the largest legitimate part ceiling is the biggest
  // of them, not `maxPartBytes` alone.
  const maxEffectiveBudget = Math.max(
    config.maxPartBytes,
    config.budgets.default,
    ...Object.values(config.budgets.byLayer)
  );

  // ---- emitted parts ------------------------------------------------------
  // `partNames` is needed for the cross-check below even when parts were
  // deliberately not written, so it is always collected.
  const partNames = new Set<string>();
  for (const part of manifest.parts) {
    if (!part || typeof part.filename !== "string") continue;
    partNames.add(part.filename);

    if (!config.artifacts.parts) continue;

    const partPath = path.join(snapshotDir, "parts", part.filename);
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(partPath);
    } catch {
      drift.partIssues.push({ part: part.filename, issue: "missing from snapshot/parts" });
      continue;
    }
    if (buffer.length !== part.byteSize) {
      drift.partIssues.push({
        part: part.filename,
        issue: `byteSize is ${part.byteSize} in the manifest but ${buffer.length} on disk`,
      });
    }
    if (sha256Hex(buffer) !== part.sha256) {
      drift.partIssues.push({ part: part.filename, issue: "sha256 does not match the manifest" });
    }
    if (buffer.length > maxEffectiveBudget) {
      drift.partIssues.push({
        part: part.filename,
        issue: `${buffer.length} B exceeds the effective part budget ${maxEffectiveBudget} B`,
      });
    }
  }

  const filesInParts = manifest.parts.reduce(
    (total, part) => total + (typeof part?.fileCount === "number" ? part.fileCount : 0),
    0
  );
  if (filesInParts !== manifest.files.length) {
    drift.partIssues.push({
      part: "(totals)",
      issue: `parts list ${filesInParts} file(s) but the manifest lists ${manifest.files.length}`,
    });
  }
  for (const file of manifest.files) {
    if (file?.part && !partNames.has(file.part)) {
      drift.partIssues.push({
        part: file.part,
        issue: `${file.relativePath} points at a part that is not in the manifest`,
      });
    }
  }

  // ---- recorded configuration --------------------------------------------
  // The manifest stores config values with secret spans masked, so the current
  // side is masked the same way before comparing — otherwise a snapshot with an
  // exclude pattern that looks like a token fails its own validate, and the
  // mismatch line prints the token.
  const maskValue = (value: string): string =>
    findSecretInPath(value, config.secretRules)?.masked ?? value;
  const currentExcludes = config.excludePatterns.map(maskValue);
  const currentInclude = config.include.map(maskValue);
  const recorded = manifest.config;
  if (recorded && typeof recorded === "object") {
    if (recorded.maxPartBytes !== config.maxPartBytes) {
      drift.configMismatches.push(
        `maxPartBytes: manifest ${recorded.maxPartBytes} vs current ${config.maxPartBytes}`
      );
    }
    if (recorded.largeFileBytes !== config.largeFileBytes) {
      drift.configMismatches.push(
        `largeFileBytes: manifest ${recorded.largeFileBytes} vs current ${config.largeFileBytes}`
      );
    }
    if (recorded.previewHeadLines !== config.previewHeadLines) {
      drift.configMismatches.push(
        `previewHeadLines: manifest ${recorded.previewHeadLines} vs current ${config.previewHeadLines}`
      );
    }
    if (recorded.previewTailLines !== config.previewTailLines) {
      drift.configMismatches.push(
        `previewTailLines: manifest ${recorded.previewTailLines} vs current ${config.previewTailLines}`
      );
    }
    if (recorded.includeSensitiveFiles !== config.includeSensitiveFiles) {
      drift.configMismatches.push(
        `includeSensitiveFiles: manifest ${recorded.includeSensitiveFiles} vs current ${config.includeSensitiveFiles}`
      );
    }
    const recordedExcludes = Array.isArray(recorded.excludePatterns)
      ? recorded.excludePatterns
      : [];
    if (recordedExcludes.join("\u0000") !== currentExcludes.join("\u0000")) {
      drift.configMismatches.push(
        `excludePatterns: manifest [${recordedExcludes.join(", ")}] vs current [${currentExcludes.join(", ")}]`
      );
    }
    const recordedInclude = Array.isArray(recorded.include) ? recorded.include : [];
    if (recordedInclude.join("\u0000") !== currentInclude.join("\u0000")) {
      drift.configMismatches.push(
        `include: manifest [${recordedInclude.join(", ")}] vs current [${currentInclude.join(", ")}]`
      );
    }
    // Snapshots written before the artifact selection existed do not record it;
    // absent is treated as "all generated by default" rather than as drift, so
    // older snapshots keep validating.
    if (recorded?.artifacts && typeof recorded.artifacts === "object") {
      for (const name of ARTIFACT_NAMES) {
        if (recorded.artifacts[name] !== config.artifacts[name]) {
          drift.configMismatches.push(
            `artifacts.${name}: manifest ${recorded.artifacts[name]} vs current ${config.artifacts[name]}`
          );
        }
      }
    }

    if (recorded?.preset !== undefined && recorded.preset !== config.preset) {
      drift.configMismatches.push(
        `preset: manifest ${recorded.preset} vs current ${config.preset}`
      );
    }

    if (recorded?.layersMode !== undefined && recorded.layersMode !== config.layersMode) {
      drift.configMismatches.push(
        `layersMode: manifest ${recorded.layersMode} vs current ${config.layersMode}`
      );
    }

    const recordedBudgets = recorded?.budgets;
    if (recordedBudgets && typeof recordedBudgets === "object") {
      if (recordedBudgets.default !== config.budgets.default) {
        drift.configMismatches.push(
          `budgets.default: manifest ${recordedBudgets.default} vs current ${config.budgets.default}`
        );
      }
      const recordedByLayer = recordedBudgets.byLayer ?? {};
      const layerNames = new Set([
        ...Object.keys(recordedByLayer),
        ...Object.keys(config.budgets.byLayer),
      ]);
      for (const layer of Array.from(layerNames).sort()) {
        if (recordedByLayer[layer] !== config.budgets.byLayer[layer]) {
          drift.configMismatches.push(
            `budgets.byLayer.${layer}: manifest ${recordedByLayer[layer]} vs current ${config.budgets.byLayer[layer]}`
          );
        }
      }
    }
  } else {
    drift.configMismatches.push("manifest does not record the effective configuration");
  }

  // ---- internal bookkeeping ----------------------------------------------
  // A manifest whose counts/totals/budgets disagree with its own file and part
  // lists is not trustworthy, even if every hash happens to match.
  const totalsMismatches = drift.totalsMismatches;
  const expectEqual = (label: string, recordedValue: unknown, actual: number): void => {
    if (recordedValue !== actual) {
      totalsMismatches.push(`${label}: manifest ${String(recordedValue)} vs actual ${actual}`);
    }
  };

  const counts = manifest.counts ?? ({} as Manifest["counts"]);
  const totals = manifest.totals ?? ({} as Manifest["totals"]);
  const sumSourceBytes = manifest.files.reduce(
    (total, file) => total + (typeof file?.sizeBytes === "number" ? file.sizeBytes : 0),
    0
  );
  const sumIncludedBytes = manifest.parts.reduce(
    (total, part) =>
      total +
      (Array.isArray(part?.includedFiles)
        ? part.includedFiles.reduce(
            (inner, entry) =>
              inner + (typeof entry?.includedBytes === "number" ? entry.includedBytes : 0),
            0
          )
        : 0),
    0
  );

  expectEqual("counts.totalFiles", counts.totalFiles, manifest.files.length);
  expectEqual("counts.partsCount", counts.partsCount, manifest.parts.length);
  expectEqual("counts.skippedCount", counts.skippedCount, manifest.skipped.length);
  expectEqual("counts.totalSizeBytes", counts.totalSizeBytes, sumSourceBytes);
  expectEqual("totals.includedFiles", totals.includedFiles, manifest.files.length);
  expectEqual("totals.partCount", totals.partCount, manifest.parts.length);
  expectEqual("totals.skippedFiles", totals.skippedFiles, manifest.skipped.length);
  expectEqual("totals.totalSourceBytes", totals.totalSourceBytes, sumSourceBytes);
  expectEqual("totals.totalContentBytes", totals.totalContentBytes, sumIncludedBytes);
  expectEqual(
    "totals.candidateFiles",
    totals.candidateFiles,
    manifest.files.length + manifest.skipped.length
  );
  expectEqual(
    "totals.warningCount",
    totals.warningCount,
    Array.isArray(manifest.warnings) ? manifest.warnings.length : 0
  );
  if (
    typeof totals.fullFiles === "number" &&
    typeof totals.previewFiles === "number" &&
    totals.fullFiles + totals.previewFiles !== manifest.files.length
  ) {
    totalsMismatches.push(
      `totals.fullFiles + previewFiles (${totals.fullFiles} + ${totals.previewFiles}) != ${manifest.files.length} files`
    );
  }
  if (manifest.budgets && manifest.budgets.maxPartBytes !== config.maxPartBytes) {
    totalsMismatches.push(
      `budgets.maxPartBytes: manifest ${manifest.budgets.maxPartBytes} vs current ${config.maxPartBytes}`
    );
  }
  if (manifest.budgets && manifest.budgets.largeFileBytes !== config.largeFileBytes) {
    totalsMismatches.push(
      `budgets.largeFileBytes: manifest ${manifest.budgets.largeFileBytes} vs current ${config.largeFileBytes}`
    );
  }

  // ---- git ----------------------------------------------------------------
  if (manifest.git && typeof manifest.git.commit === "string") {
    const current = getGitInfo(config.cwd, config.branch);
    if (
      manifest.git.commit !== "unknown" &&
      current.commit !== "unknown" &&
      manifest.git.commit !== current.commit
    ) {
      warnings.push(
        `Snapshot was generated at commit ${manifest.git.commit.slice(0, 8)} but HEAD is ${current.commit.slice(0, 8)}.`
      );
    }
    if (current.isDirty) {
      warnings.push("Working tree has uncommitted changes.");
    }
  }

  // ---- declared integrity -------------------------------------------------
  if (manifest.validation && manifest.validation.status === "failed") {
    const declared = Array.isArray(manifest.validation.errors)
      ? manifest.validation.errors
      : [];
    for (const error of declared) {
      drift.configMismatches.push(`manifest declared itself invalid: ${error}`);
    }
  }

  // ---- monolith artefacts -------------------------------------------------
  for (const [key, artifact] of [
    ["full-codebase.json", manifest.artifacts?.fullJson],
    ["full-codebase.md", manifest.artifacts?.fullMarkdown],
  ] as const) {
    if (!artifact) continue;
    const artifactPath = path.join(snapshotDir, key);
    try {
      const buffer = fs.readFileSync(artifactPath);
      if (sha256Hex(buffer) !== artifact.sha256 || buffer.length !== artifact.byteSize) {
        drift.partIssues.push({ part: key, issue: "artifact does not match its recorded digest" });
      }
    } catch {
      drift.partIssues.push({ part: key, issue: "declared artifact is missing" });
    }
  }

  // ---- git ----------------------------------------------------------------
  if (manifest.git && manifest.git.branch && manifest.git.branch !== config.branch) {
    warnings.push(
      `Snapshot was generated on branch "${manifest.git.branch}" but the configured branch is "${config.branch}".`
    );
  }

  const errors: string[] = [];
  if (drift.missingInSnapshot.length > 0) {
    errors.push(`${drift.missingInSnapshot.length} file(s) on disk are missing from the snapshot.`);
  }
  if (drift.missingOnDisk.length > 0) {
    errors.push(`${drift.missingOnDisk.length} file(s) in snapshot no longer exist on disk.`);
  }
  if (drift.hashMismatches.length > 0) {
    errors.push(
      `${drift.hashMismatches.length} file(s) have been modified since the snapshot was generated.`
    );
  }
  if (drift.partIssues.length > 0) {
    errors.push(`${drift.partIssues.length} snapshot artefact problem(s) detected.`);
  }
  if (drift.totalsMismatches.length > 0) {
    errors.push(
      `${drift.totalsMismatches.length} manifest bookkeeping value(s) disagree with the snapshot contents.`
    );
  }
  if (drift.configMismatches.length > 0) {
    errors.push(
      `${drift.configMismatches.length} configuration mismatch(es) between the manifest and this run.`
    );
  }

  // ---- masked view --------------------------------------------------------
  // The result is printed by `validate` and serialized by `--format json`; no
  // raw path may leave this function, because a path can carry a credential.
  const maskedDrift: ValidationDrift = {
    ...drift,
    missingInSnapshot: drift.missingInSnapshot.map((value) => maskedPath(value, config.secretRules)),
    missingOnDisk: drift.missingOnDisk.map((value) => maskedPath(value, config.secretRules)),
    hashMismatches: drift.hashMismatches.map((mismatch) => ({
      ...mismatch,
      path: maskedPath(mismatch.path, config.secretRules),
    })),
  };

  return {
    valid: errors.length === 0,
    manifestPresent: true,
    drift: maskedDrift,
    errors,
    warnings,
  };
}
