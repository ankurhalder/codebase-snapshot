#!/usr/bin/env node
/**
 * Differential coverage: does the snapshot account for every path a second, independent source
 * says exists?
 *
 * validate walks the tree with the generator's own rules, so a path the walker silently drops is
 * missing from both sides of that comparison. Git's index is a genuinely independent list. Every
 * tracked or untracked-not-ignored path must be in files[] or in skipped[] with a reason; a path
 * that is only in git is a silent omission, which is the one failure this tool promises not to
 * make.
 *
 * Usage:
 *   node scripts/coverage-diff.mjs [repo] [snapshotDir]
 *   node scripts/coverage-diff.mjs [repo] [snapshotDir] --from <file-list>
 *
 * --from reads one path per line (blank lines and # comments ignored), so the same comparison
 * can be run against repomix, gitingest or another tool's file list.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

function stop(message) {
  console.error("coverage-diff: " + message);
  process.exit(2);
}

const args = process.argv.slice(2);
let fromFile = null;
const positionals = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--from") {
    fromFile = args[index + 1];
    if (fromFile === undefined) stop("--from needs a file path");
    index += 1;
  } else if (args[index] === "--help" || args[index] === "-h") {
    console.log("usage: coverage-diff [repo] [snapshotDir] [--from <file-list>]");
    process.exit(0);
  } else {
    positionals.push(args[index]);
  }
}

const repoDir = path.resolve(positionals[0] ?? ".");
const snapshotDir = path.resolve(positionals[1] ?? path.join(repoDir, "snapshot"));
const manifestPath = path.join(snapshotDir, "manifest.json");
if (!fs.existsSync(manifestPath)) stop("no manifest at " + manifestPath);

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  stop("manifest is not valid JSON: " + error.message);
}
if (!Array.isArray(manifest.files) || !Array.isArray(manifest.skipped)) {
  stop("manifest has no files[]/skipped[] arrays");
}

const normalise = (value) => String(value).replace(/\\/g, "/").replace(/^\.\//, "");
const escapeRegExp = (value) => value.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
const included = new Set(manifest.files.map((file) => normalise(file.relativePath)));
const skipPaths = manifest.skipped.map((record) => normalise(record.path));
const literalSkips = skipPaths.filter((value) => !value.includes("[REDACTED"));
const maskedSkips = skipPaths
  .filter((value) => value.includes("[REDACTED"))
  .map((value) => {
    // A masked path cannot be compared literally. Every masked span becomes any run of characters
    // and the rest is escaped, so a redacted .env still accounts for its private path.
    const pieces = value.split(/\[REDACTED[^\]]*\]/g).map(escapeRegExp);
    return new RegExp("^" + pieces.join(".*") + "$");
  });

function isAccounted(relativePath) {
  if (included.has(relativePath)) return true;
  for (const skip of literalSkips) {
    if (relativePath === skip || relativePath.startsWith(skip + "/")) return true;
  }
  return maskedSkips.some((pattern) => pattern.test(relativePath));
}

let reference;
let source;
if (fromFile !== null) {
  const listPath = path.resolve(fromFile);
  if (!fs.existsSync(listPath)) stop("no file list at " + listPath);
  source = "list " + listPath;
  reference = fs
    .readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(normalise);
} else {
  try {
    const read = (extra) =>
      execFileSync("git", ["-C", repoDir, "ls-files", "-z", ...extra], {
        maxBuffer: 64 * 1024 * 1024,
      })
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map(normalise);
    reference = [...new Set([...read([]), ...read(["--others", "--exclude-standard"])])];
    source = "git ls-files (tracked plus untracked, ignored excluded)";
  } catch (error) {
    stop("could not read the git file list: " + error.message);
  }
}

const missing = [...new Set(reference)].filter((relativePath) => !isAccounted(relativePath)).sort();
const referenceSet = new Set(reference);
const extra = [...included].filter((relativePath) => !referenceSet.has(relativePath)).sort();

console.log(
  "coverage-diff: " + reference.length + " reference path(s) from " + source + "; " +
    included.size + " included, " + manifest.skipped.length + " skipped"
);
if (extra.length > 0) {
  console.log("  included but not in the reference (" + extra.length + "): " + extra.slice(0, 10).join(", "));
}
if (missing.length > 0) {
  console.error("  MISSING from files[] and skipped[] (" + missing.length + "):");
  for (const relativePath of missing.slice(0, 40)) console.error("    " + relativePath);
  if (missing.length > 40) console.error("    ... and " + (missing.length - 40) + " more");
  process.exit(1);
}
console.log("  every reference path is in files[] or skipped[]");
