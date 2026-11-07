import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  configDigest,
  loadConfigFileDetailed,
  resolveConfig,
} from "../dist/index.js";

/**
 * `configDigest` is what `validate` uses to answer "is this snapshot still configured
 * the way it was generated". It hashed layer *names* and kind *names*, so a matcher
 * change — the thing that actually decides which files land in which layer — produced
 * an identical digest and `validate` said "valid and up to date" for a snapshot whose
 * files had all moved. These tests pin the settings that change what a snapshot
 * contains, together with the two config-validation gaps found in the same audit.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-truth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const resolve = (dir, overrides = {}) =>
  resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", ...overrides });

test("a layer matcher change moves the digest", (t) => {
  const dir = tempDir(t);
  const before = resolve(dir, { layers: [{ name: "api", match: "src/api/**" }] });
  const after = resolve(dir, { layers: [{ name: "api", match: "src/v2/**" }] });
  assert.equal(before.layers[0].name, after.layers[0].name, "only the matcher differs");
  assert.notEqual(configDigest(before), configDigest(after));
});

test("a kind matcher change moves the digest", (t) => {
  const dir = tempDir(t);
  const before = resolve(dir, { kinds: [{ kind: "test", match: "**/*.test.ts" }] });
  const after = resolve(dir, { kinds: [{ kind: "test", match: "**/*.spec.ts" }] });
  assert.notEqual(configDigest(before), configDigest(after));
});

test("a discovery change moves the digest", (t) => {
  const dir = tempDir(t);
  const git = resolve(dir, { discovery: "git" });
  const walk = resolve(dir, { discovery: "walk" });
  assert.notEqual(git.discovery, walk.discovery, "the fixtures must really differ");
  assert.notEqual(configDigest(git), configDigest(walk));
});

test("a secret rule's flags and value group move the digest", (t) => {
  const dir = tempDir(t);
  const plain = resolveConfig({
    cwd: dir,
    outDir: "snapshot",
    tmpDir: "snapshot.tmp",
    secretRules: [{ rule: "tenant-key", pattern: /tenant_[a-z]{8}/ }],
  });
  const insensitive = resolveConfig({
    cwd: dir,
    outDir: "snapshot",
    tmpDir: "snapshot.tmp",
    secretRules: [{ rule: "tenant-key", pattern: /tenant_[a-z]{8}/i }],
  });
  const masked = resolveConfig({
    cwd: dir,
    outDir: "snapshot",
    tmpDir: "snapshot.tmp",
    secretRules: [{ rule: "tenant-key", pattern: /(tenant_[a-z]{8})/, valueGroup: 1 }],
  });

  // Same rule, same source text; a different set of lines is masked in each case.
  assert.notEqual(configDigest(plain), configDigest(insensitive), "the `i` flag matters");
  assert.notEqual(configDigest(plain), configDigest(masked), "the value group matters");
});

test("an unchanged configuration keeps its digest", (t) => {
  const dir = tempDir(t);
  const once = resolve(dir, { layers: [{ name: "api", match: "src/api/**" }] });
  const again = resolve(dir, { layers: [{ name: "api", match: "src/api/**" }] });
  assert.equal(configDigest(once), configDigest(again));
});

test("an unknown key under package.json#snapshot is reported, not ignored", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "1.0.0", snapshot: { maxPartByte: 4096 } }, null, 2)}\n`
  );

  const loaded = await loadConfigFileDetailed(dir);

  assert.equal(loaded.config, null, "a typo must not become a defaulted run");
  assert.ok(
    loaded.errors.some((error) => /unknown setting\(s\): `maxPartByte`/.test(error)),
    `the misspelling must be named: ${JSON.stringify(loaded.errors)}`
  );
  assert.ok(
    loaded.warnings.some((warning) => /unknown setting/.test(warning)),
    "and it must be warned about as well"
  );
});

test("a config file may spell custom rules as secretRules", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(
    path.join(dir, "snapshot.config.json"),
    `${JSON.stringify({ secretRules: [{ rule: "tenant-key", pattern: "tenant_[a-z]{8}" }] }, null, 2)}\n`
  );

  const loaded = await loadConfigFileDetailed(dir);

  assert.deepEqual(loaded.errors, [], "secretRules is a documented spelling, not a typo");
  assert.ok(loaded.config, "the file must load");
  const resolved = resolveConfig({ ...loaded.config, cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" });
  assert.ok(
    resolved.secretRules.some((rule) => rule.rule === "tenant-key"),
    "and its rule must reach the resolver"
  );
});
