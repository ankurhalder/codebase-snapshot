/**
 * Differential coverage: git's file list is an independent oracle, so a path the generator's own
 * walker silently dropped has to show up here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");
const SCRIPT = path.join(HERE, "..", "scripts", "coverage-diff.mjs");

const git = (root, args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-diff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "export const b = 2;\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "snapshot/\nsnapshot.tmp/\n");
  if (git(root, ["init", "-q"]).status !== 0) return null;
  git(root, ["-c", "user.email=t@e.c", "-c", "user.name=T", "add", "-A"]);
  git(root, ["-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "fixture"]);
  const generated = spawnSync(process.execPath, [BIN, "generate"], { cwd: root, encoding: "utf8" });
  assert.equal(generated.status, 0, (generated.stdout ?? "") + (generated.stderr ?? ""));
  return root;
}

const run = (args) => {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
};

test("every git path is in the fresh snapshot's files or skipped list", (t) => {
  const root = fixture(t);
  if (root === null) {
    t.skip("git is not available");
    return;
  }
  const result = run([root, path.join(root, "snapshot")]);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /every reference path is in files\[\] or skipped\[\]/);
});

test("a path removed from files[] shows up as missing", (t) => {
  const root = fixture(t);
  if (root === null) {
    t.skip("git is not available");
    return;
  }
  const manifestPath = path.join(root, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.files = manifest.files.filter((file) => file.relativePath !== "src/a.ts");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const result = run([root, path.join(root, "snapshot")]);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /src\/a\.ts/);
  assert.match(result.out, /MISSING/);
});

test("--from compares against another tool's file list", (t) => {
  const root = fixture(t);
  if (root === null) {
    t.skip("git is not available");
    return;
  }
  const list = path.join(root, "files.txt");
  fs.writeFileSync(list, "package.json\nsrc/a.ts\nsrc/b.ts\n");
  const clean = run([root, path.join(root, "snapshot"), "--from", list]);
  assert.equal(clean.code, 0, clean.out);

  fs.appendFileSync(list, "src/ghost.ts\n");
  const broken = run([root, path.join(root, "snapshot"), "--from", list]);
  assert.equal(broken.code, 1, broken.out);
  assert.match(broken.out, /src\/ghost\.ts/);
});
