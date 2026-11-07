import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { MAX_LINE_BYTES, buildTools, createLineReader } from "../dist/mcp.js";

/**
 * MCP edge cases from the 0.9.10 audit.
 *
 * The line cap and the read window both decide whether an agent gets an answer or a plausible
 * wrong one, and both were wrong at the edges: an oversized line that arrived complete with its
 * terminator skipped the overflow guard entirely, and a read past the end of a file returned a
 * different line than the one that was asked for.
 */

function reader() {
  const input = new PassThrough();
  const lines = [];
  const overflows = [];
  const stop = createLineReader(input, {
    onLine: (line) => lines.push(line),
    onOverflow: (bytes) => overflows.push(bytes),
  });
  return { input, lines, overflows, stop };
}

test("a normal message is delivered", () => {
  const { input, lines } = reader();
  input.write('{"jsonrpc":"2.0","id":1}\n');
  assert.deepEqual(lines, ['{"jsonrpc":"2.0","id":1}']);
});

test("an oversized line is refused even when it arrives with its newline", () => {
  const { input, lines, overflows } = reader();
  // 32 MB + 1, terminated in the same chunk. The guard used to require that the buffer held no
  // `\n` at all, so this — the exact case the cap exists for — went through to `JSON.parse`.
  input.write("x".repeat(MAX_LINE_BYTES + 1) + "\n");

  assert.deepEqual(lines, [], "the oversized line is not delivered");
  assert.equal(overflows.length, 1, "and the caller is told why");
  assert.ok(overflows[0] > MAX_LINE_BYTES);
});

test("an oversized line split across chunks is still refused", () => {
  const { input, lines, overflows } = reader();
  const half = Math.floor(MAX_LINE_BYTES / 2) + 1;
  input.write("y".repeat(half));
  input.write("y".repeat(half));
  input.write("\n");

  assert.deepEqual(lines, []);
  assert.equal(overflows.length, 1);
});

test("the reader recovers after discarding an oversized line", () => {
  const { input, lines } = reader();
  input.write("z".repeat(MAX_LINE_BYTES + 1) + "\n");
  input.write('{"jsonrpc":"2.0","id":2}\n');

  assert.deepEqual(lines, ['{"jsonrpc":"2.0","id":2}'], "the next message is not lost");
});

// ---------------------------------------------------------------------------

function makeFixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-edges-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
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

test("snapshot_locate finds a declaration that is not an export, class or function", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    // Every one of these lives in `variables`, which the tool did not search.
    "src/config.ts": "const retryLimit = 3;\nconst timeoutMs = 5000;\n",
    "src/App.tsx": "export default function App() {\n  return <div />;\n}\n",
  });
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const result = await call("snapshot_locate", { query: "retryLimit" }, context);
  const found = JSON.stringify(result.structured ?? result.text);
  assert.match(found, /retryLimit/, "a module-level const is a symbol an agent looks for");
});

test("snapshot_locate finds a Markdown frontmatter key", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "docs/guide.md": "---\ntitle: Guide\ntags: docs\n---\n\n# Heading\n",
  });
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const result = await call("snapshot_locate", { query: "tags" }, context);
  assert.match(
    JSON.stringify(result.structured ?? result.text),
    /guide\.md/,
    "frontmatter keys describe a document's structure as much as its headings do"
  );
});

test("snapshot_read of an empty file says it is empty", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/empty.ts": "",
  });
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const result = await call("snapshot_read", { path: "src/empty.ts" }, context);
  const text = result.text ?? JSON.stringify(result.structured);

  assert.doesNotMatch(text, /Lines 1[–-]0 of 1/, "a zero-line window is not a line range");
  assert.match(text, /empty/i);
});

test("snapshot_read past the end of a file says so instead of returning the last line", async (t) => {
  const root = makeFixture(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/short.ts": "export const one = 1;\nexport const two = 2;\n",
  });
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const result = await call("snapshot_read", { path: "src/short.ts", fromLine: 9000 }, context);
  const text = result.text ?? JSON.stringify(result.structured);

  assert.doesNotMatch(text, /export const two = 2/, "line 2 is not line 9000");
  assert.match(text, /past its end/i);
});
