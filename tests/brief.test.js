import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

/**
 * The owner-written half of the brief. Facts are generated; judgement is supplied. These tests
 * pin the merge: recognised sections replace the generic prose, unknown headings are kept, and a
 * heading that redefines a *measured* section is refused rather than allowed to overwrite it.
 */

const OWNER_BRIEF = [
  "# Project brief",
  "",
  "## Stakes",
  "",
  "Runs live production for one person. A wrong cleanup deletes their data.",
  "",
  "## The system",
  "",
  "A Fastify agent and a root broker, split by an unix socket.",
  "",
  "## What came before",
  "",
  "Four rounds, twenty-three defects, all fixed and tested.",
  "",
  "## The bar",
  "",
  "A finding quotes the lines and the state that reaches them.",
  "",
  "## Calibration",
  "",
  "- a grant signed for one recipe executing another",
  "- a recipe that never worked because its fixture lied",
  "",
  "## Deployment notes",
  "",
  "systemd unit names matter; they are not in the snapshot.",
  ""
].join("\n");

function tempDir(t, prefix = "snap-brief-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRepo(t, files = {}) {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", description: "A fixture for the brief." }),
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  return dir;
}

const cli = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const promptOf = (dir) => fs.readFileSync(path.join(dir, "snapshot", "PROMPT.md"), "utf8");

test("a brief replaces the judgement sections and is marked as the owner", (t) => {
  const dir = makeRepo(t, { "brief.md": OWNER_BRIEF });
  const result = cli(["generate", "--brief", "brief.md"], dir);
  assert.equal(result.code, 0, result.out);
  const prompt = promptOf(dir);

  assert.match(prompt, /Runs live production for one person/, "stakes are present");
  assert.match(prompt, /A Fastify agent and a root broker/, "the owner system text is present");
  assert.match(prompt, /Four rounds, twenty-three defects/, "the owner history is present");
  assert.match(prompt, /A finding quotes the lines and the state that reaches them/, "the owner bar");
  assert.match(prompt, /a grant signed for one recipe executing another/, "the owner calibration");
  assert.match(prompt, /Written by the project owner in `brief\.md`, not generated/, "provenance");
  assert.match(prompt, /What the index records:/, "the generated map survives the owner text");
  assert.match(prompt, /Deployment notes/, "an unknown heading is kept");
  assert.match(prompt, /systemd unit names matter/, "with its body");
});

test("a heading that would redefine a measured section is refused", (t) => {
  const dir = makeRepo(t, { "brief.md": "## Coverage\n\nEverything was fine.\n" });
  const result = cli(["generate", "--brief", "brief.md"], dir);
  assert.notEqual(result.code, 0, "must fail");
  assert.match(result.out, /may not define "Coverage"/, "names the heading");
  assert.equal(fs.existsSync(path.join(dir, "snapshot")), false, "and writes nothing");
});

test("a missing brief is an error, not a snapshot without it", (t) => {
  const dir = makeRepo(t);
  const result = cli(["generate", "--brief", "nope.md"], dir);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /nope\.md/);
  assert.match(result.out, /could not be read/);
});

test("editing the brief makes the snapshot drift", (t) => {
  const dir = makeRepo(t, { "brief.md": OWNER_BRIEF });
  assert.equal(cli(["generate", "--brief", "brief.md"], dir).code, 0);
  assert.equal(cli(["validate", "--brief", "brief.md"], dir).code, 0, "current as generated");

  fs.appendFileSync(path.join(dir, "brief.md"), "\nOne more line.\n");
  const validated = cli(["validate", "--brief", "brief.md"], dir);
  assert.equal(validated.code, 1, "a changed brief is configuration drift");
});

test("promptTask selects the job, and an unknown one is a usage error", (t) => {
  const review = makeRepo(t);
  assert.equal(cli(["generate", "--prompt-task", "review"], review).code, 0);
  assert.match(promptOf(review), /Review the change or the area named in the task/);

  const explain = makeRepo(t);
  assert.equal(cli(["generate", "--prompt-task", "explain"], explain).code, 0);
  assert.match(promptOf(explain), /Explain how the part of the system named in the task works/);

  const bad = makeRepo(t);
  const result = cli(["generate", "--prompt-task", "polish"], bad);
  assert.equal(result.code, 2, "usage error");
  assert.match(result.out, /--prompt-task expects audit, review or explain/);
});

test("the project states what it is, from package.json", (t) => {
  const dir = makeRepo(t);
  assert.equal(cli(["generate"], dir).code, 0);
  const prompt = promptOf(dir);
  assert.match(prompt, /## What this is/);
  assert.match(prompt, /A fixture for the brief\./);
});

test("a commit body reaches the history section", (t) => {
  const dir = makeRepo(t);
  const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (git(["init", "-q"]).status !== 0) {
    t.skip("git is not available");
    return;
  }
  git(["add", "-A"]);
  const committed = spawnSync(
    "git",
    [
      "-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q",
      "-m", "fix: close the timer path",
      "-m", "The guard existed on the route and the timer never called it.",
    ],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(committed.status, 0, committed.stderr);

  assert.equal(cli(["generate"], dir).code, 0);
  const prompt = promptOf(dir);
  assert.match(prompt, /fix: close the timer path/);
  assert.match(prompt, /The guard existed on the route and the timer never called it\./, "the body is kept");
});

test("a brief is parsed case-insensitively and refuses duplicates", (t) => {
  const lower = makeRepo(t, { "brief.md": "## stakes\n\nLower-case heading, still the stakes.\n" });
  assert.equal(cli(["generate", "--brief", "brief.md"], lower).code, 0);
  assert.match(promptOf(lower), /Lower-case heading, still the stakes\./);

  const smuggled = makeRepo(t, { "brief.md": "## coverage\n\nEverything was fine.\n" });
  const refused = cli(["generate", "--brief", "brief.md"], smuggled);
  assert.notEqual(refused.code, 0, "a lower-case reserved heading is still reserved");
  assert.match(refused.out, /may not define/);

  const twice = makeRepo(t, { "brief.md": "## Stakes\n\nOne.\n\n## Stakes\n\nTwo.\n" });
  const duplicate = cli(["generate", "--brief", "brief.md"], twice);
  assert.notEqual(duplicate.code, 0, "a section that says two things is ambiguous");
  assert.match(duplicate.out, /defines "Stakes" twice/);
});

test("a byte-order mark does not swallow the first brief section", (t) => {
  const dir = makeRepo(t, { "brief.md": "\uFEFF## Stakes\n\nStakes behind a BOM.\n" });
  assert.equal(cli(["generate", "--brief", "brief.md"], dir).code, 0);
  assert.match(promptOf(dir), /Stakes behind a BOM\./);
});

test("a CRLF brief reads the same as an LF one", (t) => {
  const dir = makeRepo(t, { "brief.md": "## Stakes\r\n\r\nWindows line endings.\r\n" });
  assert.equal(cli(["generate", "--brief", "brief.md"], dir).code, 0);
  assert.match(promptOf(dir), /Windows line endings\./);
});

test("the brief can come from the config file rather than the flag", (t) => {
  const dir = makeRepo(t, {
    "brief.md": "## Stakes\n\nFrom the config.\n",
    "snapshot.config.mjs": 'export default { brief: "brief.md", promptTask: "explain" };\n',
  });
  const result = cli(["generate"], dir);
  assert.equal(result.code, 0, result.out);
  const prompt = promptOf(dir);
  assert.match(prompt, /From the config\./);
  assert.match(prompt, /Explain how the part of the system/);
});

test("an empty brief is allowed and changes nothing but the digest", (t) => {
  const dir = makeRepo(t, { "brief.md": "# Nothing recognised here\n" });
  assert.equal(cli(["generate", "--brief", "brief.md"], dir).code, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
  assert.equal(manifest.config.brief.path, "brief.md", "the path is recorded");
  assert.equal(manifest.config.brief.digest.length, 64, "and its digest");
  assert.match(promptOf(dir), /## The job/, "the brief still renders");
});
