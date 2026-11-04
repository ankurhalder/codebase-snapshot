/**
 * `skill --install`: confinement, ownership, and what it refuses to touch.
 *
 * This is the one command that writes into a repository it did not create, so it is the
 * one command where a path has to be proved to be inside the repository before anything is
 * written. The audit that produced these tests found two escape routes:
 *
 *   - `.claude` (or `.claude/skills/<name>`) as a junction/symlink to a directory outside
 *     the repository: the whole `SKILL.md` was created outside;
 *   - a hard link at a target file: writing it rewrote the file outside the repository.
 *
 * The installer refuses both before the first write.
 *
 * 4.1.1 removed the third target. It used to merge a marked section into `AGENTS.md`, which
 * is the *project's* agent contract, not a skill registry — so these tests now assert that
 * `AGENTS.md` is never created, never edited, and never ignored, and that a section left
 * behind by 4.1.0 is reported rather than rewritten.
 *
 * The tests drive the real CLI (`node dist/bin.js`), so they see the same resolution and the
 * same error text a user sees.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(REPO, "dist", "bin.js");
const LEGACY_MARKER = "<!-- codebase-snapshot:skill:start -->";
const CLAUDE_SKILL = path.join(".claude", "skills", "codebase-snapshot", "SKILL.md");
const CURSOR_RULE = path.join(".cursor", "rules", "codebase-snapshot.mdc");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-install-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs the real CLI; the install report goes to stderr, so both streams are kept. */
function runInstall(cwd, target = "all") {
  const run = spawnSync("node", [BIN, "skill", "--install", "--cwd", cwd, "--target", target], {
    encoding: "utf8",
  });
  if (run.error) throw run.error;
  return { status: run.status ?? 1, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

const read = (file) => fs.readFileSync(file, "utf8");

function makeRepo(t, name) {
  const root = tempDir(t);
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  return { root, repo, outside: path.join(root, "outside") };
}

/** Creates a directory link, or skips the test where the host forbids it. */
function linkDirectory(t, target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, "junction");
    return true;
  } catch {
    t.skip("this host cannot create directory links");
    return false;
  }
}

test("a junction on .claude cannot be used to write outside the repository", (t) => {
  const { repo, outside } = makeRepo(t, "repo");
  fs.mkdirSync(outside);
  if (!linkDirectory(t, outside, path.join(repo, ".claude"))) return;

  const result = runInstall(repo, "claude");

  assert.equal(result.status, 1, `expected a refusal, got: ${result.output}`);
  assert.match(result.output, /Refusing to install the agent skill/);
  assert.match(result.output, /\.claude/);
  assert.deepEqual(fs.readdirSync(outside), [], "nothing may be created outside the repository");
});

test("a junction at the skill directory itself is refused", (t) => {
  const { repo, outside } = makeRepo(t, "repo");
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(repo, ".claude", "skills"), { recursive: true });
  if (!linkDirectory(t, outside, path.join(repo, ".claude", "skills", "codebase-snapshot"))) return;

  const result = runInstall(repo, "claude");

  assert.equal(result.status, 1);
  assert.match(result.output, /resolves outside the repository/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("a hard-linked target file is refused and the outside file is untouched", (t) => {
  const { repo, outside } = makeRepo(t, "repo");
  fs.mkdirSync(outside);
  const outsideFile = path.join(outside, "SKILL.md");
  fs.writeFileSync(outsideFile, "# outside file\n\nNothing to do with the repository.\n");
  fs.mkdirSync(path.join(repo, ".claude", "skills", "codebase-snapshot"), { recursive: true });
  try {
    fs.linkSync(outsideFile, path.join(repo, CLAUDE_SKILL));
  } catch {
    t.skip("this host cannot create hard links");
    return;
  }
  const before = fs.readFileSync(outsideFile);

  const result = runInstall(repo, "claude");

  assert.equal(result.status, 1, `expected a refusal, got: ${result.output}`);
  assert.match(result.output, /hard links/);
  assert.deepEqual(fs.readFileSync(outsideFile), before, "the outside file must not change");
});

test("a refusal happens before any write, even with --target all", (t) => {
  const { repo, outside } = makeRepo(t, "repo");
  fs.mkdirSync(outside);
  if (!linkDirectory(t, outside, path.join(repo, ".cursor"))) return;

  const result = runInstall(repo, "all");

  assert.equal(result.status, 1);
  assert.equal(
    fs.existsSync(path.join(repo, CLAUDE_SKILL)),
    false,
    "the other target must not be written when one is refused"
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("a symlink at a target file itself is refused", (t) => {
  const { repo, outside } = makeRepo(t, "repo");
  fs.mkdirSync(outside);
  const outsideFile = path.join(outside, "rule.mdc");
  fs.writeFileSync(outsideFile, "# outside\n");
  fs.mkdirSync(path.join(repo, ".cursor", "rules"), { recursive: true });
  try {
    fs.symlinkSync(outsideFile, path.join(repo, CURSOR_RULE), "file");
  } catch {
    t.skip("creating a file symlink needs elevation on this host; the junction test covers the same path");
    return;
  }

  const result = runInstall(repo, "cursor");

  assert.equal(result.status, 1);
  assert.match(result.output, /symbolic link|junction/);
  assert.equal(read(outsideFile), "# outside\n");
});

test("--target all writes both registries and nothing else", (t) => {
  const { repo } = makeRepo(t, "repo");

  const result = runInstall(repo, "all");

  assert.equal(result.status, 0, result.output);
  assert.equal(fs.existsSync(path.join(repo, CLAUDE_SKILL)), true);
  assert.equal(fs.existsSync(path.join(repo, CURSOR_RULE)), true);
  assert.deepEqual(
    fs.readdirSync(repo).sort(),
    [".claude", ".cursor", ".gitignore"],
    "a fresh install must create the two registries and the ignore file, nothing else"
  );
});

test("a second install changes nothing", (t) => {
  const { repo } = makeRepo(t, "repo");
  assert.equal(runInstall(repo, "claude").status, 0);
  const first = read(path.join(repo, CLAUDE_SKILL));
  const ignore = read(path.join(repo, ".gitignore"));

  const second = runInstall(repo, "claude");

  assert.equal(second.status, 0, second.output);
  assert.equal(read(path.join(repo, CLAUDE_SKILL)), first);
  assert.equal(read(path.join(repo, ".gitignore")), ignore, "no duplicate ignore entries");
  assert.match(second.output, /unchanged/);
});

test("what it creates is added to .gitignore, and existing entries survive", (t) => {
  const { repo } = makeRepo(t, "repo");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");

  assert.equal(runInstall(repo, "all").status, 0);

  const ignore = read(path.join(repo, ".gitignore"));
  assert.match(ignore, /node_modules\//, "the existing entry survives");
  assert.ok(ignore.includes(".claude/skills/codebase-snapshot/SKILL.md"), "skill file is ignored");
  assert.ok(ignore.includes(".cursor/rules/codebase-snapshot.mdc"), "rule file is ignored");
  assert.doesNotMatch(ignore, /AGENTS\.md/, "AGENTS.md is never ignored");
});

test("AGENTS.md is never created and never edited", (t) => {
  const { repo } = makeRepo(t, "repo");
  const house = "# House rules\n\nUse tabs.\n";
  fs.writeFileSync(path.join(repo, "AGENTS.md"), house);

  const result = runInstall(repo, "all");

  assert.equal(result.status, 0, result.output);
  assert.equal(read(path.join(repo, "AGENTS.md")), house, "the project's agent file is untouched");
  assert.doesNotMatch(read(path.join(repo, ".gitignore")), /AGENTS\.md/);
});

test("a section left by 4.1.0 is reported, never rewritten", (t) => {
  const { repo } = makeRepo(t, "repo");
  const legacy = ["# AGENTS.md", "", LEGACY_MARKER, "", "old body", "", "<!-- codebase-snapshot:skill:end -->", ""].join("\n");
  fs.writeFileSync(path.join(repo, "AGENTS.md"), legacy);

  const result = runInstall(repo, "claude");

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /AGENTS\.md still contains the section/);
  assert.equal(read(path.join(repo, "AGENTS.md")), legacy, "the block must not be touched");
});

test("--target isolation holds, and the removed `agents` target is a usage error", (t) => {
  const root = tempDir(t);
  const expectations = {
    claude: [CLAUDE_SKILL, CURSOR_RULE],
    cursor: [CURSOR_RULE, CLAUDE_SKILL],
  };
  for (const [target, [own, absent]] of Object.entries(expectations)) {
    const repo = path.join(root, target);
    fs.mkdirSync(repo, { recursive: true });
    const result = runInstall(repo, target);
    assert.equal(result.status, 0, `${target}: ${result.output}`);
    assert.equal(fs.existsSync(path.join(repo, own)), true, `${target} must write ${own}`);
    assert.equal(fs.existsSync(path.join(repo, absent)), false, `${target} must not write ${absent}`);
  }

  const repo = path.join(root, "removed");
  fs.mkdirSync(repo, { recursive: true });
  const removed = runInstall(repo, "agents");
  assert.equal(removed.status, 2, "`agents` was removed, so it must be rejected as a usage error");
  assert.match(removed.output, /target|claude|cursor/i);
});
