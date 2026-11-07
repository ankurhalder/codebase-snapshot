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
