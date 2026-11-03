import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

/**
 * 4.1.0 regression cover for `init` when `.gitignore` is not a file.
 *
 * `addGitignore` read the path before writing it, so a `.gitignore` *directory* threw a raw
 * `EISDIR` from the read — after `init` had already written the config. The run both failed and
 * left state behind, which is the worst combination. The `.gitignore` update is a convenience, so
 * it is now a note and `init` finishes what it promised.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-init-ignore-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const runInit = (dir) =>
  spawnSync(process.execPath, [BIN, "init", "--yes"], { cwd: dir, encoding: "utf8" });

test("init succeeds and explains itself when .gitignore is a directory", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n', "utf8");
  fs.mkdirSync(path.join(dir, ".gitignore"));

  const result = runInit(dir);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.equal(result.status, 0, `init must not fail over a convenience step: ${output}`);
  const configName = fs
    .readdirSync(dir)
    .find((name) => /^snapshot\.config\.(ts|mjs|cjs|js|json)$/.test(name));
  assert.ok(configName, "the config was written, which is what init promises");
  assert.match(output, /is a directory/, "the reason is stated");
  assert.match(output, /\.gitignore/, "the path is named");
  assert.doesNotMatch(output, /EISDIR: illegal operation/, "no raw errno reaches the user");
});

test("init still updates a normal .gitignore", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n', "utf8");
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n", "utf8");

  const result = runInit(dir);

  assert.equal(result.status, 0);
  const ignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.match(ignore, /node_modules/, "the existing entry survives");
  assert.match(ignore, /snapshot\//, "the snapshot directory is added");
  assert.match(ignore, /snapshot\.tmp\//);
});
