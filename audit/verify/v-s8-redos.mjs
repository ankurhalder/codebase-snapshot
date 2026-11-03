// S8 (01 §8) — `jwt-token` backtracked quadratically: 1.22 s per 200 KB and
// ~31 s/MB on an `eyJ`-dense line, unbounded by largeFileBytes.
//
// Check: the old shape (1 MB single line dense in eyJ) must now finish in a
// sane time, the control line (same length, eyJ -> eQJ) must be comparable, and
// a realistic base64 blob must stay cheap. Also probes the NEW
// `env-secret-assignment` rule for the same class of blowup (reported as a
// regression, not as S8).
import { resolveConfig, scanAndRedactSecrets } from "../../dist/index.js";
import { assert, check, finish, selfTest } from "./v-lib.mjs";

selfTest();

const rules = resolveConfig({}).secretRules;

function time(line, subset = rules) {
  const started = performance.now();
  scanAndRedactSecrets(line, subset, "perf");
  return { ms: performance.now() - started, bytes: Buffer.byteLength(line) };
}

check("S8.jwt-1mb", "1 MB eyJ-dense single line is bounded (old: ~31 s/MB extrapolated)", () => {
  const { ms, bytes } = time("eyJ".repeat(350000));
  assert(ms < 2500, `${(bytes / 1024).toFixed(0)} KB took ${ms.toFixed(0)} ms`);
  return `${(bytes / 1024).toFixed(0)} KB in ${ms.toFixed(0)} ms (old ~31000 ms)`;
});

check("S8.reported-shape", "the audit's exact 300 KB base64(json) shape is now cheap (was 2783 ms)", () => {
  // Reproduces the reported shape: base64 of a JSON array of records, which is
  // naturally dense in "eyJ" (every `{"` in the source encodes to eyJ...).
  const records = [];
  for (let i = 0; i < 2200; i += 1) {
    records.push({
      id: i,
      token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789jkl",
      payload: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    });
  }
  const blob = Buffer.from(JSON.stringify(records)).toString("base64").slice(0, 300 * 1024);
  const seeds = (blob.match(/eyJ/g) ?? []).length;
  const { ms } = time(blob);
  assert(ms < 500, `${blob.length} B with ${seeds} eyJ seeds took ${ms.toFixed(0)} ms (old: 2783 ms)`);
  return `${(blob.length / 1024).toFixed(0)} KB, ${seeds} seeds, ${ms.toFixed(0)} ms (old 2783 ms)`;
});

check("S8.realistic", "a 1.2 MB base64(JSON) single line stays cheap", () => {
  const record = JSON.stringify({ id: 1, name: "widget", tags: ["a", "b"], nested: { x: 1.5, ok: true } });
  const blob = Buffer.from(record.repeat(14000)).toString("base64");
  const { ms } = time(blob);
  assert(ms < 1000, `base64 blob took ${ms.toFixed(0)} ms`);
  return `${(blob.length / 1024).toFixed(0)} KB in ${ms.toFixed(0)} ms`;
});

check("S8.scaling", "jwt cost scales linearly with line length", () => {
  const small = time("eyJ".repeat(87500)).ms; // 262 KB
  const large = time("eyJ".repeat(350000)).ms; // 1.05 MB
  const factor = large / Math.max(small, 0.01);
  assert(factor < 8, `4x the input took ${factor.toFixed(1)}x the time (quadratic would be ~16x)`);
  return `4x input => ${factor.toFixed(1)}x time`;
});

// ---------------------------------------------------------------------------
// NEW: the `env-secret-assignment` rule introduced by the C4 fix backtracks
// quadratically. `^\s*[A-Za-z0-9_]*(?:KEY|TOKEN|...)[A-Za-z0-9_]*\s*=` re-scans
// the remainder of the line for every position where the alternation matches.
check(
  "R1.env-redos",
  "REGRESSION (found during remediation, now fixed) — env-secret-assignment is linear",
  () => {
    const envOnly = rules.filter((rule) => rule.rule === "env-secret-assignment");
    assert(envOnly.length === 1, "env rule not found in the default set");
    const a = time("KEY".repeat(20000), envOnly); // 60 KB
    const b = time("KEY".repeat(40000), envOnly); // 120 KB
    const factor = b.ms / Math.max(a.ms, 0.01);
    assert(
      factor < 3,
      `2x the input took ${factor.toFixed(1)}x the time: ${a.ms.toFixed(0)} ms @60 KB -> ${b.ms.toFixed(0)} ms @120 KB`
    );
    return `${a.ms.toFixed(0)} ms @60 KB, ${b.ms.toFixed(0)} ms @120 KB`;
  }
);

check("R1.env-redos-e2e", "REGRESSION (found during remediation, now fixed) — 240 KB KEY-dense line is cheap", () => {
  const line = "KEY".repeat(80000); // 240 KB, one line
  const { ms } = time(line);
  console.log(`    OBS: 240 KB KEY-dense line => ${ms.toFixed(0)} ms of CPU in one file`);
  assert(ms < 1000, `${ms.toFixed(0)} ms for a 240 KB line (old jwt rule at this size: ~2800 ms)`);
  return `${ms.toFixed(0)} ms (was 5630 ms before the bound)`;
});

// ---------------------------------------------------------------------------
// Every default rule x a battery of adversarial 200 KB single lines. The audit
// cleared 9/10 rules and the fixes rewrote several patterns, so the whole set is
// re-measured here rule by rule.
check("S8.all-rules", "no default rule is super-linear on any adversarial 200 KB line", () => {
  const shapes = [
    ["keyword-run", "KEY".repeat(70_000)],
    ["token-run", "TOKEN".repeat(40_000)],
    ["password-run", "PASSWORD".repeat(25_000)],
    ["unterminated-quote", `"${"a".repeat(200_000)}`],
    ["eq-run", "=".repeat(200_000)],
    ["a-eq-run", "a=".repeat(100_000)],
    ["at-run", "@".repeat(200_000)],
    ["scheme-run", "://".repeat(66_000)],
    ["aws-prefix", `AKIA${"A".repeat(200_000)}`],
    ["sg-prefix", `SG.${"a".repeat(200_000)}`],
    ["pem-prefix", `-----BEGIN ${"A".repeat(200_000)}`],
    ["digits", "1234567890".repeat(20_000)],
    ["backslashes", "\\".repeat(200_000)],
    ["colon-eq", ":=".repeat(100_000)],
  ];
  const timings = [];
  for (const rule of rules) {
    for (const [shapeName, line] of shapes) {
      const started = performance.now();
      scanAndRedactSecrets(line, [rule], "perf");
      timings.push({ rule: rule.rule, shape: shapeName, ms: performance.now() - started });
    }
  }
  timings.sort((a, b) => b.ms - a.ms);
  const slow = timings.filter((entry) => entry.ms > 400);
  console.log(
    `    OBS S8.all-rules: ${rules.length} rules x ${shapes.length} shapes = ${timings.length} runs; worst = ${timings
      .slice(0, 3)
      .map((entry) => `${entry.rule}/${entry.shape} ${entry.ms.toFixed(0)}ms`)
      .join(", ")}`
  );
  assert(
    slow.length === 0,
    `slow rule/shape pairs: ${slow.map((entry) => `${entry.rule}/${entry.shape}=${entry.ms.toFixed(0)}ms`).join(", ")}`
  );
  return `${timings.length} runs, worst ${timings[0].ms.toFixed(0)} ms (${timings[0].rule}/${timings[0].shape})`;
});

finish();


