/**
 * `reports/selection.md`: a narrowed snapshot has to explain its own choices.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "s", version: "1.0.0" }) + "\n");
  fs.writeFileSync(
    path.join(root, "src", "budget.ts"),
    "export function fitBudget(tokens: number): number {\n  return tokens;\n}\n"
  );
  fs.writeFileSync(path.join(root, "src", "other.ts"), "export const other = 1;\n");
  for (let index = 0; index < 6; index += 1) {
    const body = Array.from({ length: 50 }, (_, i) => "export const pad" + index + "_" + i + " = " + i + ";").join("\n");
    fs.writeFileSync(path.join(root, "src", "pad" + index + ".ts"), body + "\n");
  }
  return root;
}

const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
};

test("a slice writes selection.md with the question and the reason per file", (t) => {
  const root = repo(t);
  const generated = run(["generate", "--slice", "fit budget tokens", "--slice-tokens", "2000"], root);
  assert.equal(generated.code, 0, generated.out);
  const selection = fs.readFileSync(path.join(root, "snapshot", "reports", "selection.md"), "utf8");
  assert.match(selection, /# Selection/);
  assert.match(selection, /Question:\*\* fit budget tokens/);
  assert.match(selection, /src\/budget\.ts/);
  assert.match(selection, /Why each file is here/);
  assert.match(selection, /not-selected/);
});

test("a budget snapshot names what a larger budget would buy", (t) => {
  const root = repo(t);
  const generated = run(["generate", "--budget-tokens", "500"], root);
  assert.equal(generated.code, 0, generated.out);
  const selection = fs.readFileSync(path.join(root, "snapshot", "reports", "selection.md"), "utf8");
  assert.match(selection, /Budget:\*\* 500 tokens/);
  assert.match(selection, /Tokens spent:/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  if (manifest.budget.nextInLine.length > 0) {
    assert.match(selection, /What a larger budget would buy/);
  }
});

test("editing selection.md is drift validate reports", (t) => {
  const root = repo(t);
  assert.equal(run(["generate", "--slice", "fit budget tokens"], root).code, 0);
  assert.equal(run(["validate"], root).code, 0);
  fs.appendFileSync(path.join(root, "snapshot", "reports", "selection.md"), "\nextra\n");
  const validated = run(["validate"], root);
  assert.notEqual(validated.code, 0);
  assert.match(validated.out, /selection\.md/);
});
