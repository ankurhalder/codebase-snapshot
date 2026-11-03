import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { loadConfigFileDetailed, supportsTypeScriptImports } from "../dist/index.js";

/**
 * W4: `loadConfigFileDetailed` must see the config that is on disk *now*.
 *
 * ESM caches a module per specifier, so a second `import()` of the same
 * `snapshot.config.mjs` used to return the module evaluated on the first load.
 * `generate --watch` therefore applied the config it started with forever, and a
 * config that became invalid mid-watch was silently replaced by the stale one
 * instead of producing the `Could not load …` error a cold start reports.
 * These are loader-level tests: no watcher timing is involved, only two
 * successive loads of the same path.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-config-reload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, relativePath, content) {
  const target = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

/** A package.json makes the fixture a real project, not a bare directory. */
function project(dir, type) {
  write(dir, "package.json", JSON.stringify({ name: "reload-fixture", version: "1.0.0", type }));
  return dir;
}

const budget = (loaded) => loaded.config && loaded.config.maxPartBytes;

function assertLoadedBudget(loaded, expected, label) {
  assert.equal(loaded.errors.length, 0, `${label}: unexpected errors: ${loaded.errors.join("; ")}`);
  assert.ok(loaded.config, `${label}: expected a configuration object`);
  assert.equal(budget(loaded), expected, `${label}: stale budget ${budget(loaded)} != ${expected}`);
}

test("W4: an edited snapshot.config.mjs is read again on the next load", async (t) => {
  const dir = project(tempDir(t), "module");
  write(dir, "snapshot.config.mjs", "export default { maxPartBytes: 8192 };\n");
  assertLoadedBudget(await loadConfigFileDetailed(dir), 8192, "first load");

  write(dir, "snapshot.config.mjs", "export default { maxPartBytes: 12288 };\n");
  assertLoadedBudget(await loadConfigFileDetailed(dir), 12288, "second load");
});

test("W4: an edited snapshot.config.cjs is read again on the next load", async (t) => {
  const dir = project(tempDir(t), "commonjs");
  write(dir, "snapshot.config.cjs", "module.exports = { maxPartBytes: 8192 };\n");
  assertLoadedBudget(await loadConfigFileDetailed(dir), 8192, "first load");

  write(dir, "snapshot.config.cjs", "module.exports = { maxPartBytes: 16384 };\n");
  assertLoadedBudget(await loadConfigFileDetailed(dir), 16384, "second load");
});

test("W4: an edited snapshot.config.js in an ES module package is read again", async (t) => {
  const dir = project(tempDir(t), "module");
  write(dir, "snapshot.config.js", "export default { maxPartBytes: 8192 };\n");
  assertLoadedBudget(await loadConfigFileDetailed(dir), 8192, "first load");

  write(dir, "snapshot.config.js", "export default { maxPartBytes: 20480 };\n");
  assertLoadedBudget(await loadConfigFileDetailed(dir), 20480, "second load");
});

test("W4: an edited snapshot.config.ts is read again on the next load", async (t) => {
  if (!supportsTypeScriptImports()) {
    t.skip(`this Node (${process.versions.node}) cannot load a .ts config`);
    return;
  }
  const dir = project(tempDir(t), "module");
  write(dir, "snapshot.config.ts", "export default { maxPartBytes: 8192 };\n");
  assertLoadedBudget(await loadConfigFileDetailed(dir), 8192, "first load");

  write(dir, "snapshot.config.ts", "export default { maxPartBytes: 24576 };\n");
  assertLoadedBudget(await loadConfigFileDetailed(dir), 24576, "second load");
});

test("W4: a module config that becomes invalid mid-load is reported, not re-used", async (t) => {
  const dir = project(tempDir(t), "module");
  write(dir, "snapshot.config.mjs", "export default { maxPartBytes: 8192 };\n");
  assertLoadedBudget(await loadConfigFileDetailed(dir), 8192, "first load");

  // The same failure a cold start reports: a hard error, never the old object.
  write(dir, "snapshot.config.mjs", "export default { maxPartBytes: 12288;\n");
  const broken = await loadConfigFileDetailed(dir);
  assert.equal(broken.config, null, "a broken config must not fall back to the stale object");
  assert.ok(broken.errors.length > 0, "a broken config must be reported as an error");
  assert.match(broken.errors[0], /Could not load .*snapshot\.config\.mjs/);

  // And a fixed config is picked up again, so the watcher recovers.
  write(dir, "snapshot.config.mjs", "export default { maxPartBytes: 28672 };\n");
  assertLoadedBudget(await loadConfigFileDetailed(dir), 28672, "recovered load");
});

test("W4: deleting the module config mid-load falls back to the defaults", async (t) => {
  const dir = project(tempDir(t), "module");
  const configPath = write(dir, "snapshot.config.mjs", "export default { maxPartBytes: 8192 };\n");
  assertLoadedBudget(await loadConfigFileDetailed(dir), 8192, "first load");

  fs.rmSync(configPath);
  const missing = await loadConfigFileDetailed(dir);
  assert.equal(missing.config, null, "no config file means the built-in defaults");
  assert.equal(missing.file, null);
  assert.equal(missing.errors.length, 0);
});
