import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { collectFiles } from "../dist/index.js";

/**
 * gitignore(5) semantics in `walk` mode.
 *
 * `readGitignoreRules` keeps the leading `/` of a root-anchored rule, and the matcher that
 * received it — `matchesExclude` — compares against a path with no leading slash. So `/build`
 * could not equal `build`, could not prefix `build/x`, and could not sit between two slashes:
 * a `/secret-notes.txt` rule silently kept its file in the snapshot.
 *
 * The same delegation made the opposite mistake one segment down: gitignore(5) anchors a pattern
 * with a non-trailing `/` to the directory holding the `.gitignore`, so `doc/frotz` ignores the
 * top-level `doc/frotz` only — and `matchesExclude` matched `a/doc/frotz` too.
 *
 * The names here are deliberately not in `DEFAULT_IGNORED_DIRS`, which would exclude them for an
 * unrelated reason and make the test pass without exercising the rule at all.
 */

function makeTree(t, gitignore) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitignore-anchor-"));
  const write = (relative, content = "x\n") => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
  write(".gitignore", gitignore);
  for (const relative of [
    "generated-code/app.js",
    "secret-notes.txt",
    "deep/generated-code/nested.js",
    "doc/frotz/inside.md",
    "a/doc/frotz/deeper.md",
    "src/keep.ts",
  ]) {
    write(relative);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const scanned = (dir) =>
  collectFiles(dir, { discovery: "walk" }).files.map((entry) => entry.replace(/\\/g, "/"));

test("a root-anchored directory rule matches at the root and nowhere else", (t) => {
  const dir = makeTree(t, "/generated-code\n");
  const files = scanned(dir);

  assert.ok(!files.includes("generated-code/app.js"), "/generated-code is the root one");
  assert.ok(
    files.includes("deep/generated-code/nested.js"),
    "a directory of the same name below the root is not anchored to it"
  );
});

test("a root-anchored file rule matches", (t) => {
  const dir = makeTree(t, "/secret-notes.txt\n");
  assert.ok(!scanned(dir).includes("secret-notes.txt"));
});

test("a pattern with an inner slash is anchored to the .gitignore's directory", (t) => {
  const dir = makeTree(t, "doc/frotz\n");
  const files = scanned(dir);

  assert.ok(!files.includes("doc/frotz/inside.md"), "the anchored path is ignored");
  assert.ok(
    files.includes("a/doc/frotz/deeper.md"),
    "the same two segments deeper in the tree are a different path"
  );
});

test("a pattern with no slash still matches at any depth", (t) => {
  const dir = makeTree(t, "generated-code\n");
  const files = scanned(dir);

  assert.ok(!files.includes("generated-code/app.js"));
  assert.ok(!files.includes("deep/generated-code/nested.js"), "unanchored means every depth");
});

test("root-anchored glob rules work too", (t) => {
  const dir = makeTree(t, "/secret-*.txt\n");
  assert.ok(!scanned(dir).includes("secret-notes.txt"));
});

test("a negation still re-includes an anchored exclusion", (t) => {
  const dir = makeTree(t, "/generated-code/*\n!/generated-code/keep.js\n");
  const target = path.join(dir, "generated-code", "keep.js");
  fs.writeFileSync(target, "x\n", "utf8");

  const files = scanned(dir);
  assert.ok(files.includes("generated-code/keep.js"), "the negation wins");
  assert.ok(!files.includes("generated-code/app.js"), "the rest of the directory is still out");
});
