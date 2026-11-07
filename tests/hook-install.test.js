import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { HOOK_MARKER, installPreCommitHook } from "../dist/index.js";

/**
 * The pre-commit hook installer, from the 0.9.9 audit.
 *
 * `docs/stale-context-is-your-bug.md` argues that a snapshot is only trustworthy when
 * something gates on it, and `validate` is that gate — but wiring it into `.git/hooks` was
 * thirty seconds of manual work, which is exactly the kind of step a project skips.
 *
 * The rules that matter here are rule 2 of this repository: never destroy user data. An
 * existing hook this tool did not write is left alone, whatever the flags say.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-install-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const hookPathOf = (dir) => path.join(dir, ".git", "hooks", "pre-commit");

test("it installs an executable hook into a normal checkout", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });

  const result = installPreCommitHook(dir);

  assert.equal(result.written, true, JSON.stringify(result.notes));
  assert.equal(result.path, hookPathOf(dir));
  const body = fs.readFileSync(hookPathOf(dir), "utf8");
  assert.ok(body.startsWith("#!/bin/sh"), "a hook needs a shebang git can run");
  assert.ok(body.includes(HOOK_MARKER), "and a marker this tool can recognise");
  assert.match(body, /validate/, "it gates on the thing that answers the question");
  assert.match(body, /npx --no-install/, "a hook must never install anything");
  if (process.platform !== "win32") {
    const mode = fs.statSync(hookPathOf(dir)).mode;
    assert.ok((mode & 0o111) !== 0, "git refuses to run a hook that is not executable");
  }
});

test("a second run refreshes its own hook instead of refusing", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  installPreCommitHook(dir);

  const again = installPreCommitHook(dir);

  assert.equal(again.written, true, JSON.stringify(again.notes));
  assert.ok(again.notes.some((note) => /Updated/.test(note)), again.notes.join(" | "));
});

test("someone else's hook is never touched", (t) => {
  const dir = tempDir(t);
  const hookPath = hookPathOf(dir);
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  const foreign = "#!/bin/sh\n# hand-written by a person\nlint-staged\n";
  fs.writeFileSync(hookPath, foreign, "utf8");

  const result = installPreCommitHook(dir);

  assert.equal(result.written, false, "rule 2: a file this tool did not write is not ours");
  assert.equal(fs.readFileSync(hookPath, "utf8"), foreign, "byte for byte unchanged");
  assert.ok(
    result.notes.some((note) => /left untouched/.test(note)),
    "and the refusal is reported"
  );
  assert.ok(
    result.notes.some((note) => /Add `npx codebase-snapshot validate`/.test(note)),
    "with the exact change to make instead"
  );
});

test("a worktree's .git file is followed to the real git directory", (t) => {
  const dir = tempDir(t);
  // A worktree or submodule has `.git` as a file containing a gitdir: line. Writing to
  // `<cwd>/.git/hooks` there fails with ENOTDIR, which reads as "the feature is broken".
  const realGit = path.join(dir, "real-git-dir");
  fs.mkdirSync(realGit, { recursive: true });
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${realGit}\n`, "utf8");

  const result = installPreCommitHook(dir);

  assert.equal(result.written, true, JSON.stringify(result.notes));
  assert.equal(result.path, path.join(realGit, "hooks", "pre-commit"));
  assert.ok(fs.existsSync(path.join(realGit, "hooks", "pre-commit")));
});

test("outside a git working tree it says so and writes nothing", (t) => {
  const dir = tempDir(t);

  const result = installPreCommitHook(dir);

  assert.equal(result.written, false);
  assert.equal(result.path, null);
  assert.ok(result.notes.some((note) => /Not a git working tree/.test(note)));
  assert.deepEqual(fs.readdirSync(dir), [], "nothing was created");
});
