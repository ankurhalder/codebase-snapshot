import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { collectFiles, generateSnapshot } from "../dist/index.js";

/**
 * 4.0.9 regression cover for reserved directory names.
 *
 * Any directory called `snapshot`, `snapshot.tmp` or `snapshot.backup-*` used to be dropped from
 * the scan at any depth, with no `skipped[]` record — so a directory the user committed under that
 * name disappeared from the snapshot and nothing said so, contradicting the promise that every
 * discovered path is accounted for. The exclusion is for *this tool's own output*, which is
 * recognisable by its ownership marker, and for the exact `outDir`/`tmpDir` this run writes.
 */

function tempDir(t, prefix = "snap-reserved-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

/** Runs `git init` + `git add -A`; returns false when git is unavailable on this host. */
function initGit(dir) {
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("G4: a user directory named `snapshot` is scanned when outDir is elsewhere (no git)", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  write(dir, "snapshot/keep.md", "# kept\n");
  write(dir, "nested/snapshot.tmp/notes.md", "nested notes\n");

  const result = collectFiles(dir, { toolOwnedPaths: ["out"] });

  assert.ok(result.files.includes("snapshot/keep.md"), "the user's directory is not dropped");
  assert.ok(result.files.includes("nested/snapshot.tmp/notes.md"), "nor is a nested one");
});

test("G4: the same directory survives a full generate and appears in the manifest", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  write(dir, "snapshot/keep.md", "# kept\n");

  const manifest = generateSnapshot({ cwd: dir, outDir: "out" });

  assert.ok(
    manifest.files.some((file) => file.relativePath === "snapshot/keep.md"),
    "the file is in files[], not silently absent"
  );
});

test("G4: reserved names resolve identically with and without git", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  write(dir, "snapshot/keep.md", "# kept\n");

  const walking = collectFiles(dir, { toolOwnedPaths: ["out"] });
  if (!initGit(dir)) return; // git is not installed here; the walker case already ran above
  const viaGit = collectFiles(dir, { toolOwnedPaths: ["out"] });

  assert.deepEqual(
    viaGit.files.slice().sort(),
    walking.files.slice().sort(),
    "both discovery modes must offer the same candidates"
  );
});

test("the tool's own output directory is still excluded, and stays out of skipped[]", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");

  // Two runs: the second must not record the first run's output as a discovered path, or two
  // identical runs would produce different manifests.
  const first = generateSnapshot({ cwd: dir });
  const second = generateSnapshot({ cwd: dir });

  const firstPaths = first.files.map((file) => file.relativePath).sort();
  const secondPaths = second.files.map((file) => file.relativePath).sort();
  assert.deepEqual(secondPaths, firstPaths, "the snapshot does not record itself");
  assert.deepEqual(
    second.skipped.filter((record) => record.path.startsWith("snapshot")),
    [],
    "own output is not reported as a skipped user path"
  );
});

test("a first run refuses rather than eating a pre-existing snapshot/ directory", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  const keep = write(dir, "snapshot/keep.md", "# precious\n");

  // Default outDir is `snapshot`, and the user already has one. The tool cannot prove it wrote
  // this directory, so it must refuse — and leave the file alone.
  assert.throws(() => generateSnapshot({ cwd: dir }), /Refusing to replace outDir/);
  assert.equal(fs.readFileSync(keep, "utf8"), "# precious\n");
});
