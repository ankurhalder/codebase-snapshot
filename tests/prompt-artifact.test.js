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
 * PROMPT.md is generated from the manifest, and that is the whole claim: it names the parts, the
 * partial files and the fingerprint of the run that wrote it. A prompt that describes some other
 * snapshot is worse than none, because it reads as current.
 *
 * Two further properties are load-bearing: it may only describe artifacts that were actually
 * written, and it is itself an artifact with a recorded digest, so editing it fails `validate`.
 */

function tempDir(t, prefix = "snap-prompt-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRepo(t, files = {}) {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n', "utf8");
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  return dir;
}

const cli = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const readSnapshot = (dir, ...parts) => fs.readFileSync(path.join(dir, "snapshot", ...parts), "utf8");
const manifestOf = (dir) => JSON.parse(readSnapshot(dir, "manifest.json"));

test("PROMPT.md is rendered from the manifest it ships beside", (t) => {
  // One file imports the other, so the import graph has something to name.
  const dir = makeRepo(t, {
    "src/a.ts": 'import { b } from "./b";\nexport const a = b + 1;\n',
    "src/b.ts": "export const b = 1;\n",
  });
  const { code, out } = cli(["generate"], dir);
  assert.equal(code, 0, out);

  const manifest = manifestOf(dir);
  const prompt = readSnapshot(dir, "PROMPT.md");

  assert.match(prompt, new RegExp(manifest.fingerprint), "the fingerprint is the run's own");
  assert.match(prompt, /`2026-|`\d{4}-\d{2}-\d{2}T/, "the generation timestamp is quoted");
  for (const part of manifest.parts) {
    assert.ok(prompt.includes(`\`${part.filename}\``), `names ${part.filename}`);
  }
  assert.match(
    prompt,
    new RegExp(`${manifest.totals.candidateFiles} path\\(s\\) were found; ${manifest.totals.includedFiles}`),
    "the coverage line is this run's"
  );
  assert.match(prompt, /## The system/, "the brief maps the system");
  assert.match(prompt, /## The bar/, "and states the standard");
  assert.match(prompt, /## Coverage/, "and the coverage debt");
  assert.match(prompt, /## Calibration/, "and gives calibration examples");
  assert.match(prompt, /No routes, handlers or UI components were recorded/, "an empty index is stated, not implied");
  assert.match(prompt, /Load-bearing modules/, "the import graph is in the brief");
  assert.match(prompt, /Partial files: none/, "nothing was lost, and it says so");
  assert.match(prompt, /Needed but not received/, "the closing line is specified");
  assert.equal(manifest.artifacts.prompt.sha256.length, 64, "its digest is recorded");
  assert.equal(
    manifest.artifacts.prompt.byteSize,
    Buffer.byteLength(prompt, "utf8"),
    "the recorded digest describes these exact bytes"
  );
});

test("PROMPT.md names a partial file by path, reason and missing lines", (t) => {
  const body = Array.from({ length: 60 }, (_, index) => `export const v${index} = ${index};`).join("\n");
  const dir = makeRepo(t, { "src/big.ts": `${body}\n` });
  fs.writeFileSync(
    path.join(dir, "snapshot.config.mjs"),
    "export default { largeFileBytes: 400, previewHeadLines: 5, previewTailLines: 5 };\n",
    "utf8"
  );

  const { code, out } = cli(["generate"], dir);
  assert.equal(code, 0, out);

  const manifest = manifestOf(dir);
  assert.equal(manifest.incomplete.length, 1, "the fixture really is incomplete");
  const entry = manifest.incomplete[0];
  const prompt = readSnapshot(dir, "PROMPT.md");

  assert.ok(prompt.includes(entry.relativePath), "the partial file is named");
  assert.ok(prompt.includes(entry.reason), "the reason is named");
  assert.match(prompt, new RegExp(`${entry.omittedLines} of ${entry.lines} missing`), "the loss is counted");
  assert.doesNotMatch(prompt, /Partial files: none/, "and it does not claim completeness");
});

test("PROMPT.md only claims the artifacts this run wrote", (t) => {
  // A secret in the fixture, so the redaction note is the branch that matters here: with
  // `reports/audit.md` disabled the prompt has to say the per-file detail is unavailable, and it
  // may not point at a file this run never wrote.
  const dir = makeRepo(t, { "src/creds.ts": 'const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";\n' });
  const { code, out } = cli(["generate", "--skip-artifacts", "parts,audit,navigation,projectTree"], dir);
  assert.equal(code, 0, out);

  const prompt = readSnapshot(dir, "PROMPT.md");
  assert.doesNotMatch(prompt, /parts\/part-NNN\.md/, "it does not tell the model to read parts that are absent");
  assert.doesNotMatch(prompt, /reports\/navigation\.md/, "no navigation index is claimed");
  assert.doesNotMatch(prompt, /reports\/audit\.md` names the files/, "the redaction note is conditional too");
  assert.match(prompt, /\`reports\/audit\.md\` was disabled for this run/, "it says the detail is unavailable");
  assert.match(prompt, /manifest\.json/, "the manifest it does have is still named");
  assert.match(prompt, /Redacted: 1 line/, "the fixture really was redacted");
});

test("--skip-artifacts prompt writes no PROMPT.md and leaves no digest", (t) => {
  const dir = makeRepo(t);
  const { code, out } = cli(["generate", "--skip-artifacts", "prompt"], dir);
  assert.equal(code, 0, out);

  assert.equal(fs.existsSync(path.join(dir, "snapshot", "PROMPT.md")), false, "no file");
  assert.equal(manifestOf(dir).artifacts.prompt, undefined, "and no record of one");
  assert.doesNotMatch(readSnapshot(dir, "README.md"), /\[PROMPT\.md\]/, "the README does not link a file that is absent");
});

test("the README links PROMPT.md when it is written", (t) => {
  const dir = makeRepo(t);
  const { code, out } = cli(["generate"], dir);
  assert.equal(code, 0, out);
  assert.match(readSnapshot(dir, "README.md"), /\[PROMPT\.md\]\(PROMPT\.md\)/, "linked from the orientation page");
});

test("an edited PROMPT.md fails validate", (t) => {
  const dir = makeRepo(t);
  assert.equal(cli(["generate"], dir).code, 0);

  const target = path.join(dir, "snapshot", "PROMPT.md");
  fs.writeFileSync(target, `${fs.readFileSync(target, "utf8")}\nPasted by hand.\n`, "utf8");

  const validate = cli(["validate"], dir);
  assert.equal(validate.code, 1, "drift is a failure, not a warning");
  assert.match(validate.out, /PROMPT\.md/, "and the message names the file");
});

test("describe lists prompt as a default-on artifact", (t) => {
  const dir = makeRepo(t);
  const { code, out } = cli(["describe", "--format", "json"], dir);
  assert.equal(code, 0, out);

  const contract = JSON.parse(out);
  const entry = contract.artifacts.find((artifact) => artifact.name === "prompt");
  assert.ok(entry, "the contract lists it");
  assert.equal(entry.default, true, "on by default, like every artifact but the monolith");
  assert.ok(
    contract.workflow.some((step) => step.run.includes("PROMPT.md")),
    "and the consume step names it first"
  );
});

const partFile = (index) => `export const v${index} = "${"x".repeat(400)}";`;

test("the delivery plan says a small snapshot fits whole", (t) => {
  const dir = makeRepo(t);
  assert.equal(cli(["generate"], dir).code, 0);
  const prompt = readSnapshot(dir, "PROMPT.md");
  assert.match(prompt, /## Attaching this/, "the plan is present");
  assert.match(prompt, /carries the whole set: 1 part plus/, "1 part plus the reports fits 10 slots");
  assert.match(prompt, /instructions cost no attachment slot/, "and it says where the free slot is");
});

test("the delivery plan states the arithmetic when the parts do not fit a 10-file destination", (t) => {
  // 64 small files at the minimum budget: enough parts that the payload alone exceeds a chat
  // attachment limit, which is the case this section exists for.
  const files = {};
  for (let index = 0; index < 64; index += 1) {
    files[`src/f${String(index).padStart(2, "0")}.ts`] = `${partFile(index)}\n`;
  }
  const dir = makeRepo(t, files);
  const generated = cli(["generate", "--max-part-bytes", "4096"], dir);
  assert.equal(generated.code, 0, generated.out);

  const manifest = manifestOf(dir);
  assert.ok(manifest.parts.length > 10, `the fixture really needs more than 10 parts (got ${manifest.parts.length})`);

  const prompt = readSnapshot(dir, "PROMPT.md");
  assert.match(
    prompt,
    new RegExp(`The ${manifest.parts.length} parts do not fit a 10-file destination: at most 10`),
    "the count and the ceiling are stated"
  );
  assert.match(prompt, /--max-part-bytes \d+k` for about 9 parts/, "it names the budget that would fit");
  assert.match(prompt, /say which parts are missing before you answer/, "a subset is handled explicitly");
  assert.match(prompt, /Do not infer the contents of a part you did not receive/, "and invention is refused");
});

test("attachmentSlots sizes the plan, and 0 means no limit", (t) => {
  const tight = makeRepo(t);
  const generated = cli(["generate", "--attachment-slots", "3"], tight);
  assert.equal(generated.code, 0, generated.out);
  assert.match(
    readSnapshot(tight, "PROMPT.md"),
    /carries 1 part and\s+`manifest\.json` \(2 of 3\)/,
    "three slots fit one part and the manifest"
  );
  assert.equal(manifestOf(tight).config.attachmentSlots, 3, "the manifest records the destination");

  const unlimited = makeRepo(t);
  fs.writeFileSync(
    path.join(unlimited, "snapshot.config.mjs"),
    "export default { attachmentSlots: 0 };\n",
    "utf8"
  );
  assert.equal(cli(["generate"], unlimited).code, 0);
  assert.match(readSnapshot(unlimited, "PROMPT.md"), /No attachment limit is configured/, "0 is unlimited");
});

test("a nonsensical --attachment-slots is a usage error, not a silent default", (t) => {
  const dir = makeRepo(t);
  const result = cli(["generate", "--attachment-slots", "abc"], dir);
  assert.equal(result.code, 2, "usage errors exit 2");
  assert.match(result.out, /--attachment-slots expects a whole number/);
});

test("describe documents the slot setting and the flag", (t) => {
  const dir = makeRepo(t);
  const { code, out } = cli(["describe", "--format", "json"], dir);
  assert.equal(code, 0, out);
  const contract = JSON.parse(out);
  const setting = contract.config.settings.find((entry) => entry.key === "attachmentSlots");
  assert.ok(setting, "the setting is in the contract");
  assert.equal(setting.default, 10, "10 by default");
  const option = contract.options.find((entry) => entry.flag === "--attachment-slots");
  assert.ok(option, "the flag is in the contract");
  assert.equal(option.type, "number", "a count, not a stringly-typed size");
  assert.match(option.appliesTo, /generate/, "generate can set it");
});

test("the brief carries the repository history as claims, not evidence", (t) => {
  const dir = makeRepo(t);
  const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  const available = git(["init", "-q"]);
  if (available.status !== 0) {
    t.skip("git is not available");
    return;
  }
  git(["add", "-A"]);
  const committed = spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "fix: a prior round found this"],
    { cwd: dir, encoding: "utf8" }
  );
  assert.equal(committed.status, 0, committed.stderr);

  assert.equal(cli(["generate"], dir).code, 0);
  const prompt = readSnapshot(dir, "PROMPT.md");
  assert.match(prompt, /## What came before/, "a history section is present");
  assert.match(prompt, /fix: a prior round found this/, "and carries the subject");
  assert.match(prompt, /They are claims by whoever wrote them, not evidence/, "labelled as claims");
  assert.match(prompt, /Verify that those fixes hold instead of rediscovering them/, "the job says what to do with them");
});

test("a one-part snapshot is described as one part", (t) => {
  const dir = makeRepo(t);
  assert.equal(cli(["generate", "--attachment-slots", "1"], dir).code, 0);
  const prompt = readSnapshot(dir, "PROMPT.md");
  assert.match(prompt, /The only part fills a 1-file destination/, "no plural slip");
  assert.doesNotMatch(prompt, /--max-parts 1/, "and no advice to merge a single part");
  assert.match(prompt, /Parts: 1 at a 300 KB ceiling:/, "the part list reads as one part");
});
