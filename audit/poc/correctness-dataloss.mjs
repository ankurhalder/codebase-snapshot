// PoC: claim K - destructive, non-atomic write sequence (rmSync(outDir) before renameSync), EXDEV across volumes
// Run: node audit/poc/correctness-dataloss.mjs
import { generateSnapshot, resolveConfig } from "../../dist/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-loss-"));
const mkRepo = (name) => {
  const d = path.join(root, name);
  fs.mkdirSync(path.join(d, "src"), { recursive: true });
  fs.writeFileSync(path.join(d, "src", "a.ts"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(d, "README.md"), "# fixture\n", "utf8");
  return d;
};
const gen = (cwd, extra = {}) => generateSnapshot(resolveConfig({ cwd, ...extra }, { cwd }));

// ---------- K1: outDir "." => the repository itself is deleted ----------
console.log("=== K1: outDir '.' ===");
const k1 = mkRepo("k1");
console.log("  before:", fs.readdirSync(k1));
let k1err = "no error";
try {
  await gen(k1, { outDir: ".", tmpDir: ".snapshot-tmp" });
} catch (e) {
  k1err = `${e.code}: ${e.message}`;
}
console.log("  generate threw:", k1err);
console.log("  after:", fs.existsSync(k1) ? fs.readdirSync(k1) : "<fixture directory itself is GONE>");

// ---------- K2: tmpDir nested inside outDir ----------
console.log("\n=== K2: tmpDir nested inside outDir (outDir='out', tmpDir='out/.tmp') ===");
const k2 = mkRepo("k2");
fs.mkdirSync(path.join(k2, "out"), { recursive: true });
fs.writeFileSync(path.join(k2, "out", "manifest.json"), '{"previous":"snapshot"}', "utf8");
console.log("  previous snapshot present:", fs.existsSync(path.join(k2, "out", "manifest.json")), "| repo files:", fs.readdirSync(k2));
let k2err = "no error";
try {
  await gen(k2, { outDir: "out", tmpDir: "out/.tmp" });
} catch (e) {
  k2err = `${e.code}: ${e.message}`;
}
console.log("  generate threw:", k2err);
console.log("  previous snapshot still present:", fs.existsSync(path.join(k2, "out", "manifest.json")), "| out/ now:", fs.existsSync(path.join(k2, "out")) ? fs.readdirSync(path.join(k2, "out")) : "<gone>", "| snapshot.tmp:", fs.existsSync(path.join(k2, "out", ".tmp")));

// ---------- K3: EXDEV across volumes (outDir reached through a junction to D:) ----------
console.log("\n=== K3: outDir traverses a junction onto another volume (C: -> D:) ===");
const dRoot = fs.mkdtempSync("D:\\cs-exdev-");
const k3 = mkRepo("k3");
const junction = path.join(k3, "mnt");
fs.symlinkSync(dRoot, junction, "junction");
// a previous snapshot that already lives on D:
const prev = path.join(dRoot, "snapshot");
fs.mkdirSync(path.join(prev, "parts"), { recursive: true });
fs.writeFileSync(path.join(prev, "manifest.json"), '{"previous":"snapshot-on-D"}', "utf8");
console.log("  previous snapshot at D:", prev, "| manifest exists:", fs.existsSync(path.join(prev, "manifest.json")));
console.log("  resolved real path of outDir:", fs.realpathSync.native(dRoot));
let k3err = "no error";
try {
  await gen(k3, { outDir: "mnt/snapshot", tmpDir: "snapshot.tmp" });
} catch (e) {
  k3err = `${e.code}: ${e.message}`;
}
console.log("  generate threw:", k3err);
console.log("  previous manifest on D: still present:", fs.existsSync(path.join(prev, "manifest.json")));
console.log("  stray tmp dir left behind on C::", fs.existsSync(path.join(k3, "snapshot.tmp")), fs.existsSync(path.join(k3, "snapshot.tmp")) ? JSON.stringify(fs.readdirSync(path.join(k3, "snapshot.tmp"))) : "");
console.log("  fixture repo files:", fs.readdirSync(k3));

// ---------- K-extra: the primitive, bare ----------
const c = fs.mkdtempSync(path.join(os.tmpdir(), "cs-rename-c-"));
const d = fs.mkdtempSync("D:\\cs-rename-d-");
let prim;
try {
  fs.renameSync(c, d);
  prim = "renameSync succeeded";
} catch (e) {
  prim = `${e.code}: ${e.message}`;
}
console.log("\n  bare fs.renameSync(C:\\... -> D:\\...) =>", prim);

// ---------- cleanup ----------
for (const p of [c]) if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
try { fs.rmdirSync(junction); } catch {}
if (fs.existsSync(dRoot)) fs.rmSync(dRoot, { recursive: true, force: true });
if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log("\n  cleaned up. D: leftovers:", fs.readdirSync("D:\\").filter((n) => n.startsWith("cs-")));
