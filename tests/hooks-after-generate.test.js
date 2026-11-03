import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

/**
 * 4.0.9 regression cover for `hooks.afterGenerate`, from the outside.
 *
 * Three things went wrong with user code running inside the generator:
 *   H2 a *rejected* async hook was an unhandled rejection, so the process died with exit 1 after
 *      printing "Snapshot generated … Integrity: passed" and its JSON payload, and nothing reached
 *      the manifest;
 *   H1 a hook's own files were not in the ownership inventory, so the next run refused the
 *      directory it had just written;
 *   H3 a hook's `console.log` landed on stdout and corrupted `--format json`.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-hooks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

/** Runs the CLI and never throws on a non-zero exit, so the exit code can be asserted. */
function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const CONFIG = (hookBody) => `export default {
  hooks: {
    afterGenerate: ${hookBody},
  },
};
`;

test("H2: a rejected async hook does not crash the process or corrupt the payload", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  write(
    dir,
    "snapshot.config.mjs",
    CONFIG(`async () => {
    throw new Error("hook exploded");
  }`)
  );

  const { code, stdout, stderr } = runCli(["generate", "--format", "json"], dir);

  assert.equal(code, 0, `the run succeeded before the hook failed; stderr: ${stderr.slice(-400)}`);
  const payload = JSON.parse(stdout);
  assert.ok(payload, "stdout is still a single parseable JSON document");

  // The failure is recorded where a warning belongs, and it reached the shipped manifest.
  const shipped = JSON.parse(
    fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8")
  );
  const recorded = shipped.warnings.find((warning) => /hooks\.afterGenerate failed/.test(warning));
  assert.ok(recorded, `the hook failure is in manifest.warnings: ${JSON.stringify(shipped.warnings)}`);
  assert.match(recorded, /hook exploded/);
});

test("H3: a hook's console.log stays off stdout in JSON mode", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  write(
    dir,
    "snapshot.config.mjs",
    CONFIG(`() => {
    console.log("HOOK-NOISE-ON-STDOUT");
    process.stdout.write("HOOK-RAW-WRITE\\n");
  }`)
  );

  const { code, stdout, stderr } = runCli(["generate", "--format", "json"], dir);

  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /HOOK-NOISE-ON-STDOUT|HOOK-RAW-WRITE/, "stdout carries only the payload");
  assert.match(stderr, /HOOK-NOISE-ON-STDOUT|HOOK-RAW-WRITE/, "the hook's output went to stderr");
  assert.ok(JSON.parse(stdout), "stdout still parses");
});

test("H1: files a hook writes are part of the inventory, so the next run is allowed", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  write(
    dir,
    "snapshot.config.mjs",
    `import * as fs from "node:fs";
import * as path from "node:path";

export default {
  hooks: {
    afterGenerate: () => {
      fs.writeFileSync(
        path.join(process.cwd(), "snapshot", "hook-report.txt"),
        "from the hook",
        "utf8"
      );
    },
  },
};
`
  );

  const first = runCli(["generate"], dir);
  assert.equal(first.code, 0, first.stderr.slice(-400));
  assert.ok(fs.existsSync(path.join(dir, "snapshot", "hook-report.txt")), "the hook wrote its file");

  // Second run with the hook removed: the directory must still be recognised as tool-written.
  write(dir, "snapshot.config.mjs", "export default {};\n");
  const second = runCli(["generate"], dir);

  assert.equal(second.code, 0, `a refused replacement would fail here: ${second.stderr.slice(-400)}`);
  assert.doesNotMatch(second.stderr, /Refusing to replace outDir/);
});

test("a synchronous hook throw is still downgraded to a warning, not a crash", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  write(dir, "snapshot.config.mjs", CONFIG(`() => { throw new Error("sync boom"); }`));

  const { code, stderr } = runCli(["generate"], dir);

  assert.equal(code, 0, stderr.slice(-400));
  const shipped = JSON.parse(
    fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8")
  );
  assert.ok(shipped.warnings.some((warning) => /sync boom/.test(warning)));
});

test("a hook that resolves normally leaves no warning behind", (t) => {
  const dir = tempDir(t);
  write(dir, "app.ts", "export const a = 1;\n");
  write(dir, "snapshot.config.mjs", CONFIG(`async () => { await Promise.resolve(); }`));

  const { code, stderr } = runCli(["generate"], dir);
  assert.equal(code, 0, stderr.slice(-400));

  const shipped = JSON.parse(
    fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8")
  );
  assert.deepEqual(
    shipped.warnings.filter((warning) => /hooks\.afterGenerate/.test(warning)),
    [],
    "a successful hook is not a warning"
  );
});

// A guard so an accidental `execFileSync` import does not rot: the helper above is spawnSync
// because exit codes matter, and this asserts the binary really exists where the tests expect.
test("the built CLI exists", () => {
  assert.ok(fs.existsSync(BIN), `missing ${BIN}; run npm run build`);
  assert.ok(execFileSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).trim().length > 0);
});
