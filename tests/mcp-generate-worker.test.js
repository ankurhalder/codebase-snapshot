import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateInWorker } from "../dist/mcp.js";

/**
 * `snapshot_generate` off the JSON-RPC thread, from the 0.9.9 audit.
 *
 * The 0.9.4 measurement is in the changelog: a synchronous generate blocks the stdio server for
 * about 7.5 seconds on a 3,000-file repository. In that window the process cannot answer `ping`
 * or acknowledge `notifications/cancelled`, and a client with a socket timeout reports a working
 * tool call as a dead server.
 *
 * A resolved config cannot cross a thread boundary — `layers[].match` may be a function and
 * `hooks.afterGenerate` always is — so the worker loads the config file and applies the same CLI
 * options the calling thread did. These tests pin both the behaviour and that division.
 */

function makeRepo(t, files = 6) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-worker-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  for (let index = 0; index < files; index += 1) {
    fs.writeFileSync(
      path.join(dir, "src", `f${index}.ts`),
      `export function fn${index}(): number { return ${index}; }\n`
    );
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the call does not block the event loop", async (t) => {
  const dir = makeRepo(t, 120);

  let settled = false;
  const run = generateInWorker(dir, { cwd: dir }).then((result) => {
    settled = true;
    return result;
  });

  // A timer scheduled after the call must be able to run before the generation finishes. With a
  // synchronous generate this assertion is the one that fails, which is the whole point.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false, "generate must run off the calling thread");

  const result = await run;
  assert.equal(result.ok, true, result.ok ? "" : result.message);
});

test("the summary matches the snapshot written to disk", async (t) => {
  const dir = makeRepo(t);

  const result = await generateInWorker(dir, { cwd: dir });
  assert.equal(result.ok, true, result.ok ? "" : result.message);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8")
  );
  assert.equal(result.summary.fingerprint, manifest.fingerprint);
  assert.equal(result.summary.totalFiles, manifest.counts.totalFiles);
  assert.equal(result.summary.partsCount, manifest.counts.partsCount);
  assert.deepEqual(result.summary.parts, manifest.parts.map((part) => ({
    filename: part.filename,
    byteSize: part.byteSize,
  })));
});

test("the worker honours the same options the caller resolved with", async (t) => {
  const dir = makeRepo(t);

  const result = await generateInWorker(dir, { cwd: dir, outDir: "custom-out" });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  assert.ok(
    fs.existsSync(path.join(dir, "custom-out", "manifest.json")),
    "the override reached the worker's own resolveConfig"
  );
});

test("a broken config is reported, not silently regenerated with defaults", async (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(
    path.join(dir, "snapshot.config.json"),
    '{"maxPartByte": 4096}\n' // a typo: maxPartBytes
  );

  const result = await generateInWorker(dir, { cwd: dir });

  assert.equal(result.ok, false);
  assert.match(result.message, /unknown setting/);
  assert.equal(
    fs.existsSync(path.join(dir, "snapshot")),
    false,
    "nothing was written by a run that could not read its config"
  );
});

test("a failure inside generation comes back as a message, not a crash", async (t) => {
  const dir = makeRepo(t);
  // A lock file that this process does not own refuses the run; the worker must surface that
  // refusal as text rather than exiting silently.
  const tmpDir = path.join(dir, "snapshot.tmp");
  const { lockPathFor } = await import("../dist/index.js");
  fs.mkdirSync(tmpDir, { recursive: true });
  const lockPath = lockPathFor(fs.realpathSync(tmpDir));
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid })}\n`);
  t.after(() => fs.rmSync(lockPath, { force: true }));

  const result = await generateInWorker(dir, { cwd: dir });

  assert.equal(result.ok, false);
  assert.match(result.message, /already using the staging directory/);
});
