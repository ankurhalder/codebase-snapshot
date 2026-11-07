import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, resolveConfig } from "../dist/index.js";

/**
 * What counts as text, decided once on the bytes that were read.
 *
 * `generate` used to ask twice: `isBinaryFile` opened the file, chunk-read it looking for
 * a NUL, and then the file was read again in full and scanned again by `decodeText`.
 * The pre-scan now only runs above the 8 MB cap, where loading the file to answer the
 * question is the thing to avoid. This suite pins the decisions that refactor must not
 * change — including the two cases only `decodeText` can see: a NUL past a head sample,
 * and a valid-UTF-8 payload that is control bytes rather than text.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "binary-detect-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function build(dir) {
  const write = (relative, content) => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };

  write("package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write("src/plain.ts", "export const plain = 1;\n");
  // A NUL well past any head sample.
  write("data/embedded.bin", Buffer.concat([Buffer.alloc(100_000, 0x41), Buffer.from([0]), Buffer.from("tail")]));
  // Valid UTF-8, no NUL, but not text.
  write("data/controls.bin", Buffer.alloc(4096, 0x07));
  // UTF-16 with a BOM is text and must be transcoded, not skipped.
  write("src/wide.ts", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("export const w = 1;\n", "utf16le")]));
  // A binary extension is refused without reading at all.
  write("assets/logo.png", Buffer.from("not really a png"));

  return resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" });
}

test("generate classifies text and binary content the same way after the refactor", (t) => {
  const dir = tempDir(t);
  const config = build(dir);

  const manifest = generateSnapshot(config);
  const included = manifest.files.map((file) => file.relativePath).sort();
  const skippedBinary = manifest.skipped
    .filter((entry) => entry.reason === "binary")
    .map((entry) => entry.path)
    .sort();

  assert.ok(included.includes("src/plain.ts"), "plain source is included");
  assert.ok(included.includes("src/wide.ts"), "a UTF-16 file is transcoded, not skipped");
  assert.deepEqual(skippedBinary, ["assets/logo.png", "data/controls.bin", "data/embedded.bin"]);
  // The reason is more specific than a size, which is what the single decode buys.
  const controls = manifest.skipped.find((entry) => entry.path === "data/controls.bin");
  assert.match(String(controls?.detail), /control byte|not text/);
  const embedded = manifest.skipped.find((entry) => entry.path === "data/embedded.bin");
  assert.match(String(embedded?.detail), /NUL byte at offset 100000/);
});
