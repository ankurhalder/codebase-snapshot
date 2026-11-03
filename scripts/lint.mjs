#!/usr/bin/env node
/**
 * Dependency-free lint/format gate.
 *
 * The project deliberately ships no linter dependency (a compiler is already a
 * runtime dependency and `tsc` does the type checking), so this script enforces
 * the conventions that `tsc` cannot see. It runs in CI and locally with no
 * network access.
 *
 * Rules
 *   src-console      only the CLI and the bin may write to the console
 *   empty-catch      a bare `catch { }` must not swallow an error silently
 *   explicit-any     `any` is not allowed in src (use `unknown` and narrow)
 *   stray-todo       TODO/FIXME markers must not ship
 *   tabs             indentation is spaces only
 *   trailing-ws      no trailing whitespace
 *   eol              files end with exactly one newline, LF only
 *   final-newline    every source file ends with a newline
 *   test-only        no `test.only` / `describe.only` committed
 *   no-debugger      no `debugger` statements
 *   no-focus-comment comments must not contain "// eslint-disable" style escapes
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const TARGETS = ["src", "tests", "scripts"];

/** Files allowed to write to the console. */
const CONSOLE_ALLOWED = new Set(["src/cli.ts", "src/bin.ts", "scripts/lint.mjs"]);

const failures = [];
const fail = (file, line, rule, message) => {
  failures.push({ file, line, rule, message });
};

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "coverage", ".git"].includes(entry.name)) continue;
      out.push(...walk(full));
    } else if (/\.(?:ts|js|mjs|cjs|json|md|yml|yaml)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = TARGETS.flatMap((target) => walk(path.join(ROOT, target)));

for (const absolute of files) {
  const relative = path.relative(ROOT, absolute).replace(/\\/g, "/");
  const raw = fs.readFileSync(absolute, "utf8");
  const isSource = relative.startsWith("src/");

  if (raw.includes("\r")) {
    fail(relative, 0, "eol", "file contains CRLF line endings");
  }
  if (!raw.endsWith("\n")) {
    fail(relative, raw.split("\n").length, "final-newline", "file must end with a newline");
  }
  if (raw.endsWith("\n\n")) {
    fail(relative, raw.split("\n").length, "eol", "file must end with exactly one newline");
  }

  const lines = raw.split("\n");
  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (line.includes("\t")) {
      fail(relative, lineNumber, "tabs", "tab character (use spaces)");
    }
    if (/[ \t]+$/.test(line)) {
      fail(relative, lineNumber, "trailing-ws", "trailing whitespace");
    }
    if (/^\s*debugger\s*;?\s*$/.test(line)) {
      fail(relative, lineNumber, "no-debugger", "debugger statement");
    }
    if (/^\s*\/\/\s*(?:eslint-disable|@ts-ignore)/.test(line)) {
      fail(relative, lineNumber, "no-focus-comment", "suppression comment without a reason");
    }
    if (/\b(?:TODO|FIXME)\b/.test(line) && !relative.endsWith("lint.mjs")) {
      fail(relative, lineNumber, "stray-todo", "TODO/FIXME/XXX marker");
    }
    if (/^\s*\}?\s*catch\s*\{\s*\}\s*$/.test(line) || /\}\s*catch\s*\{\s*\}/.test(line)) {
      fail(relative, lineNumber, "empty-catch", "empty catch block swallows the error");
    }

    if (isSource) {
      if (/\bconsole\./.test(line) && !CONSOLE_ALLOWED.has(relative)) {
        fail(relative, lineNumber, "src-console", "console usage outside the CLI layer");
      }
      if (/\bany\b/.test(line) && /(?::\s*any\b|<any>|\bas\s+any\b)/.test(line)) {
        fail(relative, lineNumber, "explicit-any", "explicit any (use unknown and narrow)");
      }
    }

    if (relative.startsWith("tests/")) {
      if (/\b(?:test|describe|it)\.only\s*\(/.test(line)) {
        fail(relative, lineNumber, "test-only", "focused test committed");
      }
    }
  });
}

if (failures.length === 0) {
  console.log(`lint: ${files.length} file(s) clean`);
  process.exit(0);
}

for (const failure of failures) {
  console.error(`${failure.file}:${failure.line}  [${failure.rule}] ${failure.message}`);
}
console.error(`\nlint: ${failures.length} problem(s) in ${files.length} file(s)`);
process.exit(1);
