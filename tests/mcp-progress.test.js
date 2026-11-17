/**
 * Progress notifications: a long call says it is working.
 *
 * The stdio loop is what carries them, so the test drives the real server over a fake stdout and
 * asserts that a notification with the client's token arrives before the response.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildTools, createMcpServer } from "../dist/mcp.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "progress-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"p","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  return root;
}

test("a call with a progress token emits notifications before the response", async (t) => {
  const root = fixture(t);
  const seen = [];
  const server = createMcpServer({
    info: { name: "codebase-snapshot", title: "t", version: "0.0.0" },
    instructions: "",
    tools: buildTools(),
    resources: { async list() { return []; }, async read() { return null; }, templates() { return []; } },
    prompts: [],
    context: { cwd: root, roots: [root], log: () => {} },
    notify: (message) => seen.push(message),
  });

  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "snapshot_generate", arguments: {}, _meta: { progressToken: "tok-1" } },
  });

  assert.equal(response.id, 2);
  assert.ok(seen.length >= 1, "at least one progress notification");
  for (const message of seen) {
    assert.equal(message.method, "notifications/progress");
    assert.equal(message.params.progressToken, "tok-1");
    assert.equal(typeof message.params.progress, "number");
    assert.equal(typeof message.params.message, "string");
  }
});

test("a call without a token emits nothing", async (t) => {
  const root = fixture(t);
  const seen = [];
  const server = createMcpServer({
    info: { name: "codebase-snapshot", title: "t", version: "0.0.0" },
    instructions: "",
    tools: buildTools(),
    resources: { async list() { return []; }, async read() { return null; }, templates() { return []; } },
    prompts: [],
    context: { cwd: root, roots: [root], log: () => {} },
    notify: (message) => seen.push(message),
  });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "snapshot_generate", arguments: {} } });
  assert.equal(seen.length, 0);
});
