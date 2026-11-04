import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ARTIFACT_NAMES,
  assertUsableConfigInput,
  configDigest,
  isResolvedConfig,
  normalizeResolvedConfig,
  resolveConfig,
} from "../config.js";
import { collectFiles, findSecretInPath, getGitInfo } from "../scanner/files.js";
import { decodeText, isBinaryFile } from "../scanner/binary.js";
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

/**
 * Resolves a manifest-supplied filename inside `directory`, or refuses.
 *
 * A manifest is an input: it can be hand-edited, or written by an older or other tool. Joining an
 * unvalidated name onto a directory accepts `../../..` and absolute paths, so `validate` would
 * read a file anywhere on the machine and then report its size and digest back to the caller — a
 * read primitive with an oracle attached. Part names produced by this generator are bare names,
 * so anything that resolves outside the directory is a defect, not a path to follow.
 */
function confineToDirectory(directory: string, filename: string): string | null {
  if (filename.includes("\0")) return null;
  if (path.isAbsolute(filename)) return null;
  const base = path.resolve(directory);
  const resolved = path.resolve(base, filename);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const prefix = caseInsensitive ? `${base}${path.sep}`.toLowerCase() : `${base}${path.sep}`;
  const candidate = caseInsensitive ? resolved.toLowerCase() : resolved;
  return candidate.startsWith(prefix) ? resolved : null;
}

/** The newest `run-*` staging directory under `tmpDir`, or null when there is none. */
function findStagingDirectory(config: ResolvedSnapshotConfig): string | null {
  const tmpDir = path.resolve(config.cwd, config.tmpDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpDir);
  } catch {
    return null;
  }
  const runs = entries.filter((name) => name.startsWith("run-")).sort();
  const newest = runs[runs.length - 1];
  return newest ? path.join(tmpDir, newest) : null;
}

/**
 * Explains a missing manifest, and says so differently when a run died.
 *
 * `validate` and `report` used to answer "run generate first" whenever `manifest.json` was absent,
 * including for a directory this generator had already written a marker into. That answer could
 * never resolve: generation had already run, and it had failed after starting. The marker carries
 * the state, the run id and the start time, so the message can name them and say what to do.
 */
function describeMissingManifest(config: ResolvedSnapshotConfig, manifestPath: string): string {
  const outDir = path.resolve(config.cwd, config.outDir);
  const markerPath = path.join(outDir, ".codebase-snapshot");

  let marker: Record<string, unknown> | null = null;
  try {
    if (fs.existsSync(markerPath)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        marker = parsed as Record<string, unknown>;
      }
    }
  } catch {
    marker = null;
  }

  if (marker) {
    const state = typeof marker.state === "string" ? marker.state : "unknown";
    const runId = typeof marker.id === "string" ? marker.id : "unknown";
    const createdAt = typeof marker.createdAt === "string" ? marker.createdAt : "unknown";
    const staging = findStagingDirectory(config);

    if (state === "staging") {
      return (
        `The previous generate run did not finish: ${outDir} holds a .codebase-snapshot marker in ` +
        `state "staging" (run ${runId}, started ${createdAt}) and no manifest.json. ` +
        (staging ? `Its staging directory is still at ${staging}. ` : "") +
        "Run generate again to rebuild the snapshot; if another run is active, wait for it to finish first."
      );
    }

    return (
      `${outDir} carries this generator's ownership marker but no manifest.json, so the snapshot is ` +
      `incomplete (run ${runId}, recorded ${createdAt}, state "${state}"). Run generate again to rebuild it.`
    );
  }

  return `Snapshot manifest not found at: ${manifestPath}. Run generate first.`;
}

function emptyDrift(): ValidationDrift {
  return {
    missingInSnapshot: [],
    missingOnDisk: [],
    unreadable: [],
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
/** A file skipped as binary is not re-read past this size just to confirm it is still binary. */
const VERIFY_SNIFF_MAX_BYTES = 8 * 1024 * 1024;
function wouldNowBeIncluded(cwd: string, relativePath: string, reason?: string): boolean {
  const absolutePath = path.join(cwd, relativePath);
  try {
    const stats = fs.statSync(absolutePath);
    if (!stats.isFile()) return false;
    if (isBinaryFile(absolutePath)) return false;
    if (reason !== "binary") return true;

    // `generate` decides "binary" a second time, on the bytes it actually reads: a control-byte
    // payload, or a NUL past the head scan, is a file the cheap pre-read check above cannot
    // recognise. Asking only the cheap question made `validate` call a file generate had just
    // skipped a "new file" — two commands disagreeing about the same tree. A very large skipped
    // file is not read again: it was skipped as binary, and re-reading a gigabyte to confirm it
    // would cost more than the answer is worth.
    if (stats.size > VERIFY_SNIFF_MAX_BYTES) return false;
    return !decodeText(fs.readFileSync(absolutePath)).binary;
  } catch {
    return false;
  }
}

/**
 * Describes why a parsed JSON value is not usable as a snapshot manifest.
 *
 * One guard for every command that reads a manifest from disk. `validate` used to
 * accept a manifest whose `fingerprint` had been deleted and call the snapshot
 * "valid and up to date", `report` printed `undefined` for the same file, and
 * `diff` rejected it with a private copy of these rules — three answers to one
 * question. A manifest is:
 *
 * - a JSON object (not an array, not a primitive),
 * - with non-negative integer counts (`totalFiles`, `totalLines`, `totalSizeBytes`, `partsCount`),
 * - with a `generatedAt` string and a `schemaVersion` string,
 * - with a `fingerprint` that is exactly 64 lowercase hex characters (a sha256),
 * - with `files`, `skipped` and `parts` arrays, each entry carrying the field the
 *   rest of the tool indexes by (`relativePath`, `filename`),
 * - with a `totals` object (`report` reads `totals.redactedLines`) and a `layers` object.
 *
 * Returns `null` when the value is usable, otherwise one sentence naming the
 * first problem. Callers prefix it with the path they read.
 */
export function describeManifestShapeProblem(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "not a JSON object";
  const candidate = value as Record<string, unknown>;

  const counts = candidate.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    return 'no "counts" object';
  }
  for (const key of ["totalFiles", "totalLines", "totalSizeBytes", "partsCount"]) {
    const count = (counts as Record<string, unknown>)[key];
    if (typeof count !== "number") return `missing numeric \`counts.${key}\``;
    // `-5`, `1.5` and `1e999` are all numbers, and `report` printed each of them
    // verbatim: "-5 files included", "Total lines: 1.5". A count is a non-negative
    // integer, or the document is not a snapshot manifest.
    if (!Number.isSafeInteger(count) || count < 0) {
      return `\`counts.${key}\` must be a non-negative integer`;
    }
  }

  if (typeof candidate.generatedAt !== "string" || candidate.generatedAt.trim() === "") {
    return 'missing "generatedAt" timestamp';
  }
  if (typeof candidate.schemaVersion !== "string" || candidate.schemaVersion.trim() === "") {
    return 'missing "schemaVersion"';
  }
  if (
    typeof candidate.fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.fingerprint)
  ) {
    return '`fingerprint` must be a 64-character lowercase sha256 hex digest';
  }

  // `report` reads `totals.redactedLines`; a missing object used to crash the text
  // renderer after it had already printed half a report.
  if (!candidate.totals || typeof candidate.totals !== "object" || Array.isArray(candidate.totals)) {
    return 'missing "totals" object';
  }

  if (!Array.isArray(candidate.files)) return 'missing "files" array';
  for (const entry of candidate.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return 'a "files" entry is not an object';
    }
    if (typeof (entry as Record<string, unknown>).relativePath !== "string") {
      return 'a "files" entry has no "relativePath"';
    }
  }

  if (!Array.isArray(candidate.skipped)) return 'missing "skipped" array';
  if (!Array.isArray(candidate.parts)) return 'missing "parts" array';
  for (const entry of candidate.parts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return 'a "parts" entry is not an object';
    }
    if (typeof (entry as Record<string, unknown>).filename !== "string") {
      return 'a "parts" entry has no "filename"';
    }
  }

  if (!candidate.layers || typeof candidate.layers !== "object" || Array.isArray(candidate.layers)) {
    return 'missing "layers" object';
  }
  return null;
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
    // "Not found" is the wrong diagnosis when a run died: the directory is there, it even carries
    // this tool's marker, and the marker says a snapshot was being written. Saying "run generate
    // first" forever sent the reader round a loop that could not terminate.
    return {
      valid: false,
      manifestPresent: false,
      drift: emptyDrift(),
      errors: [describeMissingManifest(config, manifestPath)],
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

  // The same guard `report` and `diff` use, so the three commands agree about what
  // a manifest is. The array-only check this replaced accepted a manifest whose
  // `fingerprint` had been deleted, and answered "valid and up to date".
  const shapeProblem = describeManifestShapeProblem(manifest);
  if (shapeProblem) {
    return {
      valid: false,
      manifestPresent: true,
      drift: emptyDrift(),
      errors: [`${manifestPath} is not a snapshot manifest: ${shapeProblem}`],
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
  const skippedReasons = new Map<string, string>();
  for (const entry of manifest.skipped) {
    if (entry && typeof entry.path === "string" && typeof entry.reason === "string") {
      skippedReasons.set(entry.path, entry.reason);
    }
  }
  /** The recorded reason this disk path was skipped for, or null when it was not. */
  const skippedReasonOnDisk = (diskFile: string): string | null => {
    const direct = skippedReasons.get(diskFile);
    if (direct !== undefined) return direct;
    return skippedReasons.get(maskedPath(diskFile, config.secretRules)) ?? null;
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
      const skipReason = skippedReasonOnDisk(diskFile);
      if (skipReason !== null && !wouldNowBeIncluded(config.cwd, diskFile, skipReason)) continue;
      drift.missingInSnapshot.push(diskFile);
      continue;
    }

    let diskHash: string;
    try {
      diskHash = sha256Hex(fs.readFileSync(path.join(config.cwd, diskFile)));
    } catch (err) {
      // A file that exists but cannot be read is not a deleted file. Filing it under "no longer
      // exists on disk" sent the reader looking for a file that is right there, and it is a
      // different problem with a different fix (permissions, not a re-generate).
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        drift.missingOnDisk.push(diskFile);
      } else {
        drift.unreadable.push(diskFile);
      }
      continue;
    }
    if (diskHash !== snapshotHash) {
      drift.hashMismatches.push({ path: diskFile, diskHash, snapshotHash });
    }
  }

  for (const snapshotFile of manifestFileMap.keys()) {
    // The manifest is an input, and `path.join` accepts `../..`, so this loop used to answer
    // "does this path exist?" for any file on the machine: a traversal entry was silently accepted
    // when the target existed and reported as `deleted: ../../secret` when it did not. A recorded
    // path that does not stay inside the repository is a foreign or tampered manifest, and is
    // reported as that instead of being resolved.
    const confined = confineToDirectory(config.cwd, snapshotFile);
    if (confined === null) {
      drift.partIssues.push({
        part: "(manifest)",
        issue: `${maskedPath(snapshotFile, config.secretRules)} resolves outside the repository and was not inspected`,
      });
      continue;
    }
    if (!fs.existsSync(confined)) {
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
  const partsDir = path.join(snapshotDir, "parts");
  for (const part of manifest.parts) {
    if (!part || typeof part.filename !== "string") continue;
    partNames.add(part.filename);

    if (!config.artifacts.parts) continue;

    const partPath = confineToDirectory(partsDir, part.filename);
    if (partPath === null) {
      // A manifest is an input, so its filenames are untrusted: `path.join` would happily turn
      // `../../../etc/passwd` into a read outside the snapshot and report that file's byte size
      // and digest back to the caller. A part filename is a bare name by construction.
      drift.partIssues.push({
        part: part.filename,
        issue: "filename resolves outside snapshot/parts; refusing to read it",
      });
      continue;
    }
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
  // A digest of the raw settings catches every configuration change, including the
  // ones no per-field comparison covers (layers, kinds, custom secret rules) and the
  // ones a masked comparison cannot see (a credential-shaped value changed from A to B).
  if (recorded?.digest && recorded.digest !== configDigest(config)) {
    drift.configMismatches.push(
      "configuration: the settings differ from the ones this snapshot was generated with " +
        "(run generate)"
    );
  } else if (!recorded?.digest) {
    // No digest means no way to verify the settings: the per-field fallback below covers only the
    // fields it knows, so a snapshot written before 4.0.5 — or one with the digest removed — would
    // pass while `maxMonolithBytes`, `layers`, `kinds` and custom secret rules had changed. A
    // snapshot whose configuration cannot be checked is not up to date; it is unverifiable.
    drift.configMismatches.push(
      "configuration: the manifest records no configuration digest, so settings drift cannot be " +
        "verified (run generate to record one)"
    );
  }
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
    const effectiveDiscovery = config.discovery ?? "auto";
    const recordedDiscovery = recorded.discovery;
    if (recordedDiscovery !== undefined && recordedDiscovery !== effectiveDiscovery) {
      // How files were discovered changes which files a snapshot contains, so it is drift in
      // exactly the same sense as a changed exclude pattern. Manifests written before this was
      // recorded carry no key at all, and "not recorded" is not the same as "different".
      drift.configMismatches.push(
        `discovery: manifest ${recordedDiscovery} vs current ${effectiveDiscovery}`
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
  if (drift.unreadable.length > 0) {
    errors.push(
      `${drift.unreadable.length} file(s) exist on disk but could not be read, so their content ` +
        `could not be verified.`
    );
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
    unreadable: drift.unreadable.map((value) => maskedPath(value, config.secretRules)),
    hashMismatches: drift.hashMismatches.map((mismatch) => ({
      ...mismatch,
      path: maskedPath(mismatch.path, config.secretRules),
    })),
    // A part name comes from the manifest, which is an input: it can carry a credential shape as
    // easily as a real path can, and these records are printed.
    partIssues: drift.partIssues.map((issue) => ({
      ...issue,
      part: maskedPath(issue.part, config.secretRules),
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
