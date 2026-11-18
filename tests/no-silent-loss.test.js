import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { generateSnapshot, resolveConfig } from "../dist/index.js";

/**
 * The 0.9.19 report's P0 and P1.
 *
 * P0 was a complete file gutted to fit a part budget, with the manifest recording
 * `inclusionMode: "preview"` beside `isLarge: false`: a reader could not tell a preview chosen by
 * policy from 57 % of a file that nobody could find. The rule now is that the two ceilings answer
 * one question — can this file be emitted whole? — and that anything not emitted in full is named
 * in `incomplete[]` with the lines that are missing.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-silent-loss-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, relative, content) {
  const full = path.join(dir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function repo(t) {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"fixture"}\n');
  return dir;
}

/** Exactly the report's fixture: one 190 KB markdown file in a small repository. */
function bigMarkdown(bytes) {
  const line = "A paragraph of documentation that a model is supposed to read.\n";
  return line.repeat(Math.ceil(bytes / line.length));
}

test("P0 golden: a 190 KB file at the default budget is emitted whole", (t) => {
  const dir = repo(t);
  const body = bigMarkdown(190_000);
  write(dir, "docs/handbook.md", body);

  const manifest = generateSnapshot({ cwd: dir, outDir: "snapshot" });
  const entry = manifest.files.find((file) => file.relativePath === "docs/handbook.md");

  assert.equal(entry.inclusionMode, "full", "a file that fits must not be cut");
  assert.equal(entry.isPreviewTruncated, false);
  assert.equal(entry.truncationReason, undefined);
  assert.equal(entry.includedLines, entry.lines);
  assert.deepEqual(manifest.incomplete, [], "nothing was left out, so the list is empty");

  const part = fs.readFileSync(
    path.join(dir, "snapshot", "parts", entry.part),
    "utf8"
  );
  assert.ok(part.includes("A paragraph of documentation"), "the body is in the part");
  // The last line of the source is the last line of the block, so nothing was dropped at the end.
  assert.ok(part.includes(line_last(body)), "the final line survived");
});

function line_last(text) {
  const lines = text.trimEnd().split("\n");
  return lines[lines.length - 1];
}

test("P0: a threshold above the part budget is a config error, not a cut", (t) => {
  const dir = repo(t);
  write(dir, "a.ts", "export const a = 1;\n");

  assert.throws(
    () => generateSnapshot({ cwd: dir, outDir: "snapshot", maxPartBytes: 100_000, largeFileBytes: 200_000 }),
    /is larger than maxPartBytes/
  );
  // Nothing was written: the refusal happens before the run starts.
  assert.equal(fs.existsSync(path.join(dir, "snapshot")), false);
});

test("P0: a file that cannot fit is previewed, listed in incomplete[], with its missing lines", (t) => {
  const dir = repo(t);
  const body = Array.from({ length: 4000 }, (_, i) => `line ${i} of a document`).join("\n") + "\n";
  write(dir, "big.md", body);

  const manifest = generateSnapshot({ cwd: dir, outDir: "snapshot", maxPartBytes: 20_000 });
  const entry = manifest.files.find((file) => file.relativePath === "big.md");

  assert.equal(entry.truncationReason, "large-file-budget", "the reason says which rule cut it");
  assert.equal(manifest.incomplete.length, 1);
  const record = manifest.incomplete[0];
  assert.equal(record.reason, "large-file-budget");
  assert.equal(record.relativePath, "big.md");
  assert.equal(record.omittedRanges.length, 1, "one contiguous run is missing");
  const [from, to] = record.omittedRanges[0];
  assert.ok(from > 1 && to < record.lines, "head and tail are kept, the middle is not");
  assert.equal(record.omittedLines, to - from + 1);
  assert.equal(manifest.counts.incompleteCount, 1);
});

test("P1: every scanned path is in files[] or skipped[], and validation says so", (t) => {
  const dir = repo(t);
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  write(dir, ".env", "API_KEY=abcdef1234567890abcdef\n");

  const manifest = generateSnapshot({ cwd: dir, outDir: "snapshot" });

  const accounted = manifest.files.length + manifest.skipped.length;
  assert.equal(
    accounted,
    manifest.totals.candidateFiles,
    "the two lists together are the whole scan"
  );
  for (const record of manifest.skipped) {
    assert.ok(record.reason, "a skip without a reason is an unexplained disappearance");
  }
  assert.equal(manifest.validation.status, "passed", manifest.validation.errors.join("; "));
});

test("P1: the run summary prints included, found and skipped with reasons", (t) => {
  const dir = repo(t);
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));

  const result = spawnSync(process.execPath, [BIN, "generate", "--cwd", dir, "--out-dir", "snapshot"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const text = `${result.stdout}${result.stderr}`;
  assert.match(text, /Tracked files: 2 included of 3 paths found — 1 skipped/);
  assert.match(text, /binary 1/, "the reason that took each file is named");
});
test("P3: setup does not run a package manager where there is no package.json", (t) => {
  const dir = tempDir(t);
  write(dir, "src/a.ts", "export const a = 1;\n");

  const result = spawnSync(process.execPath, [BIN, "setup", "--yes"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const text = `${result.stdout}${result.stderr}`;
  assert.match(text, /Skipped the install: no package\.json/, "the skip is stated, not silent");
  assert.equal(
    fs.existsSync(path.join(dir, "package-lock.json")),
    false,
    "npm must not leave an empty lockfile in a repository that is not an npm project"
  );
  assert.equal(fs.existsSync(path.join(dir, "node_modules")), false);
});
