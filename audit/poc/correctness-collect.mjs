// PoC: claim I (git ls-files quoting/escaping) and J (walkDirectory drops symlinks)
// Run: node audit/poc/correctness-collect.mjs
import { generateSnapshot, resolveConfig } from "../../dist/index.js";
// collectFiles is not re-exported by dist/index.js; the same source module is importable directly under Node 24 type stripping.
import { collectFiles } from "../../src/scanner/files.ts";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-collect-"));
const git = (cwd, args) => cp.execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ---------------- I ----------------
const repo = path.join(root, "repo");
fs.mkdirSync(repo, { recursive: true });
git(repo, "init -q");
git(repo, 'config user.email "a@b.c"');
git(repo, 'config user.name "poc"');
git(repo, "config core.quotepath true"); // git default; irrelevant to the outcome, recorded for clarity

const names = [
  "src/ascii.ts",
  "src/caf\u00e9.ts",        // non-ASCII (very common)
  "src/\u65e5\u672c\u8a9e.ts", // CJK
  "src/with space.ts",
  "src/\u00fcmlaut-ok.ts",
];
for (const n of names) {
  const p = path.join(repo, n);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "export const x = 1;\n", "utf8");
}
git(repo, "add -A");
console.log("=== I: git ls-files quoting ===");
console.log("raw `git ls-files --cached --others --exclude-standard` output:");
const raw = cp.execSync("git ls-files --cached --others --exclude-standard", { cwd: repo, encoding: "utf8" });
console.log(JSON.stringify(raw));
console.log("with -z (NUL separated) headings would be byte-exact. collectFiles() output:");
const collected = collectFiles(repo, []);
for (const c of collected) {
  const exists = fs.existsSync(path.join(repo, c));
  console.log(`  ${JSON.stringify(c)} existsOnDisk=${exists}`);
}

const cfg = resolveConfig({ cwd: repo, outDir: "snapshot", tmpDir: "snapshot.tmp" }, { cwd: repo });
const m = await generateSnapshot(cfg);
console.log(`\n  manifest files: ${JSON.stringify(m.files.map((f) => f.relativePath))}`);
console.log(`  manifest skipped: ${JSON.stringify(m.skipped)}`);

// ---------------- J ----------------
console.log("\n=== J: walkDirectory (no .git => fallback path) skips symlinks ===");
const noGit = path.join(root, "nogit");
fs.mkdirSync(path.join(noGit, "real-dir"), { recursive: true });
fs.writeFileSync(path.join(noGit, "real-file.ts"), "export const a = 1;\n", "utf8");
fs.writeFileSync(path.join(noGit, "real-dir", "inner.ts"), "export const b = 2;\n", "utf8");
fs.writeFileSync(path.join(root, "outside-target.ts"), "export const outside = 3;\n", "utf8");
fs.mkdirSync(path.join(root, "outside-dir"), { recursive: true });
fs.writeFileSync(path.join(root, "outside-dir", "hidden.ts"), "export const hidden = 4;\n", "utf8");

let symlinkNote = "";
try {
  // file symlinks need SeCreateSymbolicLinkPrivilege on Windows; junctions do not.
  fs.symlinkSync(path.join(root, "outside-dir"), path.join(noGit, "link-dir"), "junction");
  symlinkNote = "junction created (link-dir -> ../outside-dir)";
} catch (e) {
  symlinkNote = `junction creation failed: ${e.code} ${e.message}`;
}
try {
  fs.symlinkSync(path.join(noGit, "real-file.ts"), path.join(noGit, "link-file.ts"), "file");
  symlinkNote += " ; file symlink created";
} catch (e) {
  symlinkNote += ` ; file symlink SKIPPED (${e.code}) - not permitted without admin/dev-mode`;
}
console.log(`  ${symlinkNote}`);
if (true) {
  console.log(`  entries physically present: ${fs.readdirSync(noGit).join(", ")}`);
  console.log(`  readdir types: ${fs.readdirSync(noGit, { withFileTypes: true }).map((d) => `${d.name}(isDir=${d.isDirectory()},isFile=${d.isFile()},isSymlink=${d.isSymbolicLink()})`).join(" | ")}`);
  console.log(`  files reachable through the junction, confirmed directly: ${JSON.stringify(fs.readdirSync(path.join(noGit, "link-dir")))}`);
  console.log(`  collectFiles(noGit) = ${JSON.stringify(collectFiles(noGit, []))}`);
  const mw = await generateSnapshot(resolveConfig({ cwd: noGit, outDir: "snapshot", tmpDir: "snapshot.tmp" }, { cwd: noGit }));
  console.log(`  manifest files = ${JSON.stringify(mw.files.map((f) => f.relativePath))} ; skipped = ${JSON.stringify(mw.skipped)}`);
}

fs.rmSync(root, { recursive: true, force: true });
