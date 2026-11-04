import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { generateSnapshot } from "../dist/index.js";

/**
 * Core-pipeline fixes from audit track 1 (src/index.ts).
 *
 *   6   an async hook's stdout must never be appended to the `--format json` payload
 *   20  one text file too large for a V8 string must be a `read-error` skip, not a fatal abort
 *   21  the "2 MB" summary guard must measure bytes, not UTF-16 code units
 *   42  a credential-shaped hook error must be masked in the manifest and on stdout
 *   7b  maxPartBytes < largeFileBytes must be warned about at generate time
 *   22  the monolith's embedded manifest must agree with the shipped one
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-core-pipeline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function writePackage(base) {
  write(base, "package.json", JSON.stringify({ name: "core-pipeline", version: "1.0.0" }));
}

function runCli(cliArgs, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, [BIN, ...cliArgs], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

// ------------------------------------------------------------------ item 6
test("an async hook's stdout cannot corrupt the --format json payload", (t) => {
  const cwd = tempDir(t);
  writePackage(cwd);
  write(cwd, "src/a.ts", "export const a = 1;\n");
  write(
    cwd,
    "snapshot.config.mjs",
    [
      "export default {",
      "  hooks: {",
      "    afterGenerate: async () => {",
      "      await new Promise((resolve) => setTimeout(resolve, 25));",
      '      console.log("ASYNC HOOK STDOUT LINE");',
      "    },",
      "  },",
      "};",
      "",
    ].join("\n")
  );

  const run = runCli(["generate", "--cwd", cwd, "--out-dir", "snap", "--format", "json"]);
  assert.equal(run.code, 0, run.stderr);

  // Before the fix the payload was followed by the hook line and this threw.
  const manifest = JSON.parse(run.stdout);
  assert.ok(
    manifest.files.some((file) => file.relativePath === "src/a.ts"),
    "the payload must describe the generated snapshot"
  );
  assert.equal(run.stdout.includes("ASYNC HOOK STDOUT LINE"), false, "hook output leaked into stdout");
  assert.match(run.stderr, /ASYNC HOOK STDOUT LINE/, "hook output should be redirected to stderr");
});

// ------------------------------------------------------------------ item 20
test("a text file too large for a V8 string is skipped as read-error, not fatal", (t) => {
  const cwd = tempDir(t);
  writePackage(cwd);
  write(cwd, "src/small.ts", "export const small = 1;\n");

  // 600 MiB of spaces: valid UTF-8, no NUL, and longer than the ~512 MiB string
  // limit V8 enforces when the buffer is materialised as a JS string.
  const hugePath = path.join(cwd, "src", "huge.txt");
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  const fd = fs.openSync(hugePath, "w");
  try {
    for (let index = 0; index < 600; index += 1) fs.writeSync(fd, chunk, 0, chunk.length);
  } finally {
    fs.closeSync(fd);
  }
  const hugeBytes = fs.statSync(hugePath).size;
  assert.equal(hugeBytes, 600 * 1024 * 1024);

  const run = runCli(["generate", "--cwd", cwd, "--out-dir", "snap", "--format", "json"]);
  assert.equal(run.code, 0, run.stderr);

  const manifest = JSON.parse(run.stdout);
  assert.equal(
    manifest.files.some((file) => file.relativePath === "src/huge.txt"),
    false,
    "the unreadable file must not be listed as included"
  );
  const skip = manifest.skipped.find((entry) => entry.path === "src/huge.txt");
  assert.ok(skip, "the file must appear in skipped[]");
  assert.equal(skip.reason, "read-error");
  assert.match(skip.detail, /^Size: 629145600 B; could not be decoded: /);
  assert.equal(run.stderr.includes("Cannot create a string longer than"), false);
});

// ------------------------------------------------------------------ item 21
test("a 3 MB CJK file is not parsed for a summary", (t) => {
  const cwd = tempDir(t);
  writePackage(cwd);
  // 1,000,000 characters x 3 bytes = 3,000,000 bytes on one line: large, but
  // below 2 M UTF-16 code units, which is what the guard used to measure.
  write(cwd, "src/cjk.ts", "日".repeat(1_000_000));

  const manifest = generateSnapshot({ cwd });
  const entry = manifest.files.find((file) => file.relativePath === "src/cjk.ts");
  assert.ok(entry, "the file must be included");
  assert.equal(entry.sizeBytes, 3_000_000);
  assert.equal(entry.summary, undefined, "a file over the 2 MB ceiling must not be parsed");
  assert.ok(
    manifest.warnings.some(
      (warning) => /exceed 2 MB and were not parsed/.test(warning) && warning.includes("src/cjk.ts")
    ),
    `expected the oversize warning, got: ${JSON.stringify(manifest.warnings)}`
  );
});

// ------------------------------------------------------------------ item 42
test("a credential-shaped hook error is masked in the manifest and on stdout", (t) => {
  const cwd = tempDir(t);
  writePackage(cwd);
  write(cwd, "src/a.ts", "export const a = 1;\n");
  write(
    cwd,
    "snapshot.config.mjs",
    [
      "export default {",
      "  hooks: {",
      "    afterGenerate: () => {",
      '      throw new Error("upstream rejected AKIAIOSFODNN7EXAMPLE");',
      "    },",
      "  },",
      "};",
      "",
    ].join("\n")
  );

  const run = runCli(["generate", "--cwd", cwd, "--out-dir", "snap", "--format", "json"]);
  assert.equal(run.code, 0, run.stderr);
  const manifest = JSON.parse(run.stdout);
  const warnings = manifest.warnings.join("\n");
  assert.match(warnings, /hooks\.afterGenerate failed:/);
  assert.equal(warnings.includes("AKIAIOSFODNN7EXAMPLE"), false, "the token leaked on stdout");
  assert.match(warnings, /\[REDACTED/);

  const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, "snap", "manifest.json"), "utf8"));
  const diskWarnings = onDisk.warnings.join("\n");
  assert.equal(diskWarnings.includes("AKIAIOSFODNN7EXAMPLE"), false, "the token leaked into manifest.json");
  assert.match(diskWarnings, /\[REDACTED/);
});

// ------------------------------------------------------------------ item 7b
test("a part budget below largeFileBytes warns only when it actually cuts a file", (t) => {
  const cwd = tempDir(t);
  writePackage(cwd);
  write(cwd, "src/a.ts", "export const a = 1;\n");

  // Nothing is big enough to be cut, so the configuration alone stays quiet: several presets
  // recommend a part budget below the default large-file threshold (node-lib is 120 KB against
  // 200 KB), so warning on the configuration alone fired on every one of their repositories.
  const quiet = generateSnapshot({ cwd, outDir: "quiet", maxPartBytes: 4096, largeFileBytes: 8192 });
  assert.deepEqual(
    quiet.warnings.filter((warning) => /is below largeFileBytes/.test(warning)),
    [],
    "no file was cut, so there is nothing to warn about"
  );

  // A file between the two budgets IS cut by the part budget, and that is worth one warning
  // naming both values.
  write(cwd, "src/big.ts", `export const big = "${"x".repeat(6000)}";\n`);
  const loud = generateSnapshot({ cwd, outDir: "loud", maxPartBytes: 4096, largeFileBytes: 8192 });
  const matches = loud.warnings.filter((warning) => /is below largeFileBytes/.test(warning));
  assert.equal(matches.length, 1, `expected exactly one warning, got ${JSON.stringify(loud.warnings)}`);
  assert.match(matches[0], /4096 B/);
  assert.match(matches[0], /8192 B/);
});

// ------------------------------------------------------------------ item 22
test("the monolith's embedded manifest agrees with the shipped one", (t) => {
  const cwd = tempDir(t);
  writePackage(cwd);
  write(cwd, "src/a.ts", "export const a = 1;\n");
  write(cwd, "src/b.ts", "export const b = 2;\n");

  const manifest = generateSnapshot({ cwd, includeMonolith: true });
  const outDir = path.join(cwd, "snapshot");
  const shipped = JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  const jsonBytes = fs.readFileSync(path.join(outDir, "full-codebase.json"));
  const embedded = JSON.parse(jsonBytes.toString("utf8"));

  assert.ok(manifest.artifacts.fullJson, "the run must record the JSON digest");
  assert.equal(shipped.artifacts.fullJson.sha256, sha256(jsonBytes));
  assert.deepEqual(embedded.manifest.warnings, shipped.warnings);
  assert.deepEqual(
    embedded.manifest.artifacts.fullMarkdown,
    shipped.artifacts.fullMarkdown,
    "the other monolith's digest is embeddable and must be final"
  );
  // A file cannot contain its own sha256: the embedded copy is the one field that
  // stays null, and the shipped manifest carries the real digest.
  assert.equal(embedded.manifest.artifacts.fullJson, null);
});

// ------------------------------------------------------------------ tree depth cap
test("a depth-capped project tree is also recorded in manifest.warnings", (t) => {
  const cwd = tempDir(t);
  writePackage(cwd);

  // One level past the tree's 512-level cap. Long paths are not available on every
  // checkout (Windows without LongPathsEnabled), so this half is skippable.
  let dir = cwd;
  try {
    for (let level = 0; level < 513; level += 1) {
      dir = path.join(dir, "d");
      fs.mkdirSync(dir);
    }
  } catch (err) {
    t.skip(`this platform cannot create a 513-level path (${err.code ?? err.message})`);
    return;
  }
  fs.writeFileSync(path.join(dir, "leaf.ts"), "export const deep = 1;\n");

  const manifest = generateSnapshot({ cwd });
  const warning = manifest.warnings.find((entry) =>
    /reports\/project-tree\.md was truncated at the 512-level depth cap/.test(entry)
  );
  assert.ok(
    warning,
    `expected the depth-cap warning, else the tree is silently incomplete: ${JSON.stringify(manifest.warnings)}`
  );
  const tree = fs.readFileSync(path.join(cwd, "snapshot", "reports", "project-tree.md"), "utf8");
  assert.match(tree, /\[tree truncated at 512 levels\]/);
});
