/**
 * The first run: what a bare `snapshot` does in a project that has no configuration.
 *
 * Three outcomes, and the tests below pin all three: a terminal asks; `--autopilot` decides and
 * does the whole setup; with no terminal and no `--autopilot` the run refuses with exit 2 and
 * names the alternatives. The refusal is the important one — a first run that silently used
 * settings nobody chose produces a snapshot nobody can trust.
 *
 * The interactive path itself needs a real TTY and is exercised by hand; what is testable here is
 * the decision (`planFirstRun`), the two filesystem probes that feed it, and the unattended paths
 * end to end.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hasPriorSnapshot, isEffectivelyEmpty, planFirstRun } from "../dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function makeProject(t, files = { "src/a.ts": "export const a = 1;\n" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "first-run-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The command as typed by someone who installed the package: no command word at all. */
function runBare(dir, args = []) {
  const result = spawnSync(process.execPath, [BIN, "--cwd", dir, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runCommand(dir, args) {
  const result = spawnSync(process.execPath, [BIN, ...args, "--cwd", dir], { encoding: "utf8" });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const configName = (dir) =>
  fs.readdirSync(dir).find((name) => /^snapshot\.config\.(ts|mjs|cjs|js|json)$/.test(name));

const facts = (overrides = {}) => ({
  hasConfig: false,
  hasPriorSnapshot: false,
  interactive: false,
  autopilot: false,
  emptyTarget: false,
  ...overrides,
});

// ------------------------------------------------------------------ the decision

test("a bare run with nothing configured and no terminal refuses instead of guessing", () => {
  assert.deepEqual(planFirstRun(facts()), {
    action: "refuse",
    exitCode: 2,
    reason: "undecided",
  });
});

test("a configured project generates", () => {
  assert.deepEqual(planFirstRun(facts({ hasConfig: true })), { action: "generate" });
});

test("a project generated before generates — no second wizard", () => {
  assert.deepEqual(planFirstRun(facts({ hasPriorSnapshot: true })), { action: "generate" });
});

test("a terminal asks", () => {
  assert.deepEqual(planFirstRun(facts({ interactive: true })), {
    action: "setup",
    interactive: true,
  });
});

test("--autopilot sets up and never asks, even at a terminal", () => {
  assert.deepEqual(planFirstRun(facts({ autopilot: true, interactive: true })), {
    action: "setup",
    interactive: false,
  });
});

test("--autopilot on an existing project still sets up what is missing", () => {
  assert.deepEqual(planFirstRun(facts({ autopilot: true, hasConfig: true })), {
    action: "setup",
    interactive: false,
  });
});

test("an empty directory is refused on every path, --autopilot included", () => {
  const expected = { action: "refuse", exitCode: 1, reason: "empty" };
  assert.deepEqual(planFirstRun(facts({ emptyTarget: true })), expected);
  assert.deepEqual(planFirstRun(facts({ emptyTarget: true, autopilot: true })), expected);
  assert.deepEqual(planFirstRun(facts({ emptyTarget: true, interactive: true })), expected);
});

// -------------------------------------------------------------- the filesystem probes

test("a directory holding only version-control metadata counts as empty", (t) => {
  const dir = makeProject(t, {});
  fs.rmSync(path.join(dir, "package.json"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });

  assert.equal(isEffectivelyEmpty(dir), true);
  fs.writeFileSync(path.join(dir, "README.md"), "# hi\n");
  assert.equal(isEffectivelyEmpty(dir), false);
});

test("a prior snapshot counts only when this tool wrote it", (t) => {
  const dir = makeProject(t, {});
  assert.equal(hasPriorSnapshot(dir, "snapshot"), false, "nothing there");

  fs.mkdirSync(path.join(dir, "snapshot"));
  const marker = path.join(dir, "snapshot", ".codebase-snapshot");
  fs.writeFileSync(marker, JSON.stringify({ generator: "some-other-tool" }));
  assert.equal(hasPriorSnapshot(dir, "snapshot"), false, "a foreign marker is not evidence");

  fs.writeFileSync(marker, JSON.stringify({ generator: "codebase-snapshot" }));
  assert.equal(hasPriorSnapshot(dir, "snapshot"), true);

  // The pre-4.5 name is the same generator: a project generated then must not be asked again.
  fs.writeFileSync(marker, JSON.stringify({ generator: "@ankurhalder/codebase-snapshot" }));
  assert.equal(hasPriorSnapshot(dir, "snapshot"), true);
});

// ------------------------------------------------------------------- the bare command

test("a bare run without a terminal writes nothing and names the way out", (t) => {
  const dir = makeProject(t);

  const run = runBare(dir);

  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /--autopilot/);
  assert.equal(configName(dir), undefined, "no config was written");
  assert.equal(fs.existsSync(path.join(dir, "snapshot")), false, "nothing was generated");
});

test("the refusal is a JSON document under --format json", (t) => {
  const dir = makeProject(t);

  const run = runBare(dir, ["--format", "json"]);

  assert.equal(run.code, 2, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.error.exitCode, 2);
  assert.match(parsed.error.message, /autopilot/);
});

test("--autopilot sets the project up and generates without asking", (t) => {
  const dir = makeProject(t);

  const run = runBare(dir, ["--autopilot", "--no-install"]);

  assert.equal(run.code, 0, run.stderr);
  assert.ok(configName(dir), "a config was written");
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.snapshot, "npx codebase-snapshot generate");
  assert.match(String(pkg.devDependencies["codebase-snapshot"]), /^\^\d+\.\d+\.\d+$/);
  assert.ok(pkg.devDependencies["codebase-snapshot"], "the dependency is declared");
  assert.ok(fs.existsSync(path.join(dir, "snapshot", "manifest.json")), "the snapshot exists");
  assert.match(run.stderr, /Snapshot generated/);
});

test("--autopilot reports the preset it chose", (t) => {
  const dir = makeProject(t);

  const run = runBare(dir, ["--autopilot", "--no-install"]);

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /preset: \w+/);
  assert.match(run.stderr, /because /);
});

test("a second bare run just generates", (t) => {
  const dir = makeProject(t);
  assert.equal(runBare(dir, ["--autopilot", "--no-install"]).code, 0);

  const run = runBare(dir);

  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /How should I set this up/);
  assert.match(run.stderr, /Using config/);
});

test("--autopilot in an empty directory refuses and writes nothing", (t) => {
  const dir = makeProject(t, {});
  fs.rmSync(path.join(dir, "package.json"));
  fs.mkdirSync(path.join(dir, ".git"));

  const run = runBare(dir, ["--autopilot"]);

  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /Nothing to snapshot/);
  assert.equal(configName(dir), undefined);
});

test("naming the command keeps the old behaviour: generate on the built-in defaults", (t) => {
  const dir = makeProject(t);

  const run = runCommand(dir, ["generate"]);

  assert.equal(run.code, 0, run.stderr);
  assert.equal(configName(dir), undefined, "no config was written");
  assert.ok(fs.existsSync(path.join(dir, "snapshot", "manifest.json")));
});

// ------------------------------------------------------------------------ conflicts

test("--autopilot contradicts --no-config", (t) => {
  const dir = makeProject(t);

  const run = runBare(dir, ["--autopilot", "--no-config"]);

  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /--no-config ignores config files/);
  assert.equal(configName(dir), undefined);
});

test("--no-install only applies to a setup", (t) => {
  const dir = makeProject(t);

  const run = runCommand(dir, ["generate", "--no-install"]);

  assert.equal(run.code, 2, run.stderr);
  assert.match(run.stderr, /--autopilot/);
});
