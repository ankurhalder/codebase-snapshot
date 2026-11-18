/**
 * Property checks for the two parsers every snapshot depends on.
 *
 * The part writer and the part reader are separate pieces of code, and the renderer normalises
 * line endings and drops the closing newline before the reader ever sees the text. Random content —
 * including lines that look like headings, fence runs longer than four and CRLF — is the cheap way
 * to find the case a hand-written fixture forgot. The redaction pass is checked the other way:
 * feeding its own output back in must change nothing and find nothing.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  DEFAULT_SECRET_PATTERNS,
  anchorForPath,
  generateSnapshot,
  resolveConfig,
  scanAndRedactSecrets,
} from "../dist/index.js";
import { findSection, parsePartSections } from "../dist/mcp.js";

/** Deterministic PRNG so a failure is a reproducible case, not a one-off. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const TICK = String.fromCharCode(96);
const TOKENS = [
  "export const value = 1;",
  TICK.repeat(3),
  TICK.repeat(4),
  TICK.repeat(5),
  "### FILE: src/fake.ts",
  "#### Content",
  "---",
  "const x = 1;",
  "héllo wörld",
  "\u0000not-really",
  "  ",
  "function alpha() { return 1; }",
];

function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fuzz-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

const expectedBody = (content) => {
  const normalised = content.replace(/\r\n|\r/g, "\n");
  return normalised.endsWith("\n") ? normalised.slice(0, -1) : normalised;
};

test("random source files round-trip through the part writer and reader", (t) => {
  const next = random(0x5eed);
  const files = { "package.json": '{"name":"fuzz","version":"1.0.0"}\n' };
  for (let index = 0; index < 12; index += 1) {
    const lines = [];
    const count = 1 + Math.floor(next() * 30);
    for (let line = 0; line < count; line += 1) {
      lines.push(TOKENS[Math.floor(next() * TOKENS.length)] + next().toString(36).slice(2, 6));
    }
    const newline = next() < 0.3 ? "\r\n" : "\n";
    const trailing = next() < 0.8 ? newline : "";
    files["src/fuzz-" + index + ".ts"] = lines.join(newline) + trailing;
  }

  const root = makeRepo(t, files);
  const config = resolveConfig(
    { cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", maxPartBytes: 65536 },
    {},
    root
  );
  const manifest = generateSnapshot(config);
  const sections = [];
  const anchors = new Set();
  for (const part of manifest.parts) {
    const parsed = parsePartSections(fs.readFileSync(path.join(root, "snapshot", "parts", part.filename), "utf8"));
    assert.equal(parsed.length, part.fileCount, part.filename + " section count");
    for (const section of parsed) {
      assert.ok(section.anchor !== null, "every section has an anchor");
      assert.equal(anchors.has(section.anchor), false, "anchors are unique");
      anchors.add(section.anchor);
      sections.push(section);
    }
  }
  for (const file of manifest.files) {
    if (file.inclusionMode !== "full") continue;
    const section = findSection(sections, file.relativePath);
    assert.ok(section, file.relativePath + " has a section");
    assert.equal(section.anchor, anchorForPath(file.relativePath));
    assert.equal(section.body, expectedBody(files[file.relativePath]), file.relativePath + " body");
    assert.equal(Buffer.byteLength(section.body, "utf8"), file.includedBytes);
  }
});

test("redaction is idempotent across generated credential shapes", () => {
  const next = random(0xc0ffee);
  const shapes = [
    () => 'password: "' + next().toString(36).slice(2) + '"',
    () => "token: sk_live_" + next().toString(36).slice(2).repeat(3),
    () => "AKIA" + "ABCDEFGHIJKLMNOP".slice(0, 16),
    () => "-----BEGIN RSA PRIVATE KEY-----",
    () => "MIIEowIBAAKCAQEA" + next().toString(36).toUpperCase().repeat(3),
    () => "-----END RSA PRIVATE KEY-----",
    () => "The marker reads [REDACTED: potential secret-like value omitted from snapshot]",
    () => "export const harmless = " + Math.floor(next() * 1000) + ";",
  ];
  for (let round = 0; round < 40; round += 1) {
    const lines = [];
    for (let index = 0; index < 8; index += 1) lines.push(shapes[Math.floor(next() * shapes.length)]());
    const text = lines.join("\n") + "\n";
    const first = scanAndRedactSecrets(text, DEFAULT_SECRET_PATTERNS, ".gitguardian.yaml");
    const second = scanAndRedactSecrets(first.redacted, DEFAULT_SECRET_PATTERNS, ".gitguardian.yaml");
    assert.equal(second.redacted, first.redacted, "a second pass changes nothing");
    assert.deepEqual(second.findings, [], "a second pass finds nothing: the marker is not a secret");
  }
});
