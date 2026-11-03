/**
 * PoC 6:
 *  (a) AST/structured summaries are computed from RAW content (index.ts:151-155)
 *      and are emitted too -> a secret in a Markdown heading is redacted from the
 *      file body but survives in the summary (parts/*.md + manifest.json).
 *  (b) a `customPatterns` entry in a JSON config file (pattern is a string, not
 *      RegExp) makes scanAndRedactSecrets throw and aborts the whole run.
 *
 * Run:  node audit/poc/security-summary-and-config.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { generateSnapshot } from "../../dist/index.js";

const here = import.meta.dirname;
const FIX = path.join(here, "security-fixture-summary");
if (!FIX.startsWith(path.join(here, "security-fixture"))) throw new Error("unexpected path " + FIX);
fs.rmSync(FIX, { recursive: true, force: true });

const w = (rel, c) => {
  const p = path.join(FIX, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c, "utf8");
};

const MONGO = "mongodb://appuser:pa55w0rd@db.internal:27017/prod";
const AWS = "AKIAIOSFODNN7EXAMPLE";
w("docs/infra.md", [
  "# Infra",
  "",
  `## Prod database: ${MONGO}`,
  "",
  `### Deploy key id: ${AWS}`,
  "",
  "Body line, no heading.",
  "",
].join("\n"));
execFileSync("git", ["init", "-q"], { cwd: FIX, stdio: "ignore" });

const manifest = await generateSnapshot({ cwd: FIX, outDir: "snapshot", tmpDir: "snapshot.tmp" });
const SNAP = path.join(FIX, "snapshot");
const parts = fs.readdirSync(path.join(SNAP, "parts"))
  .map((f) => fs.readFileSync(path.join(SNAP, "parts", f), "utf8")).join("\n");
const manifestJson = fs.readFileSync(path.join(SNAP, "manifest.json"), "utf8");
const audit = fs.readFileSync(path.join(SNAP, "reports", "audit.md"), "utf8");

console.log("=== (a) summary is built from raw content, so headings leak even though the body is redacted ===");
console.log("  body in parts/ (heading lines):");
for (const l of parts.split("\n")) {
  if (/^#{1,6} /.test(l) && (l.includes("db.internal") || l.includes("AKIA"))) console.log("    " + l);
}
console.log("  REDACTED markers in file body:", (parts.match(/REDACTED: potential secret-like value/g) || []).length);
console.log(`  "- Summary:" block in parts/ contains MONGO: ${parts.includes(MONGO)}`);
console.log(`  "- Summary:" block in parts/ contains AWS id: ${parts.includes(AWS)}`);
console.log(`  manifest.json contains MONGO: ${manifestJson.includes(MONGO)}  |  contains AWS id: ${manifestJson.includes(AWS)}`);
console.log("  manifest summary.headings:", JSON.stringify(manifest.files[0].summary.headings));
console.log(`  reports/audit.md contains MONGO: ${audit.includes(MONGO)} (raw snippet table)`);

console.log("\n=== (b) .snapshotrc.json with customPatterns aborts the whole run ===");
const FIX2 = path.join(here, "security-fixture-jsoncfg");
if (!FIX2.startsWith(path.join(here, "security-fixture"))) throw new Error("unexpected path " + FIX2);
fs.rmSync(FIX2, { recursive: true, force: true });
const w2 = (rel, c) => {
  const p = path.join(FIX2, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c, "utf8");
};
w2("package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }) + "\n");
w2(".env", "MY_TOKEN=abc123def456ghi789jkl\n");
w2(".snapshotrc.json", JSON.stringify({
  secrets: { customPatterns: [{ rule: "my-token", pattern: "MY_TOKEN=[a-z0-9]+" }] },
}, null, 2));
const { spawnSync } = await import("node:child_process");
const res = spawnSync("node", [path.join(here, "..", "..", "dist", "cli.js"), "--cwd", FIX2], { encoding: "utf8" });
console.log("  CLI exit code:", res.status);
console.log("  CLI stderr:", (res.stderr || "").trim().split("\n").slice(-2).join(" | "));
console.log("  snapshot dir created:", fs.existsSync(path.join(FIX2, "snapshot")));
