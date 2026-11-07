import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { buildTools, findSection } from "../dist/mcp.js";
import { anchorForPath, displayPath } from "../dist/index.js";

/**
 * Precision of the MCP read/locate tools, from the 0.9.9 audit.
 *
 * Both are tools an agent uses instead of reading files, so a miss is not a small failure:
 * it teaches the agent that the snapshot cannot answer the question, and it goes back to
 * reading the working tree — the thing the server exists to make unnecessary.
 */

const MAX_RESULT_BYTES = 64 * 1024;

function writeFixture(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
}

function makeFixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-precision-"));
  writeFixture(root, files);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const contextFor = (root) => ({ cwd: root, roots: [root], log: () => {} });
const tools = new Map(buildTools().map((tool) => [tool.name, tool]));

async function call(name, args, context) {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} exists`);
  return tool.handler(args, context);
}

test("snapshot_read keeps a multibyte body inside the byte limit", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    // Three-byte characters: slicing 64 KiB of *code units* returns up to 192 KiB of
    // bytes, and can cut a surrogate pair in half.
    "src/wide.ts": `${"const 日本語 = \"あああああ\";\n".repeat(6000)}`,
  });
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const result = await call(
    "snapshot_read",
    { path: "src/wide.ts", lines: 100000 },
    context
  );

  const body = result.structured?.body ?? result.text;
  assert.ok(Buffer.byteLength(body, "utf8") <= MAX_RESULT_BYTES, "the limit is in bytes");
  assert.doesNotMatch(body, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "no lone high surrogate");
  assert.doesNotMatch(body, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no lone low surrogate");
});

test("snapshot_locate finds a symbol that is not exported", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/internal.ts": [
      "function privateHelper(): number {",
      "  return 1;",
      "}",
      "interface InternalShape {",
      "  id: string;",
      "}",
      "export const visible = privateHelper();",
    ].join("\n"),
  });
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const result = await call(
    "snapshot_locate",
    { query: "privateHelper", by: "symbol" },
    context
  );

  assert.equal(result.structured?.total, 1, result.text);
  assert.equal(result.structured.matches[0].path, "src/internal.ts");
});

test("snapshot_locate searches Markdown headings as symbols", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "docs/guide.md": "# Install\n\n## Configure the proxy\n\nText.\n",
  });
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const result = await call("snapshot_locate", { query: "configure the proxy", by: "symbol" }, context);
  assert.equal(result.structured?.total, 1, result.text);
});

test("snapshot_locate matches a layer and a kind by fragment", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/a.ts": "export const a = 1;\n",
    "tests/a.test.ts": "export const t = 1;\n",
  });
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  // The fragment is taken from the snapshot itself: the point is that a *fragment* of a
  // layer or kind name is enough, the same as it is for a path, not that any particular
  // name exists.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8")
  );
  const layer = manifest.files[0].layer;
  const kind = manifest.files[0].kind;

  const byLayer = await call(
    "snapshot_locate",
    { query: layer.slice(0, 2), by: "layer" },
    context
  );
  assert.ok(byLayer.structured.total > 0, `layer "${layer}": ${byLayer.text}`);

  const byKind = await call("snapshot_locate", { query: kind.slice(0, 2), by: "kind" }, context);
  assert.ok(byKind.structured.total > 0, `kind "${kind}": ${byKind.text}`);
});

test("findSection resolves a path the heading had to cap or escape", () => {
  // Two files whose headings cap to text that cannot be told apart by path alone. The anchor
  // hashes the real `relativePath`, so it is exact for both — the content hash the part used to
  // carry could not help here at all, because these two files have the same content.
  const long = `src/${"very-long-directory-name/".repeat(14)}file.ts`;
  const other = `src/${"another-directory/".repeat(14)}file.ts`;
  assert.notEqual(displayPath(long), long, "the fixture must actually be capped");

  const sections = [
    { path: displayPath(long), anchor: anchorForPath(long), body: "same", inclusion: "full", includedLines: 1 },
    { path: displayPath(other), anchor: anchorForPath(other), body: "same", inclusion: "full", includedLines: 1 },
  ];

  const found = findSection(sections, long);
  assert.ok(found, "the section must be locatable");
  assert.equal(found.anchor, anchorForPath(long), "and it must be the right one of the two");
});
