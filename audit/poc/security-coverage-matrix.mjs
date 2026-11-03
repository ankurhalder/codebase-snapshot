/**
 * PoC 3: what do the 10 default patterns actually catch?
 *
 * Run:  node audit/poc/security-coverage-matrix.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfig, scanAndRedactSecrets, DEFAULT_SECRET_PATTERNS } from "../../dist/index.js";

const rules = resolveConfig({}).secretRules; // exactly what generateSnapshot() uses by default
const MARK = "[REDACTED: potential secret-like value omitted from snapshot]";

const CASES = [
  // [label, line, is it a real production secret family?]
  ["AWS access key id", `const id = "AKIAIOSFODNN7EXAMPLE";`],
  ["AWS secret key in .env", `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`],
  ["AWS secret key in JSON", `  "aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",`],
  ["JWT", `const t = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";`],
  ["GitHub classic PAT", `const g = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";`],
  ["GitHub fine-grained PAT", `const g = "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789";`],
  ["Slack bot token", `const s = "xoxb-123456789012-abcdefghijklmnop";`],
  ["Slack incoming webhook URL", `https://hooks.slack.com/services/T0000000/B0000000/XXXXXXXXXXXXXXXXXXXXXXXX`],
  ["Stripe live secret key", `const s = "sk_live_aBcDeFgHiJkLmNoPqRsTuVwX";`],
  ["Google API key", `const g = "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q7";`],
  ["Google OAuth client secret", `const g = "GOCSPX-aBcDeFgHiJkLmNoPqRsTuVwXyZ01";`],
  ["OpenAI key (sk-proj)", `OPENAI_API_KEY=sk-proj-AbCdEf0123456789QwErTyUiOp`],
  ["OpenAI key (legacy sk-)", `OPENAI_API_KEY=sk-AbCdEf0123456789QwErTyUiOpAsDfGhJkL`],
  ["Anthropic key", `ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789QwErTyUiOpAsDfGhJkL`],
  ["npm token", `NPM_TOKEN=npm_9f8e7d6c5b4a39281706f5e4d3c2b1a0`],
  ["npm _authToken (.npmrc)", `//registry.npmjs.org/:_authToken=npm_9f8e7d6c5b4a39281706f5e4d3c2b1a0`],
  ["PyPI token", `TWINE_PASSWORD=pypi-AgEIcHlwaS5vcmcCJGFiY2RlZmdoLWlqa2xtbm9wcXJzdHV2`],
  ["SendGrid key", `const s = "SG.aBcDeFgHiJkLmNoPqR.sTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRs";`],
  ["Twilio key", `const t = "SK0123456789abcdef0123456789abcdef";`],
  ["DigitalOcean token", `const d = "dop_v1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";`],
  ["Azure storage AccountKey", `AccountKey=aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789+/aBcDeFgHi==`],
  ["Private key header (PKCS#1)", `-----BEGIN RSA PRIVATE KEY-----`],
  ["Private key header (PKCS#8)", `-----BEGIN PRIVATE KEY-----`],
  ["Private key header (encrypted)", `-----BEGIN ENCRYPTED PRIVATE KEY-----`],
  ["DB URI with creds", `DATABASE_URL=postgres://admin:s3cr3t@db.example.com:5432/app`],
  ["Basic auth in URL", `curl https://bot:Sup3rS3cret@api.example.com/deploy`],
  ["api_key = 'quoted' 32 chars", `const apiKey = "0123456789abcdefQRSTuvwx";`],
  ["unquoted .env API_KEY", `API_KEY=0123456789abcdefQRSTuvwx`],
  ["unquoted .env SECRET_KEY", `SECRET_KEY=0123456789abcdefQRSTuvwx`],
  ["unquoted .env AUTH_TOKEN", `AUTH_TOKEN=0123456789abcdefQRSTuvwx`],
  ["unquoted .env PASSWORD", `PASSWORD=hunter2`],
  ["unquoted .env DB_PASSWORD", `DB_PASSWORD=Sup3rS3cret!2024`],
  ["quoted secret with base64 padding", `SECRET_KEY="dGhpcy1pcy1hLXZlcnktbG9uZy1iYXNlNjQtc2VjcmV0=="`],
  ["quoted secret with + / chars", `api_key = "ab+cd/ef0123456789ABCDEF"`],
  ["JSON password field", `  "password": "Sup3rS3cret!2024",`],
  ["long random in a URL query", `https://api.example.com/v1?token=aBcDeFgH0123456789iJkLmNoP`],
];

const summary = { hit: [], miss: [] };
const rows = [];
for (const [label, line] of CASES) {
  const { findings } = scanAndRedactSecrets(line, rules, "f");
  const hitRules = [...new Set(findings.map((f) => f.rule))];
  rows.push([hitRules.length ? "CAUGHT" : "MISSED", label, hitRules.join(",") || "-"]);
  (hitRules.length ? summary.hit : summary.miss).push(label);
}
const w = Math.max(...rows.map((r) => r[1].length));
for (const [status, label, rule] of rows) {
  console.log(`  ${status}  ${label.padEnd(w)}  ${rule}`);
}
console.log(`\n  caught ${summary.hit.length}/${CASES.length}, missed ${summary.miss.length}/${CASES.length}`);
console.log("  MISSED set:", summary.miss.join(" | "));

console.log("\n=== rule-level detail: which default rule covers which family ===");
for (const r of DEFAULT_SECRET_PATTERNS) console.log(`  ${r.rule.padEnd(28)} ${r.pattern}`);

console.log("\n=== false positives: default rules applied to this package's own sources ===");
const walkTs = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (/\.(ts|mjs|js|json|md)$/.test(e.name)) out.push(p);
  }
  return out;
};
const own = walkTs(path.join(import.meta.dirname, "..", "..", "src"));
let falsePositives = 0;
for (const f of own) {
  const { findings } = scanAndRedactSecrets(fs.readFileSync(f, "utf8"), rules, path.basename(f));
  for (const fnd of findings) {
    falsePositives++;
    console.log(`  FP ${path.relative(process.cwd(), f)}:${fnd.line} [${fnd.rule}] ${fnd.snippet.slice(0, 90)}`);
  }
}
console.log(`  files scanned: ${own.length}, findings: ${falsePositives} (a real repo would redact these lines for real)`);
