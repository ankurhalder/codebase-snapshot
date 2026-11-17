/**
 * The retrieval planner: a question and a budget in, a reading order out.
 *
 * The plan must be deterministic, must respect the budget, must explain every file, and must never
 * name a path the snapshot does not carry. Those four properties are the whole feature.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildTools } from "../dist/mcp.js";

const tools = new Map(buildTools().map((tool) => [tool.name, tool]));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, content) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write("package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write("src/user.ts", [
    "export interface User { id: string; }",
    "export function getUser(id: string): User { return { id }; }",
    "export function deleteUser(id: string): void {}",
    "",
  ].join("\n"));
  write("src/auth.ts", [
    'import { getUser } from "./user.js";',
    "export function authenticate(token: string): boolean { return getUser(token) !== null; }",
    "",
  ].join("\n"));
  write("src/session.ts", "export const SESSION_TTL = 3600;\n");
  write("tests/user.test.js", 'test("user", () => {});\n');
  write("README.md", "# Fixture\n");
  return root;
}

function contextFor(root) {
  return { cwd: root, roots: [root], log: () => {} };
}

async function generate(root) {
  const tool = tools.get("snapshot_generate");
  const result = await tool.handler({}, contextFor(root));
  assert.equal(result.isError, undefined, result.text);
}

async function plan(root, args) {
  const tool = tools.get("snapshot_plan_for");
  assert.ok(tool, "snapshot_plan_for is served");
  return tool.handler(args, contextFor(root));
}

test("a plan names the files that answer the question, in reading order", async (t) => {
  const root = fixture(t);
  await generate(root);
  const result = await plan(root, { question: "how is a user authenticated", maxTokens: 8000 });
  assert.equal(result.isError, undefined, result.text);
  const structured = result.structured;
  assert.ok(structured.files.length > 0, "the plan is not empty");
  const paths = structured.files.map((file) => file.path);
  assert.ok(paths.includes("src/auth.ts"), "the file whose name matches is first: " + paths.join(", "));
  assert.ok(structured.usedTokens <= 8000, "the budget is respected");
  for (const file of structured.files) {
    assert.ok(file.why.length > 0, file.path + " explains itself");
    assert.equal(typeof file.part, "string");
  }
});

test("the budget is a ceiling, not a suggestion", async (t) => {
  const root = fixture(t);
  await generate(root);
  const result = await plan(root, { question: "user auth session", maxTokens: 500 });
  assert.ok(result.structured.usedTokens <= 500);
  assert.ok(result.structured.notes.length > 0, "the plan says what it could not fit");
});

test("the same question produces the same plan", async (t) => {
  const root = fixture(t);
  await generate(root);
  const first = await plan(root, { question: "delete user", maxTokens: 4000 });
  const second = await plan(root, { question: "delete user", maxTokens: 4000 });
  assert.deepEqual(second.structured, first.structured);
});

test("tests are excluded unless asked for", async (t) => {
  const root = fixture(t);
  await generate(root);
  const without = await plan(root, { question: "user", maxTokens: 4000 });
  assert.equal(without.structured.files.some((file) => file.path.startsWith("tests/")), false);
  const withTests = await plan(root, { question: "user test", includeTests: true, maxTokens: 4000 });
  assert.ok(withTests.structured.files.some((file) => file.path.startsWith("tests/")), "asked for, included");
});

test("an empty question is refused, and no snapshot is explained", async (t) => {
  const root = fixture(t);
  const blank = await plan(root, { question: "  " });
  assert.equal(blank.isError, true);
  const missing = await plan(root, { question: "user" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /snapshot_generate/);
});

test("a query filters by layer, pattern and symbol", async (t) => {
  const root = fixture(t);
  await generate(root);
  const tool = tools.get("snapshot_query");
  assert.ok(tool, "snapshot_query is served");
  const context = contextFor(root);

  const byLayer = await tool.handler({ layer: "src" }, context);
  assert.ok(byLayer.structured.files.length >= 3, "every source file is in src");
  assert.equal(byLayer.structured.files.every((file) => file.layer === "src"), true);

  const byPattern = await tool.handler({ pathPattern: "auth" }, context);
  assert.deepEqual(
    byPattern.structured.files.map((file) => file.path),
    ["src/auth.ts"],
    "the pattern is a regular expression over the path"
  );

  const bySymbol = await tool.handler({ symbol: "deleteuser" }, context);
  assert.deepEqual(bySymbol.structured.files.map((file) => file.path), ["src/user.ts"]);

  const capped = await tool.handler({ maxFiles: 1 }, context);
  assert.equal(capped.structured.files.length, 1);
  assert.ok(capped.structured.matched > 1, "the count still says how many matched");

  const badPattern = await tool.handler({ pathPattern: "(" }, context);
  assert.equal(badPattern.isError, true);
  assert.match(badPattern.text, /not a valid regular expression/);
});
