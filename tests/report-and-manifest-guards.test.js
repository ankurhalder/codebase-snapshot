import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
const VALID_FINGERPRINT = "a".repeat(64);

function run(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-guards-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeManifest(dir, manifest) {
  const snapshot = path.join(dir, "snapshot");
  fs.mkdirSync(snapshot, { recursive: true });
  fs.writeFileSync(
    path.join(snapshot, "manifest.json"),
    typeof manifest === "string" ? manifest : `${JSON.stringify(manifest, null, 2)}\n`
  );
}

function reportManifest(overrides = {}) {
  return {
    schemaVersion: "3.0.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
    fingerprint: VALID_FINGERPRINT,
    counts: { totalFiles: 0, totalLines: 0, totalSizeBytes: 0, partsCount: 0 },
    layers: {},
    files: [],
    skipped: [],
    parts: [],
    warnings: [],
    ...overrides,
  };
}

function makeRepo(t) {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"guards","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  const generated = run(["generate", "--no-config", "--cwd", dir], dir);
  assert.equal(generated.status, 0, generated.stderr);
  return dir;
}

test("D-3: report rejects negative, fractional and infinite counts", (t) => {
  const dir = tempDir(t);
  const manifest = reportManifest({
    counts: { totalFiles: -5, totalLines: 1.5, totalSizeBytes: 0, partsCount: -1 },
  });
  const raw = JSON.stringify(manifest, null, 2).replace(
    '"totalSizeBytes": 0',
    '"totalSizeBytes": 1e999'
  );
  writeManifest(dir, raw);

  const result = run(["report", "--cwd", dir], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a snapshot manifest/);
  assert.doesNotMatch(result.stderr, /Files included:/);
  assert.doesNotMatch(result.stderr, /Infinity MB/);
});

test("D-4: report rejects a wrong-shaped fingerprint", (t) => {
  const dir = tempDir(t);
  writeManifest(dir, reportManifest({ fingerprint: "12345" }));

  const result = run(["report", "--cwd", dir], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a snapshot manifest/);
  assert.match(result.stderr, /fingerprint/);
  assert.doesNotMatch(result.stderr, /Fingerprint:\s+12345/);
});

test("D-4: validate rejects a wrong-shaped fingerprint", (t) => {
  const dir = makeRepo(t);
  const manifestPath = path.join(dir, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.fingerprint = "12345";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const result = run(["validate", "--no-config", "--cwd", dir], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fingerprint/);
  assert.doesNotMatch(result.stderr, /valid and up to date/);
});

test("D-5: validate does not use an outside manifest path as an existence oracle", (t) => {
  const dir = makeRepo(t);
  const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}.txt`);
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.writeFileSync(outside, "outside secret\n");

  const manifestPath = path.join(dir, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const file = manifest.files.find((entry) => entry.relativePath === "src/a.ts");
  assert.ok(file);
  file.relativePath = `../${path.basename(outside)}`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const existing = run(["validate", "--no-config", "--cwd", dir], dir);
  assert.equal(existing.status, 1);
  assert.match(existing.stderr, /resolves outside the repository and was not inspected/);
  assert.doesNotMatch(existing.stderr, /deleted:\s+\.\.\//);
  assert.doesNotMatch(existing.stderr, /new file:\s+\.\.\//);

  fs.rmSync(outside, { force: true });
  const missing = run(["validate", "--no-config", "--cwd", dir], dir);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /resolves outside the repository and was not inspected/);
  assert.doesNotMatch(missing.stderr, /deleted:\s+\.\.\//);
  assert.doesNotMatch(missing.stderr, /new file:\s+\.\.\//);
});

test("validate still rejects hostile counts (no regression)", (t) => {
  const dir = makeRepo(t);
  const manifestPath = path.join(dir, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.counts.totalFiles = -5;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const result = run(["validate", "--no-config", "--cwd", dir], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /counts|totalFiles/);
});

test("a normal generated snapshot still reports and validates", (t) => {
  const dir = makeRepo(t);

  const report = run(["report", "--cwd", dir], dir);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stderr, /Codebase Snapshot Report/);
  assert.match(report.stderr, /Fingerprint:\s+[0-9a-f]{64}/);

  const validate = run(["validate", "--no-config", "--cwd", dir], dir);
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stderr, /valid and up to date/);
});
