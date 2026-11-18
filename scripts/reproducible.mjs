#!/usr/bin/env node
/**
 * Reproducibility: two runs over the same tree must produce the same payload.
 *
 * The fingerprint is recorded as the identity of the content, so two runs with the same commit
 * should agree on it, on files[], on skipped[] and on every part byte. generatedAt and the
 * artifacts that quote it are excluded by design; everything else is compared.
 *
 * Usage: node scripts/reproducible.mjs [repo]
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
  console.error("reproducible: no build at " + bin + "; run npm run build first");
  process.exit(2);
}

function fail(message) {
  console.error("reproducible: " + message);
  process.exit(1);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "reproducible-"));
try {
  const generate = (name) => {
    const outDir = path.join(root, name);
    const result = spawnSync(
      process.execPath,
      [bin, "generate", "--cwd", repoDir, "--out-dir", outDir, "--no-update-check"],
      { encoding: "utf8" }
    );
    if (result.status !== 0) {
      fail(
        "generate " + name + " failed (exit " + result.status + "):\n" +
          (result.stdout ?? "") + (result.stderr ?? "")
      );
    }
    return {
      outDir,
      manifest: JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8")),
    };
  };

  const first = generate("one");
  const second = generate("two");
  const problems = [];
  const compare = (label, left, right) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) problems.push(label + " differs");
  };

  compare("fingerprint", first.manifest.fingerprint, second.manifest.fingerprint);
  compare("files[]", first.manifest.files, second.manifest.files);
  compare("skipped[]", first.manifest.skipped, second.manifest.skipped);
  compare("counts", first.manifest.counts, second.manifest.counts);
  compare("totals", first.manifest.totals, second.manifest.totals);
  compare(
    "part names",
    first.manifest.parts.map((part) => part.filename),
    second.manifest.parts.map((part) => part.filename)
  );

  for (const part of first.manifest.parts) {
    const other = second.manifest.parts.find((candidate) => candidate.filename === part.filename);
    if (other === undefined) {
      problems.push(part.filename + " is missing from the second run");
      continue;
    }
    if (part.sha256 !== other.sha256) problems.push(part.filename + " records a different hash");
    const left = fs.readFileSync(path.join(first.outDir, "parts", part.filename));
    const right = fs.readFileSync(path.join(second.outDir, "parts", part.filename));
    if (!left.equals(right)) problems.push(part.filename + " has different bytes");
  }

  if (problems.length > 0) {
    for (const problem of problems.slice(0, 20)) console.error("  " + problem);
    fail(problems.length + " difference(s) between two runs of the same tree");
  }
  console.log(
    "reproducible: fingerprint " + first.manifest.fingerprint.slice(0, 12) + ", " +
      first.manifest.parts.length + " part(s) and " + first.manifest.files.length +
      " file record(s) identical across two runs"
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
