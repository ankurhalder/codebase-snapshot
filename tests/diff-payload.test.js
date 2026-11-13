import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * `diff` compares `relativePath + hashSha256`, so it used to report "0 changed,
 * N unchanged" for a run that repacked the same sources differently
 * (`--large-file-bytes`, preview head/tail, redaction rules, artifact selection,
 * budgets). The manifests record the effective-settings digest, the content
 * fingerprint and the part count, so the payload difference is now stated
 * explicitly. These tests pin the statement, the silence when nothing differs,
 * and the untouched per-file behaviour.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function combined(result) {
  return `${result.stdout}${result.stderr}`;
}

function diffJson(before, after) {
  const result = run(["diff", before, after, "--format", "json"]);
  assert.equal(result.status, 0, `diff failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function diffText(before, after) {
  const result = run(["diff", before, after]);
  assert.equal(result.status, 0, `diff failed: ${result.stderr}`);
  return combined(result);
}

const BIG_FILE = ("export const big = '" + "x".repeat(20) + "';\n").repeat(15_000); // ~660 KB

/** One repository plus an out-of-tree directory for its snapshots. */
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "diff-payload-"));
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "diff-payload-fixture", version: "1.0.0" })
  );
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "big.ts"), BIG_FILE);
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diff-payload-out-"));
  return { repo, outRoot };
}

function generate(repo, outDir, extra = []) {
  const result = run(["generate", "--cwd", repo, "--out-dir", outDir, ...extra]);
  assert.equal(result.status, 0, `generate failed: ${result.stderr}`);
  assert.ok(fs.existsSync(path.join(outDir, "manifest.json")), "generate wrote no manifest");
}

function cleanup({ repo, outRoot }) {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(outRoot, { recursive: true, force: true });
}

test("the same sources repacked as a full body instead of a preview are reported", () => {
  const fx = fixture();
  const full = path.join(fx.outRoot, "full");
  const preview = path.join(fx.outRoot, "preview");
  try {
    generate(fx.repo, full, ["--large-file-bytes", "1mb"]);
    generate(fx.repo, preview);

    const diff = diffJson(full, preview);
    // The per-file answer is still "nothing changed"...
    assert.equal(diff.added.length, 0);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.changed.length, 0);
    assert.equal(diff.unchanged, 3);
    // ...but the payload block says the snapshot itself differs.
    assert.equal(diff.payload.sourceFilesIdentical, true);
    assert.equal(diff.payload.differs, true);
    assert.equal(diff.payload.configurationDiffers, true);
    assert.notEqual(diff.payload.configDigest.before, diff.payload.configDigest.after);
    assert.notEqual(diff.payload.partsCount.before, diff.payload.partsCount.after);
    assert.ok(
      diff.payload.reasons.some((reason) => /configuration digest/.test(reason)),
      `expected a configuration-digest reason, got ${JSON.stringify(diff.payload.reasons)}`
    );

    const text = diffText(full, preview);
    assert.match(text, /payload\/configuration differs:/);
    assert.match(text, /configuration digest/);
    assert.match(text, /source files are identical \(3 unchanged\)/);
    assert.match(text, /0 changed/, "the per-file counts must stay in the output");
  } finally {
    cleanup(fx);
  }
});

test("a budget change with identical sources is reported", () => {
  const fx = fixture();
  const wide = path.join(fx.outRoot, "wide");
  const narrow = path.join(fx.outRoot, "narrow");
  try {
    // Same sources and the same preview threshold; only the part budget differs.
    generate(fx.repo, wide, ["--large-file-bytes", "1mb"]);
    generate(fx.repo, narrow, ["--large-file-bytes", "1mb", "--max-part-bytes", "60k"]);

    const diff = diffJson(wide, narrow);
    assert.equal(diff.changed.length, 0);
    assert.equal(diff.unchanged, 3);
    assert.equal(diff.payload.sourceFilesIdentical, true);
    assert.equal(diff.payload.differs, true);
    assert.equal(diff.payload.configurationDiffers, true);
    assert.notEqual(diff.payload.configDigest.before, diff.payload.configDigest.after);
    assert.ok(
      diff.payload.reasons.some((reason) => /configuration digest/.test(reason)),
      `expected a configuration-digest reason, got ${JSON.stringify(diff.payload.reasons)}`
    );

    const text = diffText(wide, narrow);
    assert.match(text, /payload\/configuration differs:/);
    assert.match(text, /source files are identical \(3 unchanged\)/);
    assert.match(text, /0 changed/, "the per-file counts must stay in the output");
  } finally {
    cleanup(fx);
  }
});

test("identical snapshots stay silent about the payload", () => {
  const fx = fixture();
  const first = path.join(fx.outRoot, "first");
  const second = path.join(fx.outRoot, "second");
  try {
    generate(fx.repo, first);
    generate(fx.repo, second);

    const diff = diffJson(first, second);
    assert.equal(diff.added.length + diff.removed.length + diff.changed.length, 0);
    assert.equal(diff.unchanged, 3);
    assert.equal(diff.payload.sourceFilesIdentical, true);
    assert.equal(diff.payload.differs, false);
    assert.equal(diff.payload.configurationDiffers, false);
    assert.equal(diff.payload.configDigest.before, diff.payload.configDigest.after);
    assert.deepEqual(diff.payload.reasons, []);

    const text = diffText(first, second);
    assert.doesNotMatch(text, /payload\/configuration differs/);
    assert.doesNotMatch(text, /configuration not compared/);
    assert.match(text, /0 changed/);
    assert.match(text, /3 unchanged/);
  } finally {
    cleanup(fx);
  }
});

test("a source edit is still reported as a changed file, with no payload section", () => {
  const fx = fixture();
  const before = path.join(fx.outRoot, "before");
  const after = path.join(fx.outRoot, "after");
  try {
    generate(fx.repo, before);
    fs.writeFileSync(path.join(fx.repo, "src", "a.ts"), "export const a = 2;\n");
    generate(fx.repo, after);

    const diff = diffJson(before, after);
    assert.deepEqual(diff.changed, ["src/a.ts"]);
    assert.equal(diff.payload.sourceFilesIdentical, false);
    assert.equal(diff.payload.differs, false, "a source edit alone must not turn on the payload block");

    const text = diffText(before, after);
    assert.match(text, /1 changed/);
    assert.match(text, /changed:/);
    assert.match(text, /src\/a\.ts/);
    assert.doesNotMatch(text, /payload\/configuration differs/);
  } finally {
    cleanup(fx);
  }
});

test("manifests without a config digest say the configuration was not compared", () => {
  const fx = fixture();
  const current = path.join(fx.outRoot, "current");
  const full = path.join(fx.outRoot, "full");
  try {
    generate(fx.repo, current);
    generate(fx.repo, full, ["--large-file-bytes", "1mb"]);

    // Simulate a snapshot written before 4.0.5: same settings, no config.digest. A missing digest
    // is unverifiable, not malformed, so the shape guard accepts it and diff says so.
    const oldSame = path.join(fx.outRoot, "old-same.json");
    const same = JSON.parse(fs.readFileSync(path.join(current, "manifest.json"), "utf8"));
    delete same.config.digest;
    fs.writeFileSync(oldSame, JSON.stringify(same, null, 2));

    const quiet = diffJson(oldSame, current);
    assert.equal(quiet.payload.configDigest.before, null);
    assert.equal(quiet.payload.differs, false);
    assert.match(
      diffText(oldSame, current),
      /configuration not compared: a manifest has no config digest/
    );

    // An old manifest that also differs in payload: the reason names the side.
    const oldFull = path.join(fx.outRoot, "old-full.json");
    const fullManifest = JSON.parse(fs.readFileSync(path.join(full, "manifest.json"), "utf8"));
    delete fullManifest.config.digest;
    fs.writeFileSync(oldFull, JSON.stringify(fullManifest, null, 2));

    const loud = diffJson(oldFull, current);
    assert.equal(loud.payload.differs, true);
    assert.ok(
      loud.payload.reasons.some((reason) => /not recorded on the before side/.test(reason)),
      `expected the missing-digest caveat, got ${JSON.stringify(loud.payload.reasons)}`
    );
    assert.match(diffText(oldFull, current), /payload\/configuration differs:/);
  } finally {
    cleanup(fx);
  }
});
