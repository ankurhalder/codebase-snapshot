// A6 (03 §5 ranked #6, MEDIUM) — no prepare/prepack, so `npm pack` or a git
// install from a fresh clone shipped no dist/ at all.
// A7 (ranked #7, MEDIUM) — exports["./cli"] had no require condition and no
// types; exports["./package.json"] was missing.
// A10 (ranked #10, LOW) — missing sideEffects, dead index.d.cts, sourcemaps.
// A8 (ranked #8, MEDIUM) — the suite imported ../dist/index.js, so a clean
// checkout had nothing to test.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { REPO, assert, assertEqual, check, finish, selfTest, tmp } from "./v-lib.mjs";

selfTest();

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

check("A6.scripts", "prepare (or prepack) exists and builds dist", () => {
  const script = pkg.scripts?.prepare ?? pkg.scripts?.prepack;
  assert(script, `no prepare/prepack: ${JSON.stringify(pkg.scripts)}`);
  assert(/build/.test(script), `prepare does not build: ${script}`);
  return `scripts.prepare = ${script}`;
});

check("A7.exports", "exports[./cli] has import+require with per-condition types", () => {
  const cli = pkg.exports?.["./cli"];
  assert(cli, "exports[./cli] missing");
  for (const condition of ["import", "require"]) {
    assert(cli[condition], `missing ${condition} condition`);
    assert(cli[condition].types, `missing ${condition} types`);
    assert(cli[condition].default, `missing ${condition} default`);
    assert(
      fs.existsSync(path.join(REPO, cli[condition].default)),
      `${condition}.default does not exist: ${cli[condition].default}`
    );
    assert(
      fs.existsSync(path.join(REPO, cli[condition].types)),
      `${condition}.types does not exist: ${cli[condition].types}`
    );
  }
  const root = pkg.exports?.["."];
  assert(root?.require?.types, "root require.types missing");
  assert(fs.existsSync(path.join(REPO, root.require.types)), "root require.types file missing (dead index.d.cts)");
  return "./cli: import+require+types, root require.types present";
});

check("A10.package-json-export", "exports[./package.json] and sideEffects are present", () => {
  assertEqual(pkg.exports?.["./package.json"], "./package.json", "exports[./package.json]");
  assertEqual(pkg.sideEffects, false, "sideEffects");
  return "present";
});

check("A10.no-sourcemaps", "the published file list excludes .map files", () => {
  const files = pkg.files ?? [];
  assert(!files.some((pattern) => pattern.includes(".map")), `files: ${files.join(",")}`);
  assert(files.some((pattern) => pattern.startsWith("dist/")), "dist not published");
  return files.join(",");
});

// -----------------------------------------------------------------------------
// Fresh-copy gates: copy the source tree WITHOUT dist, junction node_modules, then
// run the real `npm pack` (which runs prepare -> build) and `npm test`.
const copy = tmp("a6");
for (const entry of ["package.json", "package-lock.json", "tsconfig.json", "tsup.config.ts", "README.md", "LICENSE"]) {
  const source = path.join(REPO, entry);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(copy, entry));
}
fs.cpSync(path.join(REPO, "src"), path.join(copy, "src"), { recursive: true });
fs.cpSync(path.join(REPO, "tests"), path.join(copy, "tests"), { recursive: true });
execFileSync("cmd", ["/c", "mklink", "/J", path.join(copy, "node_modules"), path.join(REPO, "node_modules")], {
  stdio: "ignore",
});

check("A6.clean-copy", "the fresh copy really has no dist/", () => {
  assert(!fs.existsSync(path.join(copy, "dist")), "dist exists in the copy");
  return "no dist";
});

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const npm = (args) =>
  spawnSync(npmCmd, args, { cwd: copy, encoding: "utf8", timeout: 300_000, shell: process.platform === "win32" });

check("A6.pack-fresh", "npm pack in a fresh clone builds dist and ships it", () => {
  // `npm pack --json` is polluted by the prepare/build output on stdout, so pack a
  // real tarball and list its contents instead.
  const packed = npm(["pack"]);
  assertEqual(packed.status, 0, `npm pack exit ${packed.status}: ${(packed.stderr || "").slice(-600)}`);
  const tarball = (packed.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz"))
    .pop();
  assert(tarball, `could not find the tarball name in: ${(packed.stdout || "").slice(-300)}`);
  const tarPath = path.join(copy, tarball);
  assert(fs.existsSync(tarPath), `tarball missing: ${tarPath}`);
  const listing = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8" });
  const files = listing
    .split("\n")
    .map((line) => line.trim().replace(/^package\//, ""))
    .filter((line) => line.length > 0 && !line.endsWith("/"));
  const required = [
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
    "dist/index.d.cts",
    "dist/cli.js",
    "dist/cli.cjs",
    "dist/cli.d.ts",
    "dist/cli.d.cts",
    "dist/bin.js",
    "README.md",
    "LICENSE",
    "package.json",
  ];
  const missing = required.filter((file) => !files.includes(file));
  assertEqual(missing.length, 0, `missing from the tarball: ${missing.join(", ")}`);
  const maps = files.filter((file) => file.endsWith(".map"));
  assertEqual(maps.length, 0, `sourcemaps shipped: ${maps.slice(0, 3).join(", ")}`);
  return `${tarball}: ${files.length} files, all entry points present, 0 maps`;
});

check("A8.npm-test-clean", "npm test passes from a clean checkout (pretest builds first)", () => {
  fs.rmSync(path.join(copy, "dist"), { recursive: true, force: true });
  assert(!fs.existsSync(path.join(copy, "dist")), "dist should be gone");
  const result = npm(["test"]);
  const output = `${result.stdout}\n${result.stderr}`;
  assertEqual(result.status, 0, `npm test exit ${result.status}: ${output.slice(-800)}`);
  const passMatch = output.match(/(?:#|ℹ)\s*pass (\d+)/);
  const failMatch = output.match(/(?:#|ℹ)\s*fail (\d+)/);
  assert(passMatch, `could not read the test summary: ${output.slice(-400)}`);
  assertEqual(Number(failMatch?.[1] ?? "0"), 0, "failing tests");
  assert(fs.existsSync(path.join(copy, "dist/index.js")), "pretest did not build dist");
  return `${passMatch[1]} tests passed from a dist-less checkout`;
});

check("A8.imports", "the suite still imports the built package (mitigated by pretest)", () => {
  const units = fs.readFileSync(path.join(REPO, "tests/units.test.js"), "utf8");
  const integration = fs.readFileSync(path.join(REPO, "tests/integration.test.js"), "utf8");
  const importer = (text) => (/from "\.\.\/dist\/index\.js"/.test(text) ? "dist" : /from "\.\.\/src\//.test(text) ? "src" : "unknown");
  return `units->${importer(units)}, integration->${importer(integration)} (pretest rebuilds dist)`;
});

// -----------------------------------------------------------------------------
check("A7.real-require", "require() and import() of ./cli and ./package.json work through the exports map", () => {
  const consumer = tmp("a7");
  fs.mkdirSync(path.join(consumer, "node_modules", "@ankurhalder"), { recursive: true });
  execFileSync(
    "cmd",
    ["/c", "mklink", "/J", path.join(consumer, "node_modules", "@ankurhalder", "codebase-snapshot"), REPO],
    { stdio: "ignore" }
  );
  fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", type: "module" }));
  const cjs = spawnSync(
    process.execPath,
    ["-e", "const c=require('@ankurhalder/codebase-snapshot/cli');const p=require('@ankurhalder/codebase-snapshot/package.json');console.log(typeof c.main, p.version)"],
    { cwd: consumer, encoding: "utf8" }
  );
  assertEqual(cjs.status, 0, `require failed: ${cjs.stderr.slice(0, 300)}`);
  assertEqual(cjs.stdout.trim(), "function 2.0.0", `require output: ${cjs.stdout.trim()}`);
  const esm = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "const c=await import('@ankurhalder/codebase-snapshot/cli');const p=await import('@ankurhalder/codebase-snapshot/package.json',{with:{type:'json'}});console.log(typeof c.main, p.default.version)"],
    { cwd: consumer, encoding: "utf8" }
  );
  assertEqual(esm.status, 0, `import failed: ${esm.stderr.slice(0, 300)}`);
  return `cjs: ${cjs.stdout.trim()} | esm: ${esm.stdout.trim()}`;
});

finish();
