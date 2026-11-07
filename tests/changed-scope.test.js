import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, resolveChangedScope, resolveConfig } from "../dist/index.js";

/**
 * Diff-scoped snapshots, from the 0.9.9 audit.
 *
 * Reviewing a pull request with a model is the case this exists for: the diff is small, the
 * repository is not, and packing all of it costs a context window to answer a question about
 * four files. The failure mode that matters is the quiet one — a ref typo that produces an
 * empty snapshot reads as "this change touched nothing", so every error here is loud.
 */

function git(dir, args) {
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], {
    cwd: dir,
    stdio: "ignore",
  });
}

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changed-scope-"));
  const write = (relative, content) => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
  write("package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write("src/used.ts", "export const used = 1;\n");
  write("src/importer.ts", 'import { used } from "./used.js";\nexport const i = used;\n');
  write("src/untouched.ts", "export const untouched = 1;\n");

  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "first"]);

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, write };
}

const configFor = (dir, extra) =>
  resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", ...extra });

test("only changed files, and untracked ones, are included", (t) => {
  const { dir, write } = makeRepo(t);
  write("src/used.ts", "export const used = 2;\n");
  write("src/brand-new.ts", "export const fresh = 3;\n");

  const manifest = generateSnapshot(configFor(dir, { changedSince: "HEAD" }));
  const included = manifest.files.map((file) => file.relativePath).sort();

  assert.deepEqual(included, ["src/brand-new.ts", "src/used.ts"]);
  const unchanged = manifest.skipped.filter((entry) => entry.reason === "unchanged");
  assert.deepEqual(
    unchanged.map((entry) => entry.path).sort(),
    ["package.json", "src/importer.ts", "src/untouched.ts"],
    "the files that did not move are accounted for, with their own reason"
  );
  assert.ok(unchanged.every((entry) => /changed since HEAD/.test(String(entry.detail))));
});

test("--staged takes the index, not the working tree", (t) => {
  const { dir, write } = makeRepo(t);
  write("src/used.ts", "export const used = 2;\n");
  git(dir, ["add", "src/used.ts"]);
  write("src/untouched.ts", "export const untouched = 99;\n"); // unstaged

  const manifest = generateSnapshot(configFor(dir, { staged: true }));

  assert.deepEqual(manifest.files.map((file) => file.relativePath), ["src/used.ts"]);
});

test("--with-dependents adds the files that import a changed one", (t) => {
  const { dir, write } = makeRepo(t);
  write("src/used.ts", "export const used = 2;\n");

  const plain = generateSnapshot(configFor(dir, { changedSince: "HEAD" }));
  assert.deepEqual(plain.files.map((file) => file.relativePath), ["src/used.ts"]);

  const widened = generateSnapshot(
    configFor(dir, { changedSince: "HEAD", withDependents: true })
  );
  assert.deepEqual(
    widened.files.map((file) => file.relativePath).sort(),
    ["src/importer.ts", "src/used.ts"],
    "the importer is what makes the change safe to review"
  );
  // A file that imports nothing has no dependents to add.
  assert.ok(
    widened.skipped.some((entry) => entry.path === "src/untouched.ts" && entry.reason === "unchanged")
  );
});

test("resolveChangedScope reports what it compared", (t) => {
  const { dir, write } = makeRepo(t);
  write("src/used.ts", "export const used = 2;\n");

  const scope = resolveChangedScope(dir, { changedSince: "HEAD" });
  assert.deepEqual([...scope.paths], ["src/used.ts"]);
  assert.equal(scope.detail, "changed since HEAD");
});

test("a ref that does not exist is an error naming the ref", (t) => {
  const { dir } = makeRepo(t);

  assert.throws(
    () => generateSnapshot(configFor(dir, { changedSince: "no-such-ref" })),
    /no-such-ref[\s\S]*without --changed-since/
  );
});

test("a directory that is not a git repository is an error, not an empty snapshot", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changed-nogit-"));
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.throws(() => generateSnapshot(configFor(dir, { changedSince: "HEAD" })), /git/);
});

test("--with-dependents without a scope is a configuration error", () => {
  assert.throws(
    () => resolveConfig({ cwd: process.cwd(), withDependents: true }),
    /needs `changedSince` or `staged`/
  );
});

test("an empty scope warns instead of looking like a success", (t) => {
  const { dir } = makeRepo(t);

  const manifest = generateSnapshot(configFor(dir, { changedSince: "HEAD" }));

  assert.equal(manifest.files.length, 0, "nothing changed, so nothing is included");
  assert.ok(
    manifest.warnings.some((warning) => /No file is changed since HEAD/.test(warning)),
    `the empty snapshot must explain itself: ${JSON.stringify(manifest.warnings)}`
  );
});
