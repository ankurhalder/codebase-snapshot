import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { collectFiles, findSecretInPath, getGitInfo } from "../dist/index.js";

/**
 * Scanner robustness, from the 0.9.9 audit.
 *
 * Four defects with one thing in common: each made a scan depend on something other
 * than the tree being scanned — a path-shape bug in the `.gitignore` matcher, a
 * process-wide "current discovery mode", a name check that undid the reserved-path
 * check, and a per-call recompilation of thirty regular expressions.
 */

function tempDir(t, prefix = "scan-robust-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

const paths = (result) => result.files.slice().sort();

function git(dir, args) {
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], {
    cwd: dir,
    stdio: "ignore",
  });
}

// ------------------------------------------------------------------ gitignore shape

test("a multi-segment directory rule in .gitignore is honoured", (t) => {
  const dir = tempDir(t);
  write(dir, ".gitignore", "public/build/\n");
  write(dir, "public/build/app.js", "bundle\n");
  write(dir, "public/keep.ts", "export const keep = 1;\n");

  const result = collectFiles(dir, { discovery: "walk" });

  assert.ok(paths(result).includes("public/keep.ts"), "siblings are still scanned");
  assert.ok(
    !paths(result).includes("public/build/app.js"),
    "a rule naming a nested directory must exclude its contents"
  );
  assert.ok(
    result.skipped.some((entry) => entry.path === "public/build" || entry.path === "public/build/app.js"),
    "and the omission must be recorded, not silent"
  );
});

test("a directory rule does not drop a regular file of the same name", (t) => {
  const dir = tempDir(t);
  write(dir, ".gitignore", "build/\n");
  write(dir, "build", "not a directory, an extensionless file\n");
  write(dir, "keep.ts", "export const keep = 1;\n");

  const result = collectFiles(dir, { discovery: "walk" });

  // `build/` matches a *directory*. A file called `build` is a different thing, and
  // dropping it was the other half of the same bug.
  assert.ok(paths(result).includes("build"), `the file must be scanned: ${paths(result)}`);
});

test("a nested directory rule still applies beneath its own directory", (t) => {
  const dir = tempDir(t);
  write(dir, "packages/foo/.gitignore", "src/generated/\n");
  write(dir, "packages/foo/src/generated/out.js", "junk\n");
  write(dir, "packages/foo/src/index.ts", "export const a = 1;\n");

  const result = collectFiles(dir, { discovery: "walk" });

  assert.ok(paths(result).includes("packages/foo/src/index.ts"));
  assert.ok(!paths(result).includes("packages/foo/src/generated/out.js"));
});

// ------------------------------------------------------------------ reserved paths

test("a custom outDir is excluded without being recorded as skipped", (t) => {
  const dir = tempDir(t);
  write(dir, "src/a.ts", "export const a = 1;\n");
  fs.mkdirSync(path.join(dir, ".context"), { recursive: true });

  const result = collectFiles(dir, { discovery: "walk", toolOwnedPaths: [".context"] });

  assert.ok(
    !result.skipped.some((entry) => entry.path === ".context"),
    "the tool's own output is not a user-facing skip"
  );
  assert.ok(!paths(result).includes(".context"), "and it is not scanned");
  assert.ok(paths(result).includes("src/a.ts"));
});

// ------------------------------------------------------------------ discovery mode

test("the discovery mode is per call, not process-wide state", (t) => {
  const dir = tempDir(t);
  git(dir, ["init", "-q"]);
  write(dir, "keep.ts", "export const keep = 1;\n");
  git(dir, ["add", "keep.ts"]);
  // Tracked and ignored at once: git lists it, a walk does not. That difference is the
  // observable consequence of which mode was used.
  write(dir, ".gitignore", "keep.ts\n");

  const viaGit = collectFiles(dir, { discovery: "git" });
  const viaWalk = collectFiles(dir, { discovery: "walk" });

  assert.ok(paths(viaGit).includes("keep.ts"), "git lists a tracked file despite the ignore rule");
  assert.ok(!paths(viaWalk).includes("keep.ts"), "the walk honours the ignore rule");
});

test("a caller that passes no mode gets auto, whatever ran before", (t) => {
  const dir = tempDir(t);
  write(dir, "a.ts", "export const a = 1;\n");

  collectFiles(dir, { discovery: "walk" });
  // A module-level "active" mode used to leak from the previous call (or from the last
  // `resolveConfig` in the process), so this returned whatever ran last.
  const result = collectFiles(dir, {});
  assert.ok(paths(result).includes("a.ts"));
});

// ------------------------------------------------------------------ git metadata

test("git metadata comes from one status call and describes the tree", (t) => {
  const dir = tempDir(t);
  git(dir, ["init", "-q"]);
  write(dir, "a.ts", "export const a = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "first"]);

  const clean = getGitInfo(dir);
  assert.match(clean.commit, /^[0-9a-f]{40}$/, "the commit is a full sha");
  assert.equal(clean.isDirty, false, "a committed tree is clean");
  assert.ok(clean.branch.length > 0 && clean.branch !== "HEAD", "a branch is named");

  write(dir, "a.ts", "export const a = 2;\n");
  const dirty = getGitInfo(dir);
  assert.equal(dirty.isDirty, true, "an edit makes the tree dirty");
  assert.equal(dirty.commit, clean.commit, "and the commit is still the checked-out one");
});

test("a directory without git reports the fallback branch and an unknown commit", (t) => {
  const dir = tempDir(t);
  const info = getGitInfo(dir, "trunk");
  assert.equal(info.branch, "trunk");
  assert.equal(info.commit, "unknown");
});

// ------------------------------------------------------------------ path scanning

test("path secret scanning is repeatable across calls", () => {
  const file = "src/config/ghp_abcdefghijklmnopqrstuvwxyz0123456789.ts";
  const first = findSecretInPath(file);
  const second = findSecretInPath(file);

  assert.ok(first, "the token in the path is found");
  assert.deepEqual(second, first, "a cached global regex must not carry lastIndex between calls");
});

test("custom rules are applied to paths as well", () => {
  const hit = findSecretInPath("src/tenant_abcdefgh.ts", [
    { rule: "tenant-key", pattern: /tenant_[a-z]{8}/ },
  ]);
  assert.ok(hit, "the custom rule matched");
  assert.deepEqual(hit.rules, ["tenant-key"]);
  assert.ok(!hit.masked.includes("tenant_abcdefgh"), "and the value is masked");
});
