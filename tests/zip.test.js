/**
 * The zip writer: stored entries, no dependency, openable by the operating system.
 *
 * The test parses the archive back the way an extractor does — end record, central directory,
 * then each local header — so a byte-offset mistake fails here rather than in a user's Downloads
 * folder. PowerShell's Expand-Archive is exercised once, manually, in the release notes.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { writeZip, crc32 } from "../dist/index.js";

function readCentral(buffer) {
  const endOffset = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(endOffset), 0x06054b50, "end of central directory");
  const count = buffer.readUInt16LE(endOffset + 10);
  const size = buffer.readUInt32LE(endOffset + 12);
  const start = buffer.readUInt32LE(endOffset + 16);
  assert.equal(start + size, endOffset, "the central directory ends where the end record begins");

  const entries = [];
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, "central header");
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, "local header for " + name);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtra;
    const data = buffer.slice(dataStart, dataStart + uncompressed);
    assert.equal(crc32(data), crc, "crc matches for " + name);

    entries.push({ name, size: uncompressed, compressed, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("an archive round-trips names, sizes and bytes", () => {
  const zip = writeZip({
    entries: [
      { name: "a.txt", content: Buffer.from("hello", "utf8") },
      { name: "nested/b.md", content: Buffer.from("# b\n", "utf8") },
    ],
  });
  const entries = readCentral(zip);
  assert.deepEqual(entries.map((entry) => entry.name), ["a.txt", "nested/b.md"]);
  assert.equal(entries[0].data.toString("utf8"), "hello");
  assert.equal(entries[1].data.toString("utf8"), "# b\n");
  assert.equal(entries[0].compressed, entries[0].size, "stored, not deflated");
});

test("a directory becomes one entry per file, with forward slashes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zip-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "parts"), { recursive: true });
  fs.writeFileSync(path.join(root, "manifest.json"), "{}");
  fs.writeFileSync(path.join(root, "parts", "part-001.md"), "# Codebase Snapshot Part 001 of 001\n");

  const zip = writeZip({ directory: root });
  const entries = readCentral(zip);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [
    "manifest.json",
    "parts/part-001.md",
  ]);
  assert.match(entries.find((entry) => entry.name.endsWith("part-001.md")).data.toString("utf8"), /Snapshot Part 001/);
});

test("crc32 matches the standard vector", () => {
  assert.equal(crc32(Buffer.from("123456789", "utf8")), 0xcbf43926);
});
