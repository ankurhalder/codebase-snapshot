#!/usr/bin/env node
/**
 * The deep release gate: generate, verify the payload against the source, validate, prove that
 * every git path is accounted for, and prove the run is reproducible.
 *
 * npm run verify covers the unit and integration suites, the site, the docs and the tarball. This
 * adds the checks that need a real snapshot of the real tree, so a release cannot be tagged on a
 * generator whose output no longer matches the repository.
 *
 * Usage: node scripts/verify-deep.mjs [repo]
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(process.argv[2] ?? ".");
const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "dist", "bin.js");
if (!fs.existsSync(bin)) {
  console.error("verify-deep: no build at " + bin + "; run npm run build first");
  process.exit(2);
}

function run(label, args, options = {}) {
  const result = spawnSync(process.execPath, args, { cwd: repoDir, encoding: "utf8", ...options });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  if (result.status !== 0) {
    console.error("verify-deep: " + label + " failed (exit " + result.status + ")");
    console.error(output.trim().split("\n").slice(-25).join("\n"));
    process.exit(1);
  }
  return output;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-deep-"));
const snapshotDir = path.join(root, "snapshot");
try {
  run("generate", [bin, "generate", "--cwd", repoDir, "--out-dir", snapshotDir, "--no-update-check"]);

  const healthResult = spawnSync(
    process.execPath,
    [bin, "health", "--deep", "--format", "json", "--cwd", repoDir, "--out-dir", snapshotDir],
    { cwd: repoDir, encoding: "utf8" }
  );
  if (healthResult.status !== 0) {
    console.error("verify-deep: health --deep failed (exit " + healthResult.status + ")");
    console.error(((healthResult.stdout ?? "") + (healthResult.stderr ?? "")).trim().split("\n").slice(-25).join("\n"));
    process.exit(1);
  }
  const health = JSON.parse(healthResult.stdout ?? "{}");
  console.log(
    "verify-deep: health " + health.score + "/100 (" + health.counts.pass + " passed, " +
      health.counts.warn + " warning(s), " + health.counts.fail + " failed, " +
      health.counts.skip + " skipped)"
  );

  run("validate", [bin, "validate", "--cwd", repoDir, "--out-dir", snapshotDir]);
  run("coverage-diff", [path.join(here, "coverage-diff.mjs"), repoDir, snapshotDir]);
  run("reproducible", [path.join(here, "reproducible.mjs"), repoDir]);
  console.log("verify-deep: okay");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
