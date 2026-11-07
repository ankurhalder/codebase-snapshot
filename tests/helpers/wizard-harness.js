import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import { runInit } from "../../dist/index.js";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The project the back/frame suites drive; callers may replace it entirely. */
export const DEFAULT_WIZARD_FILES = Object.freeze({
  "package.json": '{"name":"app","version":"1.0.0"}\n',
  "next.config.ts": "export default {};\n",
  "src/a.ts": "export const a = 1;\n",
});

/** Creates a temporary project, cleaned up with the test. */
export function createWizardProject(t, { files = DEFAULT_WIZARD_FILES, prefix = "wizard-" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Finds the config file the wizard wrote, whatever extension it chose. */
export function findConfigName(dir) {
  return fs
    .readdirSync(dir)
    .find((name) => /^snapshot\.config\.(ts|mjs|cjs|js|json)$/.test(name));
}

/**
 * Drives the interactive wizard through a fake TTY.
 *
 * A key is released on each repainted prompt (`◆`), never on arbitrary writes: releasing during
 * the previous prompt's erase can land in a reader that is about to close and stall the run.
 *
 * Variants are options, not forks: `columns` controls wrapping, `captureError` returns a thrown
 * race error instead of re-throwing it, `assertAllKeys` controls the consumed-key check, and
 * `raw`/`screen` are both returned so callers can inspect terminal bytes or readable text.
 */
export async function driveWizard(
  dir,
  keys,
  { columns = 120, captureError = false, assertAllKeys = true, timeoutMs = 5000 } = {}
) {
  const pending = [...keys];
  const chunks = [];

  const output = new PassThrough();
  output.isTTY = true;
  output.columns = columns;

  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = () => {};

  output.on("data", (chunk) => {
    const text = chunk.toString();
    chunks.push(text);
    if (!text.includes("◆") || pending.length === 0) return;
    const key = pending.shift();
    const press = typeof key === "string" ? { name: key } : key;
    queueMicrotask(() => input.emit("keypress", "", press));
  });

  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`the wizard stalled with ${pending.length} key(s) left`)),
      timeoutMs
    )
  );
  const run = runInit({ cwd: dir, io: { input, output } });
  run.catch(() => {});

  let result;
  let error = null;
  try {
    result = await Promise.race([run, timeout]);
  } catch (caught) {
    if (!captureError) throw caught;
    error = caught;
  }

  if (assertAllKeys) assert.deepEqual(pending, [], "every programmed key was consumed");
  const raw = chunks.join("");
  return { result, error, raw, screen: raw.replace(ANSI, "") };
}
