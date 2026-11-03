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

import { explainPath, resolveConfig } from "../dist/index.js";

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

// ------------------------------------------ (b) documented not-discovered

test("DH-15: a file under node_modules still explains as not-discovered", (t) => {
  const dir = makeRepo(t, { nodeModules: true });
  const result = explainPath(configFor(dir), "node_modules/dep/index.js");

  assert.equal(result.included, false);
  assert.equal(
    result.reason,
    "not-discovered",
    "the documented node_modules answer must not be replaced by an inherited default-ignore"
  );
  assert.equal(result.detail, DOCUMENTED_NOT_DISCOVERED);
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
