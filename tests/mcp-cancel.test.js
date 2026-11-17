/**
 * Cancellation: notifications/cancelled reaches a tool that asked to be told.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createMcpServer } from "../dist/mcp.js";

test("a cancelled call reaches the tool's cancel callback", async (t) => {
  const wdForTest = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-"));
  t.after(() => fs.rmSync(wdForTest, { recursive: true, force: true }));
  let cancelled = false;
  const server = createMcpServer({
    info: { name: "codebase-snapshot", title: "t", version: "0.0.0" },
    instructions: "",
    tools: [
      {
        name: "slow",
        title: "Slow",
        description: "Waits until cancelled, then resolves.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        async handler(_args, context) {
          await new Promise((resolve) => {
            context.onCancel?.(() => {
              cancelled = true;
              resolve(true);
            });
          });
          return { text: cancelled ? "cancelled" : "finished" };
        },
      },
    ],
    resources: { async list() { return []; }, async read() { return null; }, templates() { return []; } },
    prompts: [],
    context: { cwd: wdForTest, roots: [wdForTest], log: () => {} },
  });

  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  const pending = server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow", arguments: {} } });
  // Let the handler register its callback before the cancellation arrives.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
  const response = await pending;
  assert.equal(cancelled, true, "the callback ran");
  assert.equal(response.result.content[0].text, "cancelled");
});
