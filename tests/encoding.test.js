import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  countInvalidUtf8Bytes,
  decodeText,
  generateSnapshot,
  validateSnapshot,
} from "../dist/index.js";

/**
 * 4.0.9 regression cover for the encoding cluster.
 *
 * Three separate silent lies were possible before this file existed:
 *   ENC-02 a UTF-16 source file was skipped as `binary`, so real code vanished from the snapshot;
 *   ENC-01 a file that is not valid UTF-8 was emitted with U+FFFD in place of its bytes, and
 *          `validate` then called the corrupted snapshot "current";
 *   ENC-05 the NUL scan stopped at 8 MB, so a NUL beyond that was emitted as text.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-encoding-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeBytes(base, relativePath, bytes) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

const generate = (dir, overrides = {}) => generateSnapshot({ cwd: dir, ...overrides });
const validate = (dir) =>
  validateSnapshot({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" });

const entryFor = (manifest, relativePath) =>
  manifest.files.find((file) => file.relativePath === relativePath);

// ------------------------------------------------------------------ unit level

test("decodeText: plain ASCII and multi-byte UTF-8 stay utf-8", () => {
  const ascii = decodeText(Buffer.from("const answer = 42;\n", "utf8"));
  assert.equal(ascii.encoding, "utf-8");
  assert.equal(ascii.binary, false);
  assert.equal(ascii.text, "const answer = 42;\n");

  // A 4-byte sequence (emoji) and a 2-byte one (é) must not be mistaken for invalid input.
  const multiByte = decodeText(Buffer.from("café 🚀\n", "utf8"));
  assert.equal(multiByte.encoding, "utf-8");
  assert.equal(multiByte.invalidBytes, 0);
  assert.equal(multiByte.text, "café 🚀\n");
});

test("decodeText: a UTF-8 BOM is not carried into the body", () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\n", "utf8")]);
  const decoded = decodeText(withBom);
  assert.equal(decoded.encoding, "utf-8");
  assert.equal(decoded.text, "hello\n");
});

test("decodeText: UTF-16 with a BOM is transcoded, not reported as binary", () => {
  const littleEndian = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("const a = 1;\n", "utf16le"),
  ]);
  const decodedLe = decodeText(littleEndian);
  assert.equal(decodedLe.binary, false);
  assert.equal(decodedLe.encoding, "utf-16le");
  assert.equal(decodedLe.text, "const a = 1;\n");

  const bigEndianBody = Buffer.from("const b = 2;\n", "utf16le").swap16();
  const decodedBe = decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndianBody]));
  assert.equal(decodedBe.binary, false);
  assert.equal(decodedBe.encoding, "utf-16be");
  assert.equal(decodedBe.text, "const b = 2;\n");
});

test("decodeText: UTF-16 without a BOM is recognised by its NUL padding", () => {
  const body = Buffer.from("no bom here\n", "utf16le");
  const decoded = decodeText(body);
  assert.equal(decoded.binary, false);
  assert.equal(decoded.encoding, "utf-16le");
  assert.equal(decoded.text, "no bom here\n");
});

test("decodeText: a NUL outside UTF-16 marks the buffer binary and reports the offset", () => {
  const bytes = Buffer.concat([Buffer.from("text"), Buffer.from([0]), Buffer.from("more")]);
  const decoded = decodeText(bytes);
  assert.equal(decoded.binary, true);
  assert.equal(decoded.binaryOffset, 4);
  assert.equal(decoded.text, "");
});

test("decodeText: invalid UTF-8 becomes utf-8-lossy with a counted byte budget", () => {
  // 0xE9 is the last byte of a 3-byte sequence but arrives alone: a Latin-1 "é".
  const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  assert.equal(countInvalidUtf8Bytes(bytes), 1);

  const decoded = decodeText(bytes);
  assert.equal(decoded.binary, false);
  assert.equal(decoded.encoding, "utf-8-lossy");
  assert.equal(decoded.invalidBytes, 1);
  assert.match(decoded.text, /caf\uFFFD/);
});

test("countInvalidUtf8Bytes: truncated, overlong and surrogate sequences all count", () => {
  assert.equal(countInvalidUtf8Bytes(Buffer.from([0x61, 0x62, 0x63])), 0);
  assert.equal(countInvalidUtf8Bytes(Buffer.from([0xe2, 0x82])), 2, "truncated 3-byte sequence");
  assert.equal(countInvalidUtf8Bytes(Buffer.from([0xc0, 0xaf])), 2, "overlong two-byte encoding");
  assert.equal(countInvalidUtf8Bytes(Buffer.from([0xed, 0xa0, 0x80])), 3, "encoded surrogate");
  assert.equal(countInvalidUtf8Bytes(Buffer.from([0x80])), 1, "lone continuation byte");
  // A broken lead must not swallow the valid byte that follows it.
  assert.equal(countInvalidUtf8Bytes(Buffer.from([0xe9, 0x0a])), 1, "lead followed by a newline");
});

// ------------------------------------------------------------- generated output

test("ENC-02: UTF-16 source files are included, transcoded and labelled", (t) => {
  const dir = tempDir(t);
  writeBytes(
    dir,
    "utf16le.ts",
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("export const le = 1;\n", "utf16le")])
  );
  writeBytes(
    dir,
    "utf16be.ts",
    Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from("export const be = 2;\n", "utf16le").swap16(),
    ])
  );
  writeBytes(dir, "plain.ts", Buffer.from("export const plain = 3;\n", "utf8"));

  const manifest = generate(dir);

  assert.deepEqual(manifest.skipped, [], "a UTF-16 file must not be recorded as binary");

  const le = entryFor(manifest, "utf16le.ts");
  const be = entryFor(manifest, "utf16be.ts");
  assert.ok(le, "utf16le.ts is in the snapshot");
  assert.ok(be, "utf16be.ts is in the snapshot");
  assert.equal(le.encoding, "utf-16le");
  assert.equal(be.encoding, "utf-16be");
  // The bodies reach the part document, not just the manifest entry: `content` is dropped once
  // the partitioner has rendered it, so the part file is the honest place to look.
  const partText = fs.readFileSync(path.join(dir, "snapshot", "parts", le.part), "utf8");
  assert.match(partText, /export const le = 1;/);
  assert.match(partText, /export const be = 2;/);
  assert.equal(le.lines, 1);

  // The transcode is announced once per encoding class and names the files.
  const transcoded = manifest.warnings.filter((warning) => /transcoded to UTF-8/.test(warning));
  assert.equal(transcoded.length, 2);
  assert.ok(transcoded.some((warning) => warning.includes("utf16le.ts")));
  assert.ok(transcoded.some((warning) => warning.includes("utf16be.ts")));

  // A plain UTF-8 file stays unlabelled — absence of `encoding` means UTF-8.
  assert.equal(entryFor(manifest, "plain.ts").encoding, undefined);
});

test("ENC-01: a non-UTF-8 file is kept, flagged and named in a warning", (t) => {
  const dir = tempDir(t);
  // "café\n" written in Latin-1: 0xE9 is not valid UTF-8.
  writeBytes(dir, "latin1.ts", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  writeBytes(dir, "clean.ts", Buffer.from("export const x = 1;\n", "utf8"));

  const manifest = generate(dir);
  const entry = entryFor(manifest, "latin1.ts");

  assert.ok(entry, "the file is not dropped for being lossy");
  assert.equal(entry.encoding, "utf-8-lossy");
  assert.equal(manifest.skipped.length, 0);

  const warning = manifest.warnings.find((message) => /not valid UTF-8/.test(message));
  assert.ok(warning, "the lossy decode is reported");
  assert.match(warning, /latin1\.ts/);
  assert.match(warning, /1 undecodable byte/);
});

test("ENC-01: the corrupted snapshot is still reported as current, and says why", (t) => {
  const dir = tempDir(t);
  writeBytes(dir, "latin1.ts", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));

  generate(dir);
  const result = validate(dir);

  // The hash covers the raw bytes, so validation must not raise phantom drift...
  assert.equal(result.valid, true, "raw-byte hashing keeps validation stable");
  // ...but the reason the artifact is lossy travels with the manifest.
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
  assert.equal(manifest.files[0].encoding, "utf-8-lossy");
});

test("ENC-05: a NUL beyond the 8 MB head scan is still treated as binary", (t) => {
  const dir = tempDir(t);
  const size = 8 * 1024 * 1024 + 64;
  const bytes = Buffer.alloc(size, 0x61);
  bytes[8 * 1024 * 1024] = 0;
  writeBytes(dir, "late-nul.txt", bytes);
  writeBytes(dir, "notes.md", Buffer.from("# notes\n", "utf8"));

  const manifest = generate(dir);

  assert.equal(entryFor(manifest, "late-nul.txt"), undefined, "the file is not emitted as text");
  const record = manifest.skipped.find((skip) => skip.path === "late-nul.txt");
  assert.ok(record, "the skip is recorded");
  assert.equal(record.reason, "binary");
  assert.match(record.detail, /NUL byte at offset 8388608/);
});

test("a UTF-16 file keeps a stable hash across runs, so validate does not drift", (t) => {
  const dir = tempDir(t);
  writeBytes(
    dir,
    "stable.ts",
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("export const s = 1;\n", "utf16le")])
  );

  const first = generate(dir);
  const second = generate(dir);

  assert.equal(entryFor(first, "stable.ts").hashSha256, entryFor(second, "stable.ts").hashSha256);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(validate(dir).valid, true);
});
