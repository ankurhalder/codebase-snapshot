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
  assert.match(
    validated.out,
    /brief: brief\.md changed since this snapshot was generated/,
    "and the drift names the file rather than a digest"
  );
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

test("the project summary carries no HTML from the README", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(
    path.join(dir, "README.md"),
    "<div>\n  <h1>Demo</h1>\n\n  <p><b>Bold.</b><br> A <code>command</code> that fails when the code moves.</p>\n</div>\n",
    "utf8"
  );
  assert.equal(cli(["generate"], dir).code, 0);
  const prompt = promptOf(dir);
  assert.match(prompt, /A command that fails when the code moves/, "the prose survives");
  assert.doesNotMatch(prompt, /<code>|<br>/, "no inline markup reaches the brief");
  assert.equal(prompt.includes("</p>"), false, "and no closing tag either");
});

test("only version headings count as releases", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(
    path.join(dir, "CHANGELOG.md"),
    "# Changelog\n\n## A note on version numbers\n\nText.\n\n## 1.2.0\n\nFixed.\n\n## 0.9.0\n\nOlder.\n",
    "utf8"
  );
  assert.equal(cli(["generate"], dir).code, 0);
  const prompt = promptOf(dir);
  assert.match(prompt, /Most recent releases: 1\.2\.0; 0\.9\.0\./, "the versions are quoted");
  assert.doesNotMatch(prompt, /A note on version numbers/, "a prose heading is not a release");
});

test("a commit body is cut at a sentence, not mid-word", (t) => {
  const dir = makeRepo(t);
  const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (git(["init", "-q"]).status !== 0) {
    t.skip("git is not available");
    return;
  }
  const long = "The guard existed on the route. ".repeat(40);
  git(["add", "-A"]);
  const committed = spawnSync(
    "git",
    ["-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "fix: a long body", "-m", long],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(cli(["generate"], dir).code, 0);
  const body = promptOf(dir).split("\n").find((line) => line.startsWith("  The guard existed"));
  assert.ok(body, "the body is present");
  assert.match(body, /The guard existed on the route\.$/, "cut on a sentence boundary");
  assert.doesNotMatch(body, /bui…|\w…$/, "and never mid-word");
});

test("a fenced sample heading is not parsed as a section", (t) => {
  const dir = makeRepo(t, {
    "brief.md": [
      "## Stakes",
      "",
      "The block below shows the format; it is not a section.",
      "",
      "```markdown",
      "## Coverage",
      "This line is a sample.",
      "```",
      "",
      "That is all.",
      "",
    ].join("\n"),
  });
  const result = cli(["generate", "--brief", "brief.md"], dir);
  assert.equal(result.code, 0, "a fenced heading is content, not a reservation violation");
  const prompt = promptOf(dir);
  assert.match(prompt, /This line is a sample\./, "the fence travels with the section");
});

test("control characters in owner prose are escaped", (t) => {
  const dir = makeRepo(t, { "brief.md": "## Stakes\n\nBefore\u0000after the NUL.\n" });
  const result = cli(["generate", "--brief", "brief.md"], dir);
  assert.equal(result.code, 0, result.out);
  const prompt = promptOf(dir);
  assert.equal(prompt.includes("\u0000"), false, "no raw NUL reaches the artifact");
  assert.match(prompt, /Before\\u0000after the NUL\./, "it is re-spelled instead");
});

test("a heading typo with a trailing colon still lands in its section", (t) => {
  const dir = makeRepo(t, { "brief.md": "## Stakes:\n\nWith a trailing colon.\n" });
  assert.equal(cli(["generate", "--brief", "brief.md"], dir).code, 0);
  const prompt = promptOf(dir);
  assert.match(prompt, /## Stakes\n/, "rendered as the stakes section");
  assert.match(prompt, /With a trailing colon\./);
  assert.doesNotMatch(prompt, /### Stakes:/, "not dumped into owner notes");
});

test("an oversized brief is refused with its size", (t) => {
  const dir = makeRepo(t, { "brief.md": "## Stakes\n\n" + "word ".repeat(20000) + "\n" });
  const result = cli(["generate", "--brief", "brief.md"], dir);
  assert.notEqual(result.code, 0, "must fail");
  assert.match(result.out, /the limit is 65536/, "names the limit");
  assert.equal(fs.existsSync(path.join(dir, "snapshot")), false, "and writes nothing");
});

test("a manifest whose new config fields have the wrong shape is refused", (t) => {
  const dir = makeRepo(t);
  assert.equal(cli(["generate"], dir).code, 0);
  const manifestPath = path.join(dir, "snapshot", "manifest.json");
  const original = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const cases = [
    [{ ...original, config: { ...original.config, promptTask: 5 } }, /promptTask/],
    [{ ...original, config: { ...original.config, brief: "docs/brief.md" } }, /config\.brief/],
    [{ ...original, config: { ...original.config, brief: { path: "", digest: "x" } } }, /brief\.path/],
    [{ ...original, config: { ...original.config, attachmentSlots: -1 } }, /attachmentSlots/],
    [{ ...original, config: { ...original.config, maxParts: 0 } }, /maxParts/],
  ];
  for (const [tampered, expected] of cases) {
    fs.writeFileSync(manifestPath, JSON.stringify(tampered));
    const result = cli(["validate"], dir);
    assert.equal(result.code, 1, "a malformed config field is refused");
    assert.match(result.out, expected, "and the message names the field");
  }
});

test("a credential-shaped brief path is masked like every other name", (t) => {
  const dir = makeRepo(t);
  fs.mkdirSync(path.join(dir, "docs", "AKIAIOSFODNN7EXAMPLE"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "docs", "AKIAIOSFODNN7EXAMPLE", "brief.md"),
    "## Stakes\n\nPath carries a credential shape.\n",
    "utf8"
  );
  const briefPath = path.join("docs", "AKIAIOSFODNN7EXAMPLE", "brief.md");
  const result = cli(["generate", "--brief", briefPath], dir);
  assert.equal(result.code, 0, result.out);

  const prompt = promptOf(dir);
  assert.equal(prompt.includes("AKIAIOSFODNN7EXAMPLE"), false, "PROMPT.md masks the path");
  const manifest = fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8");
  assert.equal(manifest.includes("AKIAIOSFODNN7EXAMPLE"), false, "the manifest masks it too");
});

test("init writes a brief scaffold and points the config at it", (t) => {
  const dir = makeRepo(t);
  const result = cli(["init", "--yes"], dir);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Wrote BRIEF\.md/);

  const scaffold = fs.readFileSync(path.join(dir, "BRIEF.md"), "utf8");
  assert.match(scaffold, /## Stakes/, "the headings are there");
  assert.match(scaffold, /<!--/, "and the guidance is comments");

  const config = fs.readdirSync(dir).find((name) => name.startsWith("snapshot.config."));
  assert.ok(config, "a config was written");
  // Commented, not enabled: a config pointing at a scaffold the user may delete would turn
  // "delete the template" into "generate now fails".
  assert.match(fs.readFileSync(path.join(dir, config), "utf8"), /\/\/ brief: "docs\/brief\.md"/);

  // An untouched scaffold renders no owner section: comments are guidance, not assertions.
  const generated = cli(["generate"], dir);
  assert.equal(generated.code, 0, generated.out);
  const prompt = promptOf(dir);
  assert.doesNotMatch(prompt, /## Stakes/);
  assert.doesNotMatch(prompt, /Written by the project owner/);
});

test("init never overwrites a brief the repository already has", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, "BRIEF.md"), "## Stakes\n\nOur own words.\n", "utf8");
  const result = cli(["init", "--yes"], dir);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Kept BRIEF\.md/);
  assert.match(fs.readFileSync(path.join(dir, "BRIEF.md"), "utf8"), /Our own words\./);
});

test("init --dry-run writes no brief", (t) => {
  const dir = makeRepo(t);
  const result = cli(["init", "--yes", "--dry-run"], dir);
  assert.equal(result.code, 0, result.out);
  assert.equal(fs.existsSync(path.join(dir, "BRIEF.md")), false);
});

test("a filled scaffold section is merged at its slot", (t) => {
  const dir = makeRepo(t);
  assert.equal(cli(["init", "--yes"], dir).code, 0);
  // Enabling it is one edit to the config the scaffold was written beside.
  const configName = fs.readdirSync(dir).find((name) => name.startsWith("snapshot.config."));
  const configPath = path.join(dir, configName);
  fs.writeFileSync(
    configPath,
    fs.readFileSync(configPath, "utf8").replace(/\/\/ brief: "docs\/brief\.md"/, 'brief: "BRIEF.md"')
  );
  fs.writeFileSync(
    path.join(dir, "BRIEF.md"),
    "<!-- guidance -->\n\n## Stakes\n\nA wrong cleanup deletes data.\n",
    "utf8"
  );
  assert.equal(cli(["generate"], dir).code, 0);
  assert.match(promptOf(dir), /## Stakes\n\n> Written by the project owner[\s\S]*A wrong cleanup deletes data\./);
});

test("setup writes the scaffold and says so", (t) => {
  const dir = makeRepo(t);
  const result = cli(["setup", "--yes"], dir);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Wrote BRIEF\.md/, "the one file the run asks the user to fill in");
  assert.equal(fs.existsSync(path.join(dir, "BRIEF.md")), true);
});

test("a brief written without parts does not claim part files", (t) => {
  const dir = makeRepo(t);
  const result = cli(["generate", "--skip-artifacts", "parts"], dir);
  assert.equal(result.code, 0, result.out);
  const prompt = promptOf(dir);

  assert.match(prompt, /No part files were written/, "it says what is missing");
  assert.match(prompt, /The code itself is not in this snapshot/, "and what that means for the reader");
  assert.doesNotMatch(prompt, /^- Parts: /m, "it does not list parts as files to open");
  assert.doesNotMatch(prompt, /- `parts\/part-NNN\.md`/, "nor describe their format");
  assert.doesNotMatch(prompt, /Paste this file first, then the parts it names/, "nor tell the reader to attach them");

  // README.md is written from the same manifest, and a count above "No parts were written"
  // contradicted the section right below it.
  const readme = fs.readFileSync(path.join(dir, "snapshot", "README.md"), "utf8");
  assert.match(readme, /\*\*Part Count:\*\* `0`/);
  assert.match(readme, /No parts were written/);
});
