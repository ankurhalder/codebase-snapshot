import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installPreCommitHook, workerEntry } from "../dist/index.js";

/**
 * 0.9.11 — two places where a path was assembled by hand instead of by the platform.
 */

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-outdir-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n", "utf8");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const hookBody = (dir) =>
  fs.readFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "utf8");

test("the hook checks the configured output directory, not `snapshot`", (t) => {
  const dir = makeRepo(t);
  const result = installPreCommitHook(dir, ".context");

  assert.equal(result.written, true);
  const body = hookBody(dir);
  assert.match(body, /SNAPSHOT_DIR="\.context"/, "the directory the config names");
  assert.doesNotMatch(body, /\[ ! -d snapshot \]/, "the hardcoded guard is gone");
  assert.match(
    body,
    /\[ ! -f "\$SNAPSHOT_DIR\/manifest\.json" \]/,
    "the guard tests the manifest, not the directory"
  );
});

test("the hook default is still `snapshot` for a project that never set outDir", (t) => {
  const dir = makeRepo(t);
  installPreCommitHook(dir);
  assert.match(hookBody(dir), /SNAPSHOT_DIR="snapshot"/);
});

test("a directory with a space or a quote is escaped for the shell", (t) => {
  const dir = makeRepo(t);
  installPreCommitHook(dir, '.my "snap" $dir');
  const body = hookBody(dir);

  assert.match(
    body,
    /SNAPSHOT_DIR="\.my \\"snap\\" \\\$dir"/,
    "a double quote or a dollar sign would otherwise end the word or expand"
  );
});

test("re-installing keeps the marker, so the hook stays recognisably ours", (t) => {
  const dir = makeRepo(t);
  installPreCommitHook(dir, ".context");
  const again = installPreCommitHook(dir, ".context");

  assert.equal(again.written, true, "a hook carrying the marker is refreshed");
  assert.equal((hookBody(dir).match(/codebase-snapshot: pre-commit snapshot check/g) ?? []).length, 1);
});

test("the worker entry URL survives spaces, % and # in the install path", () => {
  // The interpolation form `file://${path}` reads `#` as a fragment, `%` as an escape and leaves
  // a space unescaped, so the worker imported the wrong file — or nothing.
  const directory = path.join(os.tmpdir(), "install dir", "100%", "#tag");
  const { url } = workerEntry(directory, false);

  assert.doesNotMatch(url, /#tag/, "a `#` must be escaped, not read as a fragment");
  assert.match(url, /%20/, "the space is escaped");
  assert.match(url, /%25/, "the percent sign is escaped");
  assert.equal(
    fileURLToPath(url),
    path.join(directory, "index.js"),
    "and the URL round-trips to the real path"
  );
});

test("the worker entry picks the build format's filename", () => {
  const directory = path.join(os.tmpdir(), "worker-entry");
  assert.match(workerEntry(directory, true).path, /index\.cjs$/);
  assert.match(workerEntry(directory, false).path, /index\.js$/);
});
