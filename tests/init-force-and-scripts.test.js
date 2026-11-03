import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { loadConfigFileDetailed, runInit } from "../dist/index.js";

/**
 * Regression tests for three init defects:
 *   D-1 `--force` wrote a second config file that silently shadowed the existing one;
 *   D-6 a non-object `scripts` value was replaced without telling anyone;
 *   D-5 an unwritable target surfaced a raw `EPERM …` instead of a refusal.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-fix-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeProject(dir, packageJson = { name: "fixture", version: "1.0.0" }) {
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
}

/** Every config filename the loader knows about that exists in `dir`. */
function configFiles(dir) {
  return [
    "snapshot.config.ts",
    "snapshot.config.js",
    "snapshot.config.mjs",
    "snapshot.config.cjs",
    "snapshot.config.json",
    ".snapshotrc.json",
    ".snapshotrc",
  ].filter((name) => fs.existsSync(path.join(dir, name)));
}

// ------------------------------------------------------------------------- D-1

test("D-1: --force over a JSON config refuses instead of shadowing it", async (t) => {
  const dir = tempDir(t);
  writeProject(dir);
  const jsonConfig = path.join(dir, "snapshot.config.json");
  fs.writeFileSync(jsonConfig, '{"outDir": "custom-out"}\n');

  await assert.rejects(runInit({ cwd: dir, yes: true, force: true }), /snapshot\.config\.json/);

  // Nothing was written beside it, and the user's file is untouched.
  assert.deepEqual(configFiles(dir), ["snapshot.config.json"]);
  assert.equal(fs.readFileSync(jsonConfig, "utf8"), '{"outDir": "custom-out"}\n');

  // The loader therefore sees exactly the one config the user wrote.
  const loaded = await loadConfigFileDetailed(dir);
  assert.equal(path.basename(loaded.file ?? ""), "snapshot.config.json");
  assert.deepEqual(loaded.errors, []);
});

test("D-1: --force rewrites the module config that is already present", async (t) => {
  const dir = tempDir(t);
  // ESM project: `chooseConfigFileName` prefers `snapshot.config.ts`, so keeping
  // the present `.mjs` is the observable part of the fix.
  writeProject(dir, { name: "fixture", version: "1.0.0", type: "module" });
  const mjs = path.join(dir, "snapshot.config.mjs");
  fs.writeFileSync(mjs, "export default { outDir: 'stale' };\n");

  const result = await runInit({ cwd: dir, yes: true, force: true });

  assert.equal(path.basename(result.configPath), "snapshot.config.mjs");
  assert.deepEqual(configFiles(dir), ["snapshot.config.mjs"], "exactly one config file");
  const written = fs.readFileSync(mjs, "utf8");
  assert.notEqual(written, "export default { outDir: 'stale' };\n", "the present file was rewritten");
  assert.match(written, /export default/);

  const loaded = await loadConfigFileDetailed(dir);
  assert.equal(path.basename(loaded.file ?? ""), "snapshot.config.mjs");
});

test("D-1: a clean project still writes exactly one config and loads it", async (t) => {
  const dir = tempDir(t);
  writeProject(dir);

  const result = await runInit({ cwd: dir, yes: true });

  assert.equal(result.written, true);
  assert.deepEqual(configFiles(dir), [path.basename(result.configPath)]);
  const loaded = await loadConfigFileDetailed(dir);
  assert.equal(loaded.file, result.configPath);
});

test("D-1: a pre-existing pair of configs is reported, not silently resolved", async (t) => {
  const dir = tempDir(t);
  writeProject(dir);
  fs.writeFileSync(path.join(dir, "snapshot.config.json"), '{"outDir": "json-out"}\n');
  fs.writeFileSync(path.join(dir, "snapshot.config.mjs"), "export default { outDir: 'mjs-out' };\n");

  // The `.json` is refused (a module config cannot be written there), and the
  // note names both files so the user knows which one wins today.
  await assert.rejects(runInit({ cwd: dir, yes: true, force: false }), /snapshot\.config\.ts|snapshot\.config\.json|snapshot\.config\.mjs/);

  const dry = await runInit({ cwd: dir, yes: true, force: true, dryRun: true });
  assert.ok(
    dry.notes.some((note) => /Multiple configuration files found/.test(note)),
    `notes must name the shadowing files: ${JSON.stringify(dry.notes)}`
  );
  assert.ok(dry.notes.some((note) => /snapshot\.config\.json/.test(note) && /snapshot\.config\.mjs/.test(note)));
});

// ------------------------------------------------------------------------- D-6

test("D-6: a string scripts value is reported, not silently replaced", async (t) => {
  const dir = tempDir(t);
  writeProject(dir, { name: "fixture", version: "1.0.0", scripts: "not-an-object" });

  const result = await runInit({ cwd: dir, yes: true });

  assert.ok(
    result.notes.some((note) => /"scripts" was a string, not an object/.test(note)),
    `the replacement must be reported: ${JSON.stringify(result.notes)}`
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(typeof pkg.scripts, "object");
  assert.equal(typeof pkg.scripts.snapshot, "string");
});

test("D-6: an array scripts value is reported the same way", async (t) => {
  const dir = tempDir(t);
  writeProject(dir, { name: "fixture", version: "1.0.0", scripts: [] });

  const result = await runInit({ cwd: dir, yes: true });

  assert.ok(
    result.notes.some((note) => /"scripts" was an array, not an object/.test(note)),
    JSON.stringify(result.notes)
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(typeof pkg.scripts.snapshot, "string");
});

test("D-6: an absent scripts field is added without a replacement note", async (t) => {
  const dir = tempDir(t);
  writeProject(dir);

  const result = await runInit({ cwd: dir, yes: true });

  assert.equal(
    result.notes.some((note) => /"scripts" was/.test(note)),
    false,
    "a missing field is not a replacement"
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(typeof pkg.scripts.snapshot, "string");
});

// ------------------------------------------------------------------------- D-5

test("D-5: an unwritable config path produces the tool's message, not a raw errno", async (t) => {
  const dir = tempDir(t);
  writeProject(dir);
  // A directory squatting on the config filename makes the write fail portably.
  const target = path.join(dir, "snapshot.config.mjs");
  fs.mkdirSync(target);

  await assert.rejects(
    runInit({ cwd: dir, yes: true, force: true }),
    (err) => {
      assert.match(err.message, /^Cannot write .*snapshot\.config\.mjs: /);
      assert.equal(/^(EPERM|EACCES|EISDIR|EROFS)/.test(err.message), false, err.message);
      return true;
    }
  );
});

test("D-5: a read-only directory reports permission denied", async (t) => {
  const dir = tempDir(t);
  writeProject(dir);
  try {
    fs.chmodSync(dir, 0o500);
  } catch {
    return; // platform refuses to change the mode; nothing to assert
  }

  try {
    let message = null;
    try {
      await runInit({ cwd: dir, yes: true });
    } catch (err) {
      message = err.message;
    }
    if (message === null) {
      // Windows does not enforce a read-only directory attribute for its owner.
      t.diagnostic("this platform lets the owner write into a 0o500 directory; case not exercised");
      return;
    }
    assert.match(message, /^Cannot write .*: (permission denied \((EACCES|EPERM)\)|.*)/);
    assert.equal(/^(EPERM|EACCES): /.test(message), false, "the raw errno prefix must not lead");
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});
