import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, validateSnapshot } from "../dist/index.js";

/**
 * 4.0.9 regression cover for two "the state is wrong" diagnoses.
 *
 * S8 — when a run died, the output directory held this tool's marker and no manifest, and
 * `validate`/`report` answered "run generate first" for ever. That answer can never resolve:
 * generation had already run. The marker records the state, the run id and the start time, so the
 * message names them and says what to do.
 *
 * discovery drift — how files were discovered decides which files a snapshot contains, so a
 * changed mode is configuration drift like any other, and manifests written before the key existed
 * are not "different".
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-incomplete-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

const readManifest = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));

const writeManifest = (dir, manifest) =>
  fs.writeFileSync(
    path.join(dir, "snapshot", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

test("S8: a marker left in state staging is reported as an unfinished run", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");

  // Exactly what a run killed mid-write leaves behind: the marker, no manifest.
  write(
    dir,
    "snapshot/.codebase-snapshot",
    JSON.stringify({
      generator: "@ankurhalder/codebase-snapshot",
      version: "4.0.9",
      schemaVersion: "3.0.0",
      createdAt: "2026-01-01T00:00:00.000Z",
      state: "staging",
      id: "run-abc123",
      entries: [],
    })
  );

  const result = validateSnapshot({ cwd: dir });

  assert.equal(result.valid, false);
  assert.equal(result.manifestPresent, false);
  const message = result.errors.join("\n");
  assert.match(message, /did not finish/);
  assert.match(message, /staging/);
  assert.match(message, /run-abc123/, "the run id is named");
  assert.match(message, /2026-01-01T00:00:00.000Z/, "the start time is named");
  assert.doesNotMatch(message, /Run generate first/, "the dead-end wording is gone");
});

test("S8: a marker with no manifest is reported as incomplete, not missing", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  generateSnapshot({ cwd: dir });

  // Simulate a manifest lost after the fact.
  fs.rmSync(path.join(dir, "snapshot", "manifest.json"));

  const result = validateSnapshot({ cwd: dir });
  const message = result.errors.join("\n");

  assert.equal(result.valid, false);
  assert.match(message, /incomplete/);
  assert.match(message, /Run generate again/);
});

test("S8: with no output directory at all the original message is kept", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");

  const result = validateSnapshot({ cwd: dir });
  const message = result.errors.join("\n");

  assert.match(message, /Snapshot manifest not found at/);
  assert.match(message, /Run generate first/);
});

test("S8: the documented recovery — remove the directory, regenerate, validate", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  write(
    dir,
    "snapshot/.codebase-snapshot",
    JSON.stringify({ state: "staging", id: "run-dead", createdAt: "2026-01-01T00:00:00.000Z" })
  );

  const broken = validateSnapshot({ cwd: dir });
  assert.equal(broken.valid, false);
  assert.match(broken.errors.join("\n"), /did not finish/);

  // The tool does not silently adopt a marker it cannot verify, so the documented recovery is to
  // remove the directory — the state is unrecoverable in place, and pretending otherwise would
  // mean deleting files on the strength of a marker alone.
  fs.rmSync(path.join(dir, "snapshot"), { recursive: true, force: true });
  generateSnapshot({ cwd: dir });

  assert.equal(validateSnapshot({ cwd: dir }).valid, true, "a clean regeneration repairs the state");
});

test("discovery drift: a changed mode is reported, an equal one is not", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  generateSnapshot({ cwd: dir, discovery: "walk" });

  const same = validateSnapshot({ cwd: dir, discovery: "walk" });
  assert.deepEqual(same.drift.configMismatches, [], "no drift when the mode is unchanged");

  const changed = validateSnapshot({ cwd: dir, discovery: "auto" });
  const mismatch = changed.drift.configMismatches.find((entry) => entry.startsWith("discovery:"));
  assert.ok(mismatch, `discovery drift is reported: ${JSON.stringify(changed.drift.configMismatches)}`);
  assert.match(mismatch, /manifest walk vs current auto/);
});

test("discovery drift: a manifest with no recorded mode is not drift", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  generateSnapshot({ cwd: dir });

  const manifest = readManifest(dir);
  delete manifest.config.discovery;
  writeManifest(dir, manifest);

  const result = validateSnapshot({ cwd: dir });

  assert.deepEqual(
    result.drift.configMismatches.filter((entry) => entry.startsWith("discovery:")),
    [],
    "an older manifest is not accused of drift it cannot record"
  );
});

test("the manifest records the effective discovery mode", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  generateSnapshot({ cwd: dir, discovery: "walk" });

  assert.equal(readManifest(dir).config.discovery, "walk");
});
