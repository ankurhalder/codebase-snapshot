// PoC: claim L - validateSnapshot: no schema check (crash), ignores parts/budgets/git, permanent skip set
// Run: node audit/poc/correctness-validate.mjs
import { generateSnapshot, resolveConfig, validateSnapshot } from "../../dist/index.js";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-validate-"));
const repo = path.join(root, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(repo, "src/a.ts"), "export const a = 1;\n", "utf8");
fs.writeFileSync(path.join(repo, "src/b.ts"), "export const b = 2;\n", "utf8");
fs.writeFileSync(path.join(repo, "src/binaryish.dat"), Buffer.from([0x41, 0x00, 0x42]), "binary");
const git = (args) => cp.execSync(`git ${args}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
git("init -q"); git("config user.email a@b.c"); git("config user.name poc"); git("add -A"); git('commit -qm init');

const cfg = resolveConfig({ cwd: repo, outDir: "snapshot", tmpDir: "snapshot.tmp" }, { cwd: repo });
await generateSnapshot(cfg);
const manifestPath = path.join(repo, "snapshot", "manifest.json");
const readManifest = () => JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const writeManifest = (m) => fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2), "utf8");

console.log("=== L0: baseline ===");
console.log("  validate:", JSON.stringify(validateSnapshot(cfg).valid));

console.log("\n=== L1: manifest missing `files` / `skipped` (no schema check) ===");
for (const variant of [{ skipped: [] }, { files: [] }]) {
  const m = readManifest();
  delete m.files; delete m.skipped;
  Object.assign(m, variant); // keep only one of the two keys
  writeManifest(m);
  let out;
  try {
    out = JSON.stringify(validateSnapshot(cfg));
  } catch (e) {
    out = `THREW ${e.constructor.name}: ${e.message}`;
  }
  console.log(`  manifest keys=[${Object.keys(m).join(",")}] => ${out}`);
}

console.log("\n=== L2: parts/*.md are never checked ===");
await generateSnapshot(cfg); // restore a good manifest
const partsDir = path.join(repo, "snapshot", "parts");
const parts = fs.readdirSync(partsDir);
const snapshotGood = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
fs.rmSync(path.join(partsDir, parts[0]));
console.log(`  deleted ${parts[0]}: validate => ${JSON.stringify({ valid: validateSnapshot(cfg).valid })}`);
fs.writeFileSync(path.join(partsDir, parts[0]), "# TAMPERED: file contents replaced\n", "utf8");
console.log(`  replaced ${parts[0]} with garbage: validate => ${JSON.stringify({ valid: validateSnapshot(cfg).valid })}`);
writeManifest(snapshotGood);
fs.writeFileSync(path.join(partsDir, parts[0]), "# restored\n", "utf8");
console.log("  (manifest restored) baseline valid=", validateSnapshot(cfg).valid);

console.log("\n=== L3: budget / config changes are ignored ===");
for (const budgets of [{ maxPartBytes: 1000 }, { largeFileBytes: 1 }]) {
  const c2 = resolveConfig({ cwd: repo, outDir: "snapshot", tmpDir: "snapshot.tmp", ...budgets }, { cwd: repo });
  console.log(`  validate with ${JSON.stringify(budgets)} => valid=${validateSnapshot(c2).valid} (manifest.budgets says maxPartBytes=${readManifest().budgets.maxPartBytes})`);
}

console.log("\n=== L4: validate ignores budget numbers recorded in the manifest ===");
const m4 = readManifest();
m4.budgets.maxPartBytes = 1;
m4.budgets.largeFileBytes = 1;
writeManifest(m4);
console.log("  manifest.budgets tampered to 1/1 => valid=", validateSnapshot(cfg).valid);
writeManifest(snapshotGood);

console.log("\n=== L5: git state is ignored ===");
git("checkout -qb feature-branch");
console.log("  branch now:", cp.execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo, encoding: "utf8" }).trim(), "=> validate valid=", validateSnapshot(cfg).valid, "| manifest.git.branch=", readManifest().git.branch);
git("checkout -q -"); // back
git("commit -q --allow-empty -m drift");
console.log("  new commit reached => validate valid=", validateSnapshot(cfg).valid, "| manifest.git.commit=", readManifest().git.commit.slice(0, 8));

console.log("\n=== L6: totals are not verified ===");
const m6 = readManifest();
m6.totals.totalContentBytes = 1; m6.totals.fullFiles = 999; m6.counts.totalFiles = 999; m6.validation.status = "passed";
writeManifest(m6);
console.log("  tampered totals/counts => valid=", validateSnapshot(cfg).valid);

console.log("\n=== L7: a path in manifest.skipped is excluded forever ===");
fs.writeFileSync(path.join(repo, "src/binaryish.dat"), "now plain text, no NUL bytes\n", "utf8");
const v7 = validateSnapshot(cfg);
console.log("  binaryish.dat is now valid text; manifest.skipped =", JSON.stringify(readManifest().skipped.map((s) => s.path)));
console.log("  validate =>", JSON.stringify({ valid: v7.valid, missingInSnapshot: v7.drift.missingInSnapshot }));
console.log("  and generate again double-counts it? files=", (await generateSnapshot(cfg)).files.map((f) => f.relativePath).join(","));

console.log("\n=== L8: validate re-derives the file list from the CURRENT config ===");
const cfgExcl = resolveConfig({ cwd: repo, outDir: "snapshot", tmpDir: "snapshot.tmp", excludePatterns: ["src/"] }, { cwd: repo });
await generateSnapshot(cfgExcl);
const mExcl = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
console.log("  snapshot generated with excludePatterns=['src/'] => manifest.files=", JSON.stringify(mExcl.files.map((f) => f.relativePath)));
const cfgNoExcl = resolveConfig({ cwd: repo, outDir: "snapshot", tmpDir: "snapshot.tmp" }, { cwd: repo });
const vExcl = validateSnapshot(cfgNoExcl);
console.log("  validate with the default (no excludes) =>", JSON.stringify({ valid: vExcl.valid, missingInSnapshot: vExcl.drift.missingInSnapshot }));
console.log("  validate with an exclude the snapshot never knew about =>", JSON.stringify({ valid: validateSnapshot(cfgExcl).valid }));

fs.rmSync(root, { recursive: true, force: true });
