/**
 * `skill --install` confinement and marked-block repair.
 *
 * This is the one command that writes into a repository it did not create, so it
 * is the one command where a path has to be proved to be inside the repository
 * before anything is written. The audit that produced these tests found three
 * escape routes and three malformed-block outcomes:
 *
 *   - `.claude` (or `.claude/skills/<name>`) as a junction/symlink to a directory
 *     outside the repository: the whole `SKILL.md` was created outside;
 *   - `AGENTS.md` as a hard link to a file outside: that file was rewritten;
 *   - a nested, duplicated or inverted marker pair: the file was left with
 *     unbalanced markers (3 START / 2 END) and never repaired.
 *
 * The installer now refuses all three before the first write, and normalises any
 * malformed marked section to exactly one balanced block while keeping the bytes
 * the user wrote. The tests drive the real CLI (`node dist/bin.js`), so they see
 * the same resolution and the same error text a user sees.
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
const START = "<!-- codebase-snapshot:skill:start -->";
const END = "<!-- codebase-snapshot:skill:end -->";

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
const count = (text, needle) => text.split(needle).length - 1;

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

test("a hard-linked AGENTS.md is refused and the outside file is untouched", (t) => {
  const { repo, outside } = makeRepo(t, "repo");
  fs.mkdirSync(outside);
  const outsideFile = path.join(outside, "AGENTS.md");
  fs.writeFileSync(outsideFile, "# outside file\n\nNothing to do with the repository.\n");
  try {
    fs.linkSync(outsideFile, path.join(repo, "AGENTS.md"));
  } catch {
    t.skip("this host cannot create hard links");
    return;
  }
  const before = fs.readFileSync(outsideFile);

  const result = runInstall(repo, "agents");

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
    fs.existsSync(path.join(repo, "AGENTS.md")),
    false,
    "AGENTS.md must not be created when another target is refused"
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("a well-formed section is replaced in place and re-running is byte-identical", (t) => {
  const { repo } = makeRepo(t, "repo");
  const file = path.join(repo, "AGENTS.md");
  const block = [START, "", "## codebase-snapshot (@ankurhalder/codebase-snapshot)", "", "old body", "", END].join("\n");
  const before = ["# My Project", "", "Intro one.", "Intro two.", "", block, "", "After prose.", ""].join("\n");
  fs.writeFileSync(file, before);

  const first = runInstall(repo, "agents");
  assert.equal(first.status, 0, first.output);
  const afterFirst = read(file);

  const startIndex = before.indexOf(START);
  const endIndex = before.indexOf(END) + END.length;
  assert.equal(afterFirst.startsWith(before.slice(0, startIndex)), true, "prose before the block must survive");
  assert.equal(afterFirst.endsWith(before.slice(endIndex)), true, "prose after the block must survive");
  assert.equal(afterFirst.includes("old body"), false, "the old block body must be replaced");
  assert.equal(count(afterFirst, START), 1);
  assert.equal(count(afterFirst, END), 1);

  const second = runInstall(repo, "agents");
  assert.equal(second.status, 0);
  assert.equal(read(file), afterFirst, "a second install must not change a byte");
  assert.match(second.output, /unchanged/);
});

test("a nested START START END normalises to one balanced block", (t) => {
  const { repo } = makeRepo(t, "repo");
  const file = path.join(repo, "AGENTS.md");
  fs.writeFileSync(file, ["Top prose.", "", START, START, "body", END, "", "Bottom prose.", ""].join("\n"));

  const result = runInstall(repo, "agents");
  assert.equal(result.status, 0, result.output);
  const after = read(file);
  assert.equal(count(after, START), 1, "exactly one START marker");
  assert.equal(count(after, END), 1, "exactly one END marker");
  assert.equal(after.includes("Top prose."), true);
  assert.equal(after.includes("Bottom prose."), true);
});

test("two stale blocks normalise to one balanced block", (t) => {
  const { repo } = makeRepo(t, "repo");
  const file = path.join(repo, "AGENTS.md");
  fs.writeFileSync(
    file,
    ["Top.", "", START, "old A", END, "", "Middle.", "", START, "old B", END, "", "Bottom.", ""].join("\n")
  );

  const result = runInstall(repo, "agents");
  assert.equal(result.status, 0, result.output);
  const after = read(file);
  assert.equal(count(after, START), 1);
  assert.equal(count(after, END), 1);
  assert.equal(after.includes("old A"), false, "the stale body must be gone");
  assert.equal(after.includes("old B"), false, "the stale body must be gone");
  assert.equal(after.includes("Top."), true);
  assert.equal(after.includes("Middle."), true);
  assert.equal(after.includes("Bottom."), true);
});

test("an inverted END … START pair normalises to one balanced block", (t) => {
  const { repo } = makeRepo(t, "repo");
  const file = path.join(repo, "AGENTS.md");
  fs.writeFileSync(file, ["Top.", "", END, "hand-written prose", START, "", "Bottom.", ""].join("\n"));

  const result = runInstall(repo, "agents");
  assert.equal(result.status, 0, result.output);
  const after = read(file);
  assert.equal(count(after, START), 1);
  assert.equal(count(after, END), 1);
  assert.equal(after.includes("hand-written prose"), true);
  assert.equal(after.includes("Bottom."), true);
});

test("a missing END marker is repaired and the trailing prose is kept", (t) => {
  const { repo } = makeRepo(t, "repo");
  const file = path.join(repo, "AGENTS.md");
  fs.writeFileSync(file, ["Top prose.", "", START, "", "stale body", "", "Trailing prose.", ""].join("\n"));

  const result = runInstall(repo, "agents");
  assert.equal(result.status, 0, result.output);
  const after = read(file);
  assert.equal(count(after, START), 1);
  assert.equal(count(after, END), 1);
  assert.equal(after.includes("Top prose."), true);
  assert.equal(after.includes("Trailing prose."), true);
});

test("--target isolation holds with the confinement check in place", (t) => {
  const root = tempDir(t);
  const expectations = {
    claude: [".claude/skills/codebase-snapshot/SKILL.md", "AGENTS.md", ".cursor/rules/codebase-snapshot.mdc"],
    cursor: [".cursor/rules/codebase-snapshot.mdc", "AGENTS.md", ".claude/skills/codebase-snapshot/SKILL.md"],
    agents: ["AGENTS.md", ".claude/skills/codebase-snapshot/SKILL.md", ".cursor/rules/codebase-snapshot.mdc"],
  };
  for (const [target, [own, ...absent]] of Object.entries(expectations)) {
    const repo = path.join(root, target);
    fs.mkdirSync(repo, { recursive: true });
    const result = runInstall(repo, target);
    assert.equal(result.status, 0, `${target}: ${result.output}`);
    assert.equal(fs.existsSync(path.join(repo, own)), true, `${target} must write ${own}`);
    for (const other of absent) {
      assert.equal(fs.existsSync(path.join(repo, other)), false, `${target} must not write ${other}`);
    }
  }
});

test("a symlink at AGENTS.md itself is refused", (t) => {
  const { repo, outside } = makeRepo(t, "repo");
  fs.mkdirSync(outside);
  const outsideFile = path.join(outside, "AGENTS.md");
  fs.writeFileSync(outsideFile, "# outside\n");
  try {
    fs.symlinkSync(outsideFile, path.join(repo, "AGENTS.md"), "file");
  } catch {
    t.skip("creating a file symlink needs elevation on this host; the junction test covers the same path");
    return;
  }

  const result = runInstall(repo, "agents");

  assert.equal(result.status, 1);
  assert.match(result.output, /symbolic link|junction/);
  assert.equal(read(outsideFile), "# outside\n");
});
