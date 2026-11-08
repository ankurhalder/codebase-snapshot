#!/usr/bin/env node
/**
 * Runs the test suite inside a scratch directory this script owns and deletes.
 *
 * `node --test` writes every fixture the suite creates under the host temp directory.
 * A test that forgets its cleanup leaves one directory behind per run, and a Windows
 * delete that loses a race with an indexer fails quietly — five days of runs had
 * accumulated 616 leftover directories and about 600 MB. This wrapper points TEMP,
 * TMP and TMPDIR at one root, so a leak can only leak inside that root, and removes
 * the root when the run ends, whether the tests passed or failed.
 *
 * Usage:
 *   node scripts/test-run.mjs
 *   node scripts/test-run.mjs --experimental-test-coverage
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(HERE, "..");

/** The suite files, in a stable order, as paths relative to the repository root. */
export function suiteFiles(root = REPO_ROOT) {
  return fs
    .readdirSync(path.join(root, "tests"))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join("tests", name));
}

/** Removes a directory tree, retrying the transient EPERM/EBUSY a child or an indexer can cause. */
export function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    console.error(`test-run: could not remove ${target}: ${error.message}`);
    return false;
  }
}

/** A directory under the host temp root that this script exclusively owns. */
export function makeScratchRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cbs-test-run-"));
}

let activeScratch = null;

/**
 * Runs `node --test` with the temp environment redirected into a scratch root,
 * then removes the root. Resolves with the exit code and what the run left behind.
 */
export function runSuite({
  files = suiteFiles(),
  nodeArgs = [],
  cwd = REPO_ROOT,
  env = process.env,
  stdio = "inherit",
} = {}) {
  const scratch = makeScratchRoot();
  activeScratch = scratch;
  const childEnv = { ...env, TEMP: scratch, TMP: scratch, TMPDIR: scratch };
  // A test file that runs the suite (tests/temp-hygiene.test.js) inherits
  // NODE_TEST_CONTEXT, which makes the inner node --test believe it is already a
  // running child and skip the file it was handed. An inner run must execute what
  // it was asked to, so the marker is not passed down.
  delete childEnv.NODE_TEST_CONTEXT;
  return new Promise((resolve) => {
    const settle = (code) => {
      activeScratch = null;
      let leaked = [];
      try {
        leaked = fs.readdirSync(scratch);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const removed = removeTree(scratch);
      if (leaked.length > 0) {
        const plural = leaked.length === 1 ? "entry" : "entries";
        const shown = leaked.slice(0, 5).join(", ");
        const more = leaked.length > 5 ? ", ..." : "";
        console.error(`test-run: removed ${leaked.length} leaked temp ${plural}: ${shown}${more}`);
      }
      resolve({ code, scratch, leftovers: leaked.length, removed });
    };
    const child = spawn(process.execPath, ["--test", ...nodeArgs, ...files], {
      cwd,
      env: childEnv,
      stdio,
    });
    child.on("error", (error) => {
      console.error(`test-run: could not start node --test: ${error.message}`);
      settle(1);
    });
    child.on("close", (code, signal) => settle(signal ? 1 : code ?? 1));
  });
}

// A Ctrl-C must not leave the scratch root behind either.
process.on("exit", () => {
  if (activeScratch) removeTree(activeScratch);
});

const cliPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (cliPath === import.meta.url) {
  const result = await runSuite({ nodeArgs: process.argv.slice(2) });
  process.exitCode = result.code;
}
