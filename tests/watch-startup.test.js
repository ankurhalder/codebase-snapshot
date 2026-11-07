import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isGeneratedWatchPath, watchPathsFor, watchSupportProblem } from "../dist/cli.js";
import { resolveConfig } from "../dist/index.js";

/**
 * `generate --watch` from the 0.9.10 audit.
 *
 * It ran the generator twice before anything changed — `runCommand` generated, then the loop
 * generated again — and it froze `outDir`/`tmpDir` at startup, so changing them in the config
 * made the watcher see its own output as user content and regenerate forever.
 */

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

/** The CLI refuses `--watch` where the runtime cannot do it, so this file cannot run it either. */
const watchUnavailable = watchSupportProblem();

function tempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watch-start-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("watching does not generate a second time on startup", async (t) => {
  if (watchUnavailable !== null) {
    t.skip(`recursive watching is unavailable here: ${watchUnavailable}`);
    return;
  }
  const dir = tempRepo(t);
  const child = spawn(process.execPath, [BIN, "generate", "--watch", "--cwd", dir], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));

  // Attached before the kill, not after. Waiting for `exit` on a child that has already exited
  // leaves the promise pending for ever, and a `node --test` worker with no handles left reports
  // that as "Promise resolution is still pending but the event loop has already resolved" — a
  // hang, not the assertion failure it really is. That is how a crash on Node 18 hid behind this.
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal }))
  );

  // Long enough for the initial generate plus a debounce window to have fired if it were going
  // to. The regenerate line is the one this assertion counts: it is printed only by the loop.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const premature = await Promise.race([exited, Promise.resolve(null)]);
  assert.equal(
    premature,
    null,
    `the watcher exited before the first window (${JSON.stringify(premature)}):\n${output}`
  );
  child.kill();
  await exited;

  const regenerations = (output.match(/♻️/g) ?? []).length;
  assert.equal(
    regenerations,
    0,
    `the startup snapshot is generated once; the loop produced ${regenerations} more:\n${output}`
  );
  assert.match(output, /Watching for changes/, "and the loop did start");
});

test("--watch is refused, not crashed, where the runtime cannot watch a tree", (t) => {
  // The package declares `engines: >=18`, and `fs.watch({recursive:true})` only arrived on Linux
  // in Node 20.13. Before that the CLI threw ERR_FEATURE_UNAVAILABLE_ON_PLATFORM *after* writing
  // a snapshot and printing "Watching for changes" — a working tool crashing at the end.
  assert.match(watchSupportProblem("linux", "18.20.4") ?? "", /20\.13/);
  assert.match(watchSupportProblem("linux", "20.12.2") ?? "", /20\.13/);
  assert.equal(watchSupportProblem("linux", "20.13.0"), null, "the first version that works");
  assert.equal(watchSupportProblem("linux", "22.11.0"), null);
  assert.equal(watchSupportProblem("win32", "18.0.0"), null, "Windows has always had one");
  assert.equal(watchSupportProblem("darwin", "18.0.0"), null, "and so has macOS");

  // A Node too old to watch must be told so by the CLI itself, with exit 2 and nothing written.
  if (watchUnavailable === null) {
    t.skip("this runtime can watch a tree, so it cannot exercise the refusal");
    return;
  }
  const dir = tempRepo(t);
  const refused = spawnSync(process.execPath, [BIN, "generate", "--watch", "--cwd", dir], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /20\.13/);
  assert.equal(
    fs.existsSync(path.join(dir, "snapshot")),
    false,
    "and it refused before writing anything"
  );
});

test("the watch paths follow the config, not the startup snapshot of it", () => {
  const base = { cwd: os.tmpdir(), tmpDir: "snapshot.tmp" };
  const before = watchPathsFor(resolveConfig({ ...base, outDir: "snapshot" }));
  const after = watchPathsFor(resolveConfig({ ...base, outDir: ".context" }));

  assert.notEqual(before.outDir, after.outDir);
  // The loop the fix removes: after the config moved outDir, the *old* paths no longer recognise
  // the tool's own output, so the write triggers a regeneration that triggers another write.
  assert.equal(
    isGeneratedWatchPath(path.join(after.outDir, "manifest.json"), after),
    true,
    "the reloaded config recognises its own output"
  );
  assert.equal(
    isGeneratedWatchPath(path.join(after.outDir, "manifest.json"), before),
    false,
    "the startup snapshot of the config cannot, which is why it has to be refreshed"
  );
  assert.equal(
    isGeneratedWatchPath(path.join(before.outDir, "manifest.json"), after),
    false,
    "and the refresh is a replacement, not an addition"
  );
});

test("setup with an unknown preset is a usage error, like init", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-preset-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');

  const init = spawnSync(process.execPath, [BIN, "init", "--preset", "no-such-preset", "--cwd", dir], {
    cwd: dir,
    encoding: "utf8",
  });
  const setup = spawnSync(
    process.execPath,
    [BIN, "setup", "--preset", "no-such-preset", "--cwd", dir, "--no-install"],
    { cwd: dir, encoding: "utf8" }
  );

  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(init.status, 2, "init validates the name at parse time");
  assert.equal(setup.status, 2, "and setup takes the same flag, so it must answer the same way");
  assert.match(setup.stderr, /no-such-preset/);
  assert.match(setup.stderr, /presets?/i, "the error lists what would have worked");
});
