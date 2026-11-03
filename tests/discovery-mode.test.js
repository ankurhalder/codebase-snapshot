import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { collectFiles } from "../dist/index.js";

/**
 * `--discovery walk|git|auto` (task-9).
 *
 * The state that motivated the flag: a directory whose `.git` exists but cannot be
 * listed (empty, corrupted, permission-denied). `auto` refuses — a walk is not the
 * same thing as git — and before this flag there was no way forward at all.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(path.resolve(here, ".."), "dist", "bin.js");

function tempDir(t, prefix = "discovery-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

/** A repository whose `.git` exists but cannot be listed: an empty `.git`. */
function brokenRepository(t) {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"broken","version":"1.0.0"}\n');
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, ".env", "DB_PASSWORD=notARealSecretValue1234\n");
  write(dir, "docs/.gitignore", "hidden.md\n");
  write(dir, "docs/visible.md", "# visible\n");
  write(dir, "docs/hidden.md", "# generated, ignored\n");
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

function run(cwd, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
}

const included = (manifest) => manifest.files.map((file) => file.relativePath);
const skippedPaths = (manifest) => manifest.skipped.map((entry) => entry.path);

test("auto refuses when .git exists but git cannot list it, and names the escape hatch", (t) => {
  const dir = brokenRepository(t);

  const result = run(dir, ["generate", "--cwd", dir]);

  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /This directory is a git repository, but git could not list its files/);
  assert.match(result.out, /--discovery walk/, "the refusal must point at the fix");
  // The old reason claimed a walk loses nested .gitignore rules; the walker honours
  // them now, so the message must not repeat that.
  assert.equal(
    result.out.includes("ignore nested .gitignore"),
    false,
    "the refusal must not claim nested .gitignore files are lost"
  );
});

test("walk scans that same tree: every file is included or recorded as skipped", (t) => {
  const dir = brokenRepository(t);

  const result = run(dir, ["generate", "--cwd", dir, "--discovery", "walk"]);

  assert.equal(result.code, 0, result.out);
  const manifest = readManifest(dir);
  const files = included(manifest);
  const skipped = skippedPaths(manifest);

  for (const expected of ["package.json", "src/a.ts", "docs/visible.md"]) {
    assert.ok(files.includes(expected), `${expected} must be included: ${files.join(", ")}`);
  }
  assert.ok(skipped.includes(".env"), "the credential file must be recorded");
  assert.ok(skipped.includes("docs/hidden.md"), "the nested-.gitignore file must be recorded");
  assert.equal(files.includes("docs/hidden.md"), false);

  // Nothing the fixture contains is unaccounted for.
  for (const candidate of ["package.json", "src/a.ts", ".env", "docs/visible.md", "docs/hidden.md"]) {
    assert.ok(
      files.includes(candidate) || skipped.includes(candidate),
      `${candidate} appears in neither files[] nor skipped[]`
    );
  }
});

test("walk still honours a nested .gitignore at the scanner level", (t) => {
  const dir = brokenRepository(t);

  const result = collectFiles(dir, { discovery: "walk" });

  assert.ok(result.files.includes("docs/visible.md"));
  assert.equal(result.files.includes("docs/hidden.md"), false, "a nested rule must still apply");
  const record = result.skipped.find((entry) => entry.path === "docs/hidden.md");
  assert.ok(record, JSON.stringify(result.skipped));
  assert.equal(record.reason, "gitignore");
});

test("walk still skips secrets and never emits their content", (t) => {
  const dir = brokenRepository(t);
  const secret = "notARealSecretValue1234";

  const result = run(dir, ["generate", "--cwd", dir, "--discovery", "walk", "--include-monolith"]);

  assert.equal(result.code, 0, result.out);
  const manifest = readManifest(dir);
  assert.equal(included(manifest).includes(".env"), false);
  const record = manifest.skipped.find((entry) => entry.path === ".env");
  assert.ok(record, JSON.stringify(manifest.skipped));
  assert.equal(record.reason, "sensitive-file");

  const snapshotDir = path.join(dir, "snapshot");
  const offenders = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (fs.readFileSync(full, "utf8").includes(secret)) offenders.push(full);
    }
  };
  walk(snapshotDir);
  assert.deepEqual(offenders, [], "no artifact may contain the credential");
});

test("git mode refuses outside a repository", (t) => {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"plain","version":"1.0.0"}\n');
  write(dir, "src/a.ts", "export const a = 1;\n");

  const result = run(dir, ["generate", "--cwd", dir, "--discovery", "git"]);

  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /Discovery mode is `git`, but git could not list/);
  assert.match(result.out, /--discovery walk/);
});

test("an invalid --discovery value is a usage error naming the three modes", (t) => {
  const dir = brokenRepository(t);

  const result = run(dir, ["generate", "--cwd", dir, "--discovery", "sometimes"]);

  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /--discovery must be one of: auto, git, walk/);
  assert.match(result.out, /received "sometimes"/);
});

test("the flag is rejected by a command that does not scan", (t) => {
  const dir = brokenRepository(t);

  const result = run(dir, ["report", "--cwd", dir, "--discovery", "walk"]);

  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /--discovery do(es)? not apply to `report`/);
  assert.match(result.out, /generate/);
  assert.match(result.out, /validate/);
  assert.match(result.out, /explain/);
});

test("describe publishes the option with its real scope", (t) => {
  const dir = brokenRepository(t);

  const result = run(dir, ["describe", "--format", "json"]);
  assert.equal(result.code, 0, result.out);

  const contract = JSON.parse(result.out.slice(result.out.indexOf("{")));
  const option = contract.options.find((entry) => entry.flag === "--discovery");
  assert.ok(option, "the contract must list --discovery");
  for (const command of ["generate", "validate", "explain"]) {
    assert.match(option.appliesTo, new RegExp(command));
  }
  assert.equal(option.appliesTo.includes("report"), false, "report does not scan");
  assert.ok(
    contract.config.settings.some((setting) => setting.key === "discovery"),
    "the config key must be documented in the contract"
  );
});

test("the config key `discovery` has the same effect as the flag", (t) => {
  const dir = brokenRepository(t);
  write(dir, "snapshot.config.json", '{"discovery": "walk"}\n');

  const result = run(dir, ["generate", "--cwd", dir]);

  assert.equal(result.code, 0, result.out);
  assert.ok(readManifest(dir).files.length > 0);
});

test("two walk runs produce the same fingerprint", (t) => {
  const dir = brokenRepository(t);

  const first = run(dir, ["generate", "--cwd", dir, "--discovery", "walk"]);
  assert.equal(first.code, 0, first.out);
  const firstManifest = readManifest(dir);

  const second = run(dir, ["generate", "--cwd", dir, "--discovery", "walk"]);
  assert.equal(second.code, 0, second.out);
  const secondManifest = readManifest(dir);

  assert.equal(secondManifest.fingerprint, firstManifest.fingerprint);
  assert.deepEqual(included(secondManifest), included(firstManifest));
  assert.deepEqual(skippedPaths(secondManifest), skippedPaths(firstManifest));
});
