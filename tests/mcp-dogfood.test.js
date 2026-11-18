/**
 * Dogfood: every MCP tool against one real snapshot, in one pass.
 *
 * Unit tests pin each tool's own edges; this one proves the set still answers coherently about the
 * same repository. A tool that starts returning an error, an empty string or a shape its caller
 * cannot read fails here even if its own suite is green.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { buildTools } from "../dist/mcp.js";

const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
const contextFor = (root) => ({ cwd: root, roots: [root], log: () => {} });

function writeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dogfood-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, content) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
  write(
    "package.json",
    JSON.stringify({ name: "dogfood", version: "1.0.0", dependencies: { express: "^4.19.0" } }, null, 2) + "\n"
  );
  write("README.md", "# Dogfood\n\nA fixture the MCP tools all read.\n");
  write(
    "src/app.ts",
    [
      'import { getUser } from "./user.js";',
      "",
      "export function startServer(port: number): void {",
      "  getUser(String(port));",
      "}",
      "",
    ].join("\n")
  );
  write(
    "src/user.ts",
    [
      "export interface User {",
      "  id: string;",
      "}",
      "",
      "export function getUser(id: string): User {",
      "  return { id };",
      "}",
      "",
    ].join("\n")
  );
  write(
    "tests/user.test.ts",
    ['import { getUser } from "../src/user.js";', "", 'export const hasGetUser = typeof getUser === "function";', ""].join("\n")
  );
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (git(["init", "-q"]).status === 0) {
    git(["-c", "user.email=t@e.c", "-c", "user.name=T", "add", "-A"]);
    git(["-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "fixture"]);
  }
  return root;
}

test("all 26 MCP tools answer coherently about one snapshot", async (t) => {
  const root = writeFixture(t);
  const context = contextFor(root);

  const calls = [
    ["snapshot_generate", { includeLogs: 5 }],
    ["snapshot_status", {}],
    ["snapshot_health", {}],
    ["snapshot_validate", {}],
    ["snapshot_plan", { maxPartBytes: "300k" }],
    ["snapshot_budget", { budgets: [500, 2000], question: "getUser" }],
    ["snapshot_history", { limit: 5 }],
    ["snapshot_tests", { path: "src/user.ts" }],
    ["snapshot_workspace", {}],
    ["snapshot_entrypoints", {}],
    ["snapshot_neighbors", { path: "src/app.ts" }],
    ["snapshot_routes", {}],
    ["snapshot_cycles", {}],
    ["snapshot_search", { query: "getUser" }],
    ["snapshot_stats", {}],
    ["snapshot_review", { paths: ["src/user.ts"] }],
    ["snapshot_diff_context", { paths: ["src/user.ts"] }],
    ["snapshot_symbol", { name: "getUser" }],
    ["snapshot_context", { files: ["src/user.ts"], symbols: ["getUser"] }],
    ["snapshot_query", { symbol: "getUser" }],
    ["snapshot_plan_for", { question: "Where is getUser defined?" }],
    ["snapshot_answer", { question: "Where is getUser defined?" }],
    ["snapshot_locate", { query: "getUser" }],
    ["snapshot_dependents", { path: "src/user.ts" }],
    ["snapshot_read", { path: "src/user.ts" }],
    ["snapshot_explain", { path: "src/user.ts" }],
  ];

  assert.equal(calls.length, tools.size, "every built tool is exercised");
  assert.deepEqual(
    calls.map(([name]) => name).sort(),
    [...tools.keys()].sort(),
    "the call list names every tool exactly once"
  );

  for (const [name, args] of calls) {
    const tool = tools.get(name);
    assert.ok(tool, name + " exists");
    const result = await tool.handler({ ...args, root }, context);
    assert.equal(typeof result.text, "string", name + " returns text");
    assert.ok(result.text.length > 0, name + " returns a non-empty answer");
    if (result.isError) {
      // The workspace tool is the one whose precondition this fixture does not meet; its answer
      // must say so, not crash or return an empty success.
      if (name === "snapshot_workspace") {
        assert.match(result.text, /No workspace index/);
      } else {
        assert.fail(name + " returned an error: " + result.text);
      }
    }
  }

  // The fixture must still be valid after the whole sweep: a read-only tool that mutated it would
  // show up here, and the generate call is the only writable one.
  const validate = await tools.get("snapshot_validate").handler({ root }, context);
  assert.equal(validate.isError, undefined, validate.text);
  assert.match(validate.text, /matches the repository|current/i);
});
