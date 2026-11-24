#!/usr/bin/env node
/**
 * Fetch the full M8ven Tool Trust report for this repository.
 *
 * The key is a secret and is never printed. It is read from M8VEN_API_KEY, or from a single-line
 * .m8ven-key file in the repository root (gitignored). The script exits 2 with instructions when
 * neither exists, so an accidental run cannot silently use an anonymous, reduced response.
 *
 * Create a key at https://m8ven.ai/developers/dashboard/keys, then either:
 *   set M8VEN_API_KEY=...          (current shell)
 *   or save the key to .m8ven-key  (one line, no quotes)
 *
 * Usage:
 *   node scripts/m8ven-report.mjs          summary and findings
 *   node scripts/m8ven-report.mjs --json   full response
 */
import * as fs from "node:fs";
import * as path from "node:path";

const KEY_FILE = path.join(process.cwd(), ".m8ven-key");
const TARGET = "https://github.com/ankurhalder/codebase-snapshot";
const ENDPOINT = "https://m8ven.ai/api/mcp/score?url=" + encodeURIComponent(TARGET);

function readKey() {
  const fromEnv = process.env.M8VEN_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (fs.existsSync(KEY_FILE)) {
    const fromFile = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (fromFile) return fromFile;
  }
  return "";
}

const key = readKey();
if (!key) {
  console.error("M8ven: no API key found.");
  console.error("Create one at https://m8ven.ai/developers/dashboard/keys");
  console.error("Then save it, one line, to .m8ven-key in this repository, or set M8VEN_API_KEY.");
  console.error(".m8ven-key is gitignored; do not commit it.");
  process.exit(2);
}

let response;
try {
  response = await fetch(ENDPOINT, {
    headers: { authorization: "Bearer " + key, accept: "application/json" },
  });
} catch (error) {
  console.error("M8ven: request failed: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}

const text = await response.text();
if (!response.ok) {
  console.error("M8ven: HTTP " + response.status + " " + text.slice(0, 500));
  process.exit(1);
}

let data;
try {
  data = JSON.parse(text);
} catch {
  console.error("M8ven: response was not JSON: " + text.slice(0, 500));
  process.exit(1);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(data, null, 2));
  // Do not call process.exit() here: on Windows a large stdout write can still be pending and
  // process.exit aborts the pipe with a libuv assertion. Setting the code lets Node flush and exit.
  process.exitCode = 0;
} else {

console.log("M8ven Tool Trust: " + (data.grade ?? "?") + " · " + (data.verdict ?? "?") + " · depth " + (data.depth ?? "?"));
if (data.score !== undefined) console.log("score: " + data.score);
if (data.verdict_reason) console.log("verdict reason: " + data.verdict_reason);
if (data.sub_scores) console.log("sub-scores: " + JSON.stringify(data.sub_scores));
if (data.trust_grade && data.trust_grade !== data.grade) console.log("trust grade: " + data.trust_grade);
if (data.verified !== undefined) console.log("verified: " + data.verified);
if (data.listing_url) console.log("listing: " + data.listing_url);
if (data.upgrade) console.log("upgrade: " + data.upgrade);
if (data.paid_only?.length) console.log("paid-only fields: " + data.paid_only.join(", "));

const findings = Array.isArray(data.findings) ? data.findings : [];
if (findings.length > 0) {
  console.log("\nfindings (" + findings.length + "):");
  for (const finding of findings) {
    const status = finding.status ?? finding.severity ?? "?";
    console.log("- [" + status + "] " + (finding.name ?? "finding") + ": " + (finding.detail ?? ""));
  }
} else {
  console.log("\nfindings: none returned");
}

if (Array.isArray(data.tools) && data.tools.length > 0) {
  const names = data.tools.map((tool) => (typeof tool === "string" ? tool : tool.name)).filter(Boolean);
  console.log("\ntools (" + names.length + "): " + names.join(", "));
}
if (data.capabilities) console.log("\ncapabilities: " + JSON.stringify(data.capabilities));
if (data.env_vars) console.log("\nenvironment: " + JSON.stringify(data.env_vars));
if (data.cves) console.log("\ncves: " + JSON.stringify(data.cves));
if (data.live_introspection) console.log("\nlive introspection: " + JSON.stringify(data.live_introspection, null, 2));

if (Object.keys(data).length === 0) console.log("(empty response)");
}
