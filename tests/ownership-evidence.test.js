import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot } from "../dist/index.js";

/**
 * 4.0.9 regression cover for ownership evidence.
 *
 * `.gitkeep` and `.gitignore` were subtracted from the foreign-entry set, so a snapshot directory
 * that this generator owned and that held a user's `.gitignore` was replaced — atomically, exit 0,
 * no warning — and the file was deleted. A directory that held nothing but those two was replaced
 * without any ownership evidence at all. Both are somebody's data; both now refuse.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-ownership-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

const generate = (dir, overrides = {}) => generateSnapshot({ cwd: dir, ...overrides });

const snapshotDir = (dir) => path.join(dir, "snapshot");

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

test("FS-02: a user's .gitignore inside an owned outDir is refused, not deleted", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  generate(dir);

  const added = write(dir, "snapshot/.gitignore", "*\n");

  assert.throws(
    () => generate(dir),
    /Refusing to replace outDir/,
    "the run must refuse rather than replace the directory"
  );
  assert.ok(fs.existsSync(added), "the user's file survives");
  assert.equal(fs.readFileSync(added, "utf8"), "*\n");
  // The snapshot itself is untouched too: a refused run writes nothing.
  assert.ok(fs.existsSync(path.join(dir, "snapshot", "manifest.json")));
});

test("FS-10: a directory holding only .gitkeep is refused, not replaced", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  fs.mkdirSync(path.join(dir, "snapshot"), { recursive: true });
  const keep = write(dir, "snapshot/.gitkeep", "");

  assert.throws(() => generate(dir), /Refusing to replace outDir/);
  assert.ok(fs.existsSync(keep), ".gitkeep survives");
});

test("FS-10: a directory holding only a .gitignore is refused, not replaced", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  fs.mkdirSync(path.join(dir, "snapshot"), { recursive: true });
  const ignore = write(dir, "snapshot/.gitignore", "*\n!.gitignore\n");

  assert.throws(() => generate(dir), /Refusing to replace outDir/);
  assert.equal(fs.readFileSync(ignore, "utf8"), "*\n!.gitignore\n");
});

test("FS-10: the refusal names the entry that stopped it", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  fs.mkdirSync(path.join(dir, "snapshot"), { recursive: true });
  write(dir, "snapshot/.gitkeep", "");

  assert.throws(() => generate(dir), /\.gitkeep/);
});

test(".DS_Store is still tolerated: Finder noise is not user data", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  fs.mkdirSync(path.join(dir, "snapshot"), { recursive: true });
  write(dir, "snapshot/.DS_Store", "noise");

  const manifest = generate(dir);

  assert.ok(manifest.files.some((file) => file.relativePath === "app.ts"));
  assert.ok(!fs.existsSync(path.join(dir, "snapshot", ".DS_Store")), "the noise file is gone");
});

test("a complete snapshot this build wrote is still replaced without complaint", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");

  const first = generate(dir);
  write(dir, "app.ts", "export const a = 2;\n");
  const second = generate(dir);

  assert.notEqual(first.fingerprint, second.fingerprint, "the second run really regenerated");
  assert.equal(second.counts?.files ?? second.files.length, 1);
});

test("an outDir holding only empty directories is replaced, not refused", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  // The state a killed run, an emptied snapshot or a hand-made skeleton leaves behind: `parts/` and
  // `reports/` with nothing in them. Refusing protected no data and blocked every later run.
  fs.mkdirSync(path.join(dir, "snapshot", "parts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "snapshot", "reports", "deeper"), { recursive: true });

  const manifest = generate(dir);

  assert.ok(fs.existsSync(path.join(dir, "snapshot", "manifest.json")), "the run replaced it");
  assert.ok(manifest.counts.totalFiles > 0, "the snapshot was written");
});

test("an outDir holding any file is still refused without a marker", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  write(dir, "snapshot/parts/keep.md", "user notes\n");

  assert.throws(() => generate(dir), /Refusing to replace outDir/);
  assert.equal(fs.readFileSync(path.join(dir, "snapshot", "parts", "keep.md"), "utf8"), "user notes\n");
});

// ------------------------------------------------------------------ B7: evidence
// The marker used to be accepted on shape alone: generator name, schema version, a run id,
// state "complete" and a self-listing `entries` array. A hand-written marker therefore
// authorised deleting whatever was in the directory, which contradicts AGENTS.md ("a
// hand-written marker is not evidence"). Acceptance now also requires the per-file digest
// inventory a real run records, and a LEGACY marker (a snapshot written before that
// inventory existed) must carry a manifest digest that matches the manifest beside it, so
// upgrading never refuses the output directory a user already has.

function forgedMarker(files, overrides = {}) {
  return JSON.stringify(
    {
      generator: "codebase-snapshot",
      version: "0.9.14",
      schemaVersion: "3.0.0",
      createdAt: new Date().toISOString(),
      state: "complete",
      id: crypto.randomUUID(),
      entries: [".codebase-snapshot", ...files.map((file) => file.path)],
      ...overrides,
    },
    null,
    2
  ) + "\n";
}

test("B7: the forged marker with no manifest is refused, and nothing is deleted", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  const notes = "# my notes\n";
  const budget = "item,amount\ncoffee,3\n";
  write(dir, "user-docs/notes.md", notes);
  write(dir, "user-docs/budget.csv", budget);
  write(
    dir,
    "user-docs/.codebase-snapshot",
    forgedMarker([
      { path: "notes.md", bytes: Buffer.byteLength(notes) },
      { path: "budget.csv", bytes: Buffer.byteLength(budget) },
    ])
  );

  assert.throws(
    () => generate(dir, { outDir: "user-docs" }),
    /Refusing to replace outDir/,
    "a marker with no per-file digests is not ownership evidence"
  );
  assert.equal(fs.readFileSync(path.join(dir, "user-docs", "notes.md"), "utf8"), notes);
  assert.equal(fs.readFileSync(path.join(dir, "user-docs", "budget.csv"), "utf8"), budget);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("B7: a legacy marker from a real snapshot is still replaced (upgrade path)", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  generate(dir);

  // Simulate a snapshot written before the per-file inventory existed: the same marker,
  // minus the files[] field. Its manifest digest and entry list are still the ones a real
  // run wrote, so an upgraded build must accept it.
  const markerPath = path.join(snapshotDir(dir), ".codebase-snapshot");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.ok(Array.isArray(marker.files), "the new shape really carries the inventory");
  delete marker.files;
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n");

  // The first generate after an upgrade must not fail on the user's existing output.
  const second = generate(dir);
  assert.ok(second.counts.totalFiles > 0, "the legacy snapshot was replaced, not refused");
  assert.ok(
    fs.existsSync(path.join(snapshotDir(dir), "parts", "part-001.md")),
    "the replaced snapshot is whole"
  );
  const rewritten = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.ok(
    Array.isArray(rewritten.files) && rewritten.files.length > 0,
    "the replacing run writes the hardened shape, so later runs are already strict"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("B7: a hand-written inventory whose digests or byte lengths do not match is refused", (t) => {
  for (const forged of [
    { label: "wrong digest", digest: "0".repeat(64), bytes: null },
    { label: "wrong byte length", digest: null, bytes: 1 },
  ]) {
    const dir = tempDir(t);
    write(dir, "app.ts", "export const a = 1;\n");
    const notes = "# my notes\n";
    write(dir, "user-docs/notes.md", notes);
    write(
      dir,
      "user-docs/.codebase-snapshot",
      forgedMarker([{ path: "notes.md", bytes: Buffer.byteLength(notes) }], {
        files: [
          {
            path: "notes.md",
            bytes: forged.bytes ?? Buffer.byteLength(notes),
            sha256: forged.digest ?? sha256(Buffer.from(notes)),
          },
        ],
      })
    );

    assert.throws(
      () => generate(dir, { outDir: "user-docs" }),
      /Refusing to replace outDir/,
      `a marker with a ${forged.label} must not count as ownership`
    );
    assert.equal(
      fs.readFileSync(path.join(dir, "user-docs", "notes.md"), "utf8"),
      notes,
      "the user file survives"
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("B7: a real snapshot's marker records a digest for every file it wrote", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  generate(dir);

  const marker = JSON.parse(
    fs.readFileSync(path.join(snapshotDir(dir), ".codebase-snapshot"), "utf8")
  );
  assert.ok(Array.isArray(marker.files) && marker.files.length > 0, "the marker records digests");
  assert.ok(
    marker.files.some((record) => record.path === "manifest.json"),
    "the manifest itself is in the inventory"
  );
  const filesOnDisk = marker.entries
    .filter((entry) => entry !== ".codebase-snapshot")
    .filter((entry) => fs.statSync(path.join(snapshotDir(dir), ...entry.split("/"))).isFile())
    .sort();
  assert.deepEqual(
    marker.files.map((record) => record.path).sort(),
    filesOnDisk,
    "every file the snapshot wrote has a digest, and nothing else does"
  );
  for (const record of marker.files) {
    const full = path.join(snapshotDir(dir), ...record.path.split("/"));
    const bytes = fs.readFileSync(full);
    assert.equal(record.bytes, bytes.length, `${record.path} byte length`);
    assert.equal(record.sha256, sha256(bytes), `${record.path} digest`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("B7: a new marker whose recorded digest no longer matches the part is refused", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  generate(dir);

  const part = path.join(snapshotDir(dir), "parts", "part-001.md");
  fs.writeFileSync(part, "my own notes, not the tool's\n");

  assert.throws(
    () => generate(dir),
    /Refusing to replace outDir/,
    "bytes inside the snapshot changed, so the recorded evidence no longer matches"
  );
  assert.equal(fs.readFileSync(part, "utf8"), "my own notes, not the tool's\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("B7: a real snapshot without manifest.json is still replaced", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");

  generate(dir, { artifacts: { manifest: false } });
  assert.equal(
    fs.existsSync(path.join(snapshotDir(dir), "manifest.json")),
    false,
    "the first run really wrote no manifest"
  );

  const second = generate(dir, { artifacts: { manifest: false } });
  assert.ok(second.counts.totalFiles > 0, "the legitimate no-manifest snapshot is replaceable");
  assert.ok(
    fs.existsSync(path.join(snapshotDir(dir), ".codebase-snapshot")),
    "the replacement snapshot has its own marker"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
