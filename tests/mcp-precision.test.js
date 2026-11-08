import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { buildTools, createServer, findSection } from "../dist/mcp.js";
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

// ---------------------------------------------------------------------------
// A resource read is all-or-nothing.
//
// The 512 kB single-read limit is a context-budget guard, not a licence to return half a
// document. A 764 kB manifest used to come back as 524 kB of invalid JSON whose marker told the
// reader to use snapshot_read — a tool that cannot read manifest.json at all. The rule is now:
// the complete text or a clear error naming the size and the tool to use instead.

const MAX_RESOURCE_BYTES = 512 * 1024;

async function startServer(root) {
  const server = createServer({ cwd: root, log: () => {} });
  await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {} },
  });
  await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  return server;
}

function readResource(server, id, uri) {
  return server.handle({ jsonrpc: "2.0", id, method: "resources/read", params: { uri } });
}

/** A repository whose pretty-printed manifest crosses the single-read limit. */
function makeLargeRepo(t) {
  const files = { "package.json": '{"name":"fixture","version":"1.0.0"}\n' };
  for (let index = 0; index < 600; index += 1) {
    files["src/mod" + String(index).padStart(4, "0") + ".ts"] = [
      'import { helper } from "./helper.js";',
      "export interface Shape" + index + " { id: number; label: string; }",
      "export function compute" + index + "(input: Shape" + index + "): string {",
      "  const retries = input.id + 1;",
      "  return helper(input.label) + retries;",
      "}",
      "export class Service" + index + " { run(): string { return compute" + index + '({ id: 0, label: "x" }); } }',
      "",
    ].join("\n");
  }
  files["src/helper.ts"] = "export function helper(value: string): string { return value; }\n";
  return makeFixture(t, files);
}

test("a manifest over the single-read limit is refused, never truncated", async (t) => {
  const root = makeLargeRepo(t);
  const context = contextFor(root);
  const generated = await call("snapshot_generate", {}, context);
  assert.ok(!generated.isError, generated.text);

  const manifestPath = path.join(root, "snapshot", "manifest.json");
  const manifestBytes = fs.statSync(manifestPath).size;
  assert.ok(
    manifestBytes > MAX_RESOURCE_BYTES,
    "the fixture must cross the limit to test it (manifest is " + manifestBytes + " bytes)"
  );

  const server = await startServer(root);
  const response = await readResource(server, 2, "snapshot://manifest");

  if (!response.error) {
    // The other allowed answer: the complete document, which has to parse.
    const text = response.result.contents[0].text;
    assert.ok(!text.includes("[truncated:"), "a resource is never a truncated document");
    const parsed = JSON.parse(text);
    const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(parsed.files.length, onDisk.files.length);
    return;
  }

  // The refusal a client can act on: a server error, naming the size and the tool to use.
  assert.equal(response.error.code, -32000);
  assert.equal(response.error.data.uri, "snapshot://manifest");
  assert.ok(response.error.data.bytes > MAX_RESOURCE_BYTES);
  assert.match(response.error.message, /snapshot_locate|snapshot_read|snapshot_status/);
  assert.match(response.error.message, /above/i);
});

test("a manifest under the single-read limit is returned whole and parses", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/a.ts": "export const a = 1;\n",
  });
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const server = await startServer(root);
  const response = await readResource(server, 2, "snapshot://manifest");
  assert.ok(!response.error, JSON.stringify(response.error));
  const text = response.result.contents[0].text;
  const parsed = JSON.parse(text);
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.equal(parsed.fingerprint, onDisk.fingerprint);
  assert.ok(!text.includes("[truncated:"), "a resource is never a truncated document");
});

test("a part over the single-read limit is refused, not cut mid-line", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    // One part holding a single file larger than the resource limit: the only thing standing
    // between the client and a mid-line cut is the refusal.
    "snapshot.config.json": JSON.stringify({ maxPartBytes: 700000, largeFileBytes: 1000000 }),
  });
  const body = [];
  for (let index = 0; index < 12000; index += 1) body.push("line " + index + " " + "x".repeat(40));
  // The fixture above has no nested file, so writeFixture never created `src`.
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "huge.txt"), body.join("\n") + "\n");

  const context = contextFor(root);
  const generated = await call("snapshot_generate", {}, context);
  assert.ok(!generated.isError, generated.text);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.equal(manifest.parts.length, 1, "the fixture must produce one part");
  const partPath = path.join(root, "snapshot", "parts", manifest.parts[0].filename);
  const partText = fs.readFileSync(partPath, "utf8");
  assert.ok(Buffer.byteLength(partText, "utf8") > MAX_RESOURCE_BYTES, "the part must cross the limit");

  const server = await startServer(root);
  const response = await readResource(server, 2, "snapshot://parts/1");
  if (!response.error) {
    assert.equal(response.result.contents[0].text, partText, "a returned part is the whole part");
    return;
  }
  assert.equal(response.error.code, -32000);
  assert.equal(response.error.data.uri, "snapshot://parts/1");
  assert.match(response.error.message, /snapshot_read|snapshot_locate/);
});

test("snapshot_generate refuses an outDir outside the served root", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/a.ts": "export const a = 1;\n",
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-outdir-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const context = contextFor(root);

  const absolute = await call("snapshot_generate", { outDir: outside }, context);
  assert.equal(absolute.isError, true, absolute.text);
  assert.match(absolute.text, /inside the repository/i);
  assert.equal(fs.existsSync(path.join(outside, "manifest.json")), false, "nothing was written outside the root");

  const traversal = await call("snapshot_generate", { outDir: "../escaped-out" }, context);
  assert.equal(traversal.isError, true, traversal.text);
  assert.equal(fs.existsSync(path.join(path.dirname(root), "escaped-out")), false);

  // The read tools take the same argument and obey the same rule, so a probe cannot look at a
  // manifest outside the root either.
  const status = await call("snapshot_status", { outDir: outside }, context);
  assert.equal(status.isError, true, status.text);
});

test("snapshot_generate accepts an outDir inside the served root", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/a.ts": "export const a = 1;\n",
  });
  const context = contextFor(root);

  const relative = await call("snapshot_generate", { outDir: "custom-out" }, context);
  assert.ok(!relative.isError, relative.text);
  assert.ok(fs.existsSync(path.join(root, "custom-out", "manifest.json")));

  const absoluteDir = path.join(root, "absolute-out");
  const absolute = await call("snapshot_generate", { outDir: absoluteDir }, context);
  assert.ok(!absolute.isError, absolute.text);
  assert.ok(fs.existsSync(path.join(absoluteDir, "manifest.json")));
});

test("an outDir cannot leave the root through a junction", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/a.ts": "export const a = 1;\n",
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-linked-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, "linked"), "junction");
  const context = contextFor(root);

  const escaped = await call("snapshot_generate", { outDir: "linked/snapshot" }, context);
  assert.equal(escaped.isError, true, escaped.text);
  assert.match(escaped.text, /inside the repository/i);
  assert.equal(fs.existsSync(path.join(outside, "snapshot", "manifest.json")), false);
});

test("a refused root names the flag that actually serves another directory", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/a.ts": "export const a = 1;\n",
  });
  const context = contextFor(root);

  const refused = await call("snapshot_status", { root: ".." }, context);
  assert.equal(refused.isError, true, refused.text);
  assert.match(refused.text, /--cwd/, "the advice must be a flag the CLI accepts");
  assert.doesNotMatch(refused.text, /--root/, "mcp --root is an unknown option");
});
