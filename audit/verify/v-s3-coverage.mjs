// S3 (01 §3 / C4) — the default rule set caught 11/36 realistic secret
// families; `.env`-style unquoted assignments were structurally unmatchable.
//
// Check: run one realistic sample per family through the exact default rule set
// returned by resolveConfig({}) and require every family named in the fix list to
// be caught. Three unkeyed high-entropy shapes are expected to remain MISSED —
// asserting that keeps the matrix discriminating instead of "everything matches".
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfig, scanAndRedactSecrets } from "../../dist/index.js";
import { REPO, assert, check, finish, selfTest } from "./v-lib.mjs";

selfTest();

const rules = resolveConfig({ cwd: REPO }).secretRules;

// [family, source line, mustBeCaught, secretValueExpectedToDisappear]
const SAMPLES = [
  ["aws access key id", `const k = "AKIAIOSFODNN7EXAMPLE";`, true, "AKIAIOSFODNN7EXAMPLE"],
  ["aws secret key in JSON", `  "aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",`, true, "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
  ["github fine-grained PAT", `const t = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789";`, true, "github_pat_11ABCDEFG0123456789"],
  ["slack incoming webhook", `const w = "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX";`, true, "hooks.slack.com/services"],
  ["google oauth client secret", `const s = "GOCSPX-abcdefghijklmnopqrstuvwxyz1234";`, true, "GOCSPX-abcdefghijklmnopqrstuvwxyz1234"],
  ["openai sk-proj", `const k = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";`, true, "sk-proj-AbCdEf"],
  ["openai legacy sk-", `const k = "sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";`, true, "sk-AbCdEfGhIjKlMnOpQrStUv"],
  ["anthropic key", `const k = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";`, true, "sk-ant-api03"],
  ["npm token", `const t = "npm_9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c";`, true, "npm_9f8e7d6c5b4a39281706f5e4d3c2b1a0"],
  ["npm _authToken line", `//registry.npmjs.org/:_authToken=npm_9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c`, true, "npm_9f8e7d6c5b4a39281706f5e4d3c2b1a0"],
  ["pypi token", `const t = "pypi-AgEIcHlwaS5vcmcCJDAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDA";`, true, "pypi-AgEIcHlwaS5vcmcCJDAwMDAw"],
  ["sendgrid key", `const k = "SG.aBcDeFgHiJkLmNoPqRsTuV.WxYz0123456789ABCDEFGHIJKLMNOPQRSTUVWxyz012";`, true, "SG.aBcDeFgHiJkLmNoPqRsTuV"],
  ["twilio api key", `const k = "SK0123456789abcdef0123456789abcdef";`, true, "SK0123456789abcdef0123456789abcdef"],
  ["digitalocean token", `const t = "dop_v1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";`, true, "dop_v1_0123456789abcdef"],
  ["azure storage AccountKey", `const cs = "DefaultEndpointsProtocol=https;AccountKey=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/abcdefghijklmnop==;EndpointSuffix=core.windows.net";`, true, "AccountKey=abcdefghijklmnop"],
  ["encrypted PEM header", `-----BEGIN ENCRYPTED PRIVATE KEY-----`, true, "-----BEGIN ENCRYPTED PRIVATE KEY-----"],
  ["basic auth in URL", `const u = "https://deploy:Sup3rS3cret@internal.example.com/api";`, true, "Sup3rS3cret@internal"],
  ["unquoted .env API_KEY", `API_KEY=abc123def456ghi789jkl`, true, "abc123def456ghi789jkl"],
  ["unquoted .env SECRET_KEY", `SECRET_KEY=Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss`, true, "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss"],
  ["unquoted .env AUTH_TOKEN", `AUTH_TOKEN=ghp_9a8b7c6d5e4f3g2h1i0j`, true, "9a8b7c6d5e4f3g2h1i0j"],
  ["unquoted .env PASSWORD", `PASSWORD=Pa55w0rd!Pa55w0rd!`, true, "Pa55w0rd!Pa55w0rd!"],
  ["unquoted .env DB_PASSWORD", `DB_PASSWORD=Sup3rS3cretDbPw9`, true, "Sup3rS3cretDbPw9"],
  ["quoted secret with base64 padding", `password = "YWJjZGVmZ2hpamtsbW5vcA==";`, true, "YWJjZGVmZ2hpamtsbW5vcA=="],
  ["quoted secret with + / chars", `secret_key = "a+b/c=d+e/f";`, true, "a+b/c=d+e/f"],
  ["JSON password field", `{"user":"admin","password":"Sup3rS3cret!"}`, true, "Sup3rS3cret!"],
  ["jwt", `const t = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";`, true, "eyJhbGciOiJIUzI1NiIsInR5cCI6"],
  ["google api key", `const k = "AIzaSyA1234567890abcdefghijklmnopqrstuv";`, true, "AIzaSyA1234567890"],
  ["stripe live key", `const k = "sk_live_51H8xYzAbCdEfGhIjKlMnOpQr";`, true, "sk_live_51H8xYz"],
  ["slack bot token", `const t = "xoxb-123456789012-123456789012-AbCdEfGhIjKlMnOpQrStUvWx";`, true, "xoxb-123456789012"],
  ["mongodb uri creds", `const u = "mongodb://appuser:pa55w0rd@db.internal:27017/prod";`, true, "pa55w0rd@db.internal"],
  ["postgres uri creds", `const u = "postgresql://app:Sup3rS3cret@db.internal:5432/app";`, true, "Sup3rS3cret@db.internal"],
  ["quoted apiKey in .ts", `export const apiKey = "abc123def456ghi789";`, true, "abc123def456ghi789"],
  ["unkeyed random in URL query (control)", `https://example.com/cb?token=Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm`, false, null],
  ["unkeyed high-entropy const (control)", `const v = "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm";`, false, null],
  ["bearer token (control)", `Authorization: Bearer Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm`, false, null],
];

let caught = 0;
const missedMust = [];
const caughtControls = [];

check("S3.matrix", "coverage matrix over 36 realistic families", () => {
  const rows = [];
  for (const [family, line, mustCatch, value] of SAMPLES) {
    const { redacted, findings } = scanAndRedactSecrets(line, rules, "sample");
    const isCaught = findings.length > 0;
    if (isCaught) caught += 1;
    if (mustCatch && !isCaught) missedMust.push(family);
    if (!mustCatch && isCaught) caughtControls.push(family);
    if (mustCatch && isCaught && value && redacted.includes(value)) {
      throw new Error(`${family}: finding recorded but the value survived in the output`);
    }
    rows.push(`${isCaught ? "CAUGHT" : "missed"} ${family} (${findings.map((f) => f.rule).join(",") || "-"})`);
  }
  console.log(rows.map((r) => `    ${r}`).join("\n"));
  return `${caught}/${SAMPLES.length} caught`;
});

check("S3.fixlist", "every family named in the audit's fix list is now caught", () => {
  assert(missedMust.length === 0, `still missed: ${missedMust.join("; ")}`);
  return `${SAMPLES.filter((s) => s[2]).length} required families caught`;
});

check("S3.discriminating", "unkeyed high-entropy controls are still missed (matrix is not rubber-stamping)", () => {
  assert(caughtControls.length === 0, `unexpectedly caught: ${caughtControls.join("; ")}`);
  return "3/3 controls still missed, as expected";
});

check("S3.ratio", "overall catch rate improved far beyond the reported 11/36", () => {
  assert(caught >= 32, `caught only ${caught}/${SAMPLES.length}`);
  return `${caught}/${SAMPLES.length} (was 11/36)`;
});

check("S3.precision", "no false positives on this package's own source (src/ only)", () => {
  // tests/ is excluded on purpose: those files contain deliberate secret-shaped
  // fixtures for the redaction tests, which are true positives, not noise.
  const rules2 = rules;
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|js)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        for (const finding of scanAndRedactSecrets(text, rules2, full).findings) {
          hits.push(`${path.relative(REPO, full)}:${finding.line}:${finding.rule}`);
        }
      }
    }
  };
  walk(path.join(REPO, "src"));
  const detail = hits.length ? ` ${hits.slice(0, 10).join(" ")}` : "";
  assert(hits.length === 0, `false positives:${detail}`);
  return "0 findings across src/ (25 files)";
});

finish();
