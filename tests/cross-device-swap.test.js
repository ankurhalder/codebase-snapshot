import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

/**
 * 4.0.9 regression cover for a cross-device swap.
 *
 * When `tmpDir` and `outDir` are on different devices `rename` fails with EXDEV and the snapshot
 * has to be *copied* into place. Copying straight into `outDir` meant a copy that failed halfway —
 * a full disk is the ordinary cause — left a partial snapshot at the output path, carrying a
 * `.codebase-snapshot` marker that said "complete" and an inventory naming files that were never
 * written. The next run then trusted that directory.
 *
 * The copy is now staged beside the target and renamed into place, so the output path only ever
 * holds a whole snapshot. This test injects the failure through the CommonJS build, whose
 * `node:fs` reference is the mutable module object.
 */

const requireCjs = createRequire(import.meta.url);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-exdev-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

const exdevError = () => {
  const error = new Error("EXDEV: cross-device link not permitted, rename");
  error.code = "EXDEV";
  return error;
};

/** Runs `run` with `node:fs` patched, restoring every patched member afterwards. */
function withPatchedFs(patches, run) {
  const fsModule = requireCjs("node:fs");
  const originals = new Map();
  for (const [name, replacement] of Object.entries(patches)) {
    originals.set(name, fsModule[name]);
    fsModule[name] = replacement(fsModule[name]);
  }
  try {
    return run();
  } finally {
    for (const [name, original] of originals) fsModule[name] = original;
  }
}

test("FS-03: a copy that fails halfway never lands at outDir", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");

  const { generateSnapshot } = requireCjs("../dist/index.cjs");

  let renameBlocked = false;

  assert.throws(
    () =>
      withPatchedFs(
        {
          // Fail the first staging rename as a different-device rename would.
          renameSync: (original) => (from, to) => {
            if (!renameBlocked && path.basename(String(from)).startsWith("run-")) {
              renameBlocked = true;
              throw exdevError();
            }
            return original(from, to);
          },
          // Copy the two files that make a directory *look* complete, then fail like a full disk.
          cpSync: (original) => (from, to, options) => {
            fs.mkdirSync(to, { recursive: true });
            for (const name of [".codebase-snapshot", "manifest.json"]) {
              const source = path.join(from, name);
              if (fs.existsSync(source)) original(source, path.join(to, name));
            }
            const error = new Error("ENOSPC: no space left on device, copyfile");
            error.code = "ENOSPC";
            throw error;
          },
        },
        () => generateSnapshot({ cwd: dir })
      ),
    /ENOSPC|no space left/,
    "the copy failure is reported, not swallowed"
  );

  const outDir = path.join(dir, "snapshot");
  assert.equal(
    fs.existsSync(outDir) ? fs.existsSync(path.join(outDir, ".codebase-snapshot")) : false,
    false,
    "no partial snapshot may sit at the output path wearing a complete marker"
  );

  const leftovers = fs
    .readdirSync(dir)
    .filter((name) => name.includes(".partial-") || name.includes(".backup-"));
  assert.deepEqual(leftovers, [], "the failed copy leaves nothing behind");
});

test("FS-03: a successful cross-device copy still produces a working snapshot", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");

  const { generateSnapshot, validateSnapshot } = requireCjs("../dist/index.cjs");
  let renameBlocked = false;

  const manifest = withPatchedFs(
    {
      renameSync: (original) => (from, to) => {
        if (!renameBlocked && path.basename(String(from)).startsWith("run-")) {
          renameBlocked = true;
          throw exdevError();
        }
        return original(from, to);
      },
    },
    () => generateSnapshot({ cwd: dir })
  );

  assert.equal(renameBlocked, true, "the EXDEV path really ran");
  assert.ok(manifest.files.some((file) => file.relativePath === "app.ts"));
  assert.ok(fs.existsSync(path.join(dir, "snapshot", "manifest.json")));

  const validation = validateSnapshot({ cwd: dir });
  assert.equal(validation.valid, true, "the copied snapshot is complete and current");

  const leftovers = fs
    .readdirSync(dir)
    .filter((name) => name.includes(".partial-") || name.includes(".backup-"));
  assert.deepEqual(leftovers, [], "no staging debris is left beside the output");
});
