import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, resolveConfig } from "../dist/index.js";

/**
 * 0.9.14 — incremental derivation across runs in one process.
 *
 * `--watch` calls `generateSnapshot` again for every change, and every call re-read, re-decoded,
 * re-masked and re-parsed the whole repository. On a 3 000-file project that is seconds of work per
 * keystroke, almost none of it changed. The derivation cache keeps what is a pure function of
 * (bytes, settings, path) and reuses it when the hash of the bytes is the same.
 *
 * What must stay true is that it is *invisible*: two runs over unchanged files produce the same
 * manifest, and a run over a changed file produces the same manifest it would have produced cold.
 */

function makeRepo(t, fileCount, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "derivation-cache-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    fs.writeFileSync(path.join(dir, "src", `f${index}.ts`), body(index), "utf8");
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const configFor = (dir, extra = {}) =>
  resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", ...extra }, {}, dir);

/** The parts of a manifest two runs must agree on to be called identical. */
const comparable = (manifest) => ({
  fingerprint: manifest.fingerprint,
  counts: manifest.counts,
  totals: manifest.totals,
  files: manifest.files.map((file) => ({
    path: file.relativePath,
    hash: file.hashSha256,
    inclusionMode: file.inclusionMode,
    includedBytes: file.includedBytes,
    includedLines: file.includedLines,
    summary: file.summary,
  })),
  parts: manifest.parts.map((part) => ({
    filename: part.filename,
    byteSize: part.byteSize,
    sha256: part.sha256,
    estimatedTokens: part.estimatedTokens,
  })),
});

test("a second generate over unchanged files produces the same manifest", (t) => {
  const dir = makeRepo(
    t,
    40,
    (index) => `export function fn${index}(input: number): number {\n  return input * ${index};\n}\n`
  );

  const first = generateSnapshot(configFor(dir));
  const second = generateSnapshot(configFor(dir));

  assert.deepEqual(comparable(second), comparable(first));
});

test("a changed file is re-derived, not reused", (t) => {
  const dir = makeRepo(t, 6, (index) => `export const value${index} = ${index};\n`);

  const first = generateSnapshot(configFor(dir));
  fs.writeFileSync(path.join(dir, "src", "f3.ts"), "export const value3 = 'changed';\n", "utf8");
  const second = generateSnapshot(configFor(dir));

  const before = first.files.find((file) => file.relativePath === "src/f3.ts");
  const after = second.files.find((file) => file.relativePath === "src/f3.ts");
  assert.notEqual(after.hashSha256, before.hashSha256, "the hash follows the content");
  assert.notEqual(second.fingerprint, first.fingerprint, "and so does the fingerprint");

  const part = fs.readFileSync(path.join(dir, "snapshot", "parts", after.part), "utf8");
  assert.match(part, /export const value3 = 'changed';/, "the new body reaches the part");
});

test("a file rewritten with the same size and timestamp is still re-derived", (t) => {
  // The cache is validated by content hash rather than by `mtime`, because a formatter or a
  // `git checkout` can rewrite a file within the same timestamp tick and with the same length.
  const dir = makeRepo(t, 3, (index) => `export const a${index} = 111;\n`);
  const target = path.join(dir, "src", "f1.ts");

  const before = fs.statSync(target);
  const first = generateSnapshot(configFor(dir));

  fs.writeFileSync(target, "export const a1 = 222;\n", "utf8");
  fs.utimesSync(target, before.atime, before.mtime);
  assert.equal(fs.statSync(target).size, before.size, "the file is the same length as before");

  const second = generateSnapshot(configFor(dir));
  const was = first.files.find((entry) => entry.relativePath === "src/f1.ts");
  const now = second.files.find((entry) => entry.relativePath === "src/f1.ts");
  assert.notEqual(now.hashSha256, was.hashSha256, "the new content is in the snapshot");
  const part = fs.readFileSync(path.join(dir, "snapshot", "parts", now.part), "utf8");
  assert.match(part, /222/);
});

test("a changed setting invalidates the derivation", (t) => {
  const body = "export const long = 1;\n".repeat(120);
  const dir = makeRepo(t, 2, () => body);

  const full = generateSnapshot(configFor(dir, { largeFileBytes: 100_000 }));
  assert.equal(
    full.files.find((file) => file.relativePath === "src/f0.ts").inclusionMode,
    "full"
  );

  // Same bytes, different settings: the cache key includes the settings digest, so this cannot
  // reuse the full-body derivation.
  const previewed = generateSnapshot(
    configFor(dir, { largeFileBytes: 100, previewHeadLines: 2, previewTailLines: 1 })
  );
  const file = previewed.files.find((entry) => entry.relativePath === "src/f0.ts");
  assert.equal(file.inclusionMode, "preview");
  assert.ok(file.includedBytes < file.sizeBytes);
});

test("a warm run is much faster than a cold one", (t) => {
  // The point of the cache, and the fixture is chosen so the *ratio* does not depend on how loaded
  // the machine is. Twenty files of 4 000 lines each: almost all of the cold cost is per line — the
  // masking pass runs 31 rules over every line, and the parser builds an AST for the whole file —
  // while almost all of the warm cost is per byte, which is reading, hashing and partitioning. A
  // fixture of many *small* files would spend most of both runs in per-file open/stat/write, and the
  // ratio would then be at the mercy of the filesystem.
  const dir = makeRepo(t, 20, (index) => {
    const body = Array.from(
      { length: 4000 },
      (_value, line) =>
        `  const value${line} = compute(${index} + ${line}) * ${line}; // padding for the parser`
    ).join("\n");
    return `import { compute } from "./helpers.js";\n\nexport function work${index}(): number {\n${body}\n  return value0;\n}\n`;
  });
  fs.writeFileSync(path.join(dir, "src", "helpers.ts"), "export const compute = (n: number) => n;\n");

  const clock = () => performance.now();
  const cold = clock();
  generateSnapshot(configFor(dir));
  const coldMs = clock() - cold;

  const warm = clock();
  generateSnapshot(configFor(dir));
  const warmMs = clock() - warm;

  assert.ok(
    warmMs < coldMs / 3,
    `a warm run should be at least 3x faster (cold ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms)`
  );
});
