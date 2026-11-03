// api-exports.mjs - package entry-point / exports-map probes (each probe really resolves)
import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";

const pkgRoot = path.resolve(".");
const consumer = path.join(pkgRoot, "audit", "poc", "api-consumer");
fs.mkdirSync(path.join(consumer, "node_modules", "@ankurhalder"), { recursive: true });
const link = path.join(consumer, "node_modules", "@ankurhalder", "codebase-snapshot");
if (!fs.existsSync(link)) fs.symlinkSync(pkgRoot, link, "junction");
const name = "@ankurhalder/codebase-snapshot";
const cjsRequire = createRequire(path.join(consumer, "probe.cjs"));

const results = [];
async function t(kind, label, fn) {
  try { const v = await fn(); results.push(`  [${kind}] ${label.padEnd(38)} OK    ${String(v).replaceAll(pkgRoot, "<pkg>")}`); }
  catch (e) { results.push(`  [${kind}] ${label.padEnd(38)} FAIL  ${e.code || e.constructor.name}`); }
}

// --- ESM (self-reference from inside the package)
await t("esm", `import("${name}")`, async () => (await import(name)) && "module loaded");
await t("esm", `import("${name}/cli")`, async () => (await import(`${name}/cli`)) && "module loaded");
await t("esm", `import("${name}/package.json")`, async () => (await import(`${name}/package.json`)).default.name);
await t("esm", `import("${name}/dist/index.js")`, async () => (await import(`${name}/dist/index.js`)) && "loaded");

// --- CJS (from the consumer package location)
await t("cjs", `require("${name}")`, () => Object.keys(cjsRequire(name)).length + " exports");
await t("cjs", `require("${name}/package.json")`, () => cjsRequire(`${name}/package.json`).name);
await t("cjs", `require("${name}/cli")`, () => Object.keys(cjsRequire(`${name}/cli`)).length + " exports");
await t("cjs", `require("${name}/dist/index.cjs")`, () => Object.keys(cjsRequire(`${name}/dist/index.cjs`)).length + " exports");
await t("cjs", `require.resolve("${name}")`, () => cjsRequire.resolve(name));

console.log("=== exports map, as a consumer sees it ===");
for (const r of results) console.log(r);
console.log("  runtime export count (ESM):", Object.keys(await import(name)).length);
console.log("  runtime export names      :", Object.keys(await import(name)).sort().join(", "));

const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
console.log("\n=== package.json metadata gaps ===");
console.log("  exports['./cli'] keys      :", Object.keys(pkg.exports["./cli"]).join(","), "-> require condition?", pkg.exports["./cli"].require ? "yes" : "NO");
console.log("  exports['./cli'].types     :", pkg.exports["./cli"].types ?? "MISSING");
console.log("  exports['./package.json']  :", pkg.exports["./package.json"] ? "present" : "MISSING");
console.log("  sideEffects                :", pkg.sideEffects === undefined ? "MISSING (bundlers must assume side effects)" : JSON.stringify(pkg.sideEffects));
console.log("  dist/index.d.cts referenced:", /d\.cts/.test(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")) ? "yes" : "NO - dead file");
console.log("  d.ts === d.cts             :", fs.readFileSync(path.join(pkgRoot, "dist", "index.d.ts"), "utf8") === fs.readFileSync(path.join(pkgRoot, "dist", "index.d.cts"), "utf8"));
console.log("  prepare/prepack script     :", pkg.scripts.prepare ?? pkg.scripts.prepack ?? "MISSING (npm pack / git-install will ship no dist)");
console.log("  dependencies               :", JSON.stringify(pkg.dependencies));
console.log("  files                      :", JSON.stringify(pkg.files));
