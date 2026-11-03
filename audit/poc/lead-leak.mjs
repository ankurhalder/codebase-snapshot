import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { generateSnapshot } from "../../dist/index.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lead-poc-"));
const w = (rel, content) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

// A realistic multi-line private key: only the BEGIN line has the header.
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAwSENTINELBODYSECRET1234567890abcdefghijkl",
  "mnopqrstuvwxyzSENTINELBODYSECRET1111111111111111111111111",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

w("src/aws.ts", 'const k = "AKIAIOSFODNN7EXAMPLE";\nconst safe = "hello";\n');
w("src/key.pem", PEM + "\n");
w(
  ".env",
  ["DB_PASSWORD=hunter2", "OPENAI_API_KEY=sk-proj-AAAA1111BBBB2222CCCC3333", "NPM_TOKEN=npm_abc123def456ghi789jkl012mno345pqr678stu", ""].join("\n")
);
w("package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }));

execSync("git init -q && git add -A && git -c user.email=a@b -c user.name=a commit -qm init", { cwd: tmp, stdio: "ignore" });

const manifest = await generateSnapshot({ cwd: tmp, outDir: "snapshot", tmpDir: "snapshot.tmp", maxPartBytes: 300 * 1024, largeFileBytes: 200 * 1024 });

const SECRETS = {
  "AWS key (AKIA...)": "AKIAIOSFODNN7EXAMPLE",
  "PEM key BODY line 2": "MIIEowIBAAKCAQEAwSENTINELBODYSECRET",
  "PEM key BODY line 3": "mnopqrstuvwxyzSENTINELBODYSECRET",
  ".env DB_PASSWORD": "hunter2",
  ".env OPENAI sk- key": "sk-proj-AAAA1111BBBB2222CCCC3333",
  ".env NPM_TOKEN": "npm_abc123def456ghi789jkl012mno345pqr678stu",
};

function scan(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

const snapDir = path.join(tmp, "snapshot");
const files = scan(snapDir);

console.log("=== 1. LEAK MATRIX: which emitted artifact still contains each secret? ===\n");
const rows = [];
for (const [label, secret] of Object.entries(SECRETS)) {
  const hits = files
    .filter((f) => fs.readFileSync(f, "utf8").includes(secret))
    .map((f) => path.relative(snapDir, f).replace(/\\/g, "/"));
  rows.push([label, hits.length ? hits.join(", ") : "(none - redacted everywhere)"]);
}
for (const [a, b] of rows) console.log(`  ${a.padEnd(24)} -> ${b}`);

console.log("\n=== 2. What did audit.md actually write for the AWS line? ===\n");
const audit = fs.readFileSync(path.join(snapDir, "reports/audit.md"), "utf8");
for (const line of audit.split("\n")) {
  if (line.startsWith("| `") && line.includes("AKIA")) console.log("  " + line);
}

console.log("\n=== 3. Over-redaction: whole line destroyed instead of just the secret? ===\n");
const parts = files.filter((f) => f.includes("parts"));
const allParts = parts.map((f) => fs.readFileSync(f, "utf8")).join("\n");
for (const line of allParts.split("\n")) {
  if (line.includes("REDACTED")) console.log("  " + line);
}

console.log("\n=== 4. inclusionMode / totals consistency ===\n");
console.log(" ", JSON.stringify(manifest.totals, null, 0).replace(/,"/g, ', "'));
console.log("   totalContentBytes == totalSizeBytes ?", manifest.totals.totalContentBytes === manifest.totals.totalSizeBytes);
console.log("   validation.status (never computed) =", manifest.validation.status);

console.log("\n=== 5. navigation anchor links vs. headings actually emitted ===\n");
const nav = fs.readFileSync(path.join(snapDir, "reports/navigation.md"), "utf8");
const link = nav.split("\n").find((l) => l.includes("aws.ts") && l.startsWith("| [`"));
console.log("  nav link: " + (link || "(not found)").slice(0, 130));
const emittedAnchors = [...allParts.matchAll(/^### FILE: (.+)$/gm)].map((m) => m[1]);
console.log("  headings emitted in parts:", emittedAnchors.length, "-> e.g. 'FILE: " + (emittedAnchors[0] || "") + "'");
console.log("  does any part emit an explicit anchor like <a id=...> or '#'+anchorForPath?", /<a id=|{#/.test(allParts));

console.log("\nTMP:", tmp);
