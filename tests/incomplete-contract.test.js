import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, validateSnapshot } from "../dist/index.js";

/**
 * The completeness contract is an input once `manifest.json` is on disk.
 *
 * `verifyInMemory` enforces it while generating. `validate` is the only command that reads a
 * manifest as an input, and it never looked at `incomplete[]` at all: ten tampered variants of a
 * real record — including a `relativePath` of `../escape.ts`, the only one of the three
 * path-bearing arrays that was unguarded — each reported "valid and up to date".
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "incomplete-contract-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

/** A snapshot with exactly one previewed file, so `incomplete[]` has one real record. */
function previewSnapshot(t) {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"fixture"}\n');
  write(dir, "src/big.ts", Array.from({ length: 900 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
  generateSnapshot({ cwd: dir, outDir: "snapshot", largeFileBytes: 1024 });

  const manifestPath = path.join(dir, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.incomplete.length, 1, "the fixture must have one incomplete record");
  assert.equal(manifest.counts.incompleteCount, 1);
  assert.equal(manifest.incomplete[0].relativePath, "src/big.ts");
  assert.equal(manifest.incomplete[0].reason, "large-file-budget");

  return { dir, manifest, manifestPath };
}

function validateTampered(dir, mutate) {
  const manifestPath = path.join(dir, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  mutate(manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return validateSnapshot({ cwd: dir });
}

const TAMPERINGS = [
  ["incomplete[] emptied, count kept", "shape", (m) => { m.incomplete = []; }, /does not match the length/],
  ["incompleteCount = 42", "shape", (m) => { m.counts.incompleteCount = 42; }, /does not match the length/],
  ["incompleteCount is not a number", "shape", (m) => { m.counts.incompleteCount = "1"; }, /counts\.incompleteCount/],
  ["an unknown reason", "shape", (m) => { m.incomplete[0].reason = "bogus"; }, /unknown "reason"/],
  ["includedLines beyond the file", "shape", (m) => { m.incomplete[0].includedLines = 99999; }, /includedLines/],
  ["omittedLines that does not match the ranges", "shape", (m) => { m.incomplete[0].omittedLines = 0; }, /omittedLines/],
  ["omittedRanges is not an array", "shape", (m) => { m.incomplete[0].omittedRanges = "not-an-array"; }, /omittedRanges/],
  [
    "a range outside the file",
    "shape",
    (m) => { m.incomplete[0].omittedRanges = [[1, 1]]; },
    /omittedLines.* does not match the ranges/,
  ],
  [
    "a range before line 1",
    "shape",
    (m) => { m.incomplete[0].omittedRanges = [[0, 5]]; },
    /outside 1-900/,
  ],
  [
    "relativePath escapes the repository",
    "shape",
    (m) => { m.incomplete[0].relativePath = "../escape.ts"; },
    /must stay inside the repository/,
  ],
  [
    "incomplete[] and count emptied, files[] still truncated",
    "drift",
    (m) => {
      m.incomplete = [];
      m.counts.incompleteCount = 0;
    },
    /missing from incomplete\[\]/,
  ],
  [
    "files[].truncationReason disagrees with incomplete[].reason",
    "drift",
    (m) => {
      const file = m.files.find((entry) => entry.relativePath === "src/big.ts");
      file.truncationReason = "part-budget";
    },
    /records truncationReason part-budget/,
  ],
  [
    "incomplete[] names a path that is not in files[]",
    "drift",
    (m) => { m.incomplete[0].relativePath = "src/ghost.ts"; },
    /is in incomplete\[\] but not in files\[\]/,
  ],
];

test("a real incomplete record agrees with files[] and validates clean", (t) => {
  const { dir } = previewSnapshot(t);
  // The same settings the generation used: a different largeFileBytes is configuration drift, and
  // this test is about the completeness contract.
  const result = validateSnapshot({ cwd: dir, outDir: "snapshot", largeFileBytes: 1024 });
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.deepEqual(result.drift.partIssues, []);
});

for (const [label, kind, mutate, expected] of TAMPERINGS) {
  test(`validate refuses a manifest with ${label}`, (t) => {
    const { dir } = previewSnapshot(t);
    const result = validateTampered(dir, mutate);
    assert.equal(result.valid, false, `validate accepted a manifest with ${label}`);

    const message =
      kind === "shape"
        ? result.errors.join("\n")
        : result.drift.partIssues.map((issue) => issue.issue).join("\n");
    if (kind === "shape") {
      assert.match(message, /is not a snapshot manifest/, "a malformed record is refused, not diffed");
      assert.match(message, expected, `the shape guard must name the problem: ${message}`);
      assert.doesNotMatch(message, /undefined/);
    } else {
      assert.match(message, expected, `the reason must name the problem: ${message}`);
      assert.match(
        result.errors.join("\n"),
        /snapshot artefact problem/,
        "a disagreement between the two lists is an artefact problem"
      );
    }
  });
}

test("an older manifest with no incomplete[] is not refused for it", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  generateSnapshot({ cwd: dir, outDir: "snapshot" });
  const manifestPath = path.join(dir, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  // Exactly what a pre-0.10 manifest looks like: no contract keys anywhere.
  delete manifest.incomplete;
  delete manifest.counts.incompleteCount;
  manifest.schemaVersion = "2.9.9";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const result = validateSnapshot({ cwd: dir });
  assert.equal(result.valid, true, result.errors.join("; "));
});
