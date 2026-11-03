// PoC: claims D (inclusionMode/totals contradiction), E (totalContentBytes), F (validation.status + generator.script),
// plus hardcoded empty manifest indexes.
// Run: node audit/poc/correctness-manifest-totals.mjs
import { generateSnapshot, validateSnapshot, resolveConfig } from "../../dist/index.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-totals-"));
const repo = path.join(root, "repo");
fs.mkdirSync(path.join(repo, "src"), { recursive: true });
const write = (rel, s) => fs.writeFileSync(path.join(repo, rel), s, "utf8");

// (1) bigger than largeFileBytes but only 5 short lines => preview NOT truncated, full content emitted
write("src/five-lines.ts", Array.from({ length: 5 }, (_, i) => `export const v${i} = "${"x".repeat(300)}";`).join("\n") + "\n");
// (2) a file with a secret-like value (redaction rewrites the whole line)
write("src/creds.ts", 'export const k = "AKIAIOSFODNN7EXAMPLE";\nexport const ok = 1;\n');
// (3) imports + a client directive, to test manifest.indexes
write("src/app.ts", '"use client";\nimport { a } from "./a";\nimport fs from "node:fs";\nexport function GET() {}\n');

const bytesOf = (rel) => fs.statSync(path.join(repo, rel)).size;
for (const rel of ["src/five-lines.ts", "src/creds.ts", "src/app.ts"]) console.log(`disk ${rel} = ${bytesOf(rel)} bytes`);

const cfg = resolveConfig({
  cwd: repo,
  outDir: "snapshot",
  tmpDir: "snapshot.tmp",
  largeFileBytes: 500, // (1) is ~1.6KB => "large"
  maxPartBytes: 300 * 1024,
});
const m = await generateSnapshot(cfg);

console.log("\n=== D: inclusionMode vs actual truncation ===");
for (const f of m.files) {
  console.log(`  ${f.relativePath}: sizeBytes=${f.sizeBytes} isLarge=${f.isLarge} isPreviewTruncated=${f.isPreviewTruncated} inclusionMode=${f.inclusionMode} includedLines=${f.includedLines}/${f.originalLines}`);
}
console.log(`  totals.fullFiles=${m.totals.fullFiles} totals.summaryOnlyFiles=${m.totals.summaryOnlyFiles} candidateFiles=${m.totals.candidateFiles}`);
console.log(`  counts.largeFileCount=${m.counts.largeFileCount} counts.truncatedPreviewCount=${m.counts.truncatedPreviewCount}`);
// what the part actually contains for the "summary-only" file:
const part = m.parts[m.parts.findIndex((p) => p.files.includes("src/five-lines.ts"))];
const partText = fs.readFileSync(path.join(repo, "snapshot", "parts", part.filename), "utf8");
const section = partText.slice(partText.indexOf("### FILE: src/five-lines.ts"));
console.log(`  heading used for that file: "${/#### (Bounded Preview|Content)/.exec(section)?.[1]}" ; contains last line v4? ${section.includes('export const v4 = "')} ; contains omission marker? ${section.includes("lines omitted")}`);
console.log(`  contradiction: inclusionMode=${m.files.find((f) => f.relativePath === "src/five-lines.ts").inclusionMode} but isPreviewTruncated=${m.files.find((f) => f.relativePath === "src/five-lines.ts").isPreviewTruncated} and full body emitted=true`);

console.log("\n=== E: totalContentBytes vs bytes actually emitted ===");
const headerOf = (text) => {
  const marker = "## Contents\n";
  return text.indexOf(marker) + marker.length;
};
let emittedBodyBytes = 0;
for (const p of m.parts) {
  const t = fs.readFileSync(path.join(repo, "snapshot", "parts", p.filename), "utf8");
  emittedBodyBytes += Buffer.byteLength(t, "utf8") - headerOf(t);
}
console.log(`  totals.totalSourceBytes=${m.totals.totalSourceBytes} totals.totalContentBytes=${m.totals.totalContentBytes} (equal? ${m.totals.totalContentBytes === m.totals.totalSourceBytes})`);
console.log(`  sum(manifest.files[].sizeBytes)=${m.files.reduce((a, f) => a + f.sizeBytes, 0)}`);
console.log(`  measured emitted body bytes across parts/*.md=${emittedBodyBytes}`);
const credsDisk = bytesOf("src/creds.ts");
const credsSection = (() => {
  for (const p of m.parts) {
    const t = fs.readFileSync(path.join(repo, "snapshot", "parts", p.filename), "utf8");
    const i = t.indexOf("### FILE: src/creds.ts");
    if (i >= 0) return t.slice(i);
  }
  return "";
})();
console.log(`  src/creds.ts on disk=${credsDisk}B ; section contains redaction marker=${credsSection.includes("[REDACTED:")} ; secret line length on disk=${'export const k = "AKIAIOSFODNN7EXAMPLE";'.length}B ; after redaction=${"[REDACTED: potential secret-like value omitted from snapshot]".length}B`);
console.log(`  totals.warningCount=${m.totals.warningCount} warnings.length=${m.warnings.length} secretFindings=${m.warnings.length} (warningCount == secret-finding count)`);

console.log("\n=== F: manifest.validation.status and generator.script ===");
console.log(`  manifest.validation=${JSON.stringify(m.validation)}`);
console.log(`  manifest.generator.script=${JSON.stringify(m.generator.script)} existsOnDisk=${fs.existsSync(path.join(process.cwd(), "scripts", "generate_codebase_snapshot.ts"))}`);
// make the manifest's own claim demonstrably false: tamper a source file => validate says drifted
fs.appendFileSync(path.join(repo, "src/app.ts"), "// changed\n");
const v = validateSnapshot(cfg);
console.log(`  after editing a source file: validateSnapshot.valid=${v.valid} errors=${JSON.stringify(v.errors)}`);
const mOnDisk = JSON.parse(fs.readFileSync(path.join(repo, "snapshot", "manifest.json"), "utf8"));
console.log(`  manifest.json on disk still says validation.status=${JSON.stringify(mOnDisk.validation.status)} while validateSnapshot says valid=${v.valid}`);

console.log("\n=== extra: manifest.indexes are hardcoded empty despite available summaries ===");
console.log(`  indexes.imports=${JSON.stringify(m.indexes.imports)}`);
console.log(`  indexes.directives=${JSON.stringify(m.indexes.directives)}`);
console.log(`  indexes.features=${JSON.stringify(m.indexes.features)}`);
const appEntry = JSON.parse(fs.readFileSync(path.join(repo, "snapshot", "manifest.json"), "utf8")).files.find((f) => f.relativePath === "src/app.ts");
console.log(`  but files[src/app.ts].summary.imports=${JSON.stringify(appEntry.summary.imports)} summary.directives=${JSON.stringify(appEntry.summary.directives)}`);
console.log(`  indexes.routes=${JSON.stringify(m.indexes.routes.map((r) => [r.path, r.methods]))}`);

fs.rmSync(root, { recursive: true, force: true });
