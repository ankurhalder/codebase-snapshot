/**
 * PoC 2 (unit level): scanAndRedactSecrets semantics.
 *  - whole-line replacement (over-redaction of unrelated code on the same line)
 *  - multi-line secrets: only the header line is replaced
 *  - caller-supplied rule with /g: pattern.test() is stateful -> silent skipping
 *  - a non-RegExp pattern (e.g. from .snapshotrc.json) crashes the whole run
 *
 * Run:  node audit/poc/security-redact-units.mjs
 */
import { scanAndRedactSecrets, resolveConfig, DEFAULT_SECRET_PATTERNS } from "../../dist/index.js";

const MARK = "[REDACTED: potential secret-like value omitted from snapshot]";
const show = (s) => JSON.stringify(s);

console.log("=== A. whole-line replacement destroys unrelated code on the same line ===");
const mixed = `export const awsKey = "AKIAIOSFODNN7EXAMPLE"; export const region = "us-east-1"; const retries = 3;`;
const rA = scanAndRedactSecrets(mixed, DEFAULT_SECRET_PATTERNS, "src/x.ts");
console.log("  in :", show(mixed));
console.log("  out:", show(rA.redacted));
console.log("  unrelated code lost:", ["us-east-1", "retries", "export const region"].filter((s) => !rA.redacted.includes(s)));
console.log("  bytes: in", mixed.length, "-> out", rA.redacted.length, `(a ${mixed.length}-char code line became ${rA.redacted.length} chars)`);

console.log("\n=== B. multi-line PEM: only the BEGIN header line is replaced ===");
const pem = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
  "BODYSECRETLINE2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "-----END RSA PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABODYSECRETLINE5aaaaaaaaaaaaaaaaaaaaaaaaa",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");
const rB = scanAndRedactSecrets(pem, DEFAULT_SECRET_PATTERNS, "k.pem");
const outB = rB.redacted.split("\n");
outB.forEach((l, i) => console.log(`  L${i + 1}: ${l}`));
console.log("  findings:", rB.findings.map((f) => `${f.rule}@L${f.line}`).join(", "));
console.log("  body lines preserved verbatim:", outB.filter((l) => /^(MIIE|BODYSECRET|b3Blbn).*$/.test(l)).length, "of 3");
console.log("  END lines preserved:", outB.filter((l) => l.startsWith("-----END")).length, "-> an attacker only has to re-add the BEGIN header");

console.log("\n=== C. caller-supplied rule with /g: pattern.test() keeps lastIndex ===");
const gRule = [{ rule: "custom-token", pattern: /^X=SECRET_[A-Z]+$/g }];
const lines8 = Array.from({ length: 8 }, () => "X=SECRET_ABCDEFGH");
const content8 = lines8.join("\n");
console.log("  8 identical lines, one rule with the /g flag. Replaying the exact call in redact.ts:");
const p = gRule[0].pattern;
lines8.forEach((line, i) => {
  const before = p.lastIndex;
  const hit = p.test(line);
  console.log(`    line ${i + 1}: lastIndex before=${String(before).padStart(2)} test()=${String(hit).padEnd(5)} lastIndex after=${p.lastIndex}`);
});
const rC = scanAndRedactSecrets(content8, gRule, "a.env");
console.log("  scanAndRedactSecrets report:", JSON.stringify(rC));
console.log("  redacted line indexes:", rC.redacted.split("\n").map((l, i) => (l === MARK ? i + 1 : null)).filter(Boolean).join(","),
  `-> ${rC.redacted.split("\n").filter((l) => l === MARK).length}/8 replaced, 4 secrets leak and 0 warnings`);

console.log("\n=== D. cross-file contamination: identical file content, different output ===");
const odd = Array.from({ length: 7 }, () => "X=SECRET_ABCDEFGH").join("\n");
const rules2 = [{ rule: "custom-token", pattern: /^X=SECRET_[A-Z]+$/g }];
const f1 = scanAndRedactSecrets(odd, rules2, "file1.env");
const f2 = scanAndRedactSecrets(odd, rules2, "file2.env");
const which = (r) => r.redacted.split("\n").map((l, i) => (l === MARK ? i + 1 : null)).filter(Boolean).join(",");
console.log("  file1 redacted lines:", which(f1), "findings:", f1.findings.length);
console.log("  file2 redacted lines:", which(f2), "findings:", f2.findings.length);
console.log("  same input, different result:", which(f1) !== which(f2));

console.log("\n=== E. leak-through of the same rules when a /g match is skipped mid-file ===");
const mixedContent = ["X=SECRET_ABCDEFGH", "X=SECRET_ABCDEFGH", "password=plain"].join("\n");
const rE = scanAndRedactSecrets(mixedContent, rules2, "x");
console.log("  result:", JSON.stringify(rE).slice(0, 300));

console.log("\n=== F. custom rule supplied through JSON config (pattern is a string, not RegExp) ===");
const cfg = resolveConfig({ secrets: { customPatterns: [{ rule: "json-rule", pattern: "sk-[A-Za-z0-9]{20}" }] } });
console.log("  resolved rule:", JSON.stringify(cfg.secretRules.at(-1)));
try {
  scanAndRedactSecrets("KEY=sk-AbCdEf0123456789AbCdEf01", cfg.secretRules, ".env");
  console.log("  --> no error (unexpected)");
} catch (e) {
  console.log("  --> THROWS:", e.constructor.name + ": " + e.message, "-> generateSnapshot() rejects, no snapshot is produced");
}
console.log("\n(default rule count:", DEFAULT_SECRET_PATTERNS.length, ")");
