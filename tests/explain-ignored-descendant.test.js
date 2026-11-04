/**
 * Explain/validate follow-ups from the fresh-environment verification.
 *
 * Two answers were weaker than the artifacts they described:
 *
 *   1. A file inside a `.gitignore`d directory has no skip record of its own —
 *      the walk never descends — so `explain` fell back to `not-discovered`
 *      ("not tracked or is otherwise not a candidate") while its parent
 *      directory carried the honest `gitignore` record one level up.
 *   2. `validate` printed "N file(s) exist on disk but could not be read" with
 *      no paths, the only drift summary without them, so a terminal user had to
 *      switch to `--format json` to find out which file was meant.
 *
 * The documented `not-discovered` answer is deliberately preserved for files
 * under `node_modules`: `docs/cli.md` pins that exact detail string.
 *
 * Fixtures are created without git, so discovery is the plain walk.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { explainPath, generateSnapshot, resolveConfig } from "../dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

const DOCUMENTED_NOT_DISCOVERED = "exists but is not tracked or is otherwise not a candidate";

function makeRepo(t, { nodeModules = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "explain-ignored-"));
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write("package.json", '{"name":"explain-ignored","private":true}\n');
  write(".gitignore", "ignored/\n");
  write("ignored/secret.txt", "should never be read\n");
  write("src/a.ts", "export const a = 1;\n");
  if (nodeModules) write("node_modules/dep/index.js", "module.exports = 1;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const configFor = (cwd) => resolveConfig({ cwd, outDir: "snapshot", tmpDir: "snapshot.tmp" });

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// ------------------------------------------------- (a) ignored descendant

test("DH-13: a file inside an ignored directory explains as gitignore and names the ancestor", (t) => {
  const dir = makeRepo(t);
  const result = explainPath(configFor(dir), "ignored/secret.txt");

  assert.equal(result.included, false);
  assert.equal(
    result.reason,
    "gitignore",
    `expected the ancestor's gitignore record, got ${result.reason}`
  );
  assert.ok(
    result.detail?.includes("ignored by .gitignore"),
    `expected the ancestor's detail, got: ${result.detail}`
  );
  assert.ok(
    result.detail?.includes("ignored"),
    `expected the ancestor path in the detail, got: ${result.detail}`
  );
  assert.ok(
    result.detail?.includes("inherited"),
    `expected the answer to say it was inherited, got: ${result.detail}`
  );
});

test("DH-14: the ancestor explanation is traceable to the directory that carries the record", (t) => {
  const dir = makeRepo(t);
  const file = explainPath(configFor(dir), "ignored/secret.txt");
  const directory = explainPath(configFor(dir), "ignored");

  assert.equal(directory.reason, "gitignore", "the directory keeps its own record");
  assert.ok(
    file.detail?.includes(directory.detail ?? "\u0000"),
    "the file's detail must build on the directory's own detail string"
  );
});

// --------------------------------- (b) built-in ignore is inherited too

test("DH-15: a file under node_modules names its ancestor and reason default-ignore", (t) => {
  const dir = makeRepo(t, { nodeModules: true });
  const result = explainPath(configFor(dir), "node_modules/dep/index.js");

  assert.equal(result.included, false);
  assert.equal(
    result.reason,
    "default-ignore",
    "the built-in ignore is inherited exactly like a gitignore, so all reasons behave alike"
  );
  assert.ok(
    result.detail?.includes('built-in ignore: directory "node_modules"'),
    `expected the directory's own detail, got: ${result.detail}`
  );
  assert.ok(
    result.detail?.includes("inherited from the skipped directory `node_modules`"),
    `expected the ancestor to be named, got: ${result.detail}`
  );
  assert.notEqual(result.detail, DOCUMENTED_NOT_DISCOVERED);
});

// --------------------------------------------- (c) unreadable names a path

test(
  "DH-16: validate names the unreadable file in text output and keeps it in JSON",
  { skip: process.platform !== "win32" ? "needs icacls to deny a read (Windows only)" : false },
  (t) => {
    const dir = makeRepo(t);
    fs.writeFileSync(path.join(dir, "src", "locked.ts"), "export const locked = 2;\n");
    assert.equal(runCli(["generate"], dir).code, 0, "baseline generate must succeed");

    const locked = path.join(dir, "src", "locked.ts");
    const user = execFileSync("whoami", { encoding: "utf8" }).trim();
    let denied = false;
    try {
      execFileSync("icacls", [locked, "/deny", `${user}:(R)`], { stdio: "ignore" });
      denied = true;

      const text = runCli(["validate"], dir);
      assert.equal(text.code, 1, "an unreadable file must still fail validation");
      assert.ok(
        text.stderr.includes("could not be read"),
        `expected the unreadable summary, got: ${text.stderr}`
      );
      assert.ok(
        text.stderr.includes("unreadable: src/locked.ts"),
        `the text output must name the path, got: ${text.stderr}`
      );

      const json = runCli(["validate", "--format", "json"], dir);
      assert.equal(json.code, 1);
      const payload = JSON.parse(json.stdout);
      assert.deepEqual(
        payload.drift.unreadable,
        ["src/locked.ts"],
        "the JSON payload must keep carrying drift.unreadable"
      );
    } finally {
      if (denied) execFileSync("icacls", [locked, "/remove:d", user], { stdio: "ignore" });
    }

    assert.equal(runCli(["validate"], dir).code, 0, "validation recovers once the read is allowed");
  }
);

// ------------------------------------------------ (d) deleted still names

test("DH-17: a genuinely deleted file still prints `deleted: <path>`", (t) => {
  const dir = makeRepo(t);
  assert.equal(runCli(["generate"], dir).code, 0, "baseline generate must succeed");

  fs.rmSync(path.join(dir, "src", "a.ts"));
  const result = runCli(["validate"], dir);

  assert.equal(result.code, 1);
  assert.ok(
    result.stderr.includes("deleted: src/a.ts"),
    `expected the deleted line, got: ${result.stderr}`
  );
  assert.ok(
    !result.stderr.includes("unreadable:"),
    "a deleted file must not be reported as unreadable"
  );
});

// --------------------------------------------------------------- regression

test("DH-18: a file that is not skipped at all still explains as included", (t) => {
  const dir = makeRepo(t);
  const result = explainPath(configFor(dir), "src/a.ts");

  assert.equal(result.included, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.language, "typescript");
});

// ------------------------------------- (e) genuinely unexplained keeps its string

test("DH-19: a path nothing accounts for still reports not-discovered", (t) => {
  const dir = makeRepo(t);
  const config = configFor(dir);
  generateSnapshot(config);

  // The tool prunes its own output directory without recording it, so this file
  // exists, has no skip record, and has no skipped ancestor either -- the one
  // remaining case that is genuinely unexplained.
  const result = explainPath(config, "snapshot/manifest.json");

  assert.equal(result.exists, true);
  assert.equal(result.included, false);
  assert.equal(result.reason, "not-discovered");
  assert.equal(
    result.detail,
    DOCUMENTED_NOT_DISCOVERED,
    "the not-discovered detail string is documented, so it must not drift"
  );
});

// ---------------------------------------- (f) docs quote what the binary prints

test("DH-20: the docs quote the exact reason/detail strings the binary prints", (t) => {
  const dir = makeRepo(t, { nodeModules: true });
  const config = configFor(dir);
  generateSnapshot(config);

  const defaultIgnore = explainPath(config, "node_modules/dep/index.js");
  const gitignored = explainPath(config, "ignored/secret.txt");
  const unexplained = explainPath(config, "snapshot/manifest.json");

  const cliDoc = fs.readFileSync(path.join(HERE, "..", "docs", "cli.md"), "utf8");
  const troubleshootingDoc = fs.readFileSync(
    path.join(HERE, "..", "docs", "troubleshooting.md"),
    "utf8"
  );

  assert.equal(defaultIgnore.reason, "default-ignore");
  assert.equal(gitignored.reason, "gitignore");
  assert.equal(unexplained.reason, "not-discovered");

  // Both inherited forms are documented in the CLI key table.
  for (const [name, detail] of [
    ["default-ignore", defaultIgnore.detail],
    ["gitignore", gitignored.detail]
  ]) {
    assert.ok(
      cliDoc.includes(detail),
      `docs/cli.md must quote the live ${name} detail verbatim, expected: ${detail}`
    );
  }

  // The troubleshooting reason table documents all three verbatim.
  for (const [name, detail] of [
    ["default-ignore", defaultIgnore.detail],
    ["gitignore", gitignored.detail],
    ["not-discovered", unexplained.detail]
  ]) {
    assert.ok(
      troubleshootingDoc.includes(detail),
      `docs/troubleshooting.md must quote the live ${name} detail verbatim, expected: ${detail}`
    );
  }
});

// ------------------------------------ (g) contract appliesTo has no prose

test("DH-21: no option's appliesTo is prose, and every token is a real command", () => {
  const result = runCli(["describe", "--format", "json"], HERE);
  assert.equal(result.code, 0, "describe --format json must succeed");

  const contract = JSON.parse(result.stdout);
  // `check` is an alias of `validate`; a scope entry uses the canonical name.
  const COMMANDS = [
    "generate",
    "validate",
    "report",
    "explain",
    "init",
    "setup",
    "diff",
    "describe",
    "skill",
  ];

  assert.ok(
    Array.isArray(contract.options) && contract.options.length >= 20,
    `expected the full option table, got ${contract.options?.length}`
  );

  for (const option of contract.options) {
    const appliesTo = String(option.appliesTo);

    // The regression this pins: `--format` used to read "all commands", which a
    // machine consumer parses as one command named "all commands" -- i.e. a flag
    // that applies to nothing. Literal prose must never come back.
    assert.ok(
      !/\ball\b/i.test(appliesTo),
      `${option.flag} appliesTo must be a command list, not prose: "${appliesTo}"`
    );

    const tokens = appliesTo.split("/");
    assert.ok(tokens.length > 0, `${option.flag} has an empty appliesTo`);
    for (const token of tokens) {
      assert.ok(token.length > 0, `${option.flag} appliesTo has an empty token: "${appliesTo}"`);
      assert.ok(
        COMMANDS.includes(token),
        `${option.flag} appliesTo names "${token}", which is not one of the known commands`
      );
    }
  }

  // The specific entry the Lead's sweep caught, asserted by value.
  const format = contract.options.find((option) => option.flag === "--format");
  assert.ok(format, "the contract must list --format");
  assert.equal(
    format.appliesTo,
    "generate/validate/report/explain/init/setup/diff/describe/skill",
    "--format applies everywhere, so its list must name every canonical command"
  );
});
