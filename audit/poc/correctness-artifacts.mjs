// PoC: claim M (dead anchors in navigation.md), N (fixed 3-backtick fence in monolith), R (empty repo)
// Run: node audit/poc/correctness-artifacts.mjs
import { generateSnapshot, resolveConfig } from "../../dist/index.js";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-artifacts-"));
const mkRepo = (name) => {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// ---------- M: navigation anchors ----------
console.log("=== M: reports/navigation.md anchors vs headings actually emitted in parts/*.md ===");
const repo = mkRepo("anchors");
fs.mkdirSync(path.join(repo, "src", "app"), { recursive: true });
fs.writeFileSync(path.join(repo, "src", "index.ts"), "export const a = 1;\n", "utf8");
fs.writeFileSync(path.join(repo, "src", "app", "route.ts"), "export function GET() {}\n", "utf8");
fs.writeFileSync(path.join(repo, "README.md"), "# hi\n", "utf8");
const cfg = resolveConfig({ cwd: repo, outDir: "snapshot", tmpDir: "snapshot.tmp" }, { cwd: repo });
const m = await generateSnapshot(cfg);
const nav = fs.readFileSync(path.join(repo, "snapshot", "reports", "navigation.md"), "utf8");
const linkAnchors = [...nav.matchAll(/\]\(\.\.\/parts\/([^)#]+)#([^)]+)\)/g)].map((x) => ({ part: x[1], anchor: x[2] }));
const partHeadings = [];
for (const p of m.parts) {
  const text = fs.readFileSync(path.join(repo, "snapshot", "parts", p.filename), "utf8");
  for (const line of text.split("\n")) {
    if (line.startsWith("### FILE: ")) partHeadings.push({ part: p.filename, heading: line.slice(4) });
  }
}
const ghSlug = (h) =>
  h
    .toLowerCase()
    .trim()
    .replace(/[^\w\- ]+/g, "")
    .replace(/ /g, "-");
console.log("  navigation links:", JSON.stringify(linkAnchors, null, 0));
console.log("  headings in parts:", JSON.stringify(partHeadings.map((h) => h.heading)));
console.log("  anchors that exist literally in any part file:", linkAnchors.filter((l) => {
  const t = fs.readFileSync(path.join(repo, "snapshot", "parts", l.part), "utf8");
  return t.includes(`{#${l.anchor}}`) || t.includes(`<a name="${l.anchor}"`) || t.toLowerCase().includes(`# ${l.anchor}`);
}).length);
console.log("  anchors matching the GitHub slug of an emitted heading:", linkAnchors.filter((l) => partHeadings.some((h) => ghSlug(h.heading) === l.anchor)).length, "of", linkAnchors.length);

// ---------- N: monolith fence injection ----------
console.log("\n=== N: monolith fixed 3-backtick fence vs chunker adaptive fence ===");
const repo2 = mkRepo("fence");
fs.writeFileSync(path.join(repo2, "README.md"), "Normal file\n", "utf8");
// a markdown file that legitimately contains a fenced code block
fs.writeFileSync(path.join(repo2, "docs.md"), ["# Docs", "", "```js", "const x = 1;", "```", "", "INJECTED HEADING: this text is now outside the fence"].join("\n"), "utf8");
const cfg2 = resolveConfig({ cwd: repo2, outDir: "snapshot", tmpDir: "snapshot.tmp", includeMonolith: true }, { cwd: repo2 });
const m2 = await generateSnapshot(cfg2);
const mono = fs.readFileSync(path.join(repo2, "snapshot", "full-codebase.md"), "utf8");
const docStart = mono.indexOf("## File: docs.md");
console.log("  monolith section for docs.md:");
console.log(mono.slice(docStart, docStart + 420).split("\n").map((l) => "    | " + l).join("\n"));
const fenceCount = mono.split("\n").filter((l) => l.startsWith("```")).length;
console.log(`  lines starting with \`\`\` in full-codebase.md: ${fenceCount} (2 files => expected ${2 * 2} if balanced)`);
const partText = m2.parts.map((p) => fs.readFileSync(path.join(repo2, "snapshot", "parts", p.filename), "utf8")).join("");
const fenceMatch = /(`{3,})markdown/.exec(partText);
console.log(`  chunker's fence for the same file: ${JSON.stringify(fenceMatch && fenceMatch[1])} (adaptive, > max backtick run in content)`);

// ---------- R: empty repo ----------
console.log("\n=== R: empty repo (no files at all) ===");
const empty = mkRepo("empty");
const git = (args, cwd) => cp.execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
git("init -q", empty);
const cfgE = resolveConfig({ cwd: empty, outDir: "snapshot", tmpDir: "snapshot.tmp", includeMonolith: true }, { cwd: empty });
const mE = await generateSnapshot(cfgE);
console.log("  counts:", JSON.stringify(mE.counts));
console.log("  totals:", JSON.stringify(mE.totals));
console.log("  parts:", JSON.stringify(mE.parts), "| files:", JSON.stringify(mE.files), "| git:", JSON.stringify(mE.git));
const readmeE = fs.readFileSync(path.join(empty, "snapshot", "README.md"), "utf8");
const navE = fs.readFileSync(path.join(empty, "snapshot", "reports", "navigation.md"), "utf8");
const auditE = fs.readFileSync(path.join(empty, "snapshot", "reports", "audit.md"), "utf8");
const treeE = fs.readFileSync(path.join(empty, "snapshot", "reports", "project-tree.md"), "utf8");
console.log("  any 'NaN'/'undefined'/'null' in README/audit/nav/tree:", /NaN|undefined/.test(readmeE + auditE + navE + treeE));
console.log("  README parts table rows:", readmeE.split("\n").filter((l) => l.startsWith("| [part-")).length);
console.log("  project-tree.md:", JSON.stringify(treeE));
console.log("  monolith artifacts:", JSON.stringify(mE.artifacts));
console.log("  validate on the empty snapshot:", JSON.stringify((await import("../../dist/index.js")).validateSnapshot(cfgE)));

// ---------- R2: every file skipped ----------
console.log("\n=== R2: repo whose only files are skipped (binary) ===");
const onlySkipped = mkRepo("onlyskipped");
fs.writeFileSync(path.join(onlySkipped, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
const cfgS = resolveConfig({ cwd: onlySkipped, outDir: "snapshot", tmpDir: "snapshot.tmp" }, { cwd: onlySkipped });
const mS = await generateSnapshot(cfgS);
console.log("  counts:", JSON.stringify(mS.counts), "totals:", JSON.stringify(mS.totals));
console.log("  skipped:", JSON.stringify(mS.skipped));

fs.rmSync(root, { recursive: true, force: true });
