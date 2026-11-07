import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateSnapshot, loadConfigFileDetailed, lockPathFor, resolveConfig } from "../dist/index.js";
import { generateInWorker } from "../dist/mcp.js";

/**
 * 0.9.14 — four ways the process around the snapshot misbehaved.
 *
 * 1.3 — `setup --format json` replaced `process.stdout.write` for a time window. A nested
 * generate with an async hook installed its own diversion inside that window, so `setup`'s restore
 * clobbered the hook's and the hook's restore put back a capture that had already finished: every
 * later write went into a dead string, and the hook's output went to the real stdout after the
 * capture ended.
 *
 * 1.4 — the backup directory was removed inside the swap transaction, so a transient EPERM from an
 * indexer deleted the snapshot that had just been installed.
 *
 * 1.5 — the run lock hashed an unresolved path when the staging root did not exist yet and a
 * resolved one when it did, so two runs could take two different locks.
 *
 * 2.5 — the MCP worker ran `hooks.afterGenerate`, which the documentation says it does not.
 */

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function makeRepo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "process-integrity-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// 1.3 — stdout capture, the hook diversion, and the JSON error contract
// ---------------------------------------------------------------------------

/** Runs `main` in a child process and then writes a sentinel that must survive. */
function runSetupThroughMain(dir) {
  const script = [
    `import { main } from ${JSON.stringify(pathToFileURL(CLI).href)};`,
    `const code = await main(["setup", "--format", "json", "--no-install"]);`,
    // Long enough for an async hook's first `await` to have elapsed.
    `await new Promise((resolve) => setTimeout(resolve, 250));`,
    `process.stdout.write("SENTINEL\\n");`,
    `process.exitCode = code;`,
  ].join("\n");
  const scriptPath = path.join(dir, ".sentinel-run.mjs");
  fs.writeFileSync(scriptPath, script, "utf8");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: dir,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { ...result, scriptPath };
}

test("setup --format json survives an async afterGenerate hook", (t) => {
  const dir = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/a.ts": "export const a = 1;\n",
    "snapshot.config.mjs": [
      "export default {",
      '  outDir: "snapshot",',
      "  hooks: {",
      "    afterGenerate: async (manifest) => {",
      "      await new Promise((resolve) => setTimeout(resolve, 50));",
      '      console.log("HOOK-NOISE", manifest.counts.totalFiles);',
      "    },",
      "  },",
      "};",
      "",
    ].join("\n"),
  });

  const result = runSetupThroughMain(dir);
  fs.rmSync(result.scriptPath, { force: true });

  assert.equal(result.status, 0, `setup should succeed\n${result.stdout}\n${result.stderr}`);
  assert.ok(
    result.stdout.includes("SENTINEL"),
    "a write made after the capture must still reach stdout — it used to be swallowed"
  );
  assert.ok(
    !result.stdout.includes("HOOK-NOISE"),
    "a hook's console.log must not reach the payload channel"
  );

  const document = result.stdout.slice(0, result.stdout.indexOf("SENTINEL"));
  const parsed = JSON.parse(document);
  assert.ok(parsed.setup, "the setup document is intact");
  assert.ok(parsed.manifest, "and it carries the generate document it captured");
});

test("a failed nested generate is reported as a top-level error", (t) => {
  // `setup` writes the config, then generates. When that generate fails it prints its own
  // `{ error }` document, and merging that document in as `manifest` produced
  // `{ setup, manifest: { error } }` with no top-level `error` — a shape no consumer of
  // "exactly one document, a payload or an error" can act on.
  //
  // The trigger is a snapshot directory this tool did not write: `init` succeeds, and `generate`
  // refuses to replace it.
  const dir = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/a.ts": "export const a = 1;\n",
    "snapshot/NOT-OURS.txt": "a hand-made directory\n",
  });

  const result = runSetupThroughMain(dir);
  fs.rmSync(result.scriptPath, { force: true });

  assert.notEqual(result.status, 0, "the run failed");
  const document = result.stdout.slice(0, result.stdout.indexOf("SENTINEL"));
  const parsed = JSON.parse(document);
  assert.equal(typeof parsed.error, "object", "the failure is at the top level");
  assert.ok(parsed.error !== null && typeof parsed.error.message === "string");
  assert.equal(parsed.manifest, null, "and there is no manifest pretending to be one");
});

// ---------------------------------------------------------------------------
// 1.4 — a backup that cannot be deleted must not delete the new snapshot
// ---------------------------------------------------------------------------

test("a backup directory that cannot be removed does not roll the swap back", (t) => {
  if (process.platform === "win32") {
    // The trigger is a mode bit; Windows has none that blocks `rmSync`.
    t.skip("POSIX permissions only");
    return;
  }
  const dir = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/a.ts": "export const first = 1;\n",
  });
  const config = () => resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }, {}, dir);

  const first = generateSnapshot(config());
  const firstHash = first.files.find((file) => file.relativePath === "src/a.ts").hashSha256;

  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const second = 2;\n", "utf8");

  // Prove the trigger before relying on it. A host that does not enforce directory permissions —
  // root in a container, or a filesystem that ignores the mode — would let the backup be removed,
  // and the test would then pass while proving nothing. The probe lives outside the snapshot
  // directory: the ownership guard refuses a snapshot holding an entry its inventory does not
  // mention, so a probe left inside by an EACCES would change the thing under test.
  const probeDir = path.join(dir, "permission-probe");
  fs.mkdirSync(probeDir);
  fs.writeFileSync(path.join(probeDir, "x"), "x");
  fs.chmodSync(probeDir, 0o555);
  try {
    fs.rmSync(path.join(probeDir, "x"), { force: true });
    fs.chmodSync(probeDir, 0o755);
    fs.rmSync(probeDir, { recursive: true, force: true });
    t.skip("this host does not enforce directory permissions");
    return;
  } catch {
    // Expected: unlink inside a 0555 directory is EACCES.
  }
  fs.chmodSync(probeDir, 0o755);
  fs.rmSync(probeDir, { recursive: true, force: true });

  // A read-only directory cannot have its children unlinked, so removing the *backup* fails after
  // the new snapshot is already in place — which is exactly the EPERM an indexer or an antivirus
  // produces on Windows.
  fs.chmodSync(path.join(dir, "snapshot"), 0o555);

  const second = generateSnapshot(config());
  // The backup this test deliberately leaves behind is read-only, by construction. Put the modes
  // back *here*, before any assertion and before any cleanup hook can run: `t.after` hooks are not
  // ordered relative to the one `makeRepo` registered, and a recursive delete that reaches a 0555
  // directory fails with EACCES and reports the test as failed through the hook.
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith("snapshot")) fs.chmodSync(path.join(dir, entry), 0o755);
  }
  const secondHash = second.files.find((file) => file.relativePath === "src/a.ts").hashSha256;

  assert.notEqual(secondHash, firstHash, "the second run generated a new snapshot");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
  assert.equal(
    onDisk.fingerprint,
    second.fingerprint,
    "and the new snapshot is the one left in place"
  );
});

// ---------------------------------------------------------------------------
// 1.5 — the lock key does not depend on whether the staging root exists yet
// ---------------------------------------------------------------------------

test("the lock key is stable across a symlinked ancestor before and after creation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lock-key-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const real = path.join(root, "real");
  fs.mkdirSync(real, { recursive: true });
  const alias = path.join(root, "alias");
  // A junction needs no privilege on Windows; a symlink needs none on POSIX.
  fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");

  const staging = path.join(alias, "staging", "tmp");
  const before = lockPathFor(staging);
  fs.mkdirSync(staging, { recursive: true });
  const after = lockPathFor(staging);

  assert.equal(
    after,
    before,
    "a run that started before the staging directory existed must take the same lock"
  );
});

// ---------------------------------------------------------------------------
// 2.5 — the MCP worker does not run hooks
// ---------------------------------------------------------------------------

const hookConfig = (dir, withTimer) =>
  [
    'import * as fs from "node:fs";',
    withTimer
      ? "// A handle that outlives the generation: an un-terminated worker would hold the thread.\nsetInterval(() => {}, 50);"
      : "",
    "export default {",
    '  outDir: "snapshot",',
    "  hooks: {",
    `    afterGenerate: () => { fs.writeFileSync(${JSON.stringify(
      path.join(dir, "hook-ran.txt")
    )}, "yes"); },`,
    "  },",
    "};",
    "",
  ]
    .filter(Boolean)
    .join("\n");

test("generateInWorker does not run hooks.afterGenerate", async (t) => {
  const dir = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/a.ts": "export const a = 1;\n",
  });
  fs.writeFileSync(path.join(dir, "snapshot.config.mjs"), hookConfig(dir, true), "utf8");

  const result = await generateInWorker(dir, { cwd: dir });
  assert.equal(result.ok, true, result.ok ? "" : result.message);
  assert.equal(
    fs.existsSync(path.join(dir, "hook-ran.txt")),
    false,
    "docs/mcp.md promises hooks do not run for a generation started over MCP"
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
  assert.ok(manifest.counts.totalFiles > 0, "the snapshot was still generated");
});

test("a CLI generate in the same repository does run the hook", async (t) => {
  // The counterpart that keeps the test above honest: the hook is real, and the difference is the
  // MCP path rather than a config that never loaded.
  const dir = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/a.ts": "export const a = 1;\n",
  });
  fs.writeFileSync(path.join(dir, "snapshot.config.mjs"), hookConfig(dir, false), "utf8");

  const loaded = await loadConfigFileDetailed(dir);
  assert.equal(loaded.errors.length, 0, loaded.errors.join("; "));
  generateSnapshot(resolveConfig(loaded.config, {}, dir));
  assert.equal(fs.existsSync(path.join(dir, "hook-ran.txt")), true);
});
