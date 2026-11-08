/**
 * Usage errors that have to name the thing the developer actually typed.
 *
 * `snapshot -version` used to answer `Unknown option '-e'` — `parseArgs` had split the token into
 * the short-flag cluster `-v -e -r -s -i -o -n` and complained about the third character. That
 * names a character nobody typed and hides the real mistake, which is one dash where two belong.
 * Reported from a real terminal session, by someone trying to find out which version they had.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

function run(args) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("a long option written with one dash names the whole token", () => {
  const result = run(["-version"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option '-version'/, "the token that was typed, in full");
  assert.match(result.stderr, /--version/, "and the spelling that would have worked");
  assert.doesNotMatch(result.stderr, /'-e'/, "not a single character out of the middle of it");
});

test("every misdashed option suggests its own long form", () => {
  for (const [typed, suggestion] of [
    ["-help", "--help"],
    ["-format", "--format"],
    ["-cwd", "--cwd"],
    ["-dry-run", "--dry-run"],
  ]) {
    const result = run([typed]);
    assert.equal(result.status, 2, `${typed}: exit`);
    assert.match(result.stderr, new RegExp(`Unknown option '${typed}'`), `${typed}: names it`);
    assert.match(result.stderr, new RegExp(suggestion), `${typed}: suggests ${suggestion}`);
  }
});

test("a misdashed option that is not an option points at -- instead", () => {
  const result = run(["-frobnicate"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option '-frobnicate'/);
  assert.doesNotMatch(result.stderr, /did you mean/, "there is no --frobnicate to suggest");
  assert.match(result.stderr, /after '--'/, "the way to pass something that starts with a dash");
});

test("a cluster of real short flags still works", () => {
  const result = run(["-vh"]);
  assert.equal(result.status, 0, "-vh is -v -h, both of which exist");
  // Help wins over the version line, so this is the usage text, which names the version in its
  // first line. What matters is that the cluster was not rejected as a misdashed option.
  assert.match(result.stdout, /codebase-snapshot v\d+\.\d+\.\d+/);
  assert.match(result.stdout, /Usage:/);
});

test("the misdashed message keeps the --format json contract", () => {
  const result = run(["--format", "json", "-version"]);
  assert.equal(result.status, 2);
  const document = JSON.parse(result.stdout);
  assert.equal(document.error.exitCode, 2);
  assert.match(document.error.message, /did you mean '--version'/);
});

test("a value that looks like a misdashed option is not swallowed", () => {
  // `--include` takes a value, so `--include -version` is still an option to the parser; the point
  // is that the error explains it rather than silently accepting the token as a glob.
  const result = run(["generate", "--include", "-version"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /-version/);
});

/** A fixture for the commands that take positional arguments. */
function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-mode-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const a = 1;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runIn(cwd, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("--mode can run a command that takes positional arguments", (t) => {
  // The positionals used to be resolved as a command word before `--mode` was consulted, so
  // `--mode explain src/index.ts` answered `Unknown command "src/index.ts"` and the documented
  // `--mode` form of the two positional commands could not run at all.
  const dir = makeRepo(t);

  const explained = runIn(dir, ["--mode", "explain", "src/index.ts", "--format", "json"]);
  assert.equal(explained.status, 0, explained.stderr);
  const explanation = JSON.parse(explained.stdout);
  assert.equal(explanation.path, "src/index.ts", "the path is the argument, not the command name");

  assert.equal(runIn(dir, ["generate"]).status, 0);
  const diffed = runIn(dir, [
    "--mode",
    "diff",
    "snapshot/manifest.json",
    "snapshot/manifest.json",
    "--format",
    "json",
  ]);
  assert.equal(diffed.status, 0, diffed.stderr);
  const diff = JSON.parse(diffed.stdout);
  assert.ok(diff.before && diff.after, "two manifests were compared");
});

test("--mode keeps rejecting a contradiction and an unknown command", (t) => {
  const dir = makeRepo(t);

  const contradiction = runIn(dir, ["generate", "--mode", "validate"]);
  assert.equal(contradiction.status, 2);
  assert.match(contradiction.stderr, /contradicts the command/);

  const missing = runIn(dir, ["--mode", "explain"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /explain expects exactly one path/);

  const unknown = runIn(dir, ["--mode", "not-a-command"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown --mode "not-a-command"/);
});
