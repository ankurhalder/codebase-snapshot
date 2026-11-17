#!/usr/bin/env node
/**
 * A reproducible benchmark of the three packers this tool offers.
 *
 * It measures what the product claims, on a repository you point it at: the whole snapshot, a task
 * slice, and a token budget. Numbers are tokens (the same estimate the manifest carries) and wall
 * time for a generate, so a reader can check the claim rather than take it.
 *
 * Usage: node scripts/benchmark.mjs [repo] [question]
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BIN = path.join(import.meta.dirname, "..", "dist", "bin.js");
const repo = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const question = process.argv[3] ?? "how does the snapshot generator partition files";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));

function run(label, args) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: "utf8" });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.status !== 0) {
    console.error(label + " failed: " + ((result.stderr ?? "") + (result.stdout ?? "")).trim().slice(0, 400));
    process.exit(1);
  }
  const outDir = args[args.indexOf("--out-dir") + 1] ?? "snapshot";
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, outDir, "manifest.json"), "utf8"));
  return {
    label,
    ms,
    files: manifest.files.length,
    parts: manifest.counts.partsCount,
    bytes: manifest.totals.totalContentBytes ?? manifest.totals.totalSizeBytes,
    tokens: manifest.totals.estimatedTokens ?? 0,
  };
}

const rows = [];
rows.push(run("full", ["generate", "--out-dir", "snapshot-bench-full"]));
rows.push(run("slice", ["generate", "--out-dir", "snapshot-bench-slice", "--slice", question, "--slice-tokens", "30000"]));
rows.push(run("budget", ["generate", "--out-dir", "snapshot-bench-budget", "--budget-tokens", "30000"]));

const baseline = rows[0];
console.log("| Mode | Files | Parts | Tokens | vs full | Time |");
console.log("| :-- | --: | --: | --: | --: | --: |");
for (const row of rows) {
  const share = row === baseline ? "100%" : ((row.tokens / baseline.tokens) * 100).toFixed(1) + "%";
  console.log(
    "| " + row.label + " | " + row.files + " | " + row.parts + " | " + row.tokens + " | " + share +
      " | " + (row.ms / 1000).toFixed(2) + " s |"
  );
}
console.log("");
console.log("question: " + question);
console.log("repo: " + repo);

for (const name of ["snapshot-bench-full", "snapshot-bench-slice", "snapshot-bench-budget"]) {
  fs.rmSync(path.join(repo, name), { recursive: true, force: true });
}
fs.rmSync(scratch, { recursive: true, force: true });
