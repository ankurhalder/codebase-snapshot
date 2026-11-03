/**
 * PoC 1 (end-to-end): does a detected secret still reach a shared artifact?
 *
 * Builds a throw-away git repo containing realistic secret material, runs the
 * PUBLIC generateSnapshot() from dist, then greps every emitted file for each
 * secret and tries to reconstruct a usable private key out of parts/*.md.
 *
 * Run:  node audit/poc/security-e2e-snapshot.mjs
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { generateSnapshot } from "../../dist/index.js";

const HERE = import.meta.dirname;
const FIX = path.join(HERE, "security-fixture-e2e");
if (!FIX.startsWith(path.join(HERE, "security-fixture"))) {
  throw new Error("refusing to touch unexpected path: " + FIX);
}
fs.rmSync(FIX, { recursive: true, force: true });
fs.mkdirSync(FIX, { recursive: true });

const write = (rel, content) => {
  const p = path.join(FIX, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
};

// ---- a REAL, usable RSA private key (pkcs1 => -----BEGIN RSA PRIVATE KEY-----)
const { privateKey: rsaPem, publicKey: rsaPub } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const AWS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const MONGO = "mongodb://appuser:pa55w0rd@db.internal:27017/prod";
const ENV_PASSWORD = "hunter2-NotARealPassword";
const ENV_OPENAI = "sk-proj-AbCdEf0123456789QwErTyUiOp";
const ENV_NPM = "npm_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const BASIC_AUTH_PASS = "Sup3rS3cretPass";
const B64_SECRET = "dGhpcy1pcy1hLXZlcnktbG9uZy1iYXNlNjQtc2VjcmV0LXZhbHVlPT0=";
const QUOTED_API_KEY = "0123456789abcdefQRSTuvwx";

write("src/aws.ts", [
  "// one physical line: real secret + unrelated code that will be destroyed",
  `export const awsKey = "${AWS_KEY_ID}"; export const region = "us-east-1"; const retries = 3;`,
  "export const safe = 'nothing to see here';",
  "",
].join("\n"));

write("src/tokens.ts", [
  `export const apiKey = "${QUOTED_API_KEY}";`,
  `export const jwt = "${JWT}";`,
  `export const db = "${MONGO}";`,
  "",
].join("\n"));

write(".env", [
  "# committed by accident, still picked up",
  `DB_PASSWORD=${ENV_PASSWORD}`,
  `OPENAI_API_KEY=${ENV_OPENAI}`,
  `NPM_TOKEN=${ENV_NPM}`,
  `SECRET_KEY="${B64_SECRET}"`,
  "",
].join("\n"));

write(".npmrc", `//registry.npmjs.org/:_authToken=${ENV_NPM}\n`);

write("keys/id_rsa", rsaPem);
write("keys/server.pem", rsaPem);

write("deploy.sh", [
  "#!/usr/bin/env bash",
  `curl -sS https://deploy-bot:${BASIC_AUTH_PASS}@api.internal.example.com/deploy`,
  "",
].join("\n"));

write("config/credentials.json", JSON.stringify(
  { aws_secret_access_key: AWS_SECRET, region: "us-east-1" }, null, 2) + "\n");

// real git repo so the git ls-files code path (not the walk fallback) is used
const git = (...a) => execFileSync("git", a, { cwd: FIX, stdio: "ignore" });
git("init", "-q");
git("add", "-A");
git("-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "fixture");

const manifest = await generateSnapshot({
  cwd: FIX,
  outDir: "snapshot",
  tmpDir: "snapshot.tmp",
});

const SNAP = path.join(FIX, "snapshot");
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const artifacts = walk(SNAP)
  .filter((f) => !f.endsWith("manifest.json")) // manifest scanned separately
  .map((f) => ({ rel: path.relative(SNAP, f).replace(/\\/g, "/"), text: fs.readFileSync(f, "utf8") }));
const manifestText = fs.readFileSync(path.join(SNAP, "manifest.json"), "utf8");

const SECRETS = [
  ["AWS access key id (default rule)", AWS_KEY_ID],
  ["AWS secret key (default rule)", AWS_SECRET],
  ["JWT (default rule)", JWT],
  ["mongodb URI creds (default rule)", MONGO],
  ["quoted apiKey in .ts (default rule)", QUOTED_API_KEY],
  [".env PASSWORD= (unquoted)", ENV_PASSWORD],
  [".env OPENAI_API_KEY=sk-proj-", ENV_OPENAI],
  [".env NPM_TOKEN=npm_", ENV_NPM],
  [".env SECRET_KEY=\"base64\"", B64_SECRET],
  ["Basic auth password in URL (.sh)", BASIC_AUTH_PASS],
  ["RSA key body line 1", rsaPem.split("\n")[1]],
  ["RSA key body line 2", rsaPem.split("\n")[2]],
  ["RSA key END line", "-----END RSA PRIVATE KEY-----"],
];

const pad = (s, n) => s.padEnd(n);
console.log("=== 1. FILES INCLUDED IN THE SNAPSHOT (scanner coverage) ===");
console.log("  totalFiles:", manifest.counts.totalFiles, "| warnings:", manifest.warnings.length);
const byPath = new Map();
for (const art of artifacts) {
  for (const m of art.text.matchAll(/^### FILE: (.+)$/gm)) byPath.set(m[1], art.rel);
}
for (const p of [...byPath.keys()].sort()) {
  const lang = artLang(p, artifacts);
  console.log(`  incl: ${pad(p, 24)} lang=${pad(lang, 10)} emitted in ${byPath.get(p)}`);
}
function artLang(p, arts) {
  for (const a of arts) {
    const i = a.text.indexOf(`### FILE: ${p}\n`);
    if (i >= 0) {
      const m = /^- Language: (.+)$/m.exec(a.text.slice(i, i + 600));
      if (m) return m[1].trim();
    }
  }
  return "?";
}

console.log("\n=== 2. LEAK MATRIX: which emitted artifact still contains the secret verbatim? ===");
for (const [label, secret] of SECRETS) {
  const hits = artifacts.filter((a) => a.text.includes(secret)).map((a) => a.rel);
  const inManifest = manifestText.includes(secret);
  const where = hits.length ? hits.join(", ") + (inManifest ? " (+manifest.json)" : "") : "(redacted everywhere)";
  const mark = hits.length ? "LEAK " : "OK   ";
  console.log(`  ${mark} ${pad(label, 40)} -> ${where}`);
}

console.log("\n=== 3. reports/audit.md: does it print the RAW line? ===");
const audit = artifacts.find((a) => a.rel === "reports/audit.md").text;
const auditLines = audit.split("\n");
auditLines.forEach((l, i) => {
  for (const [label, secret] of SECRETS) {
    if (l.includes(secret)) {
      console.log(`  audit.md:${i + 1}  [${label}]`);
      console.log(`    ${l}`);
    }
  }
});
const readmeLine = artifacts.find((a) => a.rel === "README.md").text
  .split("\n").find((l) => l.includes("audit.md"));
console.log("  snapshot/README.md advertises it as:", readmeLine.trim());

console.log("\n=== 4. Same secret value, side by side in parts/ vs reports/ ===");
const partsText = artifacts.filter((a) => a.rel.startsWith("parts/")).map((a) => a.text).join("\n");
for (const l of partsText.split("\n")) {
  if (l.includes("REDACTED: potential secret-like value")) console.log("  parts: " + l);
}
for (const l of audit.split("\n")) {
  if (l.startsWith("| `src/aws.ts`")) console.log("  audit: " + l);
}

console.log("\n=== 5. KEY RECONSTRUCTION: can a usable private key be rebuilt from parts/*.md? ===");
const idRsaParts = artifacts.filter((a) => a.rel.startsWith("parts/") && a.text.includes("### FILE: keys/id_rsa"));
const section = idRsaParts.length ? idRsaParts[0].text : "";
const remainder = section.slice(section.indexOf("### FILE: keys/id_rsa"));
const rLines = remainder.slice(remainder.indexOf("#### Content")).split("\n");
const openIdx = rLines.findIndex((l, i) => i > 0 && /^`{4,}/.test(l));
const fenceStr = rLines[openIdx].match(/^`{4,}/)[0];
const closeIdx = rLines.findIndex((l, i) => i > openIdx && l.trim() === fenceStr);
const bodyLines = rLines.slice(openIdx + 1, closeIdx);
console.log("  exact content line 1 as emitted:", JSON.stringify(bodyLines[0]));
console.log("  marker lines replaced:", bodyLines.filter((l) => l.includes("REDACTED")).length,
  "of", bodyLines.length, "lines | intact key-body lines:", bodyLines.filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l)).length);
let asIs;
try { crypto.createPrivateKey(bodyLines.join("\n") + "\n"); asIs = "parsed"; }
catch { asIs = "unparsable"; }
const restored = bodyLines.map((l) => (l.includes("REDACTED") ? "-----BEGIN RSA PRIVATE KEY-----" : l)).join("\n") + "\n";
let verdict;
try {
  const rebuilt = crypto.createPrivateKey(restored);
  const rebuiltPub = crypto.createPublicKey(rebuilt).export({ type: "spki", format: "pem" });
  verdict = (rebuiltPub === rsaPub ? "RECONSTRUCTED, usable key identical to original (public key matches)" : "parsed but public key differs")
    + ` | as-emitted body was ${asIs} -> a single-line header substitution makes it work`;
} catch (e) {
  verdict = "reconstruction failed: " + e.message;
}
console.log("  -->", verdict);

console.log("\n=== 6. manifest.json metadata leak ===");
console.log("  warnings sample:", JSON.stringify(manifest.warnings.slice(0, 4)));
console.log("\nFIXTURE:", FIX);
