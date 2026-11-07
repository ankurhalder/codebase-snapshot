import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { generateSnapshot, resolveConfig, runInit, validateSnapshot } from "../dist/index.js";

/**
 * 0.9.14 — the two places a *record* disagreed with reality.
 *
 * 4.1 — seven settings were recorded in the manifest and folded into the configuration digest, but
 * never joined the field-by-field comparison `validate` prints. A changed `--skeleton` produced
 * only the opaque "the settings differ from the ones this snapshot was generated with" line, so the
 * user was told that something had drifted and never which.
 *
 * 1.8 — `findConfigFile` reads `package.json` through `stripJsonComments`, which drops a UTF-8 BOM;
 * every *other* reader used bare `JSON.parse`, which throws on one. A Windows editor writes that
 * BOM, and the result was a project that reported no config, no `"type": "module"`, and no scripts
 * — while `generate` read the same file happily.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..");
const CLI = path.join(REPO_ROOT, "dist", "bin.js");

function makeRepo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "records-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const configFor = (dir, extra = {}) =>
  resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", ...extra }, {}, dir);

// ---------------------------------------------------------------------------
// 4.1 — configuration drift names the setting
// ---------------------------------------------------------------------------

test("validate names every setting that drifted, including the newer ones", (t) => {
  const dir = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/a.ts": "export function a(): number { return 1; }\n",
  });

  generateSnapshot(
    configFor(dir, {
      skeleton: true,
      sarif: true,
      maxPartTokens: 2000,
      withDependents: false,
    })
  );

  const report = validateSnapshot(
    configFor(dir, {
      skeleton: false,
      sarif: false,
      maxPartTokens: 4000,
    })
  );

  const text = report.drift.configMismatches.join("\n");
  for (const field of ["skeleton", "sarif", "maxPartTokens"]) {
    assert.match(text, new RegExp(`^${field}: manifest `, "m"), `${field} is named`);
  }
});

// ---------------------------------------------------------------------------
// 1.8 — a UTF-8 BOM in package.json
// ---------------------------------------------------------------------------

const BOM = "\uFEFF";

test("init reads a package.json that starts with a byte-order mark", async (t) => {
  const dir = makeRepo(t, {
    "package.json": `${BOM}${JSON.stringify(
      { name: "fixture", version: "1.0.0", type: "module" },
      null,
      2
    )}\n`,
    "src/a.ts": "export const a = 1;\n",
  });

  const result = await runInit({ cwd: dir, yes: true });

  assert.equal(
    result.configPath.endsWith("snapshot.config.ts"),
    true,
    `a "type": "module" project gets the .ts config, not ${result.configPath}`
  );
  assert.ok(result.scripts.includes("snapshot"), "the npm script is added");
  assert.equal(
    result.notes.some((note) => /could not parse package\.json/i.test(note)),
    false,
    "and nothing claims the file was unparseable"
  );

  const written = fs.readFileSync(path.join(dir, "package.json"), "utf8");
  assert.ok(written.startsWith(BOM), "the byte-order mark the file had is still there");
  const parsed = JSON.parse(written.replace(/^\uFEFF/, ""));
  assert.equal(parsed.scripts.snapshot, "npx codebase-snapshot generate");
  assert.ok(parsed.devDependencies["codebase-snapshot"], "and the devDependency is declared");
});

test("init notices an existing snapshot block behind a byte-order mark", async (t) => {
  const dir = makeRepo(t, {
    "package.json": `${BOM}${JSON.stringify(
      { name: "fixture", version: "1.0.0", snapshot: { outDir: "context" } },
      null,
      2
    )}\n`,
    "src/a.ts": "export const a = 1;\n",
  });

  // A config block in `package.json` takes precedence over a config file, so writing one would
  // silently change the effective settings of a repository that is already configured. `init`
  // refuses instead — which is only possible if it could read the block, and it could not read one
  // behind a byte-order mark.
  await assert.rejects(
    () => runInit({ cwd: dir, yes: true }),
    /already defines a "snapshot" config/,
    "the existing block is seen"
  );
  assert.equal(fs.existsSync(path.join(dir, "snapshot.config.mjs")), false, "and nothing is written");
});

test("the create shim finds the snapshot script behind a byte-order mark", (t) => {
  const dir = makeRepo(t, {
    "package.json": `${BOM}${JSON.stringify(
      {
        name: "fixture",
        version: "1.0.0",
        type: "module",
        scripts: { snapshot: "codebase-snapshot generate" },
      },
      null,
      2
    )}\n`,
    "src/a.ts": "export const a = 1;\n",
  });

  // The published layout, so the shim's bare import resolves.
  const nodeModules = path.join(dir, "node_modules");
  fs.mkdirSync(nodeModules, { recursive: true });
  try {
    fs.symlinkSync(REPO_ROOT, path.join(nodeModules, "codebase-snapshot"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("this host cannot create directory links");
    return;
  }
  const shim = path.join(dir, "create-shim.mjs");
  fs.copyFileSync(path.join(REPO_ROOT, "packages", "create", "index.mjs"), shim);

  const result = spawnSync(process.execPath, [shim, "--yes"], { cwd: dir, encoding: "utf8" });
  const output = `${result.stdout}${result.stderr}`;
  assert.match(
    output,
    /npm (?:install && )?npm run snapshot|npm install && npm run snapshot/,
    `the next step should be the project's own script\n${output}`
  );
  assert.doesNotMatch(output, /npx codebase-snapshot generate/, "not the published package");
});

test("the setup hint names the project's own script behind a byte-order mark", (t) => {
  const dir = makeRepo(t, {
    "package.json": `${BOM}${JSON.stringify(
      { name: "fixture", version: "1.0.0", scripts: { snapshot: "codebase-snapshot generate" } },
      null,
      2
    )}\n`,
    "src/a.ts": "export const a = 1;\n",
  });

  const result = spawnSync(process.execPath, [CLI, "setup", "--no-install"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /Next:\s+npm (?:install && )?npm run snapshot/, output);
});
