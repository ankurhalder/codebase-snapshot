/**
 * The head-to-head harness, exercised without a competitor.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

test("the comparison harness runs without a competitor and reports three modes", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "compare-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "c", version: "1.0.0" }) + "\n");
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "b.ts"), 'import { a } from "./a.js";\nexport const b = a;\n');

  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "compare.mjs"), repo, "--json"], {
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.ours.map((row) => row.label), ["full", "slice", "budget"]);
  for (const row of summary.ours) {
    assert.equal(typeof row.files, "number");
    assert.equal(typeof row.tokens, "number");
  }
  const full = summary.ours.find((row) => row.label === "full");
  assert.ok(full.tokens > 0, "the full pack of a fixture with files is not empty");
  assert.equal(summary.repomix, undefined, "no competitor is run without the flag");
});
