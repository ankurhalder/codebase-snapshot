import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  collectFiles,
  HOOK_MARKER,
  installPreCommitHook,
  loadConfigFileDetailed,
} from "../dist/index.js";

/**
 * The trust-boundary and filesystem-ownership findings from the 0.9.16 audit
 * (TRUST-01, TRUST-03, TRUST-04, FS-01, FS-02, FS-08).
 *
 * These are the findings where the tool acted on a file it did not write: a marker that only
 * had the right *name*, a `.git` file that pointed anywhere, a link whose target was a
 * credential. Each test is a witness that the evidence is now checked, not the name.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-trust-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, relative, content) {
  const full = path.join(dir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

const validMarker = (files) =>
  `${JSON.stringify({
    generator: "codebase-snapshot",
    schemaVersion: "2",
    id: "20260101-000000-0000",
    state: "complete",
    files: files.map((entry) => ({
      path: entry,
      bytes: 4,
      sha256: "a".repeat(64),
    })),
  })}\n`;

test("FS-01 a marker that only has the right name is not ownership", (t) => {
  const dir = tempDir(t);
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "snapshot/.codebase-snapshot", "{}\n");
  write(dir, "snapshot/notes.ts", "export const notes = 1;\n");
  write(dir, "snapshot/manifest.json", "{}\n");

  const forged = collectFiles(dir, {});
  assert.ok(
    forged.files.includes("snapshot/notes.ts"),
    `a forged marker must not hide a directory: ${JSON.stringify(forged.files)}`
  );

  // The same directory with a marker that accounts for what it holds is this tool's output.
  write(dir, "snapshot/.codebase-snapshot", validMarker(["manifest.json", "notes.ts"]));
  const owned = collectFiles(dir, {});
  assert.equal(
    owned.files.some((file) => file.startsWith("snapshot/")),
    false,
    `a real marker must exclude the directory: ${JSON.stringify(owned.files)}`
  );
});

test("FS-02 a link whose target is a credential file is not followed", (t) => {
  const dir = tempDir(t);
  write(dir, ".env", "API_KEY=hunter2hunter2\n");
  write(dir, "src/a.ts", "export const a = 1;\n");
  try {
    fs.symlinkSync(path.join(dir, ".env"), path.join(dir, "public-context.txt"), "file");
  } catch {
    t.skip("this filesystem does not allow creating symlinks without elevation");
    return;
  }

  const { files, skipped } = collectFiles(dir, {});
  assert.equal(files.includes("public-context.txt"), false, JSON.stringify(files));
  assert.ok(
    skipped.some(
      (entry) => entry.path === "public-context.txt" && entry.reason === "sensitive-file"
    ),
    `the refusal must be recorded: ${JSON.stringify(skipped)}`
  );
});

test("TRUST-01 an executable config is refused in the server, and says why", async (t) => {
  const dir = tempDir(t);
  write(dir, "snapshot.config.mjs", "export default { outDir: 'ctx' };\n");

  const refused = await loadConfigFileDetailed(dir, { allowExecutableConfig: false });
  assert.equal(refused.config, null, "no repository code may run");
  assert.ok(
    refused.errors.some((message) => /does not run repository code/.test(message)),
    refused.errors.join(" | ")
  );
  assert.ok(
    refused.warnings.some((message) => /snapshot\.config\.json/.test(message)),
    "the message must say what to use instead"
  );

  // The CLI loads the same file: the user invoked the repository's own command there.
  const loaded = await loadConfigFileDetailed(dir);
  assert.equal(loaded.errors.length, 0, loaded.errors.join(" | "));
  assert.equal(loaded.config.outDir, "ctx");
});

test("TRUST-03 a .git file pointing outside the repository is refused", (t) => {
  const dir = tempDir(t);
  const outside = tempDir(t);
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${outside}\n`, "utf8");

  const result = installPreCommitHook(dir);

  assert.equal(result.written, false, "an executable script must not be written there");
  assert.equal(result.path, null);
  assert.equal(fs.existsSync(path.join(outside, "hooks", "pre-commit")), false);
  assert.ok(
    result.notes.some((note) => /Not a git working tree/.test(note)),
    result.notes.join(" | ")
  );
});

test("TRUST-04 core.hooksPath is where the hook goes", (t) => {
  const dir = tempDir(t);
  try {
    childProcess.execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
    childProcess.execFileSync("git", ["config", "core.hooksPath", ".husky/_"], {
      cwd: dir,
      stdio: "ignore",
    });
  } catch {
    t.skip("git is unavailable on this host");
    return;
  }

  const result = installPreCommitHook(dir);

  assert.equal(result.written, true, result.notes.join(" | "));
  assert.equal(result.path, path.join(dir, ".husky", "_", "pre-commit"));
  assert.ok(fs.readFileSync(result.path, "utf8").includes(HOOK_MARKER));
  assert.equal(fs.existsSync(path.join(dir, ".git", "hooks", "pre-commit")), false);
});

test("FS-08 a missing snapshot fails the commit, with a documented opt-out", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });

  assert.equal(installPreCommitHook(dir).written, true);
  const body = fs.readFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "utf8");

  assert.match(body, /refusing the commit: no snapshot/);
  assert.match(body, /CODEBASE_SNAPSHOT_ALLOW_MISSING/);
  const block = body.slice(body.indexOf("# Fail closed"), body.indexOf("if ! npx"));
  assert.match(block, /exit 1/, "the missing-snapshot branch must be a failure");
});
