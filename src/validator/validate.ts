import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { collectFiles } from "../scanner/files.js";
import type { Manifest, ResolvedSnapshotConfig, ValidationResult } from "../types.js";

export function validateSnapshot(config: ResolvedSnapshotConfig): ValidationResult {
  const manifestPath = path.join(config.cwd, config.outDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    return {
      valid: false,
      manifestPresent: false,
      drift: {
        missingInSnapshot: [],
        missingOnDisk: [],
        hashMismatches: [],
      },
      errors: [`Snapshot manifest not found at: ${manifestPath}`],
    };
  }

  let manifest: Manifest;
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    manifest = JSON.parse(raw);
  } catch (err: any) {
    return {
      valid: false,
      manifestPresent: true,
      drift: {
        missingInSnapshot: [],
        missingOnDisk: [],
        hashMismatches: [],
      },
      errors: [`Failed to parse snapshot manifest: ${err.message}`],
    };
  }

  const manifestFileMap = new Map<string, string>();
  for (const f of manifest.files) {
    manifestFileMap.set(f.relativePath, f.hashSha256);
  }

  const skippedSet = new Set(manifest.skipped.map((s) => s.path));
  const currentDiskFiles = collectFiles(config.cwd, config.excludePatterns);

  const missingInSnapshot: string[] = [];
  const missingOnDisk: string[] = [];
  const hashMismatches: Array<{
    path: string;
    diskHash: string;
    snapshotHash: string;
  }> = [];

  for (const diskFile of currentDiskFiles) {
    if (skippedSet.has(diskFile)) continue;
    const snapshotHash = manifestFileMap.get(diskFile);

    if (!snapshotHash) {
      missingInSnapshot.push(diskFile);
      continue;
    }

    const fullDiskPath = path.join(config.cwd, diskFile);
    try {
      const content = fs.readFileSync(fullDiskPath);
      const diskHash = crypto.createHash("sha256").update(content).digest("hex");
      if (diskHash !== snapshotHash) {
        hashMismatches.push({
          path: diskFile,
          diskHash,
          snapshotHash,
        });
      }
    } catch {
      missingOnDisk.push(diskFile);
    }
  }

  for (const snapshotFile of manifestFileMap.keys()) {
    const fullPath = path.join(config.cwd, snapshotFile);
    if (!fs.existsSync(fullPath)) {
      missingOnDisk.push(snapshotFile);
    }
  }

  const errors: string[] = [];
  if (missingInSnapshot.length > 0) {
    errors.push(`${missingInSnapshot.length} file(s) on disk are missing from the snapshot.`);
  }
  if (missingOnDisk.length > 0) {
    errors.push(`${missingOnDisk.length} file(s) in snapshot no longer exist on disk.`);
  }
  if (hashMismatches.length > 0) {
    errors.push(`${hashMismatches.length} file(s) have been modified since the snapshot was generated.`);
  }

  const valid =
    missingInSnapshot.length === 0 &&
    missingOnDisk.length === 0 &&
    hashMismatches.length === 0;

  return {
    valid,
    manifestPresent: true,
    drift: {
      missingInSnapshot,
      missingOnDisk,
      hashMismatches,
    },
    errors,
  };
}

