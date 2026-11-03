/**
 * PoC 4: does the scanner exclude sensitive dotfiles/keys? (.env, .npmrc, id_rsa)
 * Exercises the real CLI end-to-end through collectFiles().
 *
 * Run:  node audit/poc/security-scanner-env.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const HERE = import.meta.dirname;
const CLI = path.join(HERE, "..", "..", "dist", "cli.js");
const PATHS = ["security-fixture-ignore", "security-fixture-walk", "security-fixture-tracked"].map((n) =>
  path.join(HERE, n));
for (const p of PATHS) {
  if (!p.startsWith(path.join(HERE, "security-fixture"))) throw new Error("unexpected path " + p);
  fs.rmSync(p, { recursive: true, force: true });
}

const ENV_BODY = [
  "# gitignored secrets that still live on disk",
  "DATABASE_URL=postgres://admin:s3cr3t@db.example.com:5432/app",
  "OPENAI_API_KEY=sk-proj-AbCdEf0123456789QwErTyUiOp",
  "PASSWORD=Sup3rS3cret!2024",
  "",
].join("\n");

function makeRepo(dir, gitignoreEnv) {
  const w = (rel, c) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c, "utf8");
  };
  w("package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }) + "\n");
  w("src/app.ts", "export const hello = () => 'world';\n");
  w(".env", ENV_BODY);
  w(".npmrc", "//registry.npmjs.org/:_authToken=npm_9f8e7d6c5b4a39281706f5e4d3c2b1a0\n");
  w(".git-credentials", "https://deploy-bot:Sup3rS3cret@github.com\n");
  w("keys/id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABODYLINE\n-----END OPENSSH PRIVATE KEY-----\n");
  if (gitignoreEnv) {
    w(".gitignore", "node_modules\n.env\n");
    w(".env.example", "OPENAI_API_KEY=fill-me\n");
  }
}

function runCli(dir, env = {}) {
  const out = execFileSync("node", [CLI, "--cwd", dir, "--include-monolith"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out;
}

function report(dir, label) {
  const snap = path.join(dir, "snapshot");
  if (!fs.existsSync(snap)) {
    console.log(`  ${label}: NO SNAPSHOT WRITTEN`);
    return;
  }
  const tree = fs.readFileSync(path.join(snap, "reports", "project-tree.md"), "utf8");
  const treeNames = new Set(tree.split("\n")
    .map((l) => l.replace(/^[│├└─\s]+/, "").trim())
    .filter(Boolean));
  const parts = fs.readdirSync(path.join(snap, "parts"))
    .map((f) => fs.readFileSync(path.join(snap, "parts", f), "utf8")).join("\n");
  const mono = fs.existsSync(path.join(snap, "full-codebase.md"))
    ? fs.readFileSync(path.join(snap, "full-codebase.md"), "utf8") : "";
  const included = new Set([...parts.matchAll(/^### FILE: (.+)$/gm)].map((m) => m[1]));
  console.log(`  ${label}`);
  console.log(`    files emitted into parts/: ${[...included].sort().join(", ")}`);
  for (const n of [".env", ".npmrc", ".git-credentials", "keys/id_rsa"]) {
    const base = n.split("/").pop();
    const langM = new RegExp(`### FILE: ${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n(?:.|\\n)*?- Language: (.+)`).exec(parts);
    console.log(`    ${n.padEnd(18)} collected & emitted: ${included.has(n) ? "YES" : "no "} | tree lists basename: ${treeNames.has(base) ? "Y" : "n"} | language: ${langM ? langM[1].trim() : "-"}`);
  }
  const leaked = ["Sup3rS3cret", "sk-proj-AbCdEf", "npm_9f8e7d", "BODYLINE"].filter((s) => parts.includes(s));
  console.log(`    secrets verbatim in parts/: ${leaked.join(", ") || "(none)"}`);
  console.log(`    secrets verbatim in full-codebase.md: ${["Sup3rS3cret", "sk-proj-AbCdEf", "npm_9f8e7d", "BODYLINE"].filter((s) => mono.includes(s)).join(", ") || "(none)"}`);
}

console.log("=== G1. .env untracked and listed in .gitignore (the common, safe-ish layout) ===");
const g1 = PATHS[0];
makeRepo(g1, true);
const git = (dir, ...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
git(g1, "init", "-q");
git(g1, "add", "-A");
git(g1, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "init");
console.log("  git ls-files sees:", execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: g1, encoding: "utf8" }).trim().split("\n").join(", "));
runCli(g1);
report(g1, "G1 result:");

console.log("\n=== G2. same repo, .env committed once (git add -f .env, e.g. an early sloppy commit) ===");
const g3 = PATHS[2];
makeRepo(g3, true);
git(g3, "init", "-q");
git(g3, "add", "-A");
git(g3, "add", "-f", ".env");
git(g3, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "init");
console.log("  git ls-files sees:", execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: g3, encoding: "utf8" }).trim().split("\n").join(", "));
runCli(g3);
report(g3, "G2 result:");

console.log("\n=== G3. non-git checkout (exported tarball / git missing): walkDirectory fallback ===");
const g2 = PATHS[1];
makeRepo(g2, true);
const cliOut = runCli(g2, { GIT_DIR: "Z:\\definitely-not-a-repo" });
console.log("  CLI said:", cliOut.split("\n").filter((l) => /Branch|Tracked|Failed/.test(l)).map((s) => s.trim()).join(" | "));
report(g2, "G3 result (note: .env is in .gitignore here and is still collected):");

console.log("\n=== language classification of sensitive dotfiles (src/scanner/language.ts) ===");
const { detectLanguage } = await import("../../dist/index.js");
for (const f of [".env", ".env.local", ".env.production", ".npmrc", ".git-credentials", "id_rsa", "keys/server.pem", ".netrc"]) {
  console.log(`  ${f.padEnd(20)} -> ${detectLanguage(f)}`);
}
