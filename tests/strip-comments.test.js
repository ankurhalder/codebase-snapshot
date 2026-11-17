/**
 * --strip-comments: removes comment text, keeps line numbers, does not touch strings.
 *
 * The scanner is the point: a regex that treats a comment marker inside a URL or a template literal
 * as a comment corrupts the code it claims only to trim.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "dist", "bin.js");

const TRICKY = "// a leading comment\nexport const url = \"https://example.com/a//b\";\nexport const template = `// not a comment ${1}`;\nconst pattern = /a\\/\\/b/; // a trailing comment\n/* a block\n   comment spanning lines */\nexport function answer() {\n  return 42; // the answer\n}\n";

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "strip-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{\"name\":\"s\",\"version\":\"1.0.0\"}\n");
  fs.writeFileSync(path.join(root, "src", "tricky.ts"), TRICKY);
  fs.writeFileSync(path.join(root, "src", "notes.md"), "# Notes\n\n<!-- a markdown comment -->\n");
  return root;
}

const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
};

test("comments go, strings and line numbers stay", (t) => {
  const root = makeRepo(t);
  const result = run(["generate", "--strip-comments"], root);
  assert.equal(result.code, 0, result.out);

  const part = fs.readFileSync(path.join(root, "snapshot", "parts", "part-001.md"), "utf8");
  assert.ok(part.includes("https://example.com/a//b"), "a URL keeps its slashes");
  assert.ok(part.includes("not a comment"), "a template literal keeps its text");
  assert.ok(part.includes("a\\\\/\\\\/b") || part.includes("a\\/\\/b"), "a regex keeps its slashes");
  assert.equal(part.includes("a leading comment"), false);
  assert.equal(part.includes("a block"), false);
  assert.equal(part.includes("the answer"), false);
  assert.ok(part.includes("return 42"), "the code is untouched");

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  const trickyFile = manifest.files.find((file) => file.relativePath === "src/tricky.ts");
  assert.equal(trickyFile.inclusionMode, "comments-stripped");
  assert.equal(trickyFile.lines, 9, "the line count did not move");
  assert.equal(trickyFile.originalLines, 9);
  const notes = manifest.files.find((file) => file.relativePath === "src/notes.md");
  assert.equal(notes.inclusionMode, "full", "markdown is not stripped");
});

test("health stays clean on a stripped snapshot", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate", "--strip-comments"], root).code, 0);
  const health = run(["health"], root);
  assert.equal(health.code, 0, health.out);
});
