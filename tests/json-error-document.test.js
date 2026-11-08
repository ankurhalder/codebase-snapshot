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
 * 4.1.0 regression cover for `--format json` failure modes.
 *
 * Progress goes to stderr and payloads to stdout, which used to mean a failed JSON-mode invocation
 * wrote *nothing* to stdout: an agent had to notice an empty string, then parse stderr prose and
 * guess. Every failure now writes one parseable document instead — `{ error: { message, exitCode } }`
 * — while the human line stays on stderr and the exit code is unchanged.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-jsonfail-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRepo(t) {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n', "utf8");
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const a = 1;\n", "utf8");
  return dir;
}

const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
};

const parseError = (out) => {
  const payload = JSON.parse(out);
  assert.ok(payload && payload.error, `expected an error document, got: ${out}`);
  assert.equal(typeof payload.error.message, "string");
  assert.equal(typeof payload.error.exitCode, "number");
  return payload.error;
};

test("report on a missing manifest returns a parseable error document", (t) => {
  const dir = makeRepo(t);
  const { code, out, err } = run(["report", "--format", "json"], dir);

  assert.equal(code, 1);
  const error = parseError(out);
  assert.equal(error.exitCode, 1);
  assert.match(error.message, /Manifest not found/);
  assert.match(err, /❌/, "the human line is still on stderr");
});

test("diff against a missing file returns a parseable error document", (t) => {
  const dir = makeRepo(t);
  const { code, out } = run(
    ["diff", "--format", "json", path.join(dir, "nope-a"), path.join(dir, "nope-b")],
    dir
  );

  assert.equal(code, 1);
  parseError(out);
});

test("a refused output directory returns a parseable error document", (t) => {
  const dir = makeRepo(t);
  const { code, out } = run(["generate", "--format", "json", "--out-dir", "src"], dir);

  assert.equal(code, 1);
  const error = parseError(out);
  assert.match(error.message, /Refusing to replace|Refusing to write/);
});

test("init over an existing config returns a parseable error document", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, "snapshot.config.mjs"), "export default {};\n", "utf8");

  const { code, out } = run(["init", "--yes", "--format", "json"], dir);

  assert.equal(code, 1);
  const error = parseError(out);
  assert.match(error.message, /already exists/);
});

test("a successful JSON invocation is still a payload, not an error", (t) => {
  const dir = makeRepo(t);
  assert.equal(run(["generate", "--format", "json"], dir).code, 0);

  const { code, out } = run(["validate", "--format", "json"], dir);
  assert.equal(code, 0);
  const payload = JSON.parse(out);
  assert.equal(payload.valid, true);
  assert.equal(payload.error, undefined, "success carries no error key");
});

/**
 * B5: the config loader's failures are failures too, and a `--format json` invocation owes its
 * caller one parseable document.
 *
 * Every case above goes through `fail()`. These go through `loadConfigFileDetailed` and
 * `resolveConfig`, which used to answer with exit 1 and an empty stdout — the exact gap that let
 * 0.9.14 promise "every failing run writes one JSON document" and not keep it. The gap was
 * invisible because no test below the `fail()` layer existed.
 */

/** A usable repository whose config files are the thing under test. */
function makeRepoWithConfig(t, files) {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n', "utf8");
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const a = 1;\n", "utf8");
  for (const [relative, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, relative), content, "utf8");
  }
  return dir;
}

const BROKEN_CONFIGS = [
  ["a config that does not parse", { "snapshot.config.json": '{ "outDir": "snap",' }, /could not be read|Could not parse/i],
  ["an unknown config key", { "snapshot.config.json": '{"maxPartByte": 4096}' }, /unknown setting/i],
  ["a config value resolveConfig rejects", { "snapshot.config.json": '{"maxPartBytes": 0}' }, /positive byte count/i],
  ["a config preset that does not exist", { "snapshot.config.json": '{"preset": "not-a-preset"}' }, /Unknown preset/i],
  ["a config module that throws on import", { "snapshot.config.mjs": 'throw new Error("config boom");\n' }, /config boom/i],
  ["a config module with a null default export", { "snapshot.config.mjs": "export default null;\n" }, /does not export a configuration object/i],
  ["a broken package.json", { "package.json": '{"name": "fixture", "version": }' }, /Could not parse/i],
];

for (const [label, files, message] of BROKEN_CONFIGS) {
  test(`--format json answers a config failure with one document: ${label}`, (t) => {
    const dir = makeRepoWithConfig(t, files);
    const { code, out, err } = run(["generate", "--format", "json"], dir);

    assert.equal(code, 1, `${label}: exit`);
    assert.ok(out.length > 0, `${label}: stdout must carry the error document, not be empty`);
    const document = JSON.parse(out);
    assert.ok(document.error, `${label}: { error } document`);
    assert.equal(document.error.exitCode, 1, `${label}: exitCode`);
    assert.match(document.error.message, message, `${label}: message explains the failure`);
    assert.match(err, /❌/, `${label}: the human line stays on stderr`);
  });
}

test("a config failure keeps stdout empty in text mode", (t) => {
  const dir = makeRepoWithConfig(t, { "snapshot.config.json": "{ bad" });

  const { code, out } = run(["generate"], dir);

  assert.equal(code, 1);
  assert.equal(out, "", "text mode never writes a payload to stdout");
});

test("the config-failure document is produced by validate and explain too", (t) => {
  for (const args of [
    ["validate", "--format", "json"],
    ["explain", "src/index.ts", "--format", "json"],
  ]) {
    const dir = makeRepoWithConfig(t, { "snapshot.config.json": "{ bad" });
    const { code, out } = run(args, dir);

    assert.equal(code, 1, `${args.join(" ")}: exit`);
    const document = JSON.parse(out);
    assert.equal(document.error.exitCode, 1, `${args.join(" ")}: exitCode`);
    assert.match(document.error.message, /could not be read/i);
  }
});
