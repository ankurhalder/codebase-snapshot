/**
 * Tool behaviour against a real repository on disk.
 *
 * These call the handlers directly rather than through the protocol, so a failure points at the
 * tool instead of at framing. The fixture is chosen to exercise the paths that are easy to get
 * wrong: a file large enough to be emitted as a bounded preview, a `.env` that must never be
 * readable, a symbol that only the AST summary knows about, and a directory outside the root.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildPrompts, buildResourceProvider, buildTools, createMcpServer } from "../dist/mcp.js";

function writeFixture(root) {
  const write = (relative, content) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };

  write(
    "package.json",
    JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { express: "^4.19.0" } }, null, 2)
  );
  write("README.md", "# Fixture\n\nA repository used by the MCP tests.\n");
  write(
    "src/app.ts",
    [
      'import { getUser } from "./user.js";',
      "",
      "export function startServer(port: number): void {",
      "  getUser(port);",
      "}",
      "",
      "export const appName = \"fixture\";",
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
      "export class UserStore {",
      "  private items: User[] = [];",
      "}",
      "",
    ].join("\n")
  );
  // Large enough to exceed the default 200 kB largeFileBytes threshold, so the snapshot emits a
  // bounded preview rather than the whole body.
  const lines = [];
  for (let index = 0; index < 12000; index += 1) {
    lines.push(`export const value${index} = ${index};`);
  }
  write("src/big.ts", `${lines.join("\n")}\n`);
  write("src/window.ts", Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n"));
  write(".env", "STRIPE_SECRET_KEY=sk_live_do_not_leak_this_value\n");
  write("node_modules/lib/index.js", "module.exports = {};\n");
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tools-"));
  writeFixture(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function contextFor(root) {
  return { cwd: root, roots: [root], log: () => {} };
}

const tools = new Map(buildTools().map((tool) => [tool.name, tool]));

async function call(name, args, context) {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} exists`);
  return tool.handler(args, context);
}

test("exposes exactly the 22 documented tools", () => {
  assert.deepEqual([...tools.keys()], [
    "snapshot_status",
    "snapshot_health",
    "snapshot_workspace",
    "snapshot_entrypoints",
    "snapshot_neighbors",
    "snapshot_routes",
    "snapshot_cycles",
    "snapshot_search",
    "snapshot_stats",
    "snapshot_review",
    "snapshot_diff_context",
    "snapshot_symbol",
    "snapshot_context",
    "snapshot_query",
    "snapshot_plan_for",
    "snapshot_plan",
    "snapshot_generate",
    "snapshot_validate",
    "snapshot_locate",
    "snapshot_dependents",
    "snapshot_read",
    "snapshot_explain",
  ]);
  for (const tool of tools.values()) {
    assert.equal(tool.inputSchema.type, "object", `${tool.name} has an object schema`);
    assert.ok(tool.description.length > 40, `${tool.name} has a real description`);
  }
  // Only the writing tool may be marked writable.
  const writable = [...tools.values()].filter((tool) => tool.annotations.readOnlyHint === false);
  assert.deepEqual(writable.map((tool) => tool.name), ["snapshot_generate"]);
});

test("status reports an absent snapshot without failing", async (t) => {
  const root = makeFixture(t);
  const outcome = await call("snapshot_status", {}, contextFor(root));
  assert.ok(!outcome.isError, "an absent snapshot is an answer, not a tool failure");
  assert.equal(outcome.structured.present, false);
  assert.match(outcome.text, /no snapshot manifest/i);
});

test("plan previews without writing", async (t) => {
  const root = makeFixture(t);
  const outcome = await call("snapshot_plan", {}, contextFor(root));
  assert.ok(!outcome.isError, outcome.text);
  assert.ok(outcome.structured.files >= 4);
  assert.ok(outcome.structured.parts >= 1);
  assert.ok(!fs.existsSync(path.join(root, "snapshot")), "a dry run must not create the output directory");
  assert.match(outcome.text, /Dry run/);
});

test("generate writes the snapshot and status reflects it", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  const generated = await call("snapshot_generate", {}, context);
  assert.ok(!generated.isError, generated.text);
  assert.ok(fs.existsSync(path.join(root, "snapshot", "manifest.json")));
  assert.ok(fs.existsSync(path.join(root, "snapshot", "parts")));

  const status = await call("snapshot_status", {}, context);
  assert.equal(status.structured.present, true);
  assert.equal(status.structured.fingerprint, generated.structured.fingerprint);
  assert.ok(status.structured.includedFiles >= 4);
});

test("validate is current before an edit and stale after one", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const current = await call("snapshot_validate", {}, context);
  assert.equal(current.structured.current, true, current.text);
  assert.ok(!current.isError, "a current snapshot is not an error");

  fs.appendFileSync(path.join(root, "src", "user.ts"), "\nexport const changed = true;\n");

  const stale = await call("snapshot_validate", {}, context);
  assert.equal(stale.structured.current, false);
  assert.ok(stale.structured.drift.hashMismatches.count >= 1);
  assert.match(stale.text, /out of date/);
});

test("locate finds files by path and by exported symbol", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const byPath = await call("snapshot_locate", { query: "user" }, context);
  assert.ok(byPath.structured.total >= 1, byPath.text);
  const userMatch = byPath.structured.matches.find((match) => match.path === "src/user.ts");
  assert.ok(userMatch, "src/user.ts is found by path");
  assert.match(userMatch.part, /^part-\d+\.md$/);

  const bySymbol = await call("snapshot_locate", { query: "getUser", by: "symbol" }, context);
  assert.ok(
    bySymbol.structured.matches.some((match) => match.path === "src/user.ts"),
    "getUser is found as an exported symbol"
  );

  const nothing = await call("snapshot_locate", { query: "zzz-not-present" }, context);
  assert.equal(nothing.structured.total, 0);
  assert.match(nothing.text, /nothing in the snapshot matches/i);
});

test("read returns a window and continues from where it stopped", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const first = await call("snapshot_read", { path: "src/window.ts", fromLine: 10, lines: 5 }, context);
  assert.ok(!first.isError, first.text);
  assert.equal(first.structured.fromLine, 10);
  assert.equal(first.structured.returnedLines, 5);
  assert.match(first.text, /line 10/);
  assert.match(first.text, /line 14/);
  assert.ok(!first.text.includes("line 9\n"), "the window starts where it was asked to");
  assert.equal(first.structured.nextFromLine, 15);
  assert.match(first.text, /Truncated\. Call snapshot_read with fromLine=15/);

  const second = await call("snapshot_read", { path: "src/window.ts", fromLine: 15, lines: 2 }, context);
  assert.match(second.text, /line 15/);
});

test("read serves a bounded preview for a large source file", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const outcome = await call("snapshot_read", { path: "src/big.ts" }, context);
  assert.ok(!outcome.isError, outcome.text);
  assert.equal(outcome.structured.inclusion, "preview");
  assert.match(outcome.text, /Bounded preview/);
});

test("read refuses a file the snapshot excludes, and never leaks its content", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  const generated = await call("snapshot_generate", {}, context);

  const outcome = await call("snapshot_read", { path: ".env" }, context);
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /not in the snapshot/i);
  assert.match(outcome.text, /sensitive/i);

  // The strongest assertion available: the value is nowhere in the artifacts the server serves.
  const artifacts = [];
  const snapshotDir = path.join(root, "snapshot");
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else artifacts.push(fs.readFileSync(full, "utf8"));
    }
  };
  walk(snapshotDir);
  assert.ok(
    artifacts.every((text) => !text.includes("sk_live_do_not_leak_this_value")),
    "the secret never reaches a snapshot artifact"
  );
  assert.ok(generated.structured.files >= 1);
});

test("read explains a path outside the repository instead of reading it", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const outcome = await call("snapshot_read", { path: "../outside.txt" }, context);
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /outside/i);
});

test("explain reports layer and kind, and the reason for an exclusion", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const included = await call("snapshot_explain", { path: "src/user.ts" }, context);
  assert.equal(included.structured.included, true);
  assert.ok(included.structured.layer);
  assert.ok(included.structured.kind);

  const excluded = await call("snapshot_explain", { path: ".env" }, context);
  assert.equal(excluded.structured.included, false);
  assert.ok(excluded.structured.reason);
});

test("a root outside the allowed directories is refused", async (t) => {
  const root = makeFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  const outcome = await call("snapshot_status", { root: outside }, contextFor(root));
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /outside the directories this server may read/);
});

test("the tools never adopt includeSensitiveFiles", () => {
  for (const tool of tools.values()) {
    const properties = Object.keys(tool.inputSchema.properties);
    assert.ok(!properties.includes("includeSensitiveFiles"), `${tool.name} cannot be asked to include secrets`);
    assert.ok(!properties.includes("preset"), `${tool.name} does not silently override the preset`);
  }
});

test("the brief is a resource an MCP client can read", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const provider = buildResourceProvider();
  const listed = await provider.list(context);
  const prompt = listed.find((resource) => resource.uri === "snapshot://prompt");
  assert.ok(prompt, "the brief is listed");
  assert.equal(prompt.mimeType, "text/markdown");
  assert.match(prompt.description, /Read this before the parts/);

  const read = await provider.read("snapshot://prompt", context);
  assert.ok(read, "and it reads");
  assert.match(read.text, /## The job/, "with the brief in it");
  assert.match(read.text, /## Coverage/, "including the duty section");
});

test("a known resource this snapshot does not contain says why", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);
  // The artifact is disabled or the file is gone: either way the resource is known and absent.
  fs.rmSync(path.join(root, "snapshot", "PROMPT.md"));

  const provider = buildResourceProvider();
  await assert.rejects(
    () => provider.read("snapshot://prompt", context),
    (error) => {
      assert.equal(error.name, "ResourceNotFoundError");
      assert.match(error.message, /prompt artifact was disabled/);
      return true;
    }
  );
  // An unknown URI is still an unknown URI.
  assert.equal(await provider.read("snapshot://nope", context), null);
});

test("an opt-in report is advertised, and its absence is explained", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);
  const provider = buildResourceProvider();

  for (const uri of ["snapshot://reports/diff", "snapshot://reports/log", "snapshot://reports/tokens"]) {
    await assert.rejects(
      () => provider.read(uri, context),
      (error) => {
        assert.equal(error.name, "ResourceNotFoundError", uri);
        assert.match(error.message, /not in this snapshot|disabled/, uri);
        return true;
      }
    );
  }

  // `resources/list` is a promise that a read will work: a report that was not written is not
  // advertised. Asking for it directly still gets the explanation above.
  const listed = (await provider.list(context)).map((resource) => resource.uri);
  for (const uri of ["snapshot://reports/diff", "snapshot://reports/log", "snapshot://reports/tokens"]) {
    assert.ok(!listed.includes(uri), uri + " is not advertised when absent");
  }
});

test("snapshot_generate can write the opt-in reports", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  const result = await call("snapshot_generate", { tokenTree: true, includeLogs: 3 }, context);
  assert.equal(result.isError, undefined, result.text);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.ok(manifest.artifacts.tokenTree, "tokens.md was written");
  assert.ok(fs.existsSync(path.join(root, "snapshot", "reports", "tokens.md")));
});

test("every tool states its cost, and tools/list reports it", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  const server = createMcpServer({
    info: { name: "codebase-snapshot", title: "t", version: "0.0.0" },
    instructions: "",
    tools: buildTools(),
    resources: buildResourceProvider(),
    prompts: buildPrompts(),
    context,
  });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  const listed = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  for (const tool of listed.result.tools) {
    assert.ok(
      ["cheap", "medium", "expensive"].includes(tool._meta["codebase-snapshot/cost"]),
      tool.name + " states a cost"
    );
  }
});

test("a report resource is listed only when the run wrote it", async (t) => {
  const root = makeFixture(t);
  await call("snapshot_generate", {}, contextFor(root));
  const context = contextFor(root);
  const provider = buildResourceProvider();

  const before = (await provider.list(context)).map((resource) => resource.uri);
  assert.ok(before.includes("snapshot://reports/audit"), "a default report is listed");
  assert.ok(!before.includes("snapshot://reports/diff"), "an opt-in report that was not written is not listed");
  assert.ok(!before.includes("snapshot://reports/tokens"), "nor the token tree");

  await call("snapshot_generate", { tokenTree: true }, context);
  const after = (await provider.list(context)).map((resource) => resource.uri);
  assert.ok(after.includes("snapshot://reports/tokens"), "the report this run wrote is listed");
  const text = await provider.read("snapshot://reports/tokens", context);
  assert.match(text.text, /Token/);
});

test("snapshot_workspace reads the index a workspace run wrote", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-tool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const member of ["app", "shared"]) {
    fs.mkdirSync(path.join(root, member, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, member, "package.json"), JSON.stringify({ name: member, version: "1.0.0" }) + "\n");
  }
  fs.writeFileSync(path.join(root, "shared", "src", "util.ts"), "export const util = 1;\n");
  fs.writeFileSync(path.join(root, "app", "src", "index.ts"), 'import { util } from "../../shared/src/util.js";\nexport const app = util;\n');
  fs.mkdirSync(path.join(root, "snapshot"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "snapshot", "WORKSPACE.json"),
    JSON.stringify({
      generatedAt: "2026-01-01T00:00:00.000Z",
      members: [
        { name: "app", files: 2, tokens: 10, fingerprint: "a".repeat(64) },
        { name: "shared", files: 2, tokens: 8, fingerprint: "b".repeat(64) },
      ],
      links: [{ from: "app", to: "shared", specifiers: 1, examples: ["src/index.ts"] }],
    }) + "\n"
  );

  const context = contextFor(root);
  const result = await call("snapshot_workspace", {}, context);
  assert.equal(result.isError, undefined, result.text);
  assert.equal(result.structured.members.length, 2);
  assert.equal(result.structured.links[0].from, "app");
  assert.match(result.text, /app -> shared/);

  const missing = await call("snapshot_workspace", { outDir: "nope" }, context);
  assert.equal(missing.isError, true);
  assert.match(missing.text, /--workspace/);
});
