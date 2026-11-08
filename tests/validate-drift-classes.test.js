import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, validateSnapshot } from "../dist/index.js";

/**
 * 4.0.9 regression cover for two ways `validate` told the reader something untrue.
 *
 * M1 — without `config.digest` the settings comparison silently degraded to a handful of fields,
 * so a changed `maxMonolithBytes`, `layers`, `kinds` or custom secret rule passed as "valid and up
 * to date". An unverifiable configuration is not a match.
 *
 * M2 — a file that exists but cannot be read was filed under "no longer exist on disk", sending
 * the reader to look for a file that is right there. Unreadable and deleted are different facts.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-drift-"));
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

test("M1: a manifest with no configuration digest is not 'up to date'", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  generateSnapshot({ cwd: dir });

  const manifest = readManifest(dir);
  delete manifest.config.digest;
  writeManifest(dir, manifest);

  const result = validateSnapshot({ cwd: dir });

  assert.equal(result.valid, false, "an unverifiable configuration cannot be called current");
  const mismatch = result.drift.configMismatches.find((entry) => /no configuration digest/.test(entry));
  assert.ok(mismatch, `the reason is stated: ${JSON.stringify(result.drift.configMismatches)}`);
  assert.ok(
    result.errors.some((error) => /configuration mismatch/.test(error)),
    "the summary counts it"
  );
});

test("M1: a manifest with no recorded discovery mode is not drift on its own", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  generateSnapshot({ cwd: dir });

  const manifest = readManifest(dir);
  const digest = manifest.config.digest;
  delete manifest.config.discovery;
  writeManifest(dir, manifest);

  const result = validateSnapshot({ cwd: dir });

  assert.equal(typeof digest, "string", "the digest is present, so settings are verifiable");
  assert.deepEqual(
    result.drift.configMismatches.filter((entry) => entry.startsWith("discovery:")),
    [],
    "a key the manifest never recorded is not a mismatch"
  );
});

test("M2: an unreadable file is reported as unreadable, not deleted", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  generateSnapshot({ cwd: dir });

  const target = path.join(dir, "app.ts");
  const user = process.env.USERNAME ?? process.env.USER;
  let denied = false;

  if (process.platform === "win32" && user) {
    const deny = spawnSync("icacls", [target, "/deny", `${user}:(R)`], { encoding: "utf8" });
    denied = deny.status === 0;
  }
  if (!denied) {
    // POSIX: dropping the read bit is enough when the test does not run as root.
    try {
      fs.chmodSync(target, 0o000);
      denied = true;
    } catch {
      denied = false;
    }
  }

  try {
    if (!denied) {
      t.skip("this host will not let the test make a file unreadable");
      return;
    }

    const result = validateSnapshot({ cwd: dir });

    assert.equal(result.valid, false);
    assert.deepEqual(result.drift.missingOnDisk, [], "the file exists; it is not deleted");
    assert.ok(
      result.drift.unreadable.includes("app.ts"),
      `the file is listed as unreadable: ${JSON.stringify(result.drift.unreadable)}`
    );
    assert.ok(
      result.errors.some((error) => /could not be read/.test(error)),
      "the summary says why"
    );
  } finally {
    if (process.platform === "win32" && user) {
      execFileSync("icacls", [target, "/remove:d", user], { encoding: "utf8" });
    }
    try {
      fs.chmodSync(target, 0o644);
    } catch {
      /* best effort */
    }
    fs.rmSync(target, { force: true });
  }
});

test("a clean snapshot still validates with no configuration drift", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  generateSnapshot({ cwd: dir });

  const result = validateSnapshot({ cwd: dir });

  assert.equal(result.valid, true);
  assert.deepEqual(result.drift.configMismatches, [], "no spurious drift on an untouched snapshot");
  assert.deepEqual(result.drift.unreadable, []);
});

test("a file generate skipped as binary is not reported as a new file", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  // Valid UTF-8, no NUL, more than 1% control bytes: `generate` skips it as binary.
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "blob.dat"), Buffer.alloc(4096, 0x07));

  const manifest = generateSnapshot({ cwd: dir });
  const skipped = manifest.skipped.find((entry) => entry.path === "src/blob.dat");
  assert.equal(skipped?.reason, "binary", "the fixture is skipped as binary");

  const result = validateSnapshot({ cwd: dir });

  assert.deepEqual(
    result.drift.missingInSnapshot,
    [],
    "a file generate skipped must not come back as a new file"
  );
  assert.equal(result.valid, true, "generate then validate is clean for the same tree");
});

// ------------------------------------------------- B4: binary extensions
// generate decides by extension before it reads a byte, but validate used to ask only
// "is the content text?". A text-content file with a binary extension — a Git-LFS pointer, an
// empty placeholder, a fixture that is not really a PNG — was recorded as skipped and then
// reported as a new file forever: regenerating could not clear it because generating never
// includes it. validate must apply generate's decision order, so these are clean at every step.

test("B4: a text file with a binary extension is not drift, before or after regenerating", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  write(dir, "assets/logo.png", "not a png at all\n");

  const first = generateSnapshot({ cwd: dir });
  const skipped = first.skipped.find((entry) => entry.path === "assets/logo.png");
  assert.equal(skipped?.reason, "binary", "generate decides by extension and records the skip");
  assert.equal(
    first.files.some((entry) => entry.relativePath === "assets/logo.png"),
    false,
    "and does not include it"
  );

  const before = validateSnapshot({ cwd: dir });
  assert.deepEqual(
    before.drift.missingInSnapshot,
    [],
    "a file generate skipped must not be reported as a new file"
  );
  assert.equal(before.valid, true, "generate then validate is clean for the same tree");

  generateSnapshot({ cwd: dir });
  const after = validateSnapshot({ cwd: dir });
  assert.deepEqual(
    after.drift.missingInSnapshot,
    [],
    "regenerating must not leave a permanent new-file drift behind"
  );
  assert.equal(after.valid, true, "the second generate/validate cycle is clean too");
});

test("B4: a Git-LFS pointer in a .png is a skipped file, not drift", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  // The realistic case: a large asset tracked by Git LFS is three lines of text in the work tree.
  write(
    dir,
    "assets/big.png",
    "version https://git-lfs.github.com/spec/v1\n" +
      "oid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\n" +
      "size 12345\n"
  );

  const manifest = generateSnapshot({ cwd: dir });
  assert.equal(
    manifest.skipped.find((entry) => entry.path === "assets/big.png")?.reason,
    "binary",
    "an LFS pointer carries the binary extension, so generate skips it without reading"
  );

  const result = validateSnapshot({ cwd: dir });
  assert.deepEqual(result.drift.missingInSnapshot, []);
  assert.equal(result.valid, true, "an LFS pointer must not make the snapshot look stale");
});

test("B4: a genuinely binary .png still validates clean after generate", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "assets", "real.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02])
  );

  const manifest = generateSnapshot({ cwd: dir });
  assert.equal(
    manifest.skipped.find((entry) => entry.path === "assets/real.png")?.reason,
    "binary",
    "the mirror case must keep its skip record"
  );

  const result = validateSnapshot({ cwd: dir });
  assert.deepEqual(result.drift.missingInSnapshot, []);
  assert.equal(result.valid, true, "a real binary file is not drift either");
});
