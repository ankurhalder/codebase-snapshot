import { scanAndRedactSecrets, DEFAULT_SECRET_PATTERNS } from "../../dist/index.js";
for (const n of [60000, 120000, 240000]) {
  const line = "A".repeat(n);
  const t = performance.now();
  scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, "x");
  console.log(`  ${n} chars -> ${(performance.now() - t).toFixed(1)} ms`);
}
// worst case for the alternation: keyword repeated with long runs around it
const nasty = ("API_KEY=" + "x".repeat(50) + " ").repeat(4000);
let t = performance.now();
scanAndRedactSecrets(nasty, DEFAULT_SECRET_PATTERNS, "y");
console.log(`  nasty 240KB -> ${(performance.now() - t).toFixed(1)} ms`);