import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Tests for `packages/create` — the `npm create codebase-snapshot` shim.
 *
 * The shim imports the main package by name, which only resolves in a published
 * install. Each test therefore rebuilds that layout in a temp directory: a
 * `node_modules/@ankurhalder/codebase-snapshot` link to this checkout (whose
 * `dist/` the pretest step builds) plus a byte-identical copy of the shim's own
 * `index.mjs`/`package.json`, so the code under test is the shipped file.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..");
const SHIM_SOURCE = path.join(REPO_ROOT, "packages", "create");
const DEPENDENCY = "@ankurhalder/codebase-snapshot";

function temporaryDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-create-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Recreates the published layout so the shim's bare import resolves. */
function createHarness(t) {
  if (!fs.existsSync(path.join(REPO_ROOT, "dist", "index.js"))) {
    t.skip("dist/ is not built; the pretest step builds it");
    return null;
  }

  const dir = temporaryDirectory(t);
  const scope = path.join(dir, "node_modules", "@ankurhalder");
  fs.mkdirSync(scope, { recursive: true });
  try {
    fs.symlinkSync(
      REPO_ROOT,
      path.join(scope, "codebase-snapshot"),
      process.platform === "win32" ? "junction" : "dir"
    );
  } catch {
    t.skip("this host cannot create directory links");
    return null;
  }

  const shim = path.join(dir, "create");
  fs.mkdirSync(shim, { recursive: true });
  for (const name of ["index.mjs", "package.json"]) {
    fs.copyFileSync(path.join(SHIM_SOURCE, name), path.join(shim, name));
  }
  return { dir, shim: path.join(shim, "index.mjs") };
}

function writeProject(dir, extra = {}) {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "1.0.0", ...extra }, null, 2)}\n`
  );
}

function runShim(shim, cwd, args = ["--yes"], env = {}) {
  const result = spawnSync(process.execPath, [shim, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function declaredRange() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SHIM_SOURCE, "package.json"), "utf8"));
  return manifest.dependencies[DEPENDENCY];
}

test("C-3: a directory without package.json prints a runnable next step", (t) => {
  const harness = createHarness(t);
  if (!harness) return;

  const target = path.join(harness.dir, "no-package-json");
  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  fs.writeFileSync(path.join(target, "src", "a.ts"), "export const a = 1;\n");

  const run = runShim(harness.shim, target);

  assert.equal(run.code, 0, run.stderr);
  // The regression: the old text promised `npm run snapshot` although no scripts
  // could be added, so the documented next step failed with ENOENT.
  assert.match(run.stderr, /Next:\s+npx @ankurhalder\/codebase-snapshot generate/);
  assert.equal(
    run.stderr.includes("npm run snapshot"),
    false,
    "must not promise an npm script that was never added"
  );
  assert.equal(fs.existsSync(path.join(target, "package.json")), false);
  assert.ok(fs.existsSync(path.join(target, "snapshot.config.mjs")));
});

test("C-2: the dependency is recorded at the shim's own version", (t) => {
  const harness = createHarness(t);
  if (!harness) return;

  const target = path.join(harness.dir, "esm");
  writeProject(target, { type: "module" });

  const run = runShim(harness.shim, target);

  assert.equal(run.code, 0, run.stderr);
  const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
  assert.equal(pkg.devDependencies?.[DEPENDENCY], declaredRange());
  assert.match(run.stderr, /Added devDependency: @ankurhalder\/codebase-snapshot/);
  // Without a local install, `npx` would download @latest: say so instead of
  // pretending the script is ready.
  assert.match(run.stderr, /Next:\s+npm install && npm run snapshot/);
  // The wizard's scripts still go through npx, which prefers the local copy.
  assert.match(pkg.scripts.snapshot, /npx @ankurhalder\/codebase-snapshot generate/);
});

test("C-2: an existing dependency declaration is left untouched", (t) => {
  const harness = createHarness(t);
  if (!harness) return;

  const target = path.join(harness.dir, "already-declared");
  writeProject(target, { devDependencies: { [DEPENDENCY]: "4.0.0" } });

  const run = runShim(harness.shim, target);

  assert.equal(run.code, 0, run.stderr);
  const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
  assert.equal(pkg.devDependencies[DEPENDENCY], "4.0.0", "never overwrite a user's pin");
  assert.equal(run.stderr.includes("Added devDependency"), false);
});

test("C-2: the shim's rewrite keeps the file's indentation", (t) => {
  const harness = createHarness(t);
  if (!harness) return;

  // Both scripts already exist, so the wizard leaves package.json alone and the
  // shim's own write is the only one — the case where formatting can be checked.
  const target = path.join(harness.dir, "four-space");
  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  fs.writeFileSync(path.join(target, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(
    path.join(target, "package.json"),
    `${JSON.stringify(
      {
        name: "four",
        version: "1.0.0",
        scripts: {
          snapshot: "npx @ankurhalder/codebase-snapshot generate",
          "snapshot:validate": "npx @ankurhalder/codebase-snapshot validate",
        },
      },
      null,
      4
    )}\n`
  );

  const run = runShim(harness.shim, target);

  assert.equal(run.code, 0, run.stderr);
  const raw = fs.readFileSync(path.join(target, "package.json"), "utf8");
  assert.match(raw, /^ {4}"name": "four",/m, "4-space indentation must survive the rewrite");
  assert.ok(raw.endsWith("\n"));
  assert.equal(JSON.parse(raw).devDependencies[DEPENDENCY], declaredRange());
  // A pre-existing script is runnable, so the hint must offer it.
  assert.match(run.stderr, /Next:\s+npm (?:install && npm )?run snapshot/);
});

test("C-2: scaffolding works with the network unavailable", (t) => {
  const harness = createHarness(t);
  if (!harness) return;

  const target = path.join(harness.dir, "offline");
  writeProject(target);

  const run = runShim(harness.shim, target, ["--yes"], {
    NPM_CONFIG_OFFLINE: "true",
    npm_config_offline: "true",
    // A registry that cannot answer: any fetch attempt would hang or fail.
    npm_config_registry: "http://127.0.0.1:9/",
  });

  assert.equal(run.code, 0, run.stderr);
  assert.equal(
    fs.existsSync(path.join(target, "node_modules")),
    false,
    "scaffolding must not install anything"
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"));
  assert.equal(pkg.devDependencies[DEPENDENCY], declaredRange());
});

test("C-2: with the package already installed the hint is the plain script", (t) => {
  const harness = createHarness(t);
  if (!harness) return;

  const target = path.join(harness.dir, "installed");
  writeProject(target);
  const binName = process.platform === "win32" ? "codebase-snapshot.cmd" : "codebase-snapshot";
  fs.mkdirSync(path.join(target, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(path.join(target, "node_modules", ".bin", binName), "");

  const run = runShim(harness.shim, target);

  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /Next:\s+npm run snapshot/);
});

test("C-4: the README names the config file that is actually written", (t) => {
  const harness = createHarness(t);
  if (!harness) return;

  const target = path.join(harness.dir, "config-name");
  writeProject(target, { type: "module" });

  const run = runShim(harness.shim, target);

  assert.equal(run.code, 0, run.stderr);

  const wroteTs = fs.existsSync(path.join(target, "snapshot.config.ts"));
  const wroteMjs = fs.existsSync(path.join(target, "snapshot.config.mjs"));
  assert.equal(wroteTs !== wroteMjs, true, "exactly one config file must be written");

  const written = wroteTs ? "snapshot.config.ts" : "snapshot.config.mjs";
  const readme = fs.readFileSync(path.join(SHIM_SOURCE, "README.md"), "utf8");

  assert.ok(readme.includes(written), `the README must name ${written}`);
  assert.ok(run.stderr.includes(written), "the printed config path must match it");
  // It documents both variants rather than claiming one fixed name.
  assert.match(readme, /snapshot\.config\.ts/);
  assert.match(readme, /snapshot\.config\.mjs/);
});
