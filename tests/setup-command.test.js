/**
 * `setup` — the whole first-run flow in one command.
 *
 * It writes the config only when the repository has none, adds the npm scripts, the devDependency
 * and the `.gitignore` entries, installs dependencies with the project's package manager, and then
 * generates through the normal `generate` command. The install is skipped here with `--no-install`
 * so the suite never needs the network.
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

function makeRepo(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-cmd-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(dir, args = []) {
  const result = spawnSync(process.execPath, [BIN, "setup", "--cwd", dir, "--no-install", ...args], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const configPath = (dir) =>
  fs.readdirSync(dir).find((name) => /^snapshot\.config\.(ts|mjs|cjs|js|json)$/.test(name));

test("setup writes the config, scripts, dependency and ignore entries, then generates", (t) => {
  const dir = makeRepo(t);

  const result = run(dir);

  assert.equal(result.code, 0, result.stderr);
  const name = configPath(dir);
  assert.ok(name, "a config was written");
  assert.match(result.stderr, /Created snapshot\.config/);

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.snapshot, "npx @ankurhalder/codebase-snapshot generate");
  assert.match(String(pkg.devDependencies["@ankurhalder/codebase-snapshot"]), /^\^/);

  const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.match(ignore, /snapshot\//);
  assert.match(ignore, /snapshot\.tmp\//);

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
  assert.ok(manifest.counts.totalFiles > 0, "the snapshot was generated in the same run");
  assert.match(result.stderr, /Snapshot generated/);
});

test("a second setup keeps the existing config and generates again", (t) => {
  const dir = makeRepo(t);
  assert.equal(run(dir).code, 0);
  const name = configPath(dir);
  const before = fs.readFileSync(path.join(dir, name), "utf8");

  const second = run(dir);

  assert.equal(second.code, 0, second.stderr);
  assert.equal(
    fs.readFileSync(path.join(dir, name), "utf8"),
    before,
    "the repository's own config is never rewritten silently"
  );
  assert.match(second.stderr, /Keeping snapshot\.config/);
  assert.ok(fs.existsSync(path.join(dir, "snapshot", "manifest.json")), "it still generated");
});

test("setup --dry-run writes nothing", (t) => {
  const dir = makeRepo(t);

  const result = run(dir, ["--dry-run"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(configPath(dir), undefined, "no config was written");
  assert.equal(fs.existsSync(path.join(dir, "snapshot")), false, "nothing was generated");
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts, undefined, "package.json was not touched");
  assert.match(result.stderr, /Dry run/);
});

test("setup --format json emits one document with the setup report and the manifest", (t) => {
  const dir = makeRepo(t);

  const result = run(dir, ["--format", "json"]);

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.setup.configReused, false);
  assert.equal(payload.setup.preset.length > 0, true);
  assert.equal(payload.setup.install, null, "--no-install was passed");
  assert.ok(payload.manifest, "the generation document is merged in");
  assert.ok(payload.manifest.fingerprint);
  // One document: the only closing brace at column 0 is the end of the top-level object.
  assert.equal(
    result.stdout.split("\n").filter((line) => line === "}").length,
    1,
    "exactly one JSON document on stdout"
  );
});

test("setup refuses to replace a directory it does not own, after writing the config", (t) => {
  const dir = makeRepo(t, { "snapshot/parts/keep.md": "notes\n" });

  const result = run(dir);

  assert.equal(result.code, 1, "the ownership guard still applies");
  assert.match(result.stderr, /Refusing to replace outDir/);
  assert.equal(
    fs.readFileSync(path.join(dir, "snapshot", "parts", "keep.md"), "utf8"),
    "notes\n",
    "the user's file is untouched"
  );
});

test("setup installs with a clean environment, even when npm exec poisoned it", (t) => {
  // The bug this pins: run through `npx`/`npm exec`, the child `npm install` inherits the parent
  // npm's resolved config in `npm_config_*`, and with an npm that supports an `allowScripts`
  // switch it aborted with `EALLOWSCRIPTS: --allow-scripts is not allowed in project-scoped
  // installs`. A test-only shim stands in for npm and records what it was given.
  const dir = makeRepo(t, { "package-lock.json": "{}\n" });
  const shimDir = path.join(dir, "shim");
  fs.mkdirSync(shimDir, { recursive: true });
  const record = path.join(dir, "install-record.txt");
  const isWindows = process.platform === "win32";
  const shim = path.join(shimDir, isWindows ? "npm.cmd" : "npm");
  fs.writeFileSync(
    shim,
    isWindows
      ? [
          "@echo off",
          'if defined npm_config_allow_scripts echo LEAKED>>"%SETUP_SHIM_RECORD%"',
          'echo RAN>>"%SETUP_SHIM_RECORD%"',
          "exit /b 0",
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          'if [ -n "$npm_config_allow_scripts" ]; then echo LEAKED >> "$SETUP_SHIM_RECORD"; fi',
          'echo RAN >> "$SETUP_SHIM_RECORD"',
          "exit 0",
          "",
        ].join("\n")
  );
  if (!isWindows) fs.chmodSync(shim, 0o755);

  const result = spawnSync(
    process.execPath,
    [BIN, "setup", "--cwd", dir],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
        Path: `${shimDir}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}`,
        npm_config_allow_scripts: "1",
        SETUP_SHIM_RECORD: record,
      },
    }
  );
  if (result.error) throw result.error;

  const recorded = fs.existsSync(record) ? fs.readFileSync(record, "utf8") : "";
  assert.match(recorded, /RAN/, `the package manager was not invoked: ${result.stderr}`);
  assert.equal(
    recorded.includes("LEAKED"),
    false,
    "npm's own config must not reach the nested install"
  );
  assert.match(result.stderr ?? "", /Installed dependencies/);
});
