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
