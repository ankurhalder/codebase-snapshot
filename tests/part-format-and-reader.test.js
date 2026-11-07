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
