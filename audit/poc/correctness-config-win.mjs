// PoC: claim G - loadConfigFile builds `file://${windowsPath}` and swallows every error
// Run: node audit/poc/correctness-config-win.mjs
import { loadConfigFile, resolveConfig, generateSnapshot } from "../../dist/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-config-"));
console.log("fixture root:", root, "| process.cwd():", process.cwd(), "\n");

const mk = (dir, files) => {
  const d = path.join(root, dir);
  fs.mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, name)), { recursive: true });
    fs.writeFileSync(path.join(d, name), body, "utf8");
  }
  return d;
};

const cases = [
  ["esm-js", { "snapshot.config.js": 'export default { outDir: "from-config" };\n', "package.json": '{"type":"module"}' }],
  ["cjs-js", { "snapshot.config.js": 'module.exports = { outDir: "from-config" };\n' }],
  ["mjs", { "snapshot.config.mjs": 'export default { outDir: "from-config" };\n' }],
  ["cjs", { "snapshot.config.cjs": 'module.exports = { outDir: "from-config" };\n' }],
  ["ts", { "snapshot.config.ts": 'const c = { outDir: "from-config" };\nexport default c;\n' }],
  ["json", { "snapshot.config.json": '{"outDir":"from-config"}' }],
];

for (const [label, files] of cases) {
  const dir = mk(label, files);
  const name = Object.keys(files).find((n) => n.startsWith("snapshot.config"));
  const fullPath = path.join(dir, name);
  const naive = `file://${fullPath}`;
  let importErr;
  try {
    const mod = await import(naive);
    importErr = `imported OK, default=${JSON.stringify(mod.default)}`;
  } catch (e) {
    importErr = `${e.code || e.name}: ${String(e.message).split("\n")[0]}`;
  }
  const loaded = await loadConfigFile(dir);
  console.log(`[${label}] ${name}`);
  console.log(`   import("${naive}")`);
  console.log(`      => ${importErr}`);
  console.log(`   loadConfigFile(dir) => ${loaded === null ? "null  <-- config IGNORED, no warning" : JSON.stringify(loaded)}`);
  console.log(`   resolveConfig(loaded).outDir => ${JSON.stringify(resolveConfig(loaded).outDir)}\n`);
}

// End-to-end (cwd passed explicitly, exactly like the CLI does with --cwd)
const e2e = mk("e2e", {
  "snapshot.config.ts": 'const config = { outDir: "from-config", maxPartBytes: 12345 };\nexport default config;\n',
  "src/a.ts": "export const a = 1;\n",
});
const loadedE2E = await loadConfigFile(e2e);
const cfgE2E = resolveConfig(loadedE2E, { cwd: e2e });
const m = await generateSnapshot(cfgE2E);
console.log("[end-to-end .ts config] requested outDir=from-config maxPartBytes=12345");
console.log(`   resolveConfig(loaded).cwd (no cliOptions) => ${resolveConfig(loadedE2E).cwd}   <-- process.cwd(), NOT the dir the config was loaded from`);
console.log(`   wrote to ${cfgE2E.outDir}: ${fs.existsSync(path.join(e2e, "from-config"))} | ./snapshot dir: ${fs.existsSync(path.join(e2e, "snapshot"))} | maxPartBytes=${m.budgets.maxPartBytes}`);

const e2eJson = mk("e2e-json", {
  "snapshot.config.json": '{"outDir":"json-out","maxPartBytes":12345}',
  "src/a.ts": "export const a = 1;\n",
});
const loadedJson = await loadConfigFile(e2eJson);
const cfgJson = resolveConfig(loadedJson, { cwd: e2eJson });
await generateSnapshot(cfgJson);
console.log(`[control .json config] wrote to json-out: ${fs.existsSync(path.join(e2eJson, "json-out"))} | maxPartBytes=${cfgJson.maxPartBytes}`);

// Residual: directory names containing URL metacharacters break the naive string-concat URL
console.log("\n[residual] naive `file://${path}` vs URL metacharacters in the path");
for (const dirName of ["hash#dir", "percent%41dir", "sp ace dir"]) {
  const naiveDir = path.join(root, dirName);
  fs.mkdirSync(naiveDir, { recursive: true });
  fs.writeFileSync(path.join(naiveDir, "snapshot.config.js"), 'export default { outDir: "from-config" };\n', "utf8");
  fs.writeFileSync(path.join(naiveDir, "package.json"), '{"type":"module"}', "utf8");
  const fullPath = path.join(naiveDir, "snapshot.config.js");
  let res;
  try {
    await import(`file://${fullPath}`);
    res = "imported OK";
  } catch (e) {
    res = `${e.code || e.name}: ${String(e.message).split("\n")[0]}`;
  }
  const viaUrl = await import(pathToFileURL(fullPath).href).then(() => "imported OK", (e) => `${e.code}: ${e.message.split("\n")[0]}`);
  const loaded = await loadConfigFile(naiveDir);
  console.log(`   dirName=${JSON.stringify(dirName)}`);
  console.log(`      naive file:// => ${res}`);
  console.log(`      pathToFileURL => ${viaUrl}`);
  console.log(`      loadConfigFile => ${loaded === null ? "null (silently ignored)" : JSON.stringify(loaded)}`);
}

fs.rmSync(root, { recursive: true, force: true });
