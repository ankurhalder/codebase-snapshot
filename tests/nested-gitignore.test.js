import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { collectFiles } from "../dist/index.js";

/**
 * 4.0.9 regression cover for nested `.gitignore` files.
 *
 * Only the root `.gitignore` was ever read, so in a non-git checkout a `dist/` rule inside
 * `packages/foo/.gitignore` did nothing while git honoured it in the same repository — the same
 * tree produced two different snapshots depending on whether `.git` was readable. The walker now
 * carries every `.gitignore` it passes, and the deepest rule that matches wins, which is git's
 * precedence rule.
 */

function tempDir(t, prefix = "snap-gitignore-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

const scan = (dir) => collectFiles(dir, {});
const paths = (result) => result.files.slice().sort();

test("S4: a nested .gitignore is honoured in a non-git checkout", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  write(dir, "packages/foo/src/index.ts", "export const b = 2;\n");
  write(dir, "packages/foo/generated/bundle.js", "junk\n");
  write(dir, "packages/foo/.gitignore", "generated/\n");

  const result = scan(dir);

  assert.ok(paths(result).includes("packages/foo/src/index.ts"), "the source is scanned");
  assert.ok(!paths(result).includes("packages/foo/generated/bundle.js"), "the nested rule applies");
  const record = result.skipped.find((entry) => entry.path === "packages/foo/generated");
  assert.ok(record, "the omission is recorded, not silent");
  assert.equal(record.reason, "gitignore");
});

test("S4: a nested rule does not touch paths outside its directory", (t) => {
  const dir = tempDir(t);
  write(dir, "generated/keep.js", "kept\n");
  write(dir, "packages/foo/generated/drop.js", "dropped\n");
  write(dir, "packages/foo/.gitignore", "generated/\n");

  const result = scan(dir);

  assert.ok(paths(result).includes("generated/keep.js"), "the root generated/ is untouched by a nested rule");
  assert.ok(!paths(result).includes("packages/foo/generated/drop.js"));
});

test("S4: a nested negation re-includes a path the root ignored", (t) => {
  const dir = tempDir(t);
  write(dir, ".gitignore", "*.log\n");
  write(dir, "root.log", "ignored\n");
  write(dir, "packages/foo/keep.log", "kept\n");
  write(dir, "packages/foo/.gitignore", "!keep.log\n");

  const result = scan(dir);

  assert.ok(!paths(result).includes("root.log"), "the root rule still applies at the root");
  assert.ok(paths(result).includes("packages/foo/keep.log"), "the deep negation wins");
});

test("S4: a nested rule can re-ignore a path a root negation re-included", (t) => {
  const dir = tempDir(t);
  write(dir, ".gitignore", "*.log\n!important.log\n");
  write(dir, "important.log", "kept\n");
  write(dir, "packages/foo/important.log", "dropped\n");
  write(dir, "packages/foo/.gitignore", "important.log\n");

  const result = scan(dir);

  assert.ok(paths(result).includes("important.log"), "the root negation holds at the root");
  assert.ok(!paths(result).includes("packages/foo/important.log"), "the deeper ignore wins");
});

test("S4: the walking scan and the git scan now agree", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  write(dir, "packages/foo/src/index.ts", "export const b = 2;\n");
  write(dir, "packages/foo/generated/bundle.js", "junk\n");
  write(dir, ".gitignore", "node_modules\n");
  write(dir, "packages/foo/.gitignore", "generated/\n");

  const walking = paths(scan(dir));

  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  } catch {
    return; // git is unavailable on this host; the walker cases above already ran
  }
  const viaGit = paths(scan(dir));

  assert.deepEqual(viaGit, walking, "same repository, same candidates, either discovery mode");
});
