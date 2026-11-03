// A2 (03 §3 ranked #2, HIGH) — `--format json` was not parseable: two progress
// lines preceded the JSON on stdout.
// A3 (03 §4 ranked #3, HIGH) — `--dry-run` performed the full destructive write
// sequence including rmSync(outDir); `--force`/`--monolith-content` were parsed
// and ignored.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { BIN, assert, assertEqual, assertIncludes, check, checkAsync, finish, readTree, selfTest, tmp, write } from "./v-lib.mjs";

selfTest();

function makeRepo(name) {
  const dir = tmp(name);
  write(dir, ".gitignore", "snapshot/\nsnapshot.tmp/\n");
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "src/b.ts", "export const b = 2;\n");
  return dir;
}

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 120_000 });

// -------------------------------------------------------------------- A2
check("A2.generate-json", "generate --format json writes one parseable document to stdout", () => {
  const dir = makeRepo("a2");
  const result = run(["generate", `--cwd=${dir}`, "--format=json"]);
  assertEqual(result.status, 0, `exit ${result.status}: ${result.stderr.slice(0, 200)}`);
  const parsed = JSON.parse(result.stdout); // throws if progress lines leaked
  assertEqual(parsed.schemaVersion, "3.0.0", "schemaVersion");
  assert(parsed.files.length >= 2, "manifest has no files");
  assert(result.stderr.length > 0, "no progress on stderr at all");
  assert(/Generating snapshot/.test(result.stderr), `progress not on stderr: ${result.stderr.slice(0, 120)}`);
  assert(!/Generating snapshot/.test(result.stdout), "progress leaked to stdout");
  return `JSON.parse OK (${result.stdout.length} B), progress on stderr`;
});

check("A2.validate-json", "validate --format json is parseable", () => {
  const dir = makeRepo("a2b");
  run(["generate", `--cwd=${dir}`]);
  const result = run(["validate", `--cwd=${dir}`, "--format=json"]);
  const parsed = JSON.parse(result.stdout);
  assertEqual(result.status, 0, `exit ${result.status}`);
  assertEqual(parsed.valid, true, "valid");
  assert(parsed.drift && Array.isArray(parsed.drift.partIssues), "drift shape");
  return "valid:true with drift.partIssues";
});

check("A2.report-json", "report --format json is parseable and carries the manifest", () => {
  const dir = makeRepo("a2c");
  run(["generate", `--cwd=${dir}`, "--include-monolith"]);
  const result = run(["report", `--cwd=${dir}`, "--format=json"]);
  const parsed = JSON.parse(result.stdout);
  assertEqual(result.status, 0, `exit ${result.status}`);
  assert(parsed.manifest && parsed.validation, "payload keys");
  assertEqual(parsed.validation.valid, true, "validation.valid");
  return "manifest+validation";
});

check("A2.redirect", "stdout survives a shell-style redirect to a file (the audit's reproduce command)", () => {
  const dir = makeRepo("a2d");
  const outFile = path.join(dir, "out.json");
  const errFile = path.join(dir, "out.err");
  const outFd = fs.openSync(outFile, "w");
  const errFd = fs.openSync(errFile, "w");
  const result = spawnSync(process.execPath, [BIN, "generate", `--cwd=${dir}`, "--format=json"], {
    stdio: ["ignore", outFd, errFd],
    timeout: 120_000,
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  assertEqual(result.status, 0, `exit ${result.status}`);
  const raw = fs.readFileSync(outFile, "utf8");
  const parsed = JSON.parse(raw); // the exact check that failed on v1
  assertEqual(parsed.schemaVersion, "3.0.0", "schemaVersion");
  assert(fs.readFileSync(errFile, "utf8").length > 0, "progress missing from stderr redirect");
  return `redirected ${raw.length} B, JSON.parse OK`;
});

// -------------------------------------------------------------------- A3
check("A3.fresh-dir", "--dry-run writes nothing at all", () => {
  const dir = makeRepo("a3");
  const result = run(["generate", `--cwd=${dir}`, "--dry-run", "--format=json"]);
  assertEqual(result.status, 0, `exit ${result.status}: ${result.stderr.slice(0, 200)}`);
  assert(!fs.existsSync(path.join(dir, "snapshot")), "snapshot/ directory was created");
  assert(!fs.existsSync(path.join(dir, "snapshot.tmp")), "snapshot.tmp was created");
  assertEqual(fs.readdirSync(dir).sort().join(","), ".gitignore,src", `new entries: ${fs.readdirSync(dir)}`);
  const manifest = JSON.parse(result.stdout);
  assert(manifest.counts.totalFiles >= 2, "dry run did not compute the manifest");
  return `no writes, plan = ${manifest.counts.totalFiles} files / ${manifest.counts.partsCount} parts`;
});

check("A3.existing-snapshot", "--dry-run leaves an existing snapshot byte-identical", () => {
  const dir = makeRepo("a3b");
  run(["generate", `--cwd=${dir}`]);
  const before = readTree(path.join(dir, "snapshot"), { encoding: "buffer" });
  const beforeKeys = Object.keys(before).sort();
  write(dir, "src/a.ts", "export const a = 777;\n"); // make a regenerate change something
  const result = run(["generate", `--cwd=${dir}`, "--dry-run"]);
  const after = readTree(path.join(dir, "snapshot"), { encoding: "buffer" });
  assertEqual(result.status, 0, `exit ${result.status}`);
  assertEqual(Object.keys(after).sort().join(","), beforeKeys.join(","), "file list changed");
  for (const key of beforeKeys) {
    assert(before[key].equals(after[key]), `${key} changed during a dry run`);
  }
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".backup-") || name === "snapshot.tmp");
  assertEqual(leftovers.length, 0, `litter after dry run: ${leftovers.join(",")}`);
  return `${beforeKeys.length} files unchanged, no litter (old: full write + rmSync)`;
});

check("A3.progress", "--dry-run says it wrote nothing", () => {
  const dir = makeRepo("a3c");
  const result = run(["generate", `--cwd=${dir}`, "--dry-run"]);
  assertIncludes(result.stderr, "Dry run", "stderr");
  assertIncludes(result.stderr, "nothing was written", "stderr");
  return result.stderr.split("\n").find((line) => line.includes("Dry run")).trim();
});

check("A3.dead-flags", "the dead --force / --monolith-content flags are gone; --max-monolith-bytes works", () => {
  const dir = makeRepo("a3d");
  const force = run(["generate", `--cwd=${dir}`, "--force"]);
  assertEqual(force.status, 2, `--force exit ${force.status} (should be rejected as unknown)`);
  const content = run(["generate", `--cwd=${dir}`, "--monolith-content"]);
  assertEqual(content.status, 2, `--monolith-content exit ${content.status}`);
  const skip = run(["generate", `--cwd=${dir}`, "--include-monolith", "--max-monolith-bytes=200", "--format=json"]);
  assertEqual(skip.status, 0, `exit ${skip.status}: ${skip.stderr.slice(0, 200)}`);
  const manifest = JSON.parse(skip.stdout);
  assert(!fs.existsSync(path.join(dir, "snapshot/full-codebase.md")), "oversized monolith was written");
  assert(
    manifest.warnings.some((warning) => /maxMonolithBytes/.test(warning)),
    `no warning recorded: ${JSON.stringify(manifest.warnings)}`
  );
  assertEqual(manifest.artifacts.fullMarkdown, null, "artefact still declared");
  return "unknown flags exit 2; --max-monolith-bytes skips + warns";
});

finish();

