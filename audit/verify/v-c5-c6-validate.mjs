// C§5 (02 §5 / H5, HIGH) — validateSnapshot threw an uncaught TypeError on a
// manifest without `files`/`skipped`; the CLI printed a raw stack.
// C§6 (02 §6) — validate was a source-file hash checker only: parts, budgets,
// git state and totals were never compared.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateSnapshot, resolveConfig, validateSnapshot } from "../../dist/index.js";
import {
  BIN,
  assert,
  assertEqual,
  assertIncludes,
  check,
  finish,
  gitInit,
  selfTest,
  tmp,
  write,
} from "./v-lib.mjs";

selfTest();

function makeRepo(name) {
  const dir = tmp(name);
  write(dir, ".gitignore", "snapshot/\nsnapshot.tmp/\n");
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "src/b.ts", "export const b = 2;\n");
  write(dir, "docs/readme.md", "# hi\n\nbody\n");
  const git = gitInit(dir);
  git.add(".");
  git.commit();
  return dir;
}

const dir = makeRepo("c5");
const config = resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" });
const manifestPath = path.join(dir, "snapshot/manifest.json");
generateSnapshot(config);
const pristine = fs.readFileSync(manifestPath, "utf8");

const writeManifest = (value) =>
  fs.writeFileSync(manifestPath, typeof value === "string" ? value : JSON.stringify(value, null, 2));
const restore = () => fs.writeFileSync(manifestPath, pristine);

// ------------------------------------------------------------------ C§5 shape
const SHAPES = [
  ["missing files", (m) => { delete m.files; }],
  ["missing skipped", (m) => { delete m.skipped; }],
  ["missing parts", (m) => { delete m.parts; }],
  ["empty object", () => ({})],
  ["files not an array", (m) => { m.files = "nope"; }],
  ["null document", () => "null"],
  ["array document", () => "[]"],
  ["string document", () => '"hello"'],
  ["invalid json", () => "{ not json"],
];

for (const [label, mutate] of SHAPES) {
  check(`C5.shape:${label}`, "returns {valid:false} instead of throwing", () => {
    const base = JSON.parse(pristine);
    const mutated = mutate(base);
    writeManifest(mutated ?? base);
    let result = null;
    let error = null;
    try {
      result = validateSnapshot(config);
    } catch (err) {
      error = err;
    }
    restore();
    assert(!error, `threw: ${error?.message}`);
    assertEqual(result.valid, false, "valid flag");
    assert(result.errors.length > 0, "no error message recorded");
    return result.errors[0].slice(0, 70);
  });
}

check("C5.cli-clean", "the CLI reports a broken manifest without a stack trace", () => {
  writeManifest("{}");
  const run = spawnSync(process.execPath, [BIN, "validate", "--cwd", dir], { encoding: "utf8" });
  restore();
  const output = `${run.stdout}${run.stderr}`;
  assertEqual(run.status, 1, "exit code");
  assert(!/\n\s+at .+:\d+:\d+/.test(output), `stack trace leaked: ${output.slice(0, 200)}`);
  assertIncludes(output, "Snapshot validation failed", "message");
  return `exit 1, no stack trace (${output.split("\n")[0].slice(0, 60)})`;
});

// ------------------------------------------------------------------ C§6 scope
check("C6.clean", "a freshly generated snapshot validates clean", () => {
  restore();
  const result = validateSnapshot(config);
  assert(result.valid, `unexpected drift: ${JSON.stringify(result.drift)}`);
  return "valid:true";
});

check("C6.deleted-part", "a deleted parts/*.md is detected", () => {
  const partPath = path.join(dir, "snapshot/parts/part-001.md");
  const saved = fs.readFileSync(partPath);
  fs.rmSync(partPath);
  const result = validateSnapshot(config);
  fs.writeFileSync(partPath, saved);
  assert(!result.valid, "valid:true after deleting a part");
  assert(result.drift.partIssues.some((issue) => /missing/.test(issue.issue)), JSON.stringify(result.drift.partIssues));
  return result.drift.partIssues[0].issue;
});

check("C6.garbled-part", "a corrupted parts/*.md is detected", () => {
  const partPath = path.join(dir, "snapshot/parts/part-001.md");
  const saved = fs.readFileSync(partPath);
  fs.writeFileSync(partPath, Buffer.concat([saved, Buffer.from("tampered!")]));
  const result = validateSnapshot(config);
  fs.writeFileSync(partPath, saved);
  assert(!result.valid, "valid:true after corrupting a part");
  assert(result.drift.partIssues.length >= 2, `expected size AND hash issues: ${JSON.stringify(result.drift.partIssues)}`);
  return `${result.drift.partIssues.length} issues (size + hash)`;
});

check("C6.tampered-part-metadata", "tampered part byteSize/sha256 in the manifest is detected", () => {
  const manifest = JSON.parse(pristine);
  manifest.parts[0].byteSize += 1;
  manifest.parts[0].sha256 = "0".repeat(64);
  writeManifest(manifest);
  const result = validateSnapshot(config);
  restore();
  assert(!result.valid, "valid:true with a tampered part record");
  assert(result.drift.partIssues.length >= 2, JSON.stringify(result.drift.partIssues));
  return `${result.drift.partIssues.length} part issues`;
});

check("C6.config-drift", "generating with one budget and validating with another is drift", () => {
  const other = resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", maxPartBytes: 100_000 });
  const result = validateSnapshot(other);
  assert(!result.valid, "valid:true despite a different maxPartBytes");
  assert(
    result.drift.configMismatches.some((entry) => entry.startsWith("maxPartBytes")),
    JSON.stringify(result.drift.configMismatches)
  );
  return result.drift.configMismatches[0];
});

check("C6.exclude-drift", "a different excludePatterns set is drift", () => {
  const other = resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", excludePatterns: ["src/"] });
  const result = validateSnapshot(other);
  assert(!result.valid, "valid:true despite different excludes");
  assert(
    result.drift.configMismatches.some((entry) => entry.startsWith("excludePatterns")),
    JSON.stringify(result.drift.configMismatches)
  );
  return result.drift.configMismatches[0].slice(0, 70);
});

check("C6.extra-file", "a new file on disk is reported as missingInSnapshot", () => {
  write(dir, "src/c.ts", "export const c = 3;\n");
  const result = validateSnapshot(config);
  fs.rmSync(path.join(dir, "src/c.ts"));
  assert(!result.valid, "valid:true with an unsnapshotted file");
  assert(result.drift.missingInSnapshot.includes("src/c.ts"), JSON.stringify(result.drift.missingInSnapshot));
  return "src/c.ts reported";
});

check("C6.deleted-file", "a file removed from disk is reported as missingOnDisk", () => {
  const target = path.join(dir, "docs/readme.md");
  const saved = fs.readFileSync(target);
  fs.rmSync(target);
  const result = validateSnapshot(config);
  fs.writeFileSync(target, saved);
  assert(!result.valid, "valid:true with a vanished file");
  assert(result.drift.missingOnDisk.includes("docs/readme.md"), JSON.stringify(result.drift.missingOnDisk));
  return "docs/readme.md reported";
});

check("C6.bookkeeping", "parts[].fileCount vs files[] is cross-checked", () => {
  const manifest = JSON.parse(pristine);
  manifest.parts[0].fileCount += 5;
  writeManifest(manifest);
  const result = validateSnapshot(config);
  restore();
  assert(!result.valid, "valid:true with impossible part bookkeeping");
  assert(result.drift.partIssues.some((issue) => issue.part === "(totals)"), JSON.stringify(result.drift.partIssues));
  return "totals mismatch reported";
});

check("C6.monolith", "a missing monolith artefact declared in the manifest is detected", () => {
  const dir2 = makeRepo("c6m");
  const cfg = resolveConfig({ cwd: dir2, outDir: "snapshot", tmpDir: "snapshot.tmp", includeMonolith: true });
  const manifest = generateSnapshot(cfg);
  assert(manifest.artifacts.fullMarkdown, "monolith was not recorded");
  const md = path.join(dir2, "snapshot/full-codebase.md");
  const saved = fs.readFileSync(md);
  fs.rmSync(md);
  const result = validateSnapshot(cfg);
  fs.writeFileSync(md, saved);
  assert(!result.valid, "valid:true with a missing declared artefact");
  assert(result.drift.partIssues.some((issue) => issue.part === "full-codebase.md"), JSON.stringify(result.drift.partIssues));
  return "missing full-codebase.md reported";
});

// ------------------------------- bookkeeping: totals/counts/budgets tampering
check("C6.pristine", "a pristine manifest still validates clean (no false positives)", () => {
  restore();
  const result = validateSnapshot(config);
  console.log(
    `    OBS C6.pristine: valid=${result.valid} totalsMismatches=${JSON.stringify(result.drift.totalsMismatches)} warnings=${JSON.stringify(result.warnings)}`
  );
  assert(result.valid, `false positive: ${JSON.stringify(result.drift)} ${result.errors.join("; ")}`);
  assertEqual(result.drift.totalsMismatches.length, 0, "totalsMismatches on a pristine manifest");
  return "valid:true, 0 totalsMismatches, 0 warnings";
});

const TAMPERS = [
  ["counts.totalFiles", (m) => { m.counts.totalFiles = 999; }, "counts.totalFiles"],
  ["counts.partsCount", (m) => { m.counts.partsCount = 99; }, "counts.partsCount"],
  ["counts.skippedCount", (m) => { m.counts.skippedCount = 99; }, "counts.skippedCount"],
  ["counts.totalSizeBytes", (m) => { m.counts.totalSizeBytes = 1; }, "counts.totalSizeBytes"],
  ["totals.includedFiles", (m) => { m.totals.includedFiles = 999; }, "totals.includedFiles"],
  ["totals.partCount", (m) => { m.totals.partCount = 99; }, "totals.partCount"],
  ["totals.skippedFiles", (m) => { m.totals.skippedFiles = 99; }, "totals.skippedFiles"],
  ["totals.totalSourceBytes", (m) => { m.totals.totalSourceBytes = 1; }, "totals.totalSourceBytes"],
  ["totals.totalContentBytes", (m) => { m.totals.totalContentBytes = 1; }, "totals.totalContentBytes"],
  ["totals.candidateFiles", (m) => { m.totals.candidateFiles = 999; }, "totals.candidateFiles"],
  ["totals.warningCount", (m) => { m.totals.warningCount = 99; }, "totals.warningCount"],
  ["totals.fullFiles", (m) => { m.totals.fullFiles += 1; }, "fullFiles + previewFiles"],
  ["budgets.maxPartBytes", (m) => { m.budgets.maxPartBytes = 1; }, "budgets.maxPartBytes"],
  ["budgets.largeFileBytes", (m) => { m.budgets.largeFileBytes = 1; }, "budgets.largeFileBytes"],
  ["Σ includedBytes", (m) => { m.parts[0].includedFiles[0].includedBytes += 7; }, "totals.totalContentBytes"],
];

check("C6.totals-matrix", "every tampered totals/counts/budget field is detected", () => {
  const undetected = [];
  const reported = [];
  for (const [label, mutate, needle] of TAMPERS) {
    const manifest = JSON.parse(pristine);
    mutate(manifest);
    writeManifest(manifest);
    const result = validateSnapshot(config);
    restore();
    const hit = result.drift.totalsMismatches.some((entry) => entry.includes(needle));
    if (!result.valid && hit) reported.push(label);
    else undetected.push(`${label}(valid=${result.valid},hit=${hit})`);
  }
  console.log(`    OBS C6.totals-matrix: detected=${reported.length}/${TAMPERS.length} ${undetected.length ? `undetected=${undetected.join(",")}` : ""}`);
  assertEqual(undetected.length, 0, `undetected tampering: ${undetected.join(", ")}`);
  return `${reported.length}/${TAMPERS.length} tamper cases detected with a named mismatch`;
});

check("C6.totals-detail", "the reported mismatch names the field and both values", () => {
  const manifest = JSON.parse(pristine);
  manifest.totals.includedFiles = 999;
  writeManifest(manifest);
  const result = validateSnapshot(config);
  restore();
  assert(!result.valid, "not detected");
  const entry = result.drift.totalsMismatches.find((item) => item.includes("totals.includedFiles"));
  assert(entry, JSON.stringify(result.drift.totalsMismatches));
  assert(/manifest 999 vs actual \d+/.test(entry), `entry does not show both values: ${entry}`);
  return entry;
});

check("C6.git-commit", "a commit after generation produces a warning naming both revisions", () => {
  const dir3 = makeRepo("c6g2");
  const cfg = resolveConfig({ cwd: dir3, outDir: "snapshot", tmpDir: "snapshot.tmp" });
  const manifest = generateSnapshot(cfg);
  const git = (args) => spawnSync("git", args, { cwd: dir3, encoding: "utf8" });
  git(["commit", "--allow-empty", "-m", "post-snapshot commit"]);
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  const result = validateSnapshot(cfg);
  console.log(
    `    OBS C6.git-commit: manifest=${manifest.git.commit.slice(0, 8)} HEAD=${head.slice(0, 8)} valid=${result.valid} warnings=${JSON.stringify(result.warnings)}`
  );
  const warning = result.warnings.find((entry) => /commit/.test(entry));
  assert(warning, `no commit warning: ${JSON.stringify(result.warnings)}`);
  assertIncludes(warning, manifest.git.commit.slice(0, 8), "old commit in warning");
  assertIncludes(warning, head.slice(0, 8), "HEAD in warning");
  return warning;
});

check("C6.git-dirty", "an uncommitted change produces a dirty-tree warning", () => {
  const dir3 = makeRepo("c6g3");
  const cfg = resolveConfig({ cwd: dir3, outDir: "snapshot", tmpDir: "snapshot.tmp" });
  generateSnapshot(cfg);
  write(dir3, "src/untracked.ts", "export const u = 1;\n");
  const result = validateSnapshot(cfg);
  console.log(`    OBS C6.git-dirty: valid=${result.valid} warnings=${JSON.stringify(result.warnings)}`);
  assert(
    result.warnings.some((entry) => /uncommitted changes/.test(entry)),
    `no dirty warning: ${JSON.stringify(result.warnings)}`
  );
  return result.warnings.find((entry) => /uncommitted/.test(entry));
});

check("C6.RESIDUAL-git", "git branch/commit drift after generate (no file changes)", () => {
  const dir3 = makeRepo("c6g");
  const cfg = resolveConfig({ cwd: dir3, outDir: "snapshot", tmpDir: "snapshot.tmp" });
  const manifest = generateSnapshot(cfg);
  const git = (args) => spawnSync("git", args, { cwd: dir3, encoding: "utf8" });
  // Move HEAD to a different branch AND a different commit, without touching files.
  git(["checkout", "-b", "feature-x"]);
  git(["commit", "--allow-empty", "-m", "post-snapshot commit"]);
  const head = git(["rev-parse", "--short", "HEAD"]).stdout.trim();
  const status = git(["status", "--porcelain"]).stdout.trim();
  assertEqual(status, "", "fixture is dirty — this probe must isolate git state only");
  const result = validateSnapshot(cfg);
  console.log(
    `    OBS C6.git: manifest.branch=${manifest.git.branch} manifest.commit=${manifest.git.commit.slice(0, 8)} HEAD=${head} valid=${result.valid} warnings=${JSON.stringify(result.warnings)}`
  );
  assert(
    !result.valid || result.warnings.length > 0,
    `branch/commit drift produced neither an error nor a warning (valid:${result.valid})`
  );
  return result.warnings.join(" | ") || "reported as drift";
});

finish();

