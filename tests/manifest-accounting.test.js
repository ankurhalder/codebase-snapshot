import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot } from "../dist/index.js";

/**
 * 4.1.0 regression cover for the manifest's byte and line accounting.
 *
 * Three separate off-by-a-little errors, all of them the manifest describing the file the
 * generator *read* rather than the block the reader *gets*:
 *   - `includedBytes` counted the final newline that the closing fence swallows (−1 for almost
 *     every file);
 *   - a CRLF checkout is written as LF, so `includedBytes` over-counted one byte per line;
 *   - a bounded preview reported the constant `head + tail + 1` lines, one more than the block.
 *
 * The invariant below is the one that matters and it is checked on every file in every part: the
 * numbers in the manifest must equal the bytes and lines inside that file's fenced block.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-accounting-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content, encoding = "utf8") {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, encoding);
  return target;
}

/** Cuts every `### FILE:` section out of a part and returns its fenced body. */
function fencedBodies(markdown) {
  const sections = markdown.split("\n### FILE: ");
  const found = new Map();
  for (const raw of sections.slice(1)) {
    const lines = raw.split("\n");
    const filePath = lines[0].trim();
    const banner = lines.findIndex(
      (line) => line === "#### Content" || line === "#### Bounded Preview"
    );
    if (banner === -1) continue;
    const fenceLine = lines[banner + 2];
    const fence = (fenceLine.match(/^`+/) ?? [""])[0];
    if (!fence) continue;

    // Scan forward to the closing fence. Scanning backwards from the end of the chunk would work
    // only for the last section: each section is preceded by its own `<a id=…>` anchor, which
    // belongs to the *previous* chunk and would be counted as body.
    let closing = banner + 3;
    while (closing < lines.length && lines[closing] !== fence) closing += 1;
    const bodyLines = lines.slice(banner + 3, closing);
    found.set(filePath, { body: bodyLines.join("\n"), lines: bodyLines.length });
  }
  return found;
}

test("the manifest's byte and line counts equal the emitted block, for every file", (t) => {
  const dir = tempDir(t);
  write(dir, "src/plain.ts", "export const a = 1;\n");
  write(dir, "src/no-newline.ts", "export const b = 2;");
  write(dir, "src/multibyte.ts", 'export const s = "héllo 🚀";\n');
  fs.writeFileSync(
    path.join(dir, "src/crlf.ts"),
    "export const c = 1;\r\nexport const d = 2;\r\nexport const e = 3;\r\n"
  );
  // Large enough to be emitted as a bounded preview rather than a whole body.
  write(dir, "src/big.ts", "export const v = 1;\n".repeat(20_000));

  const manifest = generateSnapshot({ cwd: dir });

  const bodies = new Map();
  for (const part of manifest.parts) {
    const file = path.join(dir, "snapshot", "parts", part.filename);
    for (const [filePath, block] of fencedBodies(fs.readFileSync(file, "utf8"))) {
      bodies.set(filePath, block);
    }
  }

  assert.ok(bodies.size > 0, "at least one part was parsed");

  for (const entry of manifest.files) {
    const block = bodies.get(entry.relativePath);
    assert.ok(block, `no fenced block found for ${entry.relativePath}`);

    assert.equal(
      Buffer.byteLength(block.body, "utf8"),
      entry.includedBytes,
      `${entry.relativePath}: includedBytes must equal the bytes in the block`
    );
    assert.equal(
      block.lines,
      entry.includedLines,
      `${entry.relativePath}: includedLines must equal the lines in the block`
    );
    assert.doesNotMatch(block.body, /\r/, `${entry.relativePath}: the block is written with LF`);
  }
});

test("the three specific off-by-a-little cases", (t) => {
  const dir = tempDir(t);
  write(dir, "plain.ts", "export const a = 1;\n");
  write(dir, "no-newline.ts", "export const b = 2;");
  fs.writeFileSync(path.join(dir, "crlf.ts"), "one\r\ntwo\r\nthree\r\n");
  write(dir, "big.ts", "export const v = 1;\n".repeat(20_000));

  const manifest = generateSnapshot({ cwd: dir });
  const entry = (name) => manifest.files.find((file) => file.relativePath === name);

  // F1: the closing fence swallows exactly one newline.
  assert.equal(entry("plain.ts").includedBytes, Buffer.byteLength("export const a = 1;"));
  assert.equal(entry("no-newline.ts").includedBytes, Buffer.byteLength("export const b = 2;"));

  // F2: CRLF is normalised before the block is written.
  const crlf = entry("crlf.ts");
  assert.equal(crlf.includedBytes, Buffer.byteLength("one\ntwo\nthree"));
  assert.equal(crlf.includedLines, 3);

  // F3: a bounded preview reports the lines it actually carries.
  const big = entry("big.ts");
  assert.equal(big.inclusionMode, "preview");
  const parsed = fencedBodies(
    fs.readFileSync(path.join(dir, "snapshot", "parts", big.part), "utf8")
  ).get("big.ts");
  assert.equal(big.includedLines, parsed.lines);
});

test("a file clipped by the part budget still matches its block", (t) => {
  const dir = tempDir(t);
  // 200 KB of source with a 4 KB part budget: the section is truncated by the budget, not by
  // `largeFileBytes`, and the numbers must still describe what survived.
  write(dir, "clipped.ts", "export const v = 1;\n".repeat(20_000));

  // `largeFileBytes` is raised above the fixture so preview truncation does NOT run first: the
  // part budget must be the only thing that clips it, which is the case this test exists for.
  const manifest = generateSnapshot({ cwd: dir, maxPartBytes: 4096, largeFileBytes: 10_000_000 });
  const entry = manifest.files.find((file) => file.relativePath === "clipped.ts");
  assert.ok(entry, "the file is in the manifest");
  assert.equal(entry.inclusionMode, "preview", "the budget, not the size threshold, clipped it");

  const block = fencedBodies(
    fs.readFileSync(path.join(dir, "snapshot", "parts", entry.part), "utf8")
  ).get("clipped.ts");
  assert.ok(block, "the block is present");
  assert.equal(Buffer.byteLength(block.body, "utf8"), entry.includedBytes);
  assert.equal(block.lines, entry.includedLines);
  assert.ok(
    Buffer.byteLength(block.body, "utf8") < entry.sizeBytes,
    "the emitted body really is smaller than the source"
  );
});
// ---------------------------------------------- fingerprint: recorded settings
// The fingerprint used to hash the file list alone, so two runs with different settings shared
// it while their parts differed. It now folds in `configDigest`, and the manifest records the
// digest it used, which makes the value reproducible from the manifest itself.

test("the fingerprint is a digest of the file list and the recorded settings digest", (t) => {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"fixture","version":"1.0.0"}');
  write(dir, "src/a.ts", "export const a = 1;\n");
  const manifest = generateSnapshot({ cwd: dir });

  // The per-file line deliberately omits `inclusionMode`: the partitioner can change a file's
  // mode after the fingerprint is computed (a body clipped by the part budget becomes
  // `preview`), which made the value impossible to reproduce from the manifest. The settings
  // digest still distinguishes every mode-changing setting. The trailing line names the recorded
  // digest.
  const recomputed = crypto
    .createHash("sha256")
    .update(
      [
        ...manifest.files.map(
          (file) => `${file.relativePath}:${file.hashSha256}:${file.sizeBytes}`
        ),
        `settings:${manifest.config.digest}`,
      ].join("\n")
    )
    .digest("hex");
  assert.equal(manifest.fingerprint, recomputed, "the fingerprint must be reproducible from the manifest");
  assert.match(manifest.fingerprint, /^[0-9a-f]{64}$/);

  const same = generateSnapshot({ cwd: dir, outDir: "again" });
  assert.equal(same.fingerprint, manifest.fingerprint, "unchanged input and settings keep it identical");

  const other = generateSnapshot({ cwd: dir, outDir: "other", maxPartBytes: 4096 });
  assert.notEqual(other.fingerprint, manifest.fingerprint, "a changed setting must move it");
});
