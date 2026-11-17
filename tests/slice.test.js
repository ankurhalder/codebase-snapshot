/**
 * Task slicing: the planner, applied at generate time.
 *
 * A slice is the same selection the MCP server returns for plan_for, written to disk. The tests
 * check the three claims that matter: it keeps what the question names, it records what it dropped,
 * and the brief says it is a slice rather than the whole repository.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "dist", "bin.js");

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"s","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "src", "billing.ts"), "export function chargeCard() { return true; }\n");
  fs.writeFileSync(path.join(root, "src", "billing.test.ts"), "test('charge', () => {});\n");
  fs.writeFileSync(path.join(root, "src", "unrelated.ts"), "export const unrelated = 1;\n");
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  return root;
}

const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
};

test("a slice keeps the files the question names and records the rest", (t) => {
  const root = makeRepo(t);
  const result = run(["generate", "--slice", "how does chargeCard work", "--slice-tokens", "4000"], root);
  assert.equal(result.code, 0, result.out);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.ok(manifest.slice, "the manifest records the slice");
  assert.equal(manifest.slice.question, "how does chargeCard work");
  assert.equal(manifest.slice.budgetTokens, 4000);
  const kept = manifest.files.map((file) => file.relativePath);
  assert.ok(kept.includes("src/billing.ts"), "the matching file is kept: " + kept.join(","));
  assert.equal(kept.includes("docs/guide.md"), false, "the unrelated document is dropped");

  const dropped = manifest.skipped.filter((record) => record.reason === "not-selected").map((record) => record.path);
  assert.ok(dropped.includes("docs/guide.md"), "the drop is recorded");

  const prompt = fs.readFileSync(path.join(root, "snapshot", "PROMPT.md"), "utf8");
  assert.match(prompt, /chargeCard/);
  assert.match(prompt, /not selected/i);
});

test("the budget is a ceiling on the slice", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate", "--slice", "billing charge", "--slice-tokens", "500"], root).code, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.ok(manifest.slice.usedTokens <= 500, "used " + manifest.slice.usedTokens);
});

test("--slice and --delta together are refused", (t) => {
  const root = makeRepo(t);
  const result = run(["generate", "--slice", "billing", "--delta", root], root);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /two different directions/);
});
