import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { countLines, generateSnapshot, resolveConfig, scanAndRedactSecrets } from "../dist/index.js";
import { DEFAULT_SECRET_PATTERNS } from "../dist/index.js";
import { parsePartSections } from "../dist/mcp.js";

/**
 * 0.9.14 — three ways the generator edited text it had no business editing.
 *
 * 1. The PEM block pattern is lazy over `[\s\S]`, which means it has no opinion about what lies
 *    between a `BEGIN` and the next `END` — including a second `BEGIN`. A file holding an
 *    unterminated key fixture and, later, a terminated one had every line in between replaced by
 *    blank lines. The generator did this to its own test suite.
 * 2. Line counts and preview truncation understood only `\n`, so a CR-only file was one line:
 *    `largeFileBytes` never fired and the whole file went into a part with its CRs intact.
 * 3. The last-resort section truncation cut the rendered Markdown at a byte offset, which lands
 *    inside the code fence — leaving it open, so every following file in that part was swallowed
 *    into the truncated file's code block.
 */

function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redaction-cr-"));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  for (const [name, body] of Object.entries(files)) {
    const absolute = path.join(root, name);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, body);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const configFor = (root, extra = {}) =>
  resolveConfig({ cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", ...extra }, {}, root);

// ---------------------------------------------------------------------------
// 1.1 — a PEM block may not bridge across another PEM block
// ---------------------------------------------------------------------------

/**
 * The shape that did the damage: an unterminated `BEGIN`, four lines of source, then a complete
 * block. The lazy match ran from the first `BEGIN` to the *second* block's `END` and swallowed
 * the source in between.
 */
const BRIDGING_FIXTURE = [
  'test("unterminated key fixture", () => {',
  '  const header = "-----BEGIN RSA PRIVATE KEY-----";',
  '  assert.equal(header.length, 31);',
  "});",
  "",
  'test("terminated key fixture", () => {',
  '  const key = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA\\n-----END RSA PRIVATE KEY-----";',
  "  assert.ok(key.includes('PRIVATE'));",
  "});",
].join("\n");

test("a PEM block does not bridge an unterminated header into the next block", () => {
  const { redacted } = scanAndRedactSecrets(BRIDGING_FIXTURE, DEFAULT_SECRET_PATTERNS, "keys.test.js");

  assert.match(
    redacted,
    /assert\.equal\(header\.length, 31\);/,
    "the assertion that sat between the two headers must survive verbatim"
  );
  assert.match(
    redacted,
    /assert\.ok\(key\.includes\('PRIVATE'\)\);/,
    "the second test's body must survive too"
  );
  assert.match(redacted, /test\("terminated key fixture"/, "the second test's own header survives");
  assert.doesNotMatch(redacted, /MIIEowIBAAKCAQEA/, "the terminated block's body is still masked");
});

test("a single terminated block is still masked as one unit", () => {
  const source = [
    "const key = [",
    '  "-----BEGIN RSA PRIVATE KEY-----",',
    '  "MIIEowIBAAKCAQEAabcdefghijklmnop",',
    '  "-----END RSA PRIVATE KEY-----",',
    "].join('\\n');",
    "const after = 1;",
  ].join("\n");
  const { redacted, findings } = scanAndRedactSecrets(source, DEFAULT_SECRET_PATTERNS, "k.js");

  assert.equal(findings.length, 1);
  assert.match(redacted, /private key block omitted/, "the block is replaced by one marker");
  assert.doesNotMatch(redacted, /MIIEowIBAAKCAQEA/, "no body line survives");
  assert.match(redacted, /const after = 1;/, "and the line after it is untouched");
});

test("a one-line escaped PEM in JSON is still masked whole", () => {
  // The block pattern must not require a real newline after the header: `\n` inside a JSON string
  // is two characters, and a rule that insisted on a line break would mask the header alone and
  // leave the base64 body in the snapshot.
  const source =
    '{"privateKey":"-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEAabcdefghij\\n-----END RSA PRIVATE KEY-----"}';
  const { redacted } = scanAndRedactSecrets(source, DEFAULT_SECRET_PATTERNS, "config.json");

  assert.doesNotMatch(redacted, /MIIEowIBAAKCAQEAabcdefghij/, "the escaped body must be masked too");
  assert.match(redacted, /REDACTED/, "and something is masked in its place");
});

// ---------------------------------------------------------------------------
// 1.6 — CR-only line endings
// ---------------------------------------------------------------------------

const CR_FILE = ["alpha", "beta", "gamma", "delta", "epsilon", ""].join("\r");

test("countLines counts CR-terminated lines", () => {
  assert.equal(countLines(CR_FILE), 5);
  assert.equal(countLines("one\rtwo\r"), 2);
  assert.equal(countLines("one\r\ntwo\r\n"), 2, "CRLF is still two lines");
  assert.equal(countLines(""), 0);
});

test("a CR-only file over largeFileBytes is previewed and emitted with LF endings", (t) => {
  const body = Array.from({ length: 400 }, (_value, index) => `line ${index} of a CR-only file`).join(
    "\r"
  );
  const root = makeRepo(t, { "src/big.txt": `${body}\r` });

  const manifest = generateSnapshot(
    configFor(root, { largeFileBytes: 1024, previewHeadLines: 3, previewTailLines: 2 })
  );
  const file = manifest.files.find((entry) => entry.relativePath === "src/big.txt");

  assert.equal(file.isPreviewTruncated, true, "the preview budget must apply to a CR-only file");
  assert.equal(file.inclusionMode, "preview");
  assert.equal(file.originalLines, 400, "the manifest must report the real line count");

  const part = fs.readFileSync(path.join(root, "snapshot", "parts", file.part), "utf8");
  assert.doesNotMatch(part, /\r/, "no carriage return reaches an artifact");
  assert.match(part, /lines omitted/, "and the file says it was cut");
});

// ---------------------------------------------------------------------------
// 1.7 — the last-resort section truncation must not leave a code fence open
// ---------------------------------------------------------------------------

test("a hard-truncated section keeps a closed code fence and stays readable", (t) => {
  // `fenceForContent` picks a fence one character longer than the longest backtick run in the
  // body, so a body of 1800 backticks needs a 1652-character fence at both ends — which is more
  // than the section budget can hold once the fixed metadata is counted. That is the path that
  // hard-truncates the *rendered* section, and it used to cut the closing fence off: the section
  // ended inside a code block that never closed.
  const root = makeRepo(t, {
    "src/a-backticks.md": "`".repeat(1800),
    "src/b-after.md": "the file after the truncated one\n",
  });

  const manifest = generateSnapshot(
    configFor(root, { maxPartBytes: 6000, include: ["src/a-backticks.md", "src/b-after.md"] })
  );

  let sawTruncated = false;
  for (const part of manifest.parts) {
    const markdown = fs.readFileSync(path.join(root, "snapshot", "parts", part.filename), "utf8");
    const sections = parsePartSections(markdown);
    assert.equal(
      sections.length,
      part.fileCount,
      `${part.filename} is readable: every file the manifest says it holds is a section`
    );
    if (markdown.includes("section truncated")) sawTruncated = true;
  }
  assert.equal(sawTruncated, true, "the budget was tight enough to force the truncation");
});

test("no part leaves a code fence open", (t) => {
  // The invariant behind the reader test: count the fence delimiters in each part. Every part
  // opens and closes its blocks, whatever the truncation did to the bodies.
  const root = makeRepo(t, {
    "src/a-backticks.md": "`".repeat(1800),
    "src/b-after.md": "```js\nconst x = 1;\n```\n",
    "src/c-normal.md": "# heading\n",
  });

  const manifest = generateSnapshot(
    configFor(root, {
      maxPartBytes: 6000,
      include: ["src/a-backticks.md", "src/b-after.md", "src/c-normal.md"],
    })
  );

  for (const part of manifest.parts) {
    const markdown = fs.readFileSync(path.join(root, "snapshot", "parts", part.filename), "utf8");
    const fenceLines = markdown
      .split("\n")
      .filter((line) => /^`{4,}[a-z]*$/.test(line))
      .map((line) => line.replace(/[a-z]/g, ""));
    assert.equal(
      fenceLines.length % 2,
      0,
      `${part.filename} has an even number of 4+-backtick delimiter lines`
    );
  }
});
