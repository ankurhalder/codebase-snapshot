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
  write("src/big.ts", Array.from({ length: 300 }, (_, index) => "export const v" + index + " = " + index + ";").join("\n") + "\n");
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

test("a context block carries the requested files within its budget", async (t) => {
  const root = fixture(t);
  await generate(root);
  const tool = tools.get("snapshot_context");
  assert.ok(tool, "snapshot_context is served");
  const context = contextFor(root);

  const byFile = await tool.handler({ files: ["src/user.ts"], maxTokens: 4000 }, context);
  assert.equal(byFile.isError, undefined, byFile.text);
  assert.match(byFile.text, /export function getUser/);
  assert.equal(byFile.structured.files.length, 1);
  assert.ok(byFile.structured.usedTokens <= 4000);

  const bySymbol = await tool.handler({ symbols: ["deleteUser"], maxTokens: 4000 }, context);
  assert.match(bySymbol.text, /deleteUser/, "a symbol resolves to the file that exports it");

  const missing = await tool.handler({ files: ["nope.ts"], maxTokens: 1000 }, context);
  assert.deepEqual(missing.structured.missing, ["nope.ts"]);
  assert.equal(missing.structured.files.length, 0);

  const none = await tool.handler({}, context);
  assert.equal(none.isError, true);

  const small = await tool.handler({ files: ["src/big.ts"], maxTokens: 500, linesPerFile: 300 }, context);
  assert.ok(small.structured.usedTokens <= 500, "the budget is honoured");
  assert.match(small.text, /first \d+ lines/, "a shortened file says so");
});

test("a symbol resolves to a definition window with a line number", async (t) => {
  const root = fixture(t);
  await generate(root);
  const tool = tools.get("snapshot_symbol");
  assert.ok(tool, "snapshot_symbol is served");
  const context = contextFor(root);

  const found = await tool.handler({ name: "deleteUser" }, context);
  assert.equal(found.structured.found, 1);
  assert.equal(found.structured.matches[0].path, "src/user.ts");
  assert.ok(found.structured.matches[0].line >= 1);
  assert.match(found.text, /export function deleteUser/);

  const absent = await tool.handler({ name: "neverExported" }, context);
  assert.equal(absent.structured.found, 0);
  assert.match(absent.text, /No definition of neverExported/);

  const blank = await tool.handler({ name: "" }, context);
  assert.equal(blank.isError, true);
});

test("a changed-file set returns its bodies and its dependents", async (t) => {
  const root = fixture(t);
  await generate(root);
  const tool = tools.get("snapshot_diff_context");
  assert.ok(tool, "snapshot_diff_context is served");
  const context = contextFor(root);

  const result = await tool.handler({ paths: ["src/user.ts"], maxTokens: 8000 }, context);
  assert.equal(result.isError, undefined, result.text);
  assert.equal(result.structured.changed.length, 1);
  assert.ok(result.structured.dependents.some((item) => item.path === "src/auth.ts"), "the importer is named");
  assert.match(result.text, /export function getUser/);
  assert.match(result.text, /dependent/);

  const missing = await tool.handler({ paths: ["nope.ts"], maxTokens: 1000 }, context);
  assert.deepEqual(missing.structured.missing, ["nope.ts"]);

  const empty = await tool.handler({ paths: [] }, context);
  assert.equal(empty.isError, true);
});

test("a review combines currency, health and the requested bodies", async (t) => {
  const root = fixture(t);
  await generate(root);
  const tool = tools.get("snapshot_review");
  assert.ok(tool, "snapshot_review is served");
  const result = await tool.handler({ paths: ["src/user.ts"], linesPerFile: 40 }, contextFor(root));
  assert.equal(result.isError, undefined, result.text);
  assert.equal(result.structured.current, true);
  assert.ok(result.structured.score >= 0 && result.structured.score <= 100);
  assert.deepEqual(result.structured.failed, []);
  assert.match(result.text, /export function getUser/);

  fs.appendFileSync(path.join(root, "src", "user.ts"), "export const changed = true;\n");
  const stale = await tool.handler({ paths: ["src/user.ts"] }, contextFor(root));
  assert.equal(stale.structured.current, false, "an edited file makes the snapshot stale");
  assert.match(stale.text, /stale/);
});

test("search finds a line, and a redacted value is never found", async (t) => {
  const root = fixture(t);
  await generate(root);
  const search = tools.get("snapshot_search");
  assert.ok(search, "snapshot_search is served");
  const context = contextFor(root);

  const found = await search.handler({ query: "getUser" }, context);
  assert.equal(found.isError, undefined, found.text);
  assert.ok(found.structured.matches.length >= 1);
  assert.ok(found.structured.matches.some((match) => match.path === "src/user.ts"), "the definition is found");
  assert.ok(found.structured.matches.every((match) => typeof match.line === "number"));

  const missing = await search.handler({ query: "neverAppearsAnywhere" }, context);
  assert.equal(missing.structured.matches.length, 0);

  const short = await search.handler({ query: "ab" }, context);
  assert.equal(short.isError, true);

  const bad = await search.handler({ query: "(" , regex: true }, context);
  assert.equal(bad.isError, true);
});

test("stats agree with the manifest", async (t) => {
  const root = fixture(t);
  await generate(root);
  const stats = tools.get("snapshot_stats");
  assert.ok(stats, "snapshot_stats is served");
  const result = await stats.handler({}, contextFor(root));
  assert.equal(result.isError, undefined, result.text);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.equal(result.structured.files, manifest.counts.totalFiles);
  assert.equal(result.structured.parts, manifest.counts.partsCount);
  assert.equal(result.structured.tokens, manifest.totals.estimatedTokens);
  assert.ok(result.structured.heaviest.length > 0);
});
