import assert from "node:assert/strict";
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

const generate = (dir) => generateSnapshot({ cwd: dir });

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
