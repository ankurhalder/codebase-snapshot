/**
 * Tool behaviour against a real repository on disk.
 *
 * These call the handlers directly rather than through the protocol, so a failure points at the
 * tool instead of at framing. The fixture is chosen to exercise the paths that are easy to get
 * wrong: a file large enough to be emitted as a bounded preview, a `.env` that must never be
 * readable, a symbol that only the AST summary knows about, and a directory outside the root.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("exposes exactly the 26 documented tools", () => {
  assert.deepEqual([...tools.keys()], [
    "snapshot_status",
    "snapshot_health",
    "snapshot_budget",
    "snapshot_history",
    "snapshot_tests",
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
    "snapshot_answer",
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

test("review names the route methods a change touches", async (t) => {
  const root = makeFixture(t);
  fs.mkdirSync(path.join(root, "src", "users"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "users", "route.ts"),
    "async function handler() {}\nexport { handler as GET, handler as POST };\n"
  );
  await call("snapshot_generate", {}, contextFor(root));
  const result = await call("snapshot_review", { paths: ["src/users/route.ts"] }, contextFor(root));
  assert.equal(result.isError, undefined, result.text);
  assert.equal(result.structured.routes.length, 1);
  assert.deepEqual(result.structured.routes[0].methods, ["GET", "POST"]);
  assert.match(result.text, /Routes touched: GET\/POST src\/users\/route\.ts/);
});

test("snapshot_tests finds the test that imports a file", async (t) => {
  const root = makeFixture(t);
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tests", "user.test.ts"),
    'import { user } from "../src/user.js";\nexport const t = user;\n'
  );
  await call("snapshot_generate", {}, contextFor(root));
  const context = contextFor(root);

  const forFile = await call("snapshot_tests", { path: "src/user.ts" }, context);
  assert.equal(forFile.isError, undefined, forFile.text);
  assert.ok(forFile.structured.tests.some((entry) => entry.path === "tests/user.test.ts"), forFile.text);

  const all = await call("snapshot_tests", {}, context);
  assert.ok(all.structured.tests.length >= 1);
  assert.ok(all.structured.covered.includes("src/user.ts"));

  const none = await call("snapshot_tests", { path: "src/auth.ts" }, context);
  assert.match(none.text, /No test in the snapshot imports/);
});

test("snapshot_history reads the log report, and says how to make one", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  // The report is `git log`; a fixture that is not a repository has no history to record.
  const steps = [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "one"],
  ];
  for (const step of steps) {
    const result = spawnSync("git", step, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }


  const missing = await call("snapshot_history", {}, context);
  assert.equal(missing.isError, true);
  assert.match(missing.text, /includeLogs/);

  const generated = await call("snapshot_generate", { includeLogs: 3 }, context);
  assert.equal(generated.isError, undefined, generated.text);

  const history = await call("snapshot_history", { limit: 2 }, context);
  assert.equal(history.isError, undefined, history.text);
  assert.ok(history.structured.commits.length > 0, history.text);
  assert.ok(history.structured.recorded >= history.structured.commits.length);
  for (const commit of history.structured.commits) {
    assert.match(commit.hash, /^[0-9a-f]+$/);
    assert.match(commit.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(commit.subject.length > 0);
  }
});

test("status separates a missing snapshot from an unreadable one", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);

  const missing = await call("snapshot_status", {}, context);
  assert.equal(missing.isError, undefined, "no snapshot yet is an answer, not an error");
  assert.equal(missing.structured.present, false);

  assert.equal((await call("snapshot_generate", {}, context)).isError, undefined);
  const manifestPath = path.join(root, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  delete manifest.indexes;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest) + "\n");

  const broken = await call("snapshot_status", {}, context);
  assert.equal(broken.isError, true, "a manifest that is not a snapshot is an error");
  assert.match(broken.text, /not a snapshot manifest/);
});

test("a tool that returns nothing says what it could not return", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const block = await call("snapshot_context", { files: ["src/not-here.ts"] }, context);
  assert.equal(block.isError, undefined, "a missing path is not a tool failure");
  assert.match(block.text, /Not returned: src\/not-here\.ts/, "the text names the missing path");

  const diff = await call("snapshot_diff_context", { paths: ["src/not-here.ts"] }, context);
  assert.match(diff.text, /Not in the snapshot: src\/not-here\.ts/);
  assert.doesNotMatch(diff.text, /No file in the snapshot imports/, "it does not claim a fact it did not check");
});

test("generate can pack and can narrow, and refuses the slice/budget pair", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);

  const packed = await call("snapshot_generate", { pack: "xml" }, context);
  assert.equal(packed.isError, undefined, packed.text);
  assert.ok(fs.existsSync(path.join(root, "snapshot", "full-codebase.xml")), "the xml pack was written");

  const sliced = await call("snapshot_generate", { slice: "user", sliceTokens: 3000 }, context);
  assert.equal(sliced.isError, undefined, sliced.text);
  const slicedManifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.ok(slicedManifest.slice, "the slice block is recorded");
  assert.equal(slicedManifest.slice.budgetTokens, 3000);

  const budgeted = await call("snapshot_generate", { budgetTokens: 800 }, context);
  assert.equal(budgeted.isError, undefined, budgeted.text);
  const budgetManifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.ok(budgetManifest.budget, "the budget block is recorded");

  const both = await call("snapshot_generate", { slice: "user", budgetTokens: 800 }, context);
  assert.equal(both.isError, true);
  assert.match(both.text, /pass one/);
});

test("symbol lookup reports where the symbol is called", async (t) => {
  const root = makeFixture(t);
  fs.writeFileSync(
    path.join(root, "src", "auth.ts"),
    'import { user } from "./user.js";\nexport function check() {\n  return user();\n}\n'
  );
  await call("snapshot_generate", {}, contextFor(root));

  const result = await call("snapshot_symbol", { name: "user" }, contextFor(root));
  assert.equal(result.isError, undefined, result.text);
  assert.ok(result.structured.found >= 1, result.text);
  const site = result.structured.references.find((entry) => entry.path === "src/auth.ts");
  assert.ok(site, "the call site is reported: " + JSON.stringify(result.structured.references));
  assert.equal(typeof site.line, "number");
  assert.ok(
    result.structured.references.some((entry) => entry.text.includes("user()")),
    "the call itself is among the sites: " + JSON.stringify(result.structured.references)
  );
  assert.match(result.text, /Call sites/);

  const quiet = await call("snapshot_symbol", { name: "user", references: false }, contextFor(root));
  assert.equal(quiet.structured.references.length, 0, "references:false skips the scan");
  assert.doesNotMatch(quiet.text, /Call sites/);
});

test("snapshot_budget says what a larger budget buys", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const result = await call("snapshot_budget", { budgets: [500, 5000] }, context);
  assert.equal(result.isError, undefined, result.text);
  assert.equal(result.structured.budgets.length, 2);
  const [small, large] = result.structured.budgets;
  assert.ok(large.files >= small.files, "a larger budget never selects fewer files");
  assert.ok(Array.isArray(large.gained));
  assert.match(result.text, /tokens:/);
});

test("snapshot_answer returns cited windows within the budget", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const result = await call("snapshot_answer", { question: "how does the user module work", maxTokens: 3000 }, context);
  assert.equal(result.isError, undefined, result.text);
  assert.match(result.text, /# Answer context:/);
  assert.ok(result.structured.files.length > 0, result.text);
  const first = result.structured.files[0];
  assert.match(first.text, /^\s+1\s+/m, "the window carries line numbers");
  assert.ok(first.why.length > 0, "every included file says why");
  assert.ok(result.structured.usedTokens <= 3000);
});

test("an empty snapshot is reported as empty, not as a question that matched nothing", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  // An allow-list that matches nothing produces a legitimate, empty snapshot.
  await call("snapshot_generate", { only: ["nothing/**"] }, context);

  const plan = await call("snapshot_plan_for", { question: "how does auth work" }, context);
  assert.match(plan.text, /The snapshot holds no files/);
  assert.doesNotMatch(plan.text, /budget is too small/i);

  const answer = await call("snapshot_answer", { question: "how does auth work" }, context);
  assert.match(answer.text, /holds no files/);
  assert.equal(answer.structured.files.length, 0);

  const budget = await call("snapshot_budget", { budgets: [1000] }, context);
  assert.match(budget.text, /holds no files/);
});

test("a question that matches nothing explains itself instead of returning bare zeros", async (t) => {
  // With imports the normal scoring already finds centrality-heavy files; the plan says why per file.
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);
  const withHubs = await call("snapshot_plan_for", { question: "zzzz-no-such-term", maxTokens: 1000 }, context);
  assert.match(withHubs.text, /centrality/, "the reason for each file is stated");
  assert.doesNotMatch(withHubs.text, /Nothing fit the budget/);

  // Without imports there is nothing to fall back on, and the plan must say that rather than blaming
  // the budget for a question that matched nothing.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "bare-"));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bare, "package.json"), JSON.stringify({ name: "b", version: "1.0.0" }) + "\n");
  fs.writeFileSync(path.join(bare, "a.ts"), "export const a = 1;\n");
  const bareContext = contextFor(bare);
  await call("snapshot_generate", {}, bareContext);

  const plan = await call("snapshot_plan_for", { question: "zzzz-no-such-term", maxTokens: 1000 }, bareContext);
  assert.match(plan.text, /no centrality data/);
  assert.doesNotMatch(plan.text, /Nothing fit the budget/, "the budget is not blamed for a missing match");

  const answer = await call("snapshot_answer", { question: "zzzz-no-such-term", maxTokens: 1000 }, bareContext);
  assert.match(answer.text, /Notes:/);
  assert.match(answer.text, /no centrality data/);
});

test("snapshot_read rejects a line window that cannot exist", async (t) => {
  const root = makeFixture(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  for (const args of [
    { path: "src/user.ts", lines: 0 },
    { path: "src/user.ts", lines: -3 },
    { path: "src/user.ts", fromLine: 0 },
    { path: "src/user.ts", fromLine: 2.7 },
  ]) {
    const result = await call("snapshot_read", args, context);
    assert.equal(result.isError, true, JSON.stringify(args) + " is refused");
    assert.match(result.text, /integer of at least 1/);
  }
});
