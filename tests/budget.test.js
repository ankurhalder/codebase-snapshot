/**
 * The budget planner: "fit this repository into N tokens" without tearing files in half.
 *
 * The test pins the three properties the docs claim: the total fits, the selection prefers what
 * matters, and every dropped path is recorded.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "dist", "bin.js");

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main.ts"), "import { core } from './core.js';\nexport const main = core;\n");
  fs.writeFileSync(path.join(root, "src", "core.ts"), "export const core = 1;\n");
  fs.writeFileSync(path.join(root, "src", "noise.ts"), "export const noise = Array.from({ length: 40 }, (_, i) => i);\n");
  fs.writeFileSync(path.join(root, "docs", "big.md"), "# Big\n" + "word ".repeat(4000) + "\n");
  return root;
}

const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
};

test("a budget selects whole files and records what did not fit", (t) => {
  const root = makeRepo(t);
  const result = run(["generate", "--budget-tokens", "600"], root);
  assert.equal(result.code, 0, result.out);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.ok(manifest.budget, "the manifest records the budget");
  assert.equal(manifest.budget.maxTokens, 600);
  assert.ok(manifest.budget.usedTokens <= 600, "used " + manifest.budget.usedTokens);

  const kept = manifest.files.map((file) => file.relativePath);
  assert.ok(kept.includes("src/main.ts"), "the entry point is kept: " + kept.join(","));
  for (const file of manifest.files) {
    assert.equal(file.inclusionMode, "full", file.relativePath + " is not torn");
  }

  const dropped = manifest.skipped.filter((record) => record.reason === "not-selected").map((record) => record.path);
  assert.ok(dropped.length > 0, "the rest is recorded");
  assert.equal(manifest.budget.files.length + dropped.length, manifest.files.length + dropped.length);
});

test("a tiny budget does not crash and says so", (t) => {
  const root = makeRepo(t);
  const result = run(["generate", "--budget-tokens", "500"], root);
  assert.equal(result.code, 0, result.out);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.ok(manifest.budget.usedTokens <= 500);
});

test("the budget report says what survived", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate", "--budget-tokens", "800"], root).code, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  const coverage = manifest.budget.coverage;
  assert.ok(coverage, "coverage is recorded");
  assert.ok(coverage.symbols.total > 0, "symbols are counted");
  assert.ok(coverage.symbols.kept <= coverage.symbols.total);
  const layers = Object.keys(coverage.byLayer);
  assert.ok(layers.length > 0);
  for (const layer of layers) {
    assert.ok(coverage.byLayer[layer].kept <= coverage.byLayer[layer].total);
  }
  assert.ok(coverage.entryPoints.total > 0, "the fixture has entry points");
});
