/**
 * PoC 5b: is the quadratic blowup in the jwt-token pattern reachable with REAL
 * repo content, and does it show up end-to-end in generateSnapshot()?
 *
 * Trigger shape: ONE long line of base64 whose decoded payload is JSON.
 * base64 of `{"` is "eyJ", so such a blob is dense in "eyJ" seeds, has no "."
 * (nothing for the pattern's `\.` to match) and - unless the encoder pads every
 * chunk - no early "=" to break the character-class run. Inlined source maps,
 * data: URIs, vendored fixtures and .b64 files look exactly like this.
 *
 * Run:  node audit/poc/security-redos-real.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { DEFAULT_SECRET_PATTERNS, generateSnapshot, scanAndRedactSecrets } from "../../dist/index.js";

const JWT_RULE = DEFAULT_SECRET_PATTERNS.find((r) => r.rule === "jwt-token").pattern;
const here = import.meta.dirname;

// ONE base64 encoding of a large JSON document (think: a vendored .b64 dataset,
// an inlined source map, a data: URI). JSON of records is dense in `{"` =>
// base64 is dense in "eyJ", has no "." and no early "=".
const json = JSON.stringify(Array.from({ length: 30_000 }, () => ({ a: 1 })));
const b64 = Buffer.from(json, "utf8").toString("base64");
console.log("=== realistic trigger: one line = base64(a JSON dataset) ===");
console.log(`  full blob: ${b64.length} chars | "eyJ" occurrences: ${(b64.match(/eyJ/g) || []).length} | "=" anywhere: ${b64.includes("=")} | "." anywhere: ${b64.includes(".")}`);

for (const n of [50_000, 100_000, 200_000, 300_000]) {
  if (n > b64.length) continue;
  const line = b64.slice(0, n); // no padding inside a real prefix
  const t0 = performance.now();
  JWT_RULE.test(line);
  const ms = performance.now() - t0;
  console.log(`  ${String(n / 1000).padStart(4)}k chars: ${String(ms.toFixed(1)).padStart(7)} ms   seeds=${(line.match(/eyJ/g) || []).length}   (1 MB at this shape would be ~${(ms * (1_000_000 / n) ** 2 / 1000).toFixed(0)} s)`);
}

// ---------- end-to-end: does generateSnapshot() stall on such a file? ----------
const FIX = path.join(here, "security-fixture-redos");
if (!FIX.startsWith(path.join(here, "security-fixture"))) throw new Error("unexpected path " + FIX);
fs.rmSync(FIX, { recursive: true, force: true });

const write = (d, rel, c) => {
  const p = path.join(d, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c, "utf8");
};
async function run(dir) {
  const t0 = performance.now();
  const m = await generateSnapshot({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" });
  return { ms: performance.now() - t0, files: m.counts.totalFiles, findings: m.warnings.length };
}

const CONTROL = path.join(FIX, "control");
const EVIL = path.join(FIX, "evil");
const LINE = b64.slice(0, 300_000);
for (const [dir, line] of [[CONTROL, LINE.replaceAll("eyJ", "eQJ")], [EVIL, LINE]]) {
  write(dir, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }) + "\n");
  write(dir, "src/app.ts", "export const ok = true;\n");
  write(dir, "vendor/sourcemap.js.map.b64", line + "\n");
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
}

console.log("\n=== end-to-end generateSnapshot() with a 300 KB single-line vendored file ===");
const c = await run(CONTROL);
console.log(`  control (identical length, "eyJ" -> "eQJ"): ${c.ms.toFixed(0)} ms  (${c.files} files)`);
const e = await run(EVIL);
console.log(`  real blob ("eyJ" seeds present):            ${e.ms.toFixed(0)} ms  (${e.files} files)`);
console.log(`  slowdown: ${(e.ms / c.ms).toFixed(1)}x  -> one 300 KB generated file costs ${(e.ms / 1000).toFixed(1)} s of CPU`);
console.log(`  note: the file exceeds largeFileBytes (200 KB) yet redaction still runs on the FULL raw content, before preview truncation`);

console.log("\n=== same line through the full default rule set ===");
const t1 = performance.now();
const r = scanAndRedactSecrets(LINE, DEFAULT_SECRET_PATTERNS, "vendor/sourcemap.js.map.b64");
console.log(`  scanAndRedactSecrets: ${(performance.now() - t1).toFixed(0)} ms, findings=${r.findings.length} (the cost is pure wasted backtracking)`);
