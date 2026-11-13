import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import * as indexApi from "../dist/index.js";
import {
  appendGitignoreEntries,
  buildImportResolver,
  generateSnapshot,
  globToRegExp,
  importsChangedFile,
  loadConfigFileDetailed,
  resolveSpecifier,
  shouldCheck,
  summarizeTypeScriptSource,
  truncateToBytes,
  tsconfigPathsFor,
  validateSnapshot,
} from "../dist/index.js";
import { makeTempDir } from "./helpers/temp.js";

/**
 * The remaining entries from the 0.9.16 verified-bug report, plus the second report from a
 * CommonJS gateway.
 *
 * Each test is written against the failure it prevents, not the implementation: a staged edit
 * that is not what git commit would write, a deleted module whose dependents go missing, a lock
 * a reused pid wedges forever, an artifact that can be deleted while validate stays green, and
 * the redaction shapes that changed what a file meant.
 */

function write(dir, relativePath, content) {
  const target = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function git(dir, args) {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function canUseGit() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function initRepo(dir) {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "tests@example.invalid"]);
  git(dir, ["config", "user.name", "codebase-snapshot tests"]);
  git(dir, ["config", "core.autocrlf", "false"]);
}

function project(dir) {
  write(dir, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write(dir, "src/a.ts", "export const a = 1;\n");
  return dir;
}

function runCli(args) {
  const result = spawnSync(process.execPath, ["dist/bin.js", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ------------------------------------------------------- SCOPE-02: staged bytes

test("--staged reads the index, not further unstaged edits", (t) => {
  if (!canUseGit()) return t.skip("git is not installed");
  const dir = makeTempDir(t, "cbs-staged-");
  initRepo(dir);
  write(dir, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write(dir, "src/a.ts", "export const a = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);

  const staged = "export const a = 2;\n";
  const working = "export const a = 3;\n";
  write(dir, "src/a.ts", staged);
  git(dir, ["add", "src/a.ts"]);
  write(dir, "src/a.ts", working);

  const manifest = generateSnapshot({ cwd: dir, staged: true });
  const entry = manifest.files.find((file) => file.relativePath === "src/a.ts");
  assert.ok(entry, "the staged path is in the snapshot");
  assert.equal(entry.hashSha256, sha256(staged), "the recorded hash is the staged blob");
  const part = fs.readFileSync(path.join(dir, "snapshot", "parts", entry.part), "utf8");
  assert.ok(part.includes("a = 2"), "the emitted body is the staged revision");
  assert.equal(part.includes("a = 3"), false, "the unstaged edit is not in the snapshot");
});

test("--staged records a staged deletion instead of dropping it", (t) => {
  if (!canUseGit()) return t.skip("git is not installed");
  const dir = makeTempDir(t, "cbs-staged-del-");
  initRepo(dir);
  write(dir, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write(dir, "src/a.ts", "export const a = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  git(dir, ["rm", "-q", "src/a.ts"]);

  const manifest = generateSnapshot({ cwd: dir, staged: true });
  const record = manifest.skipped.find((entry) => entry.path === "src/a.ts");
  assert.ok(record, "the deletion must be recorded");
  assert.equal(record.reason, "deleted");
  assert.match(record.detail, /deletion|not part of the next commit/);
});

test("a tracked file deleted from disk is 'missing' with a detail, not a bare read-error", (t) => {
  if (!canUseGit()) return t.skip("git is not installed");
  const dir = makeTempDir(t, "cbs-missing-");
  initRepo(dir);
  write(dir, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write(dir, "src/a.ts", "export const a = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  fs.rmSync(path.join(dir, "src/a.ts"));

  const manifest = generateSnapshot({ cwd: dir });
  const record = manifest.skipped.find((entry) => entry.path === "src/a.ts");
  assert.ok(record);
  assert.equal(record.reason, "missing");
  assert.ok(record.detail && record.detail.length > 0, "the operator can tell missing from unreadable");

  const validation = validateSnapshot({ cwd: dir });
  assert.ok(
    validation.warnings.some((warning) => /could not be read/.test(warning)),
    "validate surfaces the unreadable skip"
  );
});

// --------------------------------------------- SCOPE-03/04/05: import graph

test("a deleted module is a tombstone, so its importer is a dependent", () => {
  const resolver = buildImportResolver([{ relativePath: "src/b.ts" }], {
    extraPaths: ["src/a.ts"],
  });
  assert.equal(resolveSpecifier("src/b.ts", "./a", resolver), "src/a.ts");
  assert.equal(
    importsChangedFile("src/b.ts", ["./a"], new Set(["src/a.ts"]), resolver),
    true,
    "the caller of a deleted module is exactly what the change breaks"
  );
});

test("tsconfig paths resolve to a file in the repository", (t) => {
  const dir = makeTempDir(t, "cbs-tsconfig-");
  write(
    dir,
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } })
  );
  write(dir, "src/lib/db.ts", "export const db = 1;\n");
  write(dir, "src/app/page.ts", 'import { db } from "@/lib/db";\n');

  const tsconfigPaths = tsconfigPathsFor(dir);
  assert.ok(tsconfigPaths, "the tsconfig is read");
  const resolver = buildImportResolver(
    [{ relativePath: "src/app/page.ts" }, { relativePath: "src/lib/db.ts" }],
    { tsconfig: tsconfigPaths }
  );
  assert.equal(
    resolveSpecifier("src/app/page.ts", "@/lib/db", resolver),
    "src/lib/db.ts",
    "an alias is a real edge, not a missing one"
  );
});

test("SCOPE-08: ** inside a segment does not cross a directory", () => {
  assert.equal(globToRegExp("src/a**b.ts").test("src/a/x/b.ts"), false);
  assert.equal(globToRegExp("src/a**b.ts").test("src/aXb.ts"), true);
  assert.equal(globToRegExp("src/**/b.ts").test("src/b.ts"), true);
  assert.equal(globToRegExp("src/**/b.ts").test("src/a/b.ts"), true);
  assert.equal(globToRegExp("src/**").test("src/a/b.ts"), true);
});

test("SCOPE-09: a UTF-16 .gitignore survives an update, and entries are deduped by meaning", (t) => {
  const dir = makeTempDir(t, "cbs-gitignore-");
  const bom = Buffer.from([0xff, 0xfe]);
  const text = "node_modules\r\n/snapshot/\r\n";
  fs.writeFileSync(path.join(dir, ".gitignore"), Buffer.concat([bom, Buffer.from(text, "utf16le")]));

  const update = appendGitignoreEntries(dir, ["/snapshot/", "/snapshot.tmp/"]);
  assert.deepEqual(update.added, ["/snapshot.tmp/"], "the equivalent entry is not appended again");

  const raw = fs.readFileSync(path.join(dir, ".gitignore"));
  assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe], "the byte-order mark survives");
  const decoded = raw.subarray(2).toString("utf16le");
  assert.ok(decoded.startsWith("node_modules\r\n/snapshot/\r\n"));
  assert.ok(decoded.includes("/snapshot.tmp/"));
});

// ------------------------------------------------------- FS-06: lock heartbeat

test("FS-06: a live pid with a stale heartbeat is reclaimed", (t) => {
  const dir = makeTempDir(t, "cbs-lock-hb-");
  project(dir);
  const tmpDir = path.join(dir, "snapshot.tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const lockPath = indexApi.lockPathFor(fs.realpathSync(tmpDir));
  t.after(() => fs.rmSync(lockPath, { force: true }));

  // The pid is this (live) process; the heartbeat is ten minutes old. A reused pid and a hung
  // run must not wedge the directory forever.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);

  const manifest = generateSnapshot({ cwd: dir });
  assert.ok(manifest.parts.length > 0, "the run completed");
  assert.equal(fs.existsSync(lockPath), false, "the stale lock was reclaimed and released");
});

// ---------------------------------------------- FS-07: an async hook holds the lock

test("FS-07: an async hook keeps the output lock until it settles", async (t) => {
  const dir = makeTempDir(t, "cbs-hook-lock-");
  project(dir);
  let releaseHook;
  const hookDone = new Promise((resolve) => {
    releaseHook = resolve;
  });
  generateSnapshot({
    cwd: dir,
    hooks: {
      afterGenerate: () => hookDone,
    },
  });

  assert.throws(
    () => generateSnapshot({ cwd: dir }),
    /Another generate run is already using/,
    "a second run must not publish over the hook's writes"
  );

  releaseHook();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = generateSnapshot({ cwd: dir });
  assert.ok(second.parts.length > 0, "the lock is released once the hook settles");
});

// ------------------------------------------------ VAL-01/03/04: manifest gates

test("VAL-01: a current-schema manifest without generator/parts hashes is refused", (t) => {
  const dir = makeTempDir(t, "cbs-shape-");
  project(dir);
  generateSnapshot({ cwd: dir });
  const manifestPath = path.join(dir, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const baseline = fs.readFileSync(manifestPath);
  delete manifest.generator;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const noGenerator = validateSnapshot({ cwd: dir });
  assert.equal(noGenerator.valid, false);
  assert.match(noGenerator.errors.join("\n"), /generator/);

  fs.writeFileSync(manifestPath, baseline);
  const clean = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  delete clean.parts[0].sha256;
  fs.writeFileSync(manifestPath, JSON.stringify(clean));
  const noPartHash = validateSnapshot({ cwd: dir });
  assert.equal(noPartHash.valid, false);
  assert.match(noPartHash.errors.join("\n"), /sha256/);
});

test("VAL-03: deleting a declared human artifact fails validation with its path", (t) => {
  for (const relative of ["README.md", "reports/navigation.md", "reports/project-tree.md", "reports/audit.md"]) {
    const dir = makeTempDir(t, "cbs-artifact-");
    project(dir);
    generateSnapshot({ cwd: dir });
    fs.rmSync(path.join(dir, "snapshot", relative));
    const result = validateSnapshot({ cwd: dir });
    assert.equal(result.valid, false, "deleting " + relative + " must fail validation");
    const reasons = [
      ...result.errors,
      ...result.drift.partIssues.map((issue) => issue.part + ": " + issue.issue),
    ].join("\n");
    assert.ok(reasons.includes(relative), "the path is named: " + reasons);
  }
});

test("VAL-04: totalLines and the fingerprint are recomputed, not trusted", (t) => {
  const dir = makeTempDir(t, "cbs-totals-");
  project(dir);
  write(dir, "src/b.ts", "export const b = 2;\n");
  generateSnapshot({ cwd: dir });
  const manifestPath = path.join(dir, "snapshot", "manifest.json");

  const lineEdited = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  lineEdited.counts.totalLines += 1;
  fs.writeFileSync(manifestPath, JSON.stringify(lineEdited));
  const lineResult = validateSnapshot({ cwd: dir });
  assert.equal(lineResult.valid, false);
  assert.ok(
    lineResult.drift.totalsMismatches.some((entry) => /counts\.totalLines/.test(entry)),
    "expected a totalLines mismatch, got " + JSON.stringify(lineResult.drift.totalsMismatches)
  );

  const hashEdited = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  hashEdited.counts.totalLines -= 1;
  hashEdited.files[0].hashSha256 = "0".repeat(64);
  fs.writeFileSync(manifestPath, JSON.stringify(hashEdited));
  const hashResult = validateSnapshot({ cwd: dir });
  assert.ok(
    hashResult.drift.totalsMismatches.some((entry) => /fingerprint/.test(entry)),
    "an edited file list cannot keep the recorded fingerprint"
  );
});

// ------------------------------------------- CFG-06/14, CFG-01/02, CFG-07

test("CFG-06: a .js file is parsed as JavaScript, so JSX is a component not a syntax error", () => {
  const summary = summarizeTypeScriptSource("src/a.js", "const A = () => <div />;\n");
  assert.equal(summary.parseErrors, undefined, "JSX is valid JavaScript with the JS kind");
  assert.ok(summary.reactComponents.includes("A"));
});

test("CFG-14: CommonJS exports are summarised", () => {
  const summary = summarizeTypeScriptSource(
    "src/a.cjs",
    "module.exports = { a, b };\nexports.handler = () => 1;\n"
  );
  for (const name of ["a", "b", "handler"]) {
    assert.ok(summary.exports.includes(name), name + " must be an export");
  }
  assert.equal(summary.exportsKind, "cjs");
});

test("CFG-01: an unchanged module config is evaluated once; an edit re-evaluates it", async (t) => {
  const dir = makeTempDir(t, "cbs-config-cache-");
  const log = path.join(dir, "loads.log");
  const source = (outDir) =>
    'import fs from "node:fs";\n' +
    "fs.appendFileSync(" + JSON.stringify(log) + ', "x\\n");\n' +
    'export default { outDir: "' + outDir + '" };\n';
  write(dir, "snapshot.config.mjs", source("one"));
  const first = await loadConfigFileDetailed(dir);
  const second = await loadConfigFileDetailed(dir);
  assert.equal(first.config.outDir, "one");
  assert.equal(second.config.outDir, "one");
  assert.equal(fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length, 1);

  write(dir, "snapshot.config.mjs", source("two"));
  const third = await loadConfigFileDetailed(dir);
  assert.equal(third.config.outDir, "two", "an edited config is picked up");
  assert.equal(fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length, 2);
});

test("CFG-02: an executable matcher makes the digest explicitly not verifiable", (t) => {
  const dir = makeTempDir(t, "cbs-matcher-");
  project(dir);
  write(
    dir,
    "snapshot.config.mjs",
    'export default {\n  layers: [{ name: "src", match: (p) => p.startsWith("src/") }],\n};\n'
  );
  generateSnapshot({ cwd: dir });
  const validation = validateSnapshot({ cwd: dir });
  assert.ok(
    validation.warnings.some((warning) => /executable \(function\) matchers/.test(warning)),
    "expected the not-verifiable warning, got " + JSON.stringify(validation.warnings)
  );
});

test("CFG-07: shouldCheck reads the last --format, like the parser", () => {
  assert.equal(shouldCheck(["--format", "text", "--format", "json"], {}), false);
  assert.equal(shouldCheck(["--format=json", "--format=text"], {}), true);
  assert.equal(shouldCheck(["--format", "json", "--", "--format", "text"], {}), false);
});

// ----------------------------------------------------- CFG-15: contract prose

test("CFG-15: describe names JS/JSX support and nested .gitignore files", () => {
  const result = runCli(["describe", "--format", "json"]);
  assert.equal(result.code, 0, result.stderr);
  const contract = JSON.parse(result.stdout);
  const option = (flag) => contract.options.find((entry) => entry.flag === flag);
  assert.match(option("--skeleton").summary, /JS, JSX, TS and TSX/);
  assert.match(option("--discovery").summary, /nested/);
  assert.match(option("--autopilot").summary, /Autopilot chooses the preset/);
});

// -------------------------------------------------- CI-01 / DOC-01: repo gates

test("CI-01: every workflow action is pinned, and a tag is refused", (t) => {
  const clean = spawnSync(process.execPath, ["scripts/check-workflows.mjs"], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  assert.equal(clean.status, 0, clean.stderr);

  const root = makeTempDir(t, "cbs-workflows-");
  write(
    root,
    ".github/workflows/x.yml",
    "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n"
  );
  const bad = spawnSync(process.execPath, ["scripts/check-workflows.mjs", root], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not pinned/);
});

test("DOC-01: docs and README are not excluded from secret scanning", () => {
  for (const file of [".github/secret_scanning.yml", ".gitguardian.yaml"]) {
    // Comments explain the old exclusions; only the live entries count.
    const entries = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    assert.doesNotMatch(entries, /docs\//);
    assert.doesNotMatch(entries, /\*\*\.md/);
    assert.doesNotMatch(entries, /llms\.txt/);
  }
});

// ------------------------------------- the second report: redaction false positives

test("a shell expansion is a reference, not a literal to mask", () => {
  const lines = [
    ['CRON_SECRET="${CRON_SECRET:-$(load_var CRON_SECRET "$PROBE_ENV_FILE" || true)}"', "a.sh"],
    ['LOG_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"', "a.sh"],
    ['  -H "x-api-key: ${AI_ADMIN_GATEWAY_KEY}" \\', "a.sh"],
    ["- SEARXNG_SECRET_KEY=${SEARXNG_SECRET_KEY:?SEARXNG_SECRET_KEY is required}", "a.yml"],
  ];
  for (const [line, file] of lines) {
    const { redacted } = indexApi.scanAndRedactSecrets(line, indexApi.DEFAULT_SECRET_PATTERNS, file);
    assert.equal(redacted, line, "the line must survive: " + line);
  }
});

test("identifiers in source code are not masked", () => {
  const lines = [
    ["SEARXNG_SECRET_KEY: optionalString,", "a.js"],
    ['const headers = key ? { "x-api-key": key } : {};', "a.js"],
    ['headers: { "Content-Type": "application/json", "x-api-key": key },', "a.js"],
    ['options.isDryRun ? "PASS" : "MUTATE",', "a.ts"],
    ['ok ? "PASS" : "FAIL"', "a.js"],
  ];
  for (const [line, file] of lines) {
    const { redacted } = indexApi.scanAndRedactSecrets(line, indexApi.DEFAULT_SECRET_PATTERNS, file);
    assert.equal(redacted, line, "the expression must survive: " + line);
  }
});

test("placeholders and documented examples stay readable", () => {
  const lines = [
    ["DATABASE_API_KEY=replace-me-with-the-read-tier-key", ".env.example"],
    ["OPENAI_API_KEY=sk-...", ".env.example"],
    ["QDRANT_API_KEY=...", ".env.example"],
    ["# REVALIDATE_SECRET=replace-me-with-a-fresh-secret", ".env.example"],
    ["# GITHUB_API_TOKEN=<fine-grained PAT, public_repo scope minimum>", "a.sh"],
    ["// literal mongodb://...:password@host template", "a.js"],
  ];
  for (const [line, file] of lines) {
    const { redacted } = indexApi.scanAndRedactSecrets(line, indexApi.DEFAULT_SECRET_PATTERNS, file);
    assert.equal(redacted, line, "the placeholder must survive: " + line);
  }
});

test("a real credential in the same formats is still masked", () => {
  const cases = [
    ["CRON_SECRET=abc123def456ghi789", "a.sh"],
    ["dbPassword: hunter2", "a.yml"],
    ["api_key: abc123", "a.json"],
  ];
  for (const [line, file] of cases) {
    const { redacted } = indexApi.scanAndRedactSecrets(line, indexApi.DEFAULT_SECRET_PATTERNS, file);
    assert.match(redacted, /\[REDACTED/, "still masked: " + line);
  }
});

test("Express route registrations populate the route methods", () => {
  const summary = summarizeTypeScriptSource(
    "src/routes.js",
    'router.get("/a", handler);\napp.post("/b", handler);\nserver.delete("/c", handler);\n'
  );
  assert.deepEqual(summary.routeHandlers, ["DELETE", "GET", "POST"]);
});

test("README and audit label source and emitted lines separately", (t) => {
  const dir = makeTempDir(t, "cbs-lines-");
  write(dir, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write(dir, "src/big.ts", "export const value = 'x';\n".repeat(500));
  generateSnapshot({ cwd: dir, largeFileBytes: 1024, previewHeadLines: 2, previewTailLines: 2 });
  const readme = fs.readFileSync(path.join(dir, "snapshot", "README.md"), "utf8");
  assert.match(readme, /\*\*Source Lines:\*\*/);
  assert.match(readme, /\*\*Emitted Lines:\*\*/);
  const audit = fs.readFileSync(path.join(dir, "snapshot", "reports", "audit.md"), "utf8");
  assert.match(audit, /\*\*Source Lines:\*\*/);
  assert.match(audit, /\*\*Emitted Lines:\*\*/);
});

test("an Express route file's methods reach manifest.indexes.routes", (t) => {
  const dir = makeTempDir(t, "cbs-express-");
  write(dir, "package.json", '{"name":"fixture","version":"1.0.0","dependencies":{"express":"^4"}}\n');
  write(
    dir,
    "src/server/routes/users.js",
    'const router = require("express").Router();\nrouter.get("/users", list);\nrouter.post("/users", create);\nmodule.exports = router;\n'
  );
  const manifest = generateSnapshot({ cwd: dir, preset: "node-express" });
  const route = manifest.indexes.routes.find((entry) => entry.path === "src/server/routes/users.js");
  assert.ok(route, "the file is classified as a route");
  assert.deepEqual(route.methods, ["GET", "POST"]);
});

test("CFG-05: explain rejects the parser flags it never read", () => {
  for (const flag of [
    "--skip-artifacts",
    "--only-artifacts",
    "--max-monolith-bytes",
    "--include-monolith",
    "--max-part-bytes",
  ]) {
    const result = runCli(["explain", flag, "readme", "src/index.ts"]);
    assert.equal(result.code, 2, flag + " must be a usage error, not a no-op");
  }
});

test("CFG-15: generate --autopilot says it chooses the preset", () => {
  const result = runCli(["generate", "--autopilot", "--preset", "nextjs"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /autopilot chooses the preset/);
});

test("LIM-04: truncation keeps a real U+FFFD and never splits a code point", () => {
  const replacement = "\uFFFD";
  const real = "abc" + replacement;
  assert.equal(truncateToBytes(real, Buffer.byteLength(real)).content, real, "a real U+FFFD survives");
  assert.equal(truncateToBytes(real, 6).content, real, "the cut lands after the character");

  const emoji = "a\u{1F600}b";
  const split = truncateToBytes(emoji, 2).content;
  assert.equal(split, "a", "half of a surrogate pair is never emitted");
  assert.equal(split.includes(replacement), false);
  assert.equal(truncateToBytes(emoji, 5).content, "a\u{1F600}", "the whole pair fits at its boundary");
});
