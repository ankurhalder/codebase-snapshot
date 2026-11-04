import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `init` ends by telling the user what to run next. That line has to be executable exactly
 * as printed: it used to say `npm run snapshot` in a directory with no package.json, and
 * then, after a re-run, a bare `codebase-snapshot generate` — a package
 * specifier, not a command.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function makeDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-next-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** `init` writes its progress to stderr, so that is where the hint lives. */
function runInit(dir, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [BIN, "init", "--cwd", dir, "--yes", ...extraArgs],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stderr;
}

test("no package.json: the hint is a command that exists", (t) => {
  const dir = makeDir(t, { "main.go": "package main\nfunc main() {}\n" });
  const stderr = runInit(dir);
  assert.match(stderr, /Next:\s+npx codebase-snapshot generate/);
  assert.doesNotMatch(stderr, /Next:\s+npm run snapshot/, "npm run needs a package.json");
});

test("scripts written but dependencies not installed: the hint installs first", (t) => {
  const dir = makeDir(t, { "package.json": '{"name":"fixture","version":"1.0.0","type":"module"}\n' });
  const stderr = runInit(dir);
  assert.match(stderr, /Added npm scripts: snapshot, snapshot:validate/);
  assert.match(stderr, /Next:\s+npm install && npm run snapshot/);
});

test("a re-run over a configured project does not print a bare package name", (t) => {
  const dir = makeDir(t, { "package.json": '{"name":"fixture","version":"1.0.0","type":"module"}\n' });
  runInit(dir);
  const stderr = runInit(dir, ["--force"]);

  assert.doesNotMatch(
    stderr,
    /Next:\s+codebase-snapshot generate/,
    "a bare package name is not a runnable command"
  );
  assert.match(
    stderr,
    /Next:\s+(npx codebase-snapshot generate|npm install && npm run snapshot)/
  );
});

test("an installed project is told the plain script", (t) => {
  const dir = makeDir(t, { "package.json": '{"name":"fixture","version":"1.0.0","type":"module"}\n' });
  runInit(dir);
  fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", ".bin", "codebase-snapshot"), "", "utf8");

  const stderr = runInit(dir, ["--force"]);
  assert.match(stderr, /Next:\s+npm run snapshot/);
});
