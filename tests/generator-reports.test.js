/**
 * The three opt-in reports: diff, log, token tree.
 *
 * Each is an artifact of the run that produced it: the diff says which git command and is truncated
 * with a note, the log names its range, the token tree totals agree with the per-file rows.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "dist", "bin.js");

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reports-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"r","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "export const b = 2;\n");
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (git(["init", "-q"]).status !== 0) return null;
  git(["-c", "user.email=t@e.c", "-c", "user.name=T", "add", "-A"]);
  git(["-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "first"]);
  return root;
}

const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
};

test("--include-diffs writes the uncommitted change, and nothing when there is none", (t) => {
  const root = makeRepo(t);
  if (root === null) {
    t.skip("git is not available");
    return;
  }
  // Clean tree: the artifact is absent, because an empty report is noise.
  assert.equal(run(["generate"], root).code, 0);
  assert.equal(fs.existsSync(path.join(root, "snapshot", "reports", "diff.md")), false);

  fs.appendFileSync(path.join(root, "src", "a.ts"), "export const added = true;\n");
  assert.equal(run(["generate", "--include-diffs"], root).code, 0);
  const diff = fs.readFileSync(path.join(root, "snapshot", "reports", "diff.md"), "utf8");
  assert.match(diff, /Uncommitted changes/);
  assert.match(diff, /added/);
  assert.match(diff, /git diff/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.ok(manifest.artifacts.diff, "the manifest records it");
});

test("--include-logs names its range and the commits", (t) => {
  const root = makeRepo(t);
  if (root === null) {
    t.skip("git is not available");
    return;
  }
  assert.equal(run(["generate", "--include-logs", "5"], root).code, 0);
  const log = fs.readFileSync(path.join(root, "snapshot", "reports", "log.md"), "utf8");
  assert.match(log, /Recent commits/);
  assert.match(log, /first/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.ok(manifest.artifacts.log);
});

test("--token-tree totals agree with its rows", (t) => {
  const root = makeRepo(t);
  if (root === null) {
    t.skip("git is not available");
    return;
  }
  assert.equal(run(["generate", "--token-tree"], root).code, 0);
  const tree = fs.readFileSync(path.join(root, "snapshot", "reports", "tokens.md"), "utf8");
  assert.match(tree, /Token tree/);
  const total = Number(/\*\*Total: (\d+) tokens across (\d+) files\.\*\*/.exec(tree)?.[1]);
  assert.ok(Number.isFinite(total) && total > 0);
  const rows = tree.split("\n").filter((line) => line.startsWith("| ") && line.includes("| part-"));
  const sum = rows.reduce((value, line) => value + Number(line.split("|")[4].trim()), 0);
  assert.equal(sum, total, "the rows add up to the stated total");
});

test("an invalid --include-logs value is a usage error, not a silent default", (t) => {
  const root = makeRepo(t);
  if (root === null) {
    t.skip("git is not available");
    return;
  }
  const result = run(["generate", "--include-logs", "0"], root);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /include-logs/);
});

test("deleting an opt-in report fails validation with its path", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate", "--token-tree"], root).code, 0);
  assert.equal(run(["validate", "--token-tree"], root).code, 0);

  fs.rmSync(path.join(root, "snapshot", "reports", "tokens.md"));
  const result = run(["validate", "--token-tree"], root);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /tokens\.md/);
});

test("the brief names the opt-in reports this run wrote", (t) => {
  const root = makeRepo(t);
  fs.appendFileSync(path.join(root, "src", "a.ts"), "export const changed = true;\n");
  assert.equal(run(["generate", "--token-tree", "--include-diffs"], root).code, 0);
  const prompt = fs.readFileSync(path.join(root, "snapshot", "PROMPT.md"), "utf8");
  assert.match(prompt, /reports\/tokens\.md/);
  assert.match(prompt, /reports\/diff\.md/);
  assert.doesNotMatch(prompt, /reports\/log\.md/, "log was not requested");
});
