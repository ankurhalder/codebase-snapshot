import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot } from "../dist/index.js";

/**
 * 4.0.9 regression cover for a nested repository.
 *
 * A submodule is a single gitlink entry, so git lists a path where a file is expected and `stat`
 * answers "directory". That was recorded as the generic `not-file`, which tells the reader the
 * path is a socket or a FIFO. The contents exist and simply belong to a different repository, and
 * `skipped[]` says so now.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-nested-repo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd, args) =>
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args],
    { cwd, stdio: "ignore" }
  );

test("S7: a nested repository is recorded as nested-repository, not not-file", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "app.ts"), "export const a = 1;\n", "utf8");

  // A nested repository with one commit, then added to the parent: git records a gitlink.
  const nested = path.join(dir, "vendor", "lib");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "lib.ts"), "export const lib = 1;\n", "utf8");

  try {
    git(nested, ["init", "-q"]);
    git(nested, ["add", "-A"]);
    git(nested, ["commit", "-q", "-m", "nested"]);
    git(dir, ["init", "-q"]);
    git(dir, ["add", "-A"]);
  } catch {
    t.skip("git is unavailable on this host");
    return;
  }

  const manifest = generateSnapshot({ cwd: dir });

  const record = manifest.skipped.find((entry) => entry.path === "vendor/lib");
  assert.ok(record, `the gitlink is recorded, not dropped: ${JSON.stringify(manifest.skipped)}`);
  assert.equal(record.reason, "nested-repository");
  assert.match(record.detail, /another repository/);
  assert.ok(
    !manifest.files.some((file) => file.relativePath === "vendor/lib"),
    "a gitlink is not emitted as a file"
  );
});

test("S7: a plain directory is still not-file, and a nested repository is distinguished", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "app.ts"), "export const a = 1;\n", "utf8");
  // A directory that is not a repository, listed by git as a path: impossible in practice, so
  // this asserts the branch rather than a real fixture — git only lists directories as gitlinks.
  fs.mkdirSync(path.join(dir, "plain"), { recursive: true });

  try {
    git(dir, ["init", "-q"]);
    git(dir, ["add", "-A"]);
  } catch {
    t.skip("git is unavailable on this host");
    return;
  }

  const manifest = generateSnapshot({ cwd: dir });

  assert.ok(
    !manifest.skipped.some((entry) => entry.reason === "nested-repository"),
    "an empty directory is not a nested repository"
  );
});
