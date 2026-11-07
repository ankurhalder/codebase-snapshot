import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, lockPathFor, resolveConfig } from "../dist/index.js";

/**
 * The run lock, from the 0.9.9 audit.
 *
 * The lock is the one piece of state that outlives a crashed run and blocks every run
 * after it. `acquireRunLock` creates the file with `wx` and then writes the pid into it,
 * so a process killed between those two calls leaves a *zero-byte* lock: the file exists,
 * and it names no owner. `lockOwnerIsGone` parsed it, failed, and answered "not gone" —
 * forever, because nothing in the file would ever change. Only deleting the file by hand
 * recovered the repository.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function project(dir) {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  return resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" });
}

/** The lock file for this project's staging directory. */
function lockFor(dir) {
  const tmpDir = path.join(dir, "snapshot.tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  return { tmpDir, lockPath: lockPathFor(fs.realpathSync(tmpDir)) };
}

test("a zero-byte lock left by a crash does not wedge the next run", (t) => {
  const dir = tempDir(t);
  const config = project(dir);
  const { lockPath } = lockFor(dir);

  fs.writeFileSync(lockPath, "");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(lockPath, twoHoursAgo, twoHoursAgo);

  const manifest = generateSnapshot(config);

  assert.ok(manifest.parts.length > 0, "the run completed");
  assert.equal(fs.existsSync(lockPath), false, "and released the lock it took");
});

test("a lock that names a dead process is reclaimed", (t) => {
  const dir = tempDir(t);
  const config = project(dir);
  const { lockPath } = lockFor(dir);

  // A pid that cannot exist: process ids are positive and far below this on every
  // platform Node supports.
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 2 ** 30 - 1 })}\n`);

  const manifest = generateSnapshot(config);
  assert.ok(manifest.parts.length > 0);
  assert.equal(fs.existsSync(lockPath), false);
});

test("a fresh lock is respected, whatever its contents", (t) => {
  const dir = tempDir(t);
  const config = project(dir);
  const { lockPath } = lockFor(dir);

  // Written moments ago, so it may belong to a run that is still inside the window
  // between creating the file and writing its pid. Refusing is the correct answer: a
  // wrongly refused run costs a retry, a wrongly stolen lock costs a snapshot.
  fs.writeFileSync(lockPath, "");
  try {
    assert.throws(() => generateSnapshot(config), /Another generate run is already using/);
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
});
