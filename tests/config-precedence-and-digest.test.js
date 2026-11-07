import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  configDigest,
  generateSnapshot,
  loadConfigFileDetailed,
  normalizeResolvedConfig,
  resolveConfig,
} from "../dist/index.js";

/**
 * Configuration: what `--only-artifacts` means, where a config is found, and a digest that must not
 * depend on the order somebody typed two keys in.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-precedence-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const base = { outDir: "snapshot", tmpDir: "snapshot.tmp", discovery: "walk" };

test("--only-artifacts turns on what it names, even when the config turned it off", (t) => {
  // The CLI derived `skipArtifacts` as the complement of the requested list and never forwarded
  // the list itself, so an artifact named on the command line kept whatever the config said. With
  // `artifacts: { audit: false }` in `snapshot.config.ts`, `generate --only-artifacts audit` set the
  // other six off and left audit off as well — every artifact disabled, nothing written, exit 0.
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/app.ts": "export const app = 1;\n",
    "snapshot.config.ts": "export default {};\n",
  });

  const resolved = resolveConfig(
    { ...base, artifacts: { audit: false } },
    { onlyArtifacts: ["audit"] },
    root
  );
  assert.equal(resolved.artifacts.audit, true, "the named artifact is on");
  for (const name of ["readme", "manifest", "parts", "navigation", "projectTree", "monolith"]) {
    assert.equal(resolved.artifacts[name], false, `${name} must be off`);
  }
});

test("--only-artifacts writes only what it names (end to end)", (t) => {
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/app.ts": "export const app = 1;\n",
    "snapshot.config.json": JSON.stringify({
      outDir: "snapshot",
      tmpDir: "snapshot.tmp",
      discovery: "walk",
      artifacts: { audit: false },
    }),
  });

  const result = spawnSync(
    process.execPath,
    [BIN, "generate", "--only-artifacts", "audit", "--cwd", root],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, `generate succeeded: ${result.stderr}`);

  const written = fs.readdirSync(path.join(root, "snapshot")).sort();
  assert.ok(written.includes("reports"), `the audit was written: ${written.join(", ")}`);
  assert.equal(written.includes("parts"), false, "and nothing else was");
  assert.ok(
    fs.existsSync(path.join(root, "snapshot", "reports", "audit.md")),
    "reports/audit.md exists"
  );
});

test("a config is found through a BOM, and a non-object snapshot key is not one", (t) => {
  // `findConfigFile` parsed `package.json` with bare `JSON.parse` while `loadConfigFileDetailed`
  // used the JSONC-tolerant parser, so a BOM made the first answer "no config" and the second
  // read it anyway — a first run that refused, or generated, depending on which one was asked.
  // And `"snapshot"` was checked with `!== undefined`, so an array or a string — another tool's
  // key — was reported as this tool's configuration.
  const withBom = makeRepo(t, {
    "package.json": `\uFEFF${JSON.stringify({ name: "fixture", snapshot: { outDir: "out" } })}`,
    "src/app.ts": "export const app = 1;\n",
  });
  const bomRun = spawnSync(process.execPath, [BIN, "--cwd", withBom], { encoding: "utf8" });
  assert.equal(bomRun.status, 0, `a configured project runs: ${bomRun.stderr}`);
  assert.ok(
    fs.existsSync(path.join(withBom, "out", "manifest.json")),
    "the snapshot went to the configured outDir"
  );

  for (const value of ["[]", '"other-tool"', "42"]) {
    const root = makeRepo(t, {
      "package.json": `{"name":"fixture","snapshot":${value}}`,
      "src/app.ts": "export const app = 1;\n",
    });
    const run = spawnSync(process.execPath, [BIN, "--cwd", root], { encoding: "utf8" });
    assert.equal(
      run.status,
      2,
      `"snapshot": ${value} is not this tool's configuration, so the bare run must refuse: ${run.stderr}`
    );
    assert.equal(
      fs.existsSync(path.join(root, "snapshot")),
      false,
      `nothing is generated on a refusal ("snapshot": ${value})`
    );
  }
});

test("loadConfigFileDetailed remembers the directory it loaded from", async (t) => {
  // `loadConfigFile` attached `CONFIG_DIR_SYMBOL` and `loadConfigFileDetailed` — the one the MCP
  // server uses — did not. So `resolveConfig(loaded.config)` scanned `process.cwd()` instead of the
  // directory the config came from, which is the one thing the symbol exists to prevent.
  const root = makeRepo(t, {
    "snapshot.config.mjs": 'export default { outDir: "out" };\n',
    "src/app.ts": "export const app = 1;\n",
  });

  const loaded = await loadConfigFileDetailed(root);
  assert.equal(loaded.errors.length, 0, loaded.errors.join("; "));
  const resolved = resolveConfig(loaded.config);
  assert.equal(
    resolved.cwd,
    path.resolve(root),
    "the config's own directory wins over the process's working directory"
  );
});

test("includeMonolith and artifacts.monolith cannot disagree", (t) => {
  // `normalizeResolvedConfig` re-derived `artifacts` from `config.artifacts` with `includeMonolith`
  // as the *default*, so a spread override left the two saying different things: `{...resolved,
  // includeMonolith: true}` produced a config with `includeMonolith: true` and
  // `artifacts.monolith: false`, and `generate` had nothing to say about which one was true.
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/app.ts": "export const app = 1;\n",
  });
  const config = resolveConfig({ ...base, cwd: root }, {}, root);
  assert.equal(config.artifacts.monolith, false, "the monolith is off by default");

  const viaFlag = normalizeResolvedConfig({ ...config, includeMonolith: true });
  assert.equal(viaFlag.includeMonolith, true);
  assert.equal(viaFlag.artifacts.monolith, true, "the flag wins over the recorded value");

  const viaArtifact = normalizeResolvedConfig({
    ...config,
    artifacts: { ...config.artifacts, monolith: true },
  });
  assert.equal(viaArtifact.artifacts.monolith, true);
  assert.equal(viaArtifact.includeMonolith, true, "and the reverse direction agrees too");

  // What the disagreement actually costs: the monolith is not written.
  const manifest = generateSnapshot({ ...config, includeMonolith: true });
  assert.ok(manifest.artifacts.fullMarkdown, "a config that asked for the monolith gets it");
});

test("the config digest does not depend on the order of budgets.byLayer keys", (t) => {
  // `JSON.stringify` preserves insertion order, so `{ docs, api }` and `{ api, docs }` hashed
  // differently — the same settings, a different digest, and `validate` reporting drift for a
  // snapshot nobody changed.
  const root = makeRepo(t, { "package.json": '{"name":"fixture","version":"1.0.0"}\n' });

  const one = resolveConfig(
    { ...base, cwd: root, budgets: { default: "100k", byLayer: { docs: "40k", api: "60k" } } },
    {},
    root
  );
  const other = resolveConfig(
    { ...base, cwd: root, budgets: { default: "100k", byLayer: { api: "60k", docs: "40k" } } },
    {},
    root
  );
  assert.deepEqual(one.budgets.byLayer, other.budgets.byLayer);
  assert.equal(configDigest(one), configDigest(other), "identical settings, identical digest");

  // And a real difference still moves it.
  const changed = resolveConfig(
    { ...base, cwd: root, budgets: { default: "100k", byLayer: { docs: "41k", api: "60k" } } },
    {},
    root
  );
  assert.notEqual(configDigest(one), configDigest(changed));
});
