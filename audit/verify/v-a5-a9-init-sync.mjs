// A5 (03 §6 ranked #5, MEDIUM) — `init` wrote snapshot.config.ts, unloadable on
// the advertised Node >= 18 engines, and every config error was swallowed.
// A9 (03 §7 ranked #9) — generateSnapshot was `async` but fully blocking.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateSnapshot, generateSnapshotAsync, resolveConfig } from "../../dist/index.js";
import { BIN, REPO, assert, assertEqual, assertIncludes, check, checkAsync, finish, selfTest, tmp, write } from "./v-lib.mjs";

selfTest();

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 120_000 });

check("A5.init", "init writes a config this Node can load, and generate then uses it", () => {
  const dir = tmp("a5");
  write(dir, "src/a.ts", "export const a = 1;\n");
  // The generated config imports the package by name, exactly as a real consumer
  // would, so make the package resolvable from the fixture.
  fs.mkdirSync(path.join(dir, "node_modules", "@ankurhalder"), { recursive: true });
  execFileSync(
    "cmd",
    ["/c", "mklink", "/J", path.join(dir, "node_modules", "@ankurhalder", "codebase-snapshot"), REPO],
    { stdio: "ignore" }
  );
  const init = run(["init", `--cwd=${dir}`]);
  assertEqual(init.status, 0, `init exit ${init.status}: ${init.stderr.slice(0, 200)}`);
  const configs = fs.readdirSync(dir).filter((name) => name.startsWith("snapshot.config."));
  assertEqual(configs.length, 1, `config files: ${configs.join(",")}`);
  const gen = run(["generate", `--cwd=${dir}`, "--format=json"]);
  assertEqual(gen.status, 0, `generate exit ${gen.status}: ${gen.stderr.slice(0, 300)}`);
  assert(/Using config .*snapshot\.config\.ts/.test(gen.stderr), `the written config was not picked up (stderr: ${gen.stderr.slice(0, 300)})`);
  const manifest = JSON.parse(gen.stdout);
  assertEqual(manifest.config.maxPartBytes, 307200, "config value not honoured");
  return `${configs[0]} written and loaded`;
});

check("A5.init-twice", "init refuses to overwrite an existing config", () => {
  const dir = tmp("a5b");
  run(["init", `--cwd=${dir}`]);
  const second = run(["init", `--cwd=${dir}`]);
  assertEqual(second.status, 1, `exit ${second.status}`);
  assertIncludes(second.stderr, "already exists", "stderr");
  return "exit 1, no overwrite";
});

check("A5.config-format", "the generated config is a real module with defineConfig()", () => {
  const dir = tmp("a5c");
  run(["init", `--cwd=${dir}`]);
  const name = fs.readdirSync(dir).find((entry) => entry.startsWith("snapshot.config."));
  const body = fs.readFileSync(path.join(dir, name), "utf8");
  assertIncludes(body, "defineConfig", "config body");
  assertIncludes(body, "@ankurhalder/codebase-snapshot", "config import");
  return `${name}: ${body.split("\n")[0]}`;
});

// ------------------------------------------------------------------ A9
check("A9.sync", "generateSnapshot returns a Manifest, not a Promise", () => {
  const dir = tmp("a9");
  write(dir, "src/a.ts", "export const a = 1;\n");
  const config = resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" });
  const result = generateSnapshot(config);
  assertEqual(typeof result?.then, "undefined", "generateSnapshot still returns a thenable");
  assertEqual(result.schemaVersion, "3.0.0", "schemaVersion");
  assert(typeof result.counts.totalFiles === "number", "no manifest shape");
  return "synchronous Manifest";
});

await checkAsync("A9.await-still-works", "await generateSnapshot(...) keeps working at old call sites", async () => {
  const dir = tmp("a9b");
  write(dir, "src/a.ts", "export const a = 1;\n");
  const result = await generateSnapshot(
    resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }),
    { dryRun: true }
  );
  assertEqual(result.schemaVersion, "3.0.0", "schemaVersion");
  return "awaited Manifest";
});

await checkAsync("A9.async-wrapper", "generateSnapshotAsync returns a real Promise", async () => {
  const dir = tmp("a9c");
  write(dir, "src/a.ts", "export const a = 1;\n");
  const pending = generateSnapshotAsync(
    resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }),
    { dryRun: true }
  );
  assertEqual(typeof pending?.then, "function", "not a Promise");
  const result = await pending;
  assertEqual(result.schemaVersion, "3.0.0", "schemaVersion");
  return "Promise<Manifest>";
});

finish();


