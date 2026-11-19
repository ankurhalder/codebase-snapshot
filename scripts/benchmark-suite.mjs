#!/usr/bin/env node
/**
 * The ten-repository comparison: our three packs, repomix and gitingest on the same public
 * repositories, cloned shallow and measured in one run.
 *
 * Usage: node scripts/benchmark-suite.mjs [--json] [url ...]
 *
 * Default repositories are small and public, so the run is minutes rather than an afternoon. A
 * repository that cannot be cloned or processed is reported as skipped with the reason; it is never
 * dropped silently from the table.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BIN = path.join(HERE, "..", "dist", "bin.js");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const DEFAULT_REPOS = [
  "https://github.com/jonschlinkert/is-odd",
  "https://github.com/chalk/chalk",
  "https://github.com/tj/co",
  "https://github.com/isaacs/minimatch",
  "https://github.com/moment/luxon",
  "https://github.com/psf/requests",
  "https://github.com/pallets/click",
  "https://github.com/expressjs/express",
  "https://github.com/colinhacks/zod",
  "https://github.com/anuraghazra/github-readme-stats",
];
const repos = args.filter((arg) => !arg.startsWith("--"));
const targets = repos.length > 0 ? repos : DEFAULT_REPOS;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bench-suite-"));

const run = (command, argv, options = {}) => {
  const result = spawnSync(command, argv, { encoding: "utf8", ...options, env: { ...process.env, ...(options.env ?? {}) } });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

function ours(repo) {
  const started = process.hrtime.bigint();
  const outDir = path.join(scratch, "ours-" + Math.random().toString(36).slice(2, 8));
  const result = run(process.execPath, [BIN, "generate", "--cwd", repo, "--out-dir", outDir], { cwd: repo });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (!result.ok) return { ok: false, reason: (result.stderr + result.stdout).trim().split("\n").pop() };
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  fs.rmSync(outDir, { recursive: true, force: true });
  return {
    ok: true,
    files: manifest.counts.totalFiles,
    bytes: manifest.totals.totalContentBytes ?? manifest.counts.totalSizeBytes,
    tokens: manifest.totals.estimatedTokens ?? 0,
    ms,
  };
}

/** Runs npx without shell:true (Node warns about unescaped arguments with it). */
function npx(args, options) {
  if (process.platform === "win32") {
    const quoted = args
      .map((arg) =>
        arg.indexOf(" ") === -1 && arg.indexOf(String.fromCharCode(34)) === -1
          ? arg
          : String.fromCharCode(34) + arg.split(String.fromCharCode(34)).join(String.fromCharCode(34, 34)) + String.fromCharCode(34)
      )
      .join(" ");
    return run("cmd.exe", ["/d", "/s", "/c", "npx " + quoted], options);
  }
  return run("npx", args, options);
}

function repomix(repo) {
  const out = path.join(scratch, "repomix-" + Math.random().toString(36).slice(2, 8) + ".md");
  const packed = npx([
    "--yes", "repomix@1.19.0", "--quiet", "--style", "markdown", "--output", out,
  ], { cwd: repo, timeout: 600000 });
  if (!packed.ok) return { ok: false, reason: "repomix did not run" };
  const counted = npx(["--yes", "repomix@1.19.0", "--token-count-tree"], { cwd: repo, timeout: 600000 });
  const text = counted.stdout + counted.stderr;
  const tokens = /Total Tokens:\s*([\d,]+)/.exec(text);
  const files = /Total Files:\s*([\d,]+)/.exec(text);
  const bytes = fs.existsSync(out) ? fs.statSync(out).size : 0;
  fs.rmSync(out, { force: true });
  if (tokens === null) return { ok: false, reason: "repomix printed no token total" };
  return {
    ok: true,
    files: files === null ? null : Number(files[1].replace(/,/g, "")),
    bytes,
    tokens: Number(tokens[1].replace(/,/g, "")),
  };
}

function gitingest(repo) {
  const result = run("python", ["-m", "gitingest", repo, "-o", "-"], {
    env: { PYTHONIOENCODING: "utf-8" },
    timeout: 600000,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (!result.ok) return { ok: false, reason: "gitingest did not run" };
  return { ok: true, bytes: Buffer.byteLength(result.stdout, "utf8") };
}

const rows = [];
for (const url of targets) {
  const name = url.replace(/\.git$/, "").split("/").slice(-2).join("/");
  const clone = path.join(scratch, "clone-" + Math.random().toString(36).slice(2, 8));
  process.stderr.write("cloning " + name + " ... ");
  const cloned = run("git", ["clone", "--depth", "1", "--quiet", url, clone], { timeout: 600000 });
  if (!cloned.ok) {
    process.stderr.write("skipped (clone failed)\n");
    rows.push({ name, skipped: "clone failed" });
    continue;
  }
  process.stderr.write("done\n  our pack ... ");
  const oursRow = ours(clone);
  process.stderr.write("done\n  repomix ... ");
  const repomixRow = repomix(clone);
  process.stderr.write("done\n  gitingest ... ");
  const gitingestRow = gitingest(clone);
  process.stderr.write("done\n");
  rows.push({ name, ours: oursRow, repomix: repomixRow, gitingest: gitingestRow });
  fs.rmSync(clone, { recursive: true, force: true });
}

if (asJson) {
  console.log(JSON.stringify({ rows }, null, 2));
} else {
  console.log("| Repository | Ours files | Ours tokens | repomix tokens | repomix ÷ ours | gitingest bytes |");
  console.log("| :-- | --: | --: | --: | --: | --: |");
  for (const row of rows) {
    if (row.skipped !== undefined) {
      console.log("| " + row.name + " | skipped: " + row.skipped + " | | | | |");
      continue;
    }
    const oursTokens = row.ours.ok ? row.ours.tokens : null;
    const repomixTokens = row.repomix.ok ? row.repomix.tokens : null;
    const ratio = oursTokens !== null && repomixTokens !== null ? (repomixTokens / oursTokens).toFixed(2) : "n/a";
    console.log(
      "| " + row.name + " | " + (row.ours.ok ? row.ours.files : "failed") + " | " +
        (oursTokens === null ? "failed" : oursTokens.toLocaleString("en-US")) + " | " +
        (repomixTokens === null ? "n/a" : repomixTokens.toLocaleString("en-US")) + " | " + ratio + " | " +
        (row.gitingest.ok ? row.gitingest.bytes.toLocaleString("en-US") : "n/a") + " |"
    );
  }
}

fs.rmSync(scratch, { recursive: true, force: true });
