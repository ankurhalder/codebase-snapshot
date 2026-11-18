/**
 * Health: the audit of a written snapshot.
 *
 * Every case here is a real failure mode: a part that no longer matches its hash, a secret that
 * survived into an artifact, a host path in the text, a missing artifact, a strict exit code. The
 * clean case must score 100, or the report is noise.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function repoWithSnapshot(t, files = {}, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  for (const [relative, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, relative), content);
  }
  const result = cli(["generate", ...extraArgs], dir);
  assert.equal(result.code, 0, result.out);
  return dir;
}

const cli = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, stdout: result.stdout ?? "" };
};

const health = (dir, ...extra) => cli(["health", ...extra], dir);

test("a clean snapshot scores 100 and exits 0", (t) => {
  const dir = repoWithSnapshot(t);
  const result = health(dir);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /Snapshot health: 100\/100/);
  assert.match(result.out, /0 failed/);
});

test("a part that no longer matches its hash is a failure", (t) => {
  const dir = repoWithSnapshot(t);
  const parts = fs.readdirSync(path.join(dir, "snapshot", "parts"));
  fs.appendFileSync(path.join(dir, "snapshot", "parts", parts[0]), "tampered\n");

  const result = health(dir);
  assert.equal(result.code, 1, "a failed check exits 1");
  assert.match(result.out, /Every part matches its recorded size and hash/);
  assert.match(result.out, /altered/);
});

test("--strict turns a critical failure into exit 2", (t) => {
  const dir = repoWithSnapshot(t);
  const parts = fs.readdirSync(path.join(dir, "snapshot", "parts"));
  fs.appendFileSync(path.join(dir, "snapshot", "parts", parts[0]), "tampered\n");
  assert.equal(health(dir, "--strict").code, 2);
});

test("--format json emits one document with the checks", (t) => {
  const dir = repoWithSnapshot(t);
  const result = health(dir, "--format", "json");
  assert.equal(result.code, 0, result.out);
  const report = JSON.parse(result.stdout);
  assert.equal(report.score, 100);
  assert.ok(report.checks.length >= 10);
  assert.equal(report.counts.fail, 0);
});

test("a secret that survived into an artifact is a critical failure", (t) => {
  const dir = repoWithSnapshot(t);
  const readme = path.join(dir, "snapshot", "README.md");
  fs.appendFileSync(readme, "\nleaked AKIAIOSFODNN7EXAMPLE\n");
  const result = health(dir);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /No unmasked secret survives in an artifact/);
  // The value itself must never be printed by the audit.
  assert.equal(result.out.includes("AKIAIOSFODNN7EXAMPLE"), false);
});

test("a host path in the text is a warning, not a failure", (t) => {
  // The path is in the source, so every artifact hash still matches: this isolates the PII check
  // from the integrity check, which a modified artifact would trip instead.
  const dir = repoWithSnapshot(t, {
        "src/notes.ts": "// moved from /home/someone/repo/src/a.ts\nexport const c = 3;\n",
  });
  const result = health(dir);
  assert.equal(result.code, 0, "a warning does not fail the run");
  assert.match(result.out, /No host path or machine identity leaks/);
  assert.match(result.out, /1 warning/);
});

test("a missing artifact is a failure", (t) => {
  const dir = repoWithSnapshot(t);
  fs.rmSync(path.join(dir, "snapshot", "PROMPT.md"));
  const result = health(dir);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /Every recorded artifact is present and unchanged/);
});

test("a stale snapshot is reported as a warning", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-git-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (git(["init", "-q"]).status !== 0) {
    t.skip("git is not available");
    return;
  }
  git(["-c", "user.email=t@e.c", "-c", "user.name=T", "add", "-A"]);
  git(["-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "one"]);
  assert.equal(cli(["generate"], dir).code, 0, "generated with a real HEAD");
  assert.equal(health(dir).code, 0);
  fs.appendFileSync(path.join(dir, "src", "a.ts"), "export const b = 2;\n");
  git(["-c", "user.email=t@e.c", "-c", "user.name=T", "add", "-A"]);
  git(["-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "two"]);
  const result = health(dir);
  assert.match(result.out, /The snapshot still describes the repository/);
  assert.match(result.out, /HEAD is/);
});

test("a signed snapshot reports no unexpected path", (t) => {
  const root = repoWithSnapshot(t);
  const signed = spawnSync(process.execPath, [BIN, "generate", "--sign"], { cwd: root, encoding: "utf8" });
  assert.equal(signed.status, 0, (signed.stdout ?? "") + (signed.stderr ?? ""));
  const result = health(root);
  assert.equal(result.code, 0, result.out);
  assert.doesNotMatch(result.out, /unexpected path/);
  assert.match(result.out, /signature verifies/);
});

test("every artifact the manifest records is expected, and none is a warning", (t) => {
  const dir = repoWithSnapshot(t, {}, ["--pack", "xml", "--include-logs", "3", "--token-tree", "--include-diffs"]);
  const result = health(dir);
  assert.equal(result.code, 0, result.out);
  assert.doesNotMatch(result.out, /unexpected path/);
  assert.match(result.out, /\d+ passed, 0 warning/);
  assert.match(result.out, /0 failed/);
});

test("a Windows home path is a warning in a plain text and in a string literal", (t) => {
  // The doubled form is how the path appears inside a JavaScript or JSON string, and it used to be
  // the one spelling the detector missed: the pattern demanded exactly one backslash.
  const dir = repoWithSnapshot(t, {
    "src/literal.ts": "export const p = \"C:\\\\Users\\\\someone\\\\key.txt\";\n",
  });
  const result = health(dir);
  assert.equal(result.code, 0, result.out);
  const section = result.out.slice(result.out.indexOf("No host path"));
  assert.match(section, /hit\(s\)/, "the check warns");
  assert.match(section, /C:\\\\Users\\\\someone/, "the string-literal spelling is reported");
});

test("a part whose body is shorter than the manifest says is a failure", (t) => {
  const dir = repoWithSnapshot(t);
  const ok = health(dir);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /Every file body matches the manifest accounting/);

  // Remove a line from the part without touching the manifest: the hashes still agree because the
  // part hash is only checked against the manifest, which was not edited.
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
  const part = manifest.parts[0];
  const partPath = path.join(dir, "snapshot", "parts", part.filename);
  const text = fs.readFileSync(partPath, "utf8");
  const marker = "export const";
  const at = text.indexOf(marker);
  assert.ok(at > 0, "the fixture part holds source");
  const lineEnd = text.indexOf("\n", at);
  fs.writeFileSync(partPath, text.slice(0, at) + text.slice(lineEnd + 1));

  const broken = health(dir);
  assert.equal(broken.code, 1, broken.out);
  assert.match(broken.out, /Every file body matches the manifest accounting/);
  assert.match(broken.out, /disagree/);
});
