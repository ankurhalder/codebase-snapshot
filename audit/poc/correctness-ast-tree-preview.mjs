// PoC: claims O (tree localeCompare + unbounded), P (preview/line arithmetic), Q (ts-parser)
// Run: node audit/poc/correctness-ast-tree-preview.mjs
import { generateProjectTree, generateSnapshot, resolveConfig, summarizeTypeScriptSource, truncatePreview } from "../../dist/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-ast-"));
const mkRepo = (name) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (repo, rel, body) => { const p = path.join(repo, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body, "utf8"); };

// ---------------- O ----------------
console.log("=== O: tree.ts localeCompare determinism / unbounded size ===");
const names = ["zebra.ts", "Ärger.ts", "apple.ts", "Banana.ts", "a.ts", "Z.ts", "ä.ts", "b.ts"];
const tree = generateProjectTree(names);
console.log("  generateProjectTree order (machine default locale):");
console.log(tree.split("\n").slice(3, -2).map((l) => "    " + l).join("\n"));
const byCodeUnit = [...names].sort();
const byEn = [...names].sort(new Intl.Collator("en-US").compare);
const bySv = [...names].sort(new Intl.Collator("sv-SE").compare);
console.log("  code-unit sort      :", JSON.stringify(byCodeUnit));
console.log("  en-US collation     :", JSON.stringify(byEn));
console.log("  sv-SE collation     :", JSON.stringify(bySv));
console.log("  en-US === sv-SE ?", JSON.stringify(byEn) === JSON.stringify(bySv), "| tree === code-unit ?", tree.includes("apple.ts") && byCodeUnit.join() === byEn.join());
console.log("  (project-tree.md is not covered by any hash, so this only affects diff noise)");

const bigList = Array.from({ length: 20_000 }, (_, i) => `packages/pkg-${String(i % 200).padStart(3, "0")}/src/module-${i}.ts`);
const t0 = performance.now();
const bigTree = generateProjectTree(bigList);
const t1 = performance.now();
console.log(`  generateProjectTree(20000 paths) => ${(Buffer.byteLength(bigTree, "utf8") / 1024).toFixed(0)} KB in ${(t1 - t0).toFixed(0)} ms; no size cap (index.ts writes it twice: reports/ and root)`);
console.log("  name collision (file 'a' + dir 'a/b.ts'):", JSON.stringify(generateProjectTree(["a", "a/b.ts"]).split("\n").slice(3, -2)));

// ---------------- P ----------------
console.log("\n=== P: preview.ts / line arithmetic ===");
for (const [label, content] of [["empty", ""], ["two lines + trailing NL", "a\nb\n"], ["two lines, no trailing NL", "a\nb"], ["single newline", "\n"]]) {
  const total = content.split("\n").length;
  const small = truncatePreview(content, 80, 40);
  console.log(`  ${label.padEnd(26)} split().length=${total} truncatePreview.originalLines=${small.originalLines} includedLines=${small.includedLines} isTruncated=${small.isTruncated}`);
}
const lines400 = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n") + "\n";
const prev = truncatePreview(lines400, 80, 40);
const emitted = prev.content.split("\n").length;
console.log(`  400-line file: originalLines=${prev.originalLines} includedLines=${prev.includedLines} actual emitted line count=${emitted} marker="${prev.content.split("\n")[80]}"`);

const repoP = mkRepo("lines");
write(repoP, "src/two.ts", "export const a = 1;\nexport const b = 2;\n"); // really 2 lines
write(repoP, "src/empty.ts", "");
write(repoP, "src/onlynl.ts", "\n");
write(repoP, "src/nonl.ts", "const x = 1;");
const mP = await generateSnapshot(resolveConfig({ cwd: repoP, outDir: "snapshot", tmpDir: "snapshot.tmp" }, { cwd: repoP }));
console.log("  manifest lines (index.ts lineCount = content.split('\\n').length, 0 only when empty):");
for (const f of mP.files) console.log(`    ${f.relativePath.padEnd(14)} sizeBytes=${String(f.sizeBytes).padStart(3)} lines=${f.lines} originalLines=${f.originalLines} includedLines=${f.includedLines}`);
console.log(`  totals.totalLines=${mP.totals && mP.counts.totalLines}`);

// ---------------- Q ----------------
console.log("\n=== Q: ast/ts-parser.ts ===");
const repoQ = mkRepo("ast");
write(repoQ, "a.ts", [
  'import { x } from "./x";',
  'export * from "./star";',
  'export default function () { return 1; }',
  'function GET() { return 2; }',        // NOT exported
  'export function POST() { return 3; }',
  'const putHandler = 1;',
  'export const DELETE = () => 4;',
  'const PATCH = () => 5;',              // NOT exported
].join("\n"));
write(repoQ, "b.mts", 'import { y } from "./y";\nexport const z = 1;\n');
write(repoQ, "c.cts", 'import { w } from "./w";\nexport const q = 1;\n');
write(repoQ, "d.ts", 'import { v } from "./v";\nexport const r = 1;\n');
const mQ = await generateSnapshot(resolveConfig({ cwd: repoQ, outDir: "snapshot", tmpDir: "snapshot.tmp" }, { cwd: repoQ }));
for (const f of mQ.files) {
  const s = f.summary;
  console.log(`  ${f.relativePath.padEnd(8)} summary=${s === undefined ? "NONE" : JSON.stringify({ imports: s.imports, exports: s.exports, functions: s.functions, routeHandlers: s.routeHandlers, variables: s.variables })}`);
}

// setParentNodes cost
const src = fs.readFileSync(path.join(process.cwd(), "dist", "index.js"), "utf8").repeat(3); // ~160KB of dense JS
console.log(`  setParentNodes benchmark on ${(Buffer.byteLength(src) / 1024).toFixed(0)} KB of JS:`);
for (const setParentNodes of [false, true]) {
  const t = [];
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    ts.createSourceFile("bench.js", src, ts.ScriptTarget.Latest, setParentNodes, ts.ScriptKind.TS);
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  console.log(`    setParentNodes=${String(setParentNodes).padEnd(5)} median=${t[2].toFixed(1)} ms`);
}
const s2 = performance.now();
const tasksum = summarizeTypeScriptSource("bench.js", src);
console.log(`  summarizeTypeScriptSource on the same input: ${(performance.now() - s2).toFixed(1)} ms (imports:${tasksum.imports.length} functions:${tasksum.functions.length} exports:${tasksum.exports.length})`);

// pathological input (deeply nested expressions): does one file crash the whole snapshot?
console.log("  pathological input (deeply nested expressions):");
for (const depth of [1_000, 5_000, 10_000, 30_000]) {
  const deep = "export const x = " + "(".repeat(depth) + "1" + ")".repeat(depth) + ";\n";
  let parseOnly;
  try { ts.createSourceFile("deep.ts", deep, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); parseOnly = "parser ok"; } catch (e) { parseOnly = `parser THREW ${e.constructor.name}`; }
  let res;
  try {
    const s = performance.now();
    summarizeTypeScriptSource("deep.ts", deep);
    res = `ok in ${(performance.now() - s).toFixed(0)} ms`;
  } catch (e) {
    res = `THREW ${e.constructor.name}: ${e.message}`;
  }
  console.log(`    ${String(depth).padStart(6)} nested parens => ${res} (${parseOnly})`);
}
// long left-nested binary chain: the parser handles it iteratively, the walk in ts-parser.ts is recursive
for (const depth of [5_000, 20_000]) {
  const chain = "export const v = " + Array.from({ length: depth }, () => "a").join(" && ") + ";\n";
  let parseOnly;
  try { ts.createSourceFile("c.ts", chain, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS); parseOnly = "parser ok"; } catch (e) { parseOnly = `parser THREW ${e.constructor.name}`; }
  let res;
  try { summarizeTypeScriptSource("c.ts", chain); res = "ok"; } catch (e) { res = `THREW ${e.constructor.name}: ${e.message}`; }
  console.log(`    ${String(depth).padStart(6)} '&&' operands => ${res} (${parseOnly})`);
}
// and end-to-end: does generateSnapshot die on such a file?
const repoDeep = mkRepo("deep");
write(repoDeep, "bad.ts", "export const x = " + "(".repeat(30_000) + "1" + ")".repeat(30_000) + ";\n");
write(repoDeep, "good.ts", "export const y = 1;\n");
try {
  const md = await generateSnapshot(resolveConfig({ cwd: repoDeep, outDir: "snapshot", tmpDir: "snapshot.tmp" }, { cwd: repoDeep }));
  console.log("    generateSnapshot on a deeply-nested file: ok, files=", md.files.length);
} catch (e) {
  console.log(`    generateSnapshot on a deeply-nested file: THREW ${e.constructor.name}: ${e.message}`);
}
// other pathological shapes
for (const [label, body] of [
  ["unterminated template", "const s = `abc"],
  ["unterminated block comment", "/* abc"],
  ["nul char", "const a = 1;\u0000const b = 2;"],
  ["100k char single line", "const s = '" + "a".repeat(100_000) + "';"],
]) {
  let res;
  try { summarizeTypeScriptSource("p.ts", body); res = "ok"; } catch (e) { res = `THREW ${e.constructor.name}: ${e.message}`; }
  console.log(`    ${label.padEnd(28)} => ${res}`);
}

fs.rmSync(root, { recursive: true, force: true });
