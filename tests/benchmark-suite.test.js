/**
 * The repository suite: three tools over public repositories, no silent drops.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

test("the suite reports a repository it cannot clone instead of dropping it", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "suite-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "s", version: "1.0.0" }) + "\n");
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");

  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "benchmark-suite.mjs"), "--json", repo], {
    encoding: "utf8",
    timeout: 300000,
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout.slice(result.stdout.indexOf(String.fromCharCode(123))));
  assert.equal(summary.rows.length, 1);
  assert.match(String(summary.rows[0].skipped), /clone failed/);
});
