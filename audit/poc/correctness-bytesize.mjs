// PoC: claims A (self-referential byteSize) and B (maxPartBytes not enforced)
// Run: node audit/poc/correctness-bytesize.mjs
import { partitionFiles, generateSnapshot } from "../../dist/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const entry = (relPath, content) => ({
  path: relPath,
  relativePath: relPath,
  sizeBytes: Buffer.byteLength(content, "utf8"),
  bytes: Buffer.byteLength(content, "utf8"),
  lines: content.split("\n").length,
  hashSha256: crypto.createHash("sha256").update(content).digest("hex"),
  sha256: "",
  part: "",
  layer: "src",
  kind: "other",
  language: "ts",
  inclusionMode: "full",
  isLarge: false,
  isPreviewTruncated: false,
  originalLines: content.split("\n").length,
  includedLines: content.split("\n").length,
  summary: undefined,
  content,
});

function check(files, budget, label) {
  const parts = partitionFiles(files, budget);
  console.log(`\n[${label}] budget=${budget} parts=${parts.length}`);
  for (const p of parts) {
    const actual = Buffer.byteLength(p.markdown, "utf8");
    const delta = p.metadata.bytes - actual;
    console.log(
      `  ${p.filename} files=${p.metadata.fileCount} reportedBytes=${p.metadata.bytes} actualBytes=${actual} delta=${delta} withinBudget=${actual <= budget} overBy=${actual > budget ? actual - budget : 0}`
    );
  }
  return parts;
}

// ---------- A: is metadata.bytes === Buffer.byteLength(markdown)? ----------
console.log("=== A: self-referential byteSize accuracy ===");
const results = [];
for (const bodyBytes of [10, 1000, 9990, 99990, 999998, 3_000_000]) {
  const files = [entry("src/a.ts", "x".repeat(bodyBytes))];
  const parts = partitionFiles(files, 10 * 1024 * 1024);
  const actual = Buffer.byteLength(parts[0].markdown, "utf8");
  results.push({ bodyBytes, reported: parts[0].metadata.bytes, actual, delta: parts[0].metadata.bytes - actual });
}
console.table(results);

// multi part, several files, forces digit-count changes on each part
const many = [];
for (let i = 0; i < 40; i++) many.push(entry(`src/deep/file-${i}.ts`, "y".repeat(4000 + i * 37)));
check(many, 24_000 + 40 * 160 + 50_000, "A-multi-part");

// ---------- B1: a single file section larger than the budget ----------
console.log("\n=== B1: one file whose rendered section alone exceeds maxPartBytes ===");
const big = [entry("src/bundle.js", "z".repeat(500_000)), entry("src/small.ts", "a".repeat(100))];
check(big, 100_000, "B1-single-oversized-file");

// ---------- B2: CRLF accounting direction ----------
console.log("\n=== B2: CRLF section counted before .replace(/\\r\\n/g,'\\n') ===");
const crlf = "line\r\n".repeat(20_000); // 120000 bytes with CRLF
const crlfEntry = entry("src/crlf.ts", crlf);
const sectionText = null; // not exported; use partitionFiles accounting indirectly
const pCrlf = partitionFiles([crlfEntry], 10 * 1024 * 1024)[0];
console.log(`  sourceBytes=${Buffer.byteLength(crlf, "utf8")} reportedBytes=${pCrlf.metadata.bytes} actualBytes=${Buffer.byteLength(pCrlf.markdown, "utf8")} shrinkageFromNormalization=${Buffer.byteLength(crlf, "utf8") - Buffer.byteLength(crlf.replace(/\r\n/g, "\n"), "utf8")}`);

// accounting check: does the per-section sum (pre-normalization) match the joined body?
// sum of section byteLengths is what the flush() decision uses.
console.log(`  -> flush() compares pre-normalization section bytes; emitted content is smaller by the CR count (safe direction: parts get SMALLER, not larger)`);

// ---------- B3 end-to-end: realistic minified single-line file ----------
console.log("\n=== B3: end-to-end generateSnapshot, minified single-line file (no '\\n' => preview cannot truncate by lines) ===");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-bytesize-"));
const repo = path.join(root, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
fs.writeFileSync(path.join(repo, "src", "vendor.min.js"), "var a=1;".repeat(520_000), "utf8"); // ~5.2MB, one line, no NUL
fs.writeFileSync(path.join(repo, "src", "tiny.ts"), "export const x = 1;\n", "utf8");
const manifest = await generateSnapshot({
  cwd: repo,
  outDir: "snapshot",
  tmpDir: "snapshot.tmp",
  maxPartBytes: 300 * 1024,
  largeFileBytes: 200 * 1024,
  includeMonolith: false,
});
console.log(`  manifest.counts=` + JSON.stringify(manifest.counts));
for (const p of manifest.parts) {
  const file = path.join(repo, "snapshot", "parts", p.filename);
  const stat = fs.statSync(file);
  console.log(`  ${p.filename} reportedBytes=${p.bytes} fileStatBytes=${stat.size} budget=${manifest.budgets.maxPartBytes} ratio=${(stat.size / manifest.budgets.maxPartBytes).toFixed(2)}x`);
}
const large = manifest.files.find((f) => f.isLarge);
console.log(`  large file entry: isLarge=${large.isLarge} isPreviewTruncated=${large.isPreviewTruncated} inclusionMode=${large.inclusionMode} sizeBytes=${large.sizeBytes} includedLines=${large.includedLines}/${large.originalLines}`);
const partOfLarge = manifest.parts.find((p) => p.files.includes(large.relativePath));
const partFile = path.join(repo, "snapshot", "parts", partOfLarge.filename);
const partText = fs.readFileSync(partFile, "utf8");
console.log(`  does the part contain the full 5.2MB body? ${partText.includes("var a=1;".repeat(1000))} (heading says: ${/#### (Bounded Preview|Content)/.exec(partText)?.[1]})`);

// ---------- B4: how much of the budget does the guessed header reserve waste? ----------
console.log("\n=== B4: header budget guess `24_000 + n*160` vs real header size ===");
const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "cs-header-"));
const repo2 = path.join(root2, "repo");
fs.mkdirSync(path.join(repo2, "src"), { recursive: true });
for (let i = 0; i < 400; i++) {
  fs.writeFileSync(path.join(repo2, "src", `m${String(i).padStart(3, "0")}.ts`), `export const v${i} = ${i};\n`, "utf8");
}
const budget = 100_000;
const m2 = await generateSnapshot({
  cwd: repo2, outDir: "snapshot", tmpDir: "snapshot.tmp",
  maxPartBytes: budget, largeFileBytes: 1024 * 1024, includeMonolith: false,
});
let wasted = 0;
for (const p of m2.parts) {
  const text = fs.readFileSync(path.join(repo2, "snapshot", "parts", p.filename), "utf8");
  const marker = "## Contents\n";
  const headerBytes = Buffer.byteLength(text.slice(0, text.indexOf(marker) + marker.length), "utf8");
  const reserve = 24_000 + p.fileCount * 160;
  const slack = budget - p.bytes;
  wasted += slack;
  console.log(`  ${p.filename} files=${String(p.fileCount).padStart(3)} partBytes=${String(p.bytes).padStart(6)} budget=${budget} unused=${String(slack).padStart(6)} actualHeader=${headerBytes}B reservedHeader=${reserve}B`);
}
console.log(`  400 tiny files => ${m2.parts.length} parts, total unused budget=${wasted} B (${((wasted / (budget * m2.parts.length)) * 100).toFixed(0)}% of the allotted budget unused)`);

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(root2, { recursive: true, force: true });
