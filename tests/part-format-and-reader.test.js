import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { anchorForPath, generateSnapshot, resolveConfig } from "../dist/index.js";
import { buildTools, parsePartSections, windowText } from "../dist/mcp.js";

/**
 * What a part costs the reader, from the 0.9.12 audit.
 *
 * The snapshot is prompt material, so every line in `parts/*.md` is paid for out of a context
 * window. Nine metadata bullets and a pretty-printed JSON summary above *every* file cost about
 * 32 000 tokens on this repository — 12 % of the whole snapshot — and most of it repeated code
 * that followed three lines later.
 */

const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
const contextFor = (root) => ({ cwd: root, roots: [root], log: () => {} });
async function call(name, args, context) {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} exists`);
  return tool.handler(args, context);
}

function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "part-format-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const configFor = (root, extra = {}) => {
  const resolved = resolveConfig(
    { cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", ...extra },
    {},
    root
  );
  return resolved;
};

test("a section carries one metadata line, its digest stays in the manifest", (t) => {
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/app.ts": "export const app = 1;\n",
  });
  const manifest = generateSnapshot(configFor(root));
  const partText = fs.readFileSync(path.join(root, "snapshot", "parts", "part-001.md"), "utf8");
  const entry = manifest.files.find((file) => file.relativePath === "src/app.ts");

  assert.match(
    partText,
    /^- Meta: [\w-]+\/[\w-]+ \| [\w-]+ \| full \| \d+ lines? \(\d+ B\)$/m,
    "one compact line replaces the nine bullets"
  );
  for (const removed of [
    "- Layer:",
    "- Kind:",
    "- Language:",
    "- Inclusion:",
    "- Source Bytes:",
    "- Source Lines:",
    "- Included Lines:",
  ]) {
    assert.equal(partText.includes(removed), false, `${removed} is gone from the part`);
  }
  // The digest is a machine-readable fact, not reading material. It stays where a machine reads.
  assert.equal(
    partText.includes(entry.hashSha256),
    false,
    "the per-file SHA-256 must not be printed into the part"
  );
  assert.equal(
    manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.hashSha256)),
    true,
    "and every file still records one in the manifest"
  );
});

test("a full file does not repeat its own summary above itself", (t) => {
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/app.ts": "export function alpha(): number { return 1; }\nexport const beta = 2;\n",
  });
  const manifest = generateSnapshot(configFor(root));
  const partText = fs.readFileSync(path.join(root, "snapshot", "parts", "part-001.md"), "utf8");
  const entry = manifest.files.find((file) => file.relativePath === "src/app.ts");

  assert.ok(entry.summary, "the manifest still carries the structural summary");
  assert.equal(
    partText.includes('"functions"'),
    false,
    "the pretty-printed JSON summary is not printed for a full file"
  );
  assert.match(partText, /- Summary Quality: ast/, "how the summary was produced is still stated");
});

test("a signatures section still carries its summary, because the body is not the file", (t) => {
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/app.ts":
      "export function alpha(a: number): number { const doubled = a * 2; return doubled; }\n" +
      "export const beta = 2;\n",
  });
  generateSnapshot(configFor(root, { skeleton: true }));
  const partText = fs.readFileSync(path.join(root, "snapshot", "parts", "part-001.md"), "utf8");
  assert.match(partText, /\| signatures \|/, "the compact line names the compression");
  assert.match(
    partText,
    /"functions"/,
    "the structural summary survives, because the body no longer lists what the file contains"
  );
  assert.match(partText, /\{ \/\* \.\.\. \*\/ \}/, "and the body really is a signature");
});

test("a preview says how much of the file it holds", (t) => {
  const source = Array.from({ length: 400 }, (_, index) => `export const v${index} = ${index};`).join(
    "\n"
  );
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/big.ts": source,
  });
  generateSnapshot(
    configFor(root, { largeFileBytes: 200, previewHeadLines: 2, previewTailLines: 2 })
  );
  const partText = fs.readFileSync(path.join(root, "snapshot", "parts", "part-001.md"), "utf8");
  assert.match(
    partText,
    /\| preview \| \d+ lines? of 400 lines \(\d+ B\)/,
    "the compact line says what was cut, in one line instead of three"
  );
  assert.match(partText, /#### Bounded Preview/);
});

test("the reader finds a section whose heading had to be capped", (t) => {
  // Two long paths whose rendered headings differ only in the part the cap removes.
  const longPath = `src/${"deeply-nested-directory/".repeat(12)}file.ts`;
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    [longPath]: "export const deep = 1;\n",
  });
  generateSnapshot(configFor(root));
  const partText = fs.readFileSync(path.join(root, "snapshot", "parts", "part-001.md"), "utf8");
  const sections = parsePartSections(partText);

  const target = sections.find((section) => section.anchor === anchorForPath(longPath));
  assert.ok(target, "the anchor line is parsed");
  assert.equal(target.path.length <= 300, true, "and the heading really was capped");
  assert.equal(target.inclusion, "full");
  assert.match(target.body, /export const deep = 1;/);
});

test("snapshot_read states the line range for a preview, and the past-end case", async (t) => {
  const source = Array.from({ length: 300 }, (_, index) => `export const v${index} = ${index};`).join(
    "\n"
  );
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/big.ts": source,
  });
  const context = contextFor(root);
  await call("snapshot_generate", { maxPartBytes: "300k" }, context);
  // A tiny preview budget is set through the config rather than the tool, so write one.
  fs.writeFileSync(
    path.join(root, "snapshot.config.json"),
    JSON.stringify({ preset: "generic", largeFileBytes: 200, previewHeadLines: 3, previewTailLines: 3 })
  );
  await call("snapshot_generate", {}, context);

  const first = await call("snapshot_read", { path: "src/big.ts", lines: 2 }, context);
  assert.match(
    first.text,
    /^Lines 1\u20132 of \d+\.$/m,
    `a window into a preview must still say where it is: ${first.text}`
  );
  assert.match(first.text, /Bounded preview/, "and still say that the body is a preview");

  const past = await call("snapshot_read", { path: "src/big.ts", fromLine: 9000 }, context);
  assert.match(
    past.text,
    /fromLine=9000 is past its end/,
    `asking beyond the end must say so: ${past.text}`
  );
});

test("windowText keeps its own arithmetic straight at the boundary", () => {
  const body = "a\nb\nc";
  assert.equal(windowText(body, 1, 10).totalLines, 3);
  assert.equal(windowText(body, 3, 10).pastEnd, false);
  assert.equal(windowText(body, 4, 10).pastEnd, true);
});

// ---------------------------------------------------------------------------
// The metadata counts, from the 0.9.15 audit.
//
// `compactMetadata` writes `<N lines>[ of <M lines>] (<B> B)` in the last `|`-separated field,
// with English plurals. The reader matched `(\d+) lines` over the whole line, so `1 line (20 B)`
// produced `includedLines: null`, a 1-of-3 skeleton reported the source count (3) instead of the
// emitted one, and a free-form field that happened to read like a count beat the real count.
// The counts now come from the last field, and the `of` form reports its first number — the one
// the manifest records as `includedLines`.

test("a one-line file reports one included line, not null", (t) => {
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/one.ts": "export const one = 1;\n",
  });
  const manifest = generateSnapshot(configFor(root));
  const partText = fs.readFileSync(path.join(root, "snapshot", "parts", "part-001.md"), "utf8");
  const entry = manifest.files.find((file) => file.relativePath === "src/one.ts");

  assert.equal(entry.includedLines, 1, "the manifest records the emitted count");
  assert.match(partText, /^- Meta: [\w-]+\/[\w-]+ \| [\w-]+ \| full \| 1 line \(\d+ B\)$/m);
  const section = parsePartSections(partText).find((candidate) => candidate.path === "src/one.ts");
  assert.ok(section, "the section is parsed");
  assert.equal(section.includedLines, 1, "a singular 1 line is a count, not a missing value");
  assert.equal(section.includedLines, entry.includedLines);
});

test("a twelve-line file reports twelve included lines", (t) => {
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/twelve.ts":
      Array.from({ length: 12 }, (_, index) => "export const v" + index + " = " + index + ";").join("\n") + "\n",
  });
  const manifest = generateSnapshot(configFor(root));
  const partText = fs.readFileSync(path.join(root, "snapshot", "parts", "part-001.md"), "utf8");
  const entry = manifest.files.find((file) => file.relativePath === "src/twelve.ts");

  assert.equal(entry.includedLines, 12);
  assert.match(partText, /\| full \| 12 lines \(\d+ B\)/);
  const section = parsePartSections(partText).find((candidate) => candidate.path === "src/twelve.ts");
  assert.equal(section.includedLines, 12);
});

test("a previewed section reports the emitted count, not the source count", (t) => {
  const source = Array.from(
    { length: 300 },
    (_, index) => "export const v" + index + " = " + index + ";"
  ).join("\n");
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/big.ts": source,
  });
  const manifest = generateSnapshot(
    configFor(root, { largeFileBytes: 200, previewHeadLines: 20, previewTailLines: 19 })
  );
  const partText = fs.readFileSync(path.join(root, "snapshot", "parts", "part-001.md"), "utf8");
  const entry = manifest.files.find((file) => file.relativePath === "src/big.ts");

  assert.equal(entry.inclusionMode, "preview");
  assert.equal(entry.includedLines, 40, "20 head lines + the omission notice + 19 tail lines");
  assert.equal(entry.originalLines, 300);
  assert.match(partText, /\| preview \| 40 lines of 300 lines \(\d+ B\)/);
  const section = parsePartSections(partText).find((candidate) => candidate.path === "src/big.ts");
  assert.equal(section.includedLines, 40, "the first number is what the body holds");
  assert.notEqual(section.includedLines, entry.originalLines, "the source size is not the emitted count");
});

test("a skeleton that collapses to one line reports one, not the source size", (t) => {
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/fn.ts": "export function alpha(): number {\n  return 1;\n}\n",
  });
  const manifest = generateSnapshot(configFor(root, { skeleton: true }));
  const partText = fs.readFileSync(path.join(root, "snapshot", "parts", "part-001.md"), "utf8");
  const entry = manifest.files.find((file) => file.relativePath === "src/fn.ts");

  assert.equal(entry.inclusionMode, "signatures");
  assert.equal(entry.includedLines, 1);
  assert.equal(entry.originalLines, 3);
  assert.match(partText, /\| signatures \| 1 line of 3 lines \(\d+ B\)/);
  const section = parsePartSections(partText).find((candidate) => candidate.path === "src/fn.ts");
  assert.equal(section.includedLines, 1, "the number before \"of\" is the emitted count");
  assert.equal(section.inclusion, "signatures");
});

test("counts are read from the last metadata field, whatever the free-form fields contain", () => {
  const fence = "\u0060".repeat(4);
  const partText = [
    '<a id="a"></a>',
    "### FILE: piped.ts",
    "",
    "- Meta: api|v2/lib | 2 lines | full | 7 lines (120 B)",
    "",
    "#### Content",
    "",
    fence + "typescript",
    "a",
    fence,
    "",
    '<a id="b"></a>',
    "### FILE: numbered2.ts",
    "",
    "- Meta: app2/src | 4 lines | full | 9 lines (90 B)",
    "",
    "#### Content",
    "",
    fence + "typescript",
    "b",
    fence,
    "",
  ].join("\n");

  const sections = parsePartSections(partText);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].path, "piped.ts");
  assert.equal(sections[0].inclusion, "full", "a layer containing a pipe does not shift the inclusion");
  assert.equal(sections[0].includedLines, 7, "the free-form fields before the counts are not counts");
  assert.equal(sections[1].path, "numbered2.ts");
  assert.equal(sections[1].includedLines, 9, "a digit in a layer name is not the count");
});

test("a legacy bullet section still parses, including its included-line count", () => {
  const fence = "\u0060".repeat(4);
  const partText = [
    '<a id="y"></a>',
    "### FILE: legacy.ts",
    "",
    "- Layer: src",
    "- Kind: source",
    "- Language: typescript",
    "- Inclusion: preview",
    "- Source Bytes: 900",
    "- Source Lines: 300",
    "- Included Lines: 40",
    "",
    "#### Bounded Preview",
    "",
    fence + "typescript",
    "x",
    fence,
    "",
  ].join("\n");

  const section = parsePartSections(partText)[0];
  assert.equal(section.inclusion, "preview");
  assert.equal(section.includedLines, 40);
  assert.equal(section.body, "x");
});
