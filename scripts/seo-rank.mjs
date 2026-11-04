/**
 * Measures discoverability: where this package ranks in npm search, and where
 * this repository ranks in GitHub repository search, for a fixed query set.
 *
 * The point is comparison over time. npm's search API scores almost purely on
 * text match — the quality/popularity/maintenance knobs are inert and a package
 * with 2.5k weekly downloads outranks one with 124M — so a keyword or
 * description change moves these numbers within about 45 minutes of publishing.
 * GitHub's index is Elasticsearch, rebuilt on push, scoring repository name,
 * description and topics; a README is only searched behind `in:readme`.
 *
 * Run it before and after a metadata change, and the difference is evidence
 * rather than opinion.
 *
 * Usage:
 *   node scripts/seo-rank.mjs             human-readable table
 *   node scripts/seo-rank.mjs --json      machine-readable to stdout
 *   node scripts/seo-rank.mjs --record    append the run to seo-log.jsonl
 *   node scripts/seo-rank.mjs --check     exit 1 when a flagship query regresses
 *
 * `--check` is for CI: it fails when a query we are supposed to win has slipped
 * past its target, which is the only automated way to notice a metadata
 * regression. It needs the network; offline runs should not use it.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const REPOSITORY = (pkg.repository?.url ?? "")
  .replace(/^git\+/, "")
  .replace(/\.git$/, "")
  .replace(/^https:\/\/github\.com\//, "");

/** Names that mean "this package", across the scoped-to-unscoped migration. */
const OUR_NAMES = ["codebase-snapshot", "@ankurhalder/codebase-snapshot"];
/** The scaffolder shares the name, and must not outrank the package itself. */
const SCAFFOLDER = "create-codebase-snapshot";

/**
 * `target` is the rank we claim we can hold. Only queries we already win get
 * one: an aspirational target that fails on day one trains everyone to ignore
 * the check.
 */
const NPM_QUERIES = [
  { text: "codebase snapshot", target: 3 },
  { text: "llm codebase", target: 3 },
  { text: "codebase prompt", target: null },
  { text: "repository to llm", target: null },
  { text: "llm context files", target: null },
  { text: "codebase to markdown", target: null },
  { text: "pack repo for ai", target: null },
  { text: "ai snapshot", target: null },
  { text: "context engineering tool", target: null },
  { text: "token efficient codebase", target: null },
];

const GITHUB_QUERIES = [
  { text: "codebase snapshot", target: null },
  { text: "codebase-snapshot", target: null },
  { text: "repo to llm", target: null },
  { text: "llm context codebase", target: null },
];

const WINDOW = 25;

function rankOf(names, candidates) {
  for (let index = 0; index < names.length; index += 1) {
    if (candidates.includes(names[index])) return { rank: index + 1, name: names[index] };
  }
  return { rank: null, name: null };
}

async function npmRank(text) {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${WINDOW}`;
  const response = await fetch(url, { headers: { "user-agent": "codebase-snapshot-seo-rank" } });
  if (!response.ok) throw new Error(`npm search returned ${response.status}`);
  const body = await response.json();
  const names = (body.objects ?? []).map((entry) => entry.package.name);
  const ours = rankOf(names, OUR_NAMES);
  const scaffold = rankOf(names, [SCAFFOLDER]);
  const entry = body.objects?.[ours.rank - 1];
  return {
    surface: "npm",
    query: text,
    rank: ours.rank,
    name: ours.name,
    score: entry?.score?.final ?? null,
    scaffoldRank: scaffold.rank,
    scanned: names.length,
  };
}

/**
 * Prefers the authenticated `gh` CLI, which is already logged in on this
 * machine; falls back to an anonymous request, which the search API rate-limits
 * to ten calls a minute — enough for this query set.
 */
function githubNamesWithGh(text) {
  try {
    const raw = execFileSync(
      "gh",
      ["api", `search/repositories?q=${encodeURIComponent(text)}&per_page=100`, "--jq", ".items[].full_name"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return raw.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

async function githubNamesWithFetch(text) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "codebase-snapshot-seo-rank",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(text)}&per_page=100`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub search returned ${response.status}`);
  const body = await response.json();
  return (body.items ?? []).map((item) => item.full_name);
}

async function githubRank(text) {
  const names = githubNamesWithGh(text) ?? (await githubNamesWithFetch(text));
  const found = names.indexOf(REPOSITORY);
  return {
    surface: "github",
    query: text,
    rank: found === -1 ? null : found + 1,
    name: found === -1 ? null : REPOSITORY,
    score: null,
    scaffoldRank: null,
    scanned: names.length,
  };
}

function cell(value, width) {
  const text = value === null || value === undefined ? "—" : String(value);
  return text.length > width ? `${text.slice(0, width - 1)} ` : text.padEnd(width);
}

function printTable(rows) {
  const out = [];
  out.push(`${cell("surface", 7)}${cell("query", 26)}${cell("rank", 6)}${cell("score", 9)}${cell("scaffolder", 11)}scanned`);
  out.push("-".repeat(72));
  for (const row of rows) {
    const rank = row.rank === null ? "absent" : `#${row.rank}`;
    const score = row.score === null ? "—" : row.score.toFixed(1);
    const scaffold = row.scaffoldRank === null ? "—" : `#${row.scaffoldRank}`;
    out.push(
      `${cell(row.surface, 7)}${cell(row.query, 26)}${cell(rank, 6)}${cell(score, 9)}${cell(scaffold, 11)}${row.scanned}`
    );
  }
  process.stdout.write(`${out.join("\n")}\n`);
}

function failures(rows) {
  const broken = [];
  for (const query of NPM_QUERIES) {
    if (query.target === null) continue;
    const row = rows.find((candidate) => candidate.surface === "npm" && candidate.query === query.text);
    if (!row) continue;
    if (row.rank === null || row.rank > query.target) {
      broken.push(`npm "${query.text}": ${row.rank === null ? "absent" : `#${row.rank}`}, target #${query.target}`);
    }
  }
  for (const query of GITHUB_QUERIES) {
    if (query.target === null) continue;
    const row = rows.find((candidate) => candidate.surface === "github" && candidate.query === query.text);
    if (!row) continue;
    if (row.rank === null || row.rank > query.target) {
      broken.push(`github "${query.text}": ${row.rank === null ? "absent" : `#${row.rank}`}, target #${query.target}`);
    }
  }
  for (const query of NPM_QUERIES) {
    const row = rows.find((candidate) => candidate.surface === "npm" && candidate.query === query.text);
    if (row && row.rank !== null && row.scaffoldRank !== null && row.scaffoldRank < row.rank) {
      broken.push(`npm "${query.text}": ${SCAFFOLDER} outranks the package (#${row.scaffoldRank} vs #${row.rank})`);
    }
  }
  return broken;
}

const argv = new Set(process.argv.slice(2));
if (argv.has("--help") || argv.has("-h")) {
  process.stdout.write("usage: node scripts/seo-rank.mjs [--json] [--record] [--check]\n");
  process.exit(0);
}

const rows = [];
for (const query of NPM_QUERIES) rows.push(await npmRank(query.text));
for (const query of GITHUB_QUERIES) rows.push(await githubRank(query.text));

if (argv.has("--record")) {
  const line = JSON.stringify({ measuredAt: new Date().toISOString(), version: pkg.version, rows });
  fs.appendFileSync(path.join(ROOT, "seo-log.jsonl"), `${line}\n`);
}

if (argv.has("--json")) {
  process.stdout.write(`${JSON.stringify({ repository: REPOSITORY, version: pkg.version, rows }, null, 2)}\n`);
} else {
  printTable(rows);
}

const broken = failures(rows);
if (broken.length > 0) {
  process.stdout.write(`\nregressions:\n${broken.map((line) => `  - ${line}`).join("\n")}\n`);
  if (argv.has("--check")) process.exit(1);
}
