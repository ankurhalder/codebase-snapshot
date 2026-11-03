/**
 * PoC 5: ReDoS / catastrophic backtracking check on the 10 default patterns.
 * Measures wall-clock .test() time on pathological single lines (the unit of
 * work in redact.ts is one line).
 *
 * Run:  node audit/poc/security-redos.mjs
 */
import { DEFAULT_SECRET_PATTERNS } from "../../dist/index.js";
import { performance } from "node:perf_hooks";

const SIZES = [10_000, 50_000, 200_000, 1_000_000];
const BUDGET_MS = 250; // stop escalating a case once a single run costs this much

// candidate pathological inputs per rule: [name, generator(size) => string]
const CASES = {
  "private-key-header": [
    ["dashes", (n) => "-".repeat(n)],
    ["repeated header prefix", (n) => "-----BEGIN ".repeat(Math.ceil(n / 12))],
    ["header-ish, no tail", (n) => "-----BEGIN " + "PRIVATE ".repeat(Math.ceil(n / 8))],
  ],
  "jwt-token": [
    ["eyJ + long run", (n) => "eyJ" + "a".repeat(n)],
    ["repeated eyJ", (n) => "eyJ".repeat(Math.ceil(n / 3))],
    ["2 segments", (n) => "eyJ" + "a".repeat(n / 2) + "." + "eyJ" + "a".repeat(n / 2)],
    ["3 segments, no final run", (n) => "eyJ" + "a".repeat(n / 3) + ".eyJ" + "a".repeat(n / 3) + "."],
    ["base64 JSON blob (many eyJ, no dots)", (n) => ("eyJ" + "A".repeat(9) + "x".repeat(9)).repeat(Math.ceil(n / 21))],
  ],
  "aws-access-key-id": [
    ["AKIA + uppercase run", (n) => "AKIA" + "A".repeat(n)],
    ["repeated AKIA", (n) => "AKIA".repeat(Math.ceil(n / 4))],
    ["ASIA + digits", (n) => "ASIA" + "9".repeat(n)],
  ],
  "aws-secret-access-key": [
    ["key= + run", (n) => "aws_secret_access_key=" + "a".repeat(n)],
    ["key = + quotes", (n) => "aws_secret_key = " + '"'.repeat(n)],
    ["whitespace run", (n) => "aws_secret_access_key" + " ".repeat(n) + "!"],
  ],
  "github-token": [
    ["ghp_ + run", (n) => "ghp_" + "a".repeat(n)],
    ["ghp_ + run + bang", (n) => "ghp_" + "a".repeat(n) + "!"],
    ["repeated ghp_", (n) => "ghp_".repeat(Math.ceil(n / 4))],
  ],
  "slack-token": [["xoxb- + run", (n) => "xoxb-" + "0".repeat(n)]],
  "stripe-secret-key": [["sk_live_ + run", (n) => "sk_live_" + "a".repeat(n)]],
  "google-api-key": [["AIza + run", (n) => "AIza" + "A".repeat(n)]],
  "database-uri-credentials": [
    ["no @", (n) => "postgres://" + "a".repeat(n) + "!"],
    ["colon, no @", (n) => "postgres://a:" + "b".repeat(n) + "!"],
    ["many colons", (n) => "postgres://" + "a:".repeat(Math.ceil(n / 2))],
    ["user:pass run then bang", (n) => "mongodb://" + "x".repeat(n / 2) + ":" + "y".repeat(n / 2) + "!"],
  ],
  "generic-secret-assignment": [
    ["api_key= + quotes", (n) => "api_key=" + '"'.repeat(n)],
    ["open quote + run", (n) => 'api_key = "' + "a".repeat(n)],
    ["whitespace run", (n) => "api_key" + " ".repeat(n) + "!"],
    ["repeated api_key=", (n) => "api_key=".repeat(Math.ceil(n / 8))],
  ],
};

/** time fn once; repeat only when cheap (reps keep totals bounded) */
function time(fn) {
  const t0 = performance.now();
  fn();
  const first = performance.now() - t0;
  if (first > 20) return first;
  let best = first;
  for (let i = 0; i < 2; i++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

/** ascending size ladder that stops itself once a run exceeds the budget */
function ladder(gen, run) {
  const out = [];
  for (const n of SIZES) {
    const input = gen(n);
    const ms = time(() => run(input));
    out.push({ n, ms });
    if (ms > BUDGET_MS) break;
  }
  return out;
}

let worst = { ms: 0 };
console.log(`=== per-rule worst case (size ladder ${SIZES.join("/")}, aborts a case above ${BUDGET_MS}ms) ===`);
for (const rule of DEFAULT_SECRET_PATTERNS) {
  const cases = CASES[rule.rule] || [];
  for (const [name, gen] of cases) {
    const res = ladder(gen, (input) => rule.pattern.test(input));
    const last = res[res.length - 1];
    if (last.ms > worst.ms) worst = { ms: last.ms, rule: rule.rule, name, n: last.n };
    const txt = res.map((r) => `${r.n / 1000}k: ${r.ms.toFixed(2)}ms`).join("  ");
    const slow = last.ms > 50 ? "  <-- SLOW/BLOWUP" : "";
    console.log(`  ${rule.rule.padEnd(26)} ${name.padEnd(34)} ${txt}${slow}`);
  }
}

console.log("\n=== whole default rule set on one long line (realistic generated/minified file) ===");
for (const [label, gen] of [
  ["base64 blob", (n) => "data=" + "A".repeat(n)],
  ["minified js-ish", (n) => "var a=1;".repeat(Math.ceil(n / 8))],
  ["base64-ish with eyJ seeds", (n) => ("eyJ" + "A".repeat(15)).repeat(Math.ceil(n / 18))],
  ["mixed punctuation", (n) => "a:b@c/d:e@f".repeat(Math.ceil(n / 11))],
]) {
  const res = ladder(gen, (input) => { for (const r of DEFAULT_SECRET_PATTERNS) r.pattern.test(input); });
  const last = res[res.length - 1];
  if (last.ms > worst.ms) worst = { ms: last.ms, rule: "ALL 10 rules", name: label, n: last.n };
  console.log(`  ${label.padEnd(34)} ${res.map((r) => `${r.n / 1000}k: ${r.ms.toFixed(2)}ms`).join("  ")}`);
}

console.log("\n=== injectivity sanity check (patterns are non-global, so .test() is stateless) ===");
console.log("  /g or /y flags on defaults:", DEFAULT_SECRET_PATTERNS.filter((r) => r.pattern.global || r.pattern.sticky).length);
const p = DEFAULT_SECRET_PATTERNS.find((r) => r.rule === "aws-access-key-id").pattern;
console.log("  lastIndex after 3 calls:", [p.test("AKIAIOSFODNN7EXAMPLE"), p.test("AKIAIOSFODNN7EXAMPLE"), p.lastIndex]);

console.log(`\nWORST OBSERVED: ${worst.ms.toFixed(2)} ms (${worst.rule} / ${worst.name} / ${worst.n} chars)`);
console.log(worst.ms > 50 ? "VERDICT: measurable blowup" : "VERDICT: no catastrophic backtracking found (sub-linear/linear scaling)");
