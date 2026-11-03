/**
 * PoC 5c: which realistic single-line blobs make the jwt-token pattern quadratic?
 * Cost is O(lineLength x numberOf"eyJ"seeds) because `[A-Za-z0-9-_]{10,}` greedily
 * runs to the end of the line and then backtracks looking for the `\.` that is absent.
 *
 * Run:  node audit/poc/security-redos-shapes.mjs
 */
import { performance } from "node:perf_hooks";
import { DEFAULT_SECRET_PATTERNS } from "../../dist/index.js";

const p = DEFAULT_SECRET_PATTERNS.find((r) => r.rule === "jwt-token").pattern;
const SHAPES = {
  "base64(json array of records)": JSON.stringify(Array.from({ length: 30000 }, () => ({ a: 1 }))),
  "base64(json array of strings)": JSON.stringify(Array.from({ length: 30000 }, () => "v")),
  "base64(json obj of objs)": JSON.stringify(Object.fromEntries(Array.from({ length: 30000 }, (_, i) => ["k" + i, { a: 1 }]))),
  "base64(sourcemap-like)": JSON.stringify({ version: 3, sources: Array.from({ length: 20000 }, (_, i) => `a${i}.ts`), mappings: "AAAA" }),
  "raw repeated eyJ (worst case)": "eyJ".repeat(200000),
  "raw base64 of a PEM key": Buffer.from("-----BEGIN PRIVATE KEY-----\n" + "MIIEowIBAAKCAQEA".repeat(2000) + "\n-----END PRIVATE KEY-----").toString("base64"),
};
console.log("  shape                            size    eyJ-seeds   time");
for (const [name, src] of Object.entries(SHAPES)) {
  const isB64Input = name.startsWith("base64");
  const blob = isB64Input ? Buffer.from(src, "utf8").toString("base64") : src;
  for (const n of [100_000, 200_000, 400_000]) {
    if (n > blob.length) continue;
    const line = blob.slice(0, n);
    const seeds = (line.match(/eyJ/g) || []).length;
    const t0 = performance.now();
    p.test(line);
    const ms = performance.now() - t0;
    console.log(`  ${name.padEnd(30)} ${String(n / 1000).padStart(4)}k ${String(seeds).padStart(9)} ${String(ms.toFixed(1)).padStart(9)} ms`);
  }
}
