import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { shouldCheck } from "../dist/index.js";

/**
 * Flags the CLI accepted and then dropped, from the 0.9.9 audit.
 *
 * `setup` writes a config and then generates *through the generate command*, and it built
 * that inner command line by hand. Five options the caller had just chosen were not copied
 * into it, so the run reported one configuration and generated with another — the exact
 * silent fallback rule 1 forbids, with the user's own flag as the evidence.
 *
 * `--only-artifacts monolith` had a second version of the same problem: it turned the six
 * default artifacts off and relied on `includeMonolith` to turn the seventh on, and neither
 * `init` nor `setup` passed `includeMonolith` on, so the config it wrote enabled *nothing*.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-forward-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, "src", "big.ts"), `${"export const x = 1;\n".repeat(200)}`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(dir, command, args = []) {
  // `--no-install` belongs to `setup` only; passing it to `init` is a usage error by
  // design, and the parser is right to reject a flag that changes nothing for a command.
  const flags = command === "setup" ? ["--no-install"] : [];
  const result = spawnSync(
    process.execPath,
    [BIN, command, "--cwd", dir, ...flags, ...args],
    { encoding: "utf8" }
  );
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const configName = (dir) =>
  fs.readdirSync(dir).find((name) => /^snapshot\.config\.(ts|mjs|cjs|js|json)$/.test(name));

test("setup --only-artifacts monolith enables the monolith instead of disabling everything", (t) => {
  const dir = makeRepo(t);

  const result = run(dir, "setup", ["--only-artifacts", "monolith"]);

  assert.equal(result.code, 0, result.stderr);
  const text = fs.readFileSync(path.join(dir, configName(dir)), "utf8");
  assert.match(text, /includeMonolith:\s*true/, "the named artifact must be enabled");
  assert.match(text, /monolith:\s*true/, "and the artifact switch agrees");
  assert.match(text, /readme:\s*false/, "everything else is off");
  assert.match(text, /parts:\s*false/);
});

test("init --yes --only-artifacts monolith writes a config that generates something", (t) => {
  const dir = makeRepo(t);

  const result = run(dir, "init", ["--yes", "--only-artifacts", "monolith"]);

  assert.equal(result.code, 0, result.stderr);
  const text = fs.readFileSync(path.join(dir, configName(dir)), "utf8");
  assert.match(text, /includeMonolith:\s*true/);
});

test("setup forwards the size flags it accepted", (t) => {
  const dir = makeRepo(t);

  const result = run(dir, "setup", [
    "--large-file-bytes",
    "10",
    "--max-monolith-bytes",
    "1mb",
    "--include-monolith",
    "--format",
    "json",
  ]);

  assert.equal(result.code, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  const config = document.manifest.config;
  assert.equal(config.largeFileBytes, 10, "--large-file-bytes reached the generator");
  assert.equal(config.includeMonolith, true, "--include-monolith reached the generator");
  assert.equal(config.maxMonolithBytes, 1024 * 1024, "--max-monolith-bytes reached the generator");
});

test("setup forwards the discovery mode it accepted", (t) => {
  const dir = makeRepo(t);
  // Not a git repository, so `--discovery git` must be refused rather than quietly
  // falling back to the walk — which is exactly what happens when the flag is dropped.
  const result = run(dir, "setup", ["--discovery", "git"]);

  assert.notEqual(result.code, 0, "git mode in a non-repository is a refusal");
  assert.match(result.stderr, /Discovery mode is `git`/);
});

test("the walk mode still works through setup", (t) => {
  const dir = makeRepo(t);
  const result = run(dir, "setup", ["--discovery", "walk"]);
  assert.equal(result.code, 0, result.stderr);
});

test("a file named *.json in the arguments does not disable the update check", () => {
  const env = { ...process.env };
  delete env.CI;
  delete env.CODEBASE_SNAPSHOT_NO_UPDATE_CHECK;

  // The check is skipped when the *output format* is JSON, not when a word containing
  // "json" appears anywhere in the command line.
  assert.equal(shouldCheck(["explain", "package.json"], env), true);
  assert.equal(shouldCheck(["diff", "a/manifest.json", "b/manifest.json"], env), true);
  assert.equal(shouldCheck(["explain", "package.json", "--format", "json"], env), false);
  assert.equal(shouldCheck(["generate", "--format=json"], env), false);
});
