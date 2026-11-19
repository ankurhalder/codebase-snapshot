#!/usr/bin/env node
/**
 * A head-to-head benchmark: this tool against repomix (and gitingest, if installed).
 *
 * The point is not to win a token contest — the two tools count tokens differently and pack
 * different file sets — but to make the difference visible and repeatable. Every number is
 * measured on the repository you point it at, in the same run, and the caveats are printed with
 * the table.
 *
 * Usage: node scripts/compare.mjs [repo] [--repomix] [--gitingest] [--json]
 *
 * repomix is run through `npx`, so it is fetched at run time and is never a dependency of this
 * package. If it cannot be fetched the script says so and reports only this tool's numbers.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BIN = path.join(HERE, "..", "dist", "bin.js");
const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const repo = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? path.join(HERE, ".."));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "compare-"));
const question = "how does the snapshot generator partition files";

function finish(code) {
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(code);
}

function ours(label, extra) {
  const outDir = path.join(scratch, label);
  const started = process.hrtime.bigint();
  const result = spawnSync(
    process.execPath,
    [BIN, "generate", "--out-dir", outDir, ...extra],
    { cwd: repo, encoding: "utf8" }
  );
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.status !== 0) {
    console.error(label + " failed: " + ((result.stderr ?? "") + (result.stdout ?? "")).trim().slice(0, 400));
    finish(1);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  return {
    label,
    files: manifest.files.length,
    bytes: manifest.totals.totalContentBytes ?? manifest.totals.totalSizeBytes,
    tokens: manifest.totals.estimatedTokens ?? 0,
    ms,
  };
}

/** Runs repomix and returns its own accounting, or a reason it is not available. */
function repomix() {
  const output = path.join(scratch, "repomix.md");
  const packed = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["--yes", "repomix@1.19.0", "--quiet", "--style", "markdown", "--output", output],
    { cwd: repo, encoding: "utf8", timeout: 600000, shell: process.platform === "win32" }
  );
  if (packed.status !== 0) {
    return { available: false, reason: ((packed.stderr ?? "") + (packed.stdout ?? "")).trim().split("\n").pop() };
  }
  const counted = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["--yes", "repomix@1.19.0", "--token-count-tree"],
    { cwd: repo, encoding: "utf8", timeout: 600000, shell: process.platform === "win32" }
  );
  const text = (counted.stdout ?? "") + (counted.stderr ?? "");
  const tokens = /Total Tokens:\s*([\d,]+)/.exec(text);
  const files = /Total Files:\s*([\d,]+)/.exec(text);
  if (tokens === null) return { available: false, reason: "repomix ran but printed no token total" };
  return {
    available: true,
    files: files === null ? null : Number(files[1].replace(/,/g, "")),
    tokens: Number(tokens[1].replace(/,/g, "")),
    bytes: fs.statSync(output).size,
  };
}

/** gitingest writes a digest to stdout; it reports size, not tokens. */
function gitingest() {
  const result = spawnSync("python", ["-m", "gitingest", "--output", "-", repo], {
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 64 * 1024 * 1024,
    // gitingest prints a directory tree; on Windows its stdout is cp1252 unless told otherwise and
    // it aborts with "charmap codec can't encode" before writing anything.
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  if (result.status !== 0) return { available: false, reason: ((result.stderr ?? "") + (result.stdout ?? "")).trim().split("\n").pop() };
  return { available: true, bytes: Buffer.byteLength(result.stdout ?? "", "utf8") };
}

const rows = [
  ours("full", []),
  ours("slice", ["--slice", question, "--slice-tokens", "30000"]),
  ours("budget", ["--budget-tokens", "30000"]),
];
const baseline = rows[0].tokens;

const summary = { repo, question, ours: rows };
if (flags.has("--repomix")) {
  const result = repomix();
  summary.repomix = result;
  if (!result.available) console.error("repomix: not available (" + result.reason + "); comparison skipped");
}
if (flags.has("--gitingest")) {
  const result = gitingest();
  summary.gitingest = result;
  if (!result.available) console.error("gitingest: not available (" + result.reason + "); comparison skipped");
}

if (flags.has("--json")) {
  console.log(JSON.stringify(summary, null, 2));
  finish(0);
}

console.log("| Tool / mode | Files | Content bytes | Tokens | vs full | Time |");
console.log("| :-- | --: | --: | --: | --: | --: |");
for (const row of rows) {
  const share = row.tokens === baseline ? "100%" : ((row.tokens / baseline) * 100).toFixed(1) + "%";
  console.log(
    "| codebase-snapshot (" + row.label + ") | " + row.files + " | " + row.bytes.toLocaleString("en-US") +
      " | " + row.tokens.toLocaleString("en-US") + " | " + share + " | " + (row.ms / 1000).toFixed(2) + " s |"
  );
}
if (summary.repomix?.available) {
  const result = summary.repomix;
  console.log(
    "| repomix 1.19.0 | " + (result.files ?? "?") + " | " + result.bytes.toLocaleString("en-US") + " | " +
      result.tokens.toLocaleString("en-US") + " | " + ((result.tokens / baseline) * 100).toFixed(1) + "% | n/a |"
  );
}
if (summary.gitingest?.available) {
  console.log(
    "| gitingest | ? | " + summary.gitingest.bytes.toLocaleString("en-US") + " | n/a | n/a | n/a |"
  );
}
console.log("");
console.log("repo: " + repo);
console.log("question: " + question);
console.log("");
console.log("Caveats, stated because they change the answer:");
console.log("- Token counts are each tool's own. codebase-snapshot estimates ceil(bytes / 4); repomix uses its own tokenizer, so the counts are not interchangeable.");
console.log("- File sets differ: this tool applies its own ignore rules and skips binaries; repomix applies its defaults.");
console.log("- A slice or budget is the same snapshot narrowed after scanning, so its time is the full scan plus the plan, not a cheaper scan.");
finish(0);
