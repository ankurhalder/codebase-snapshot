import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 4.0.9 regression cover: `--no-config` must mean "this repository's config is not executed",
 * and `diff` must never import one at all — it answers a question about two manifest files.
 *
 * The fixture config writes a file next to itself when it is imported, so "was the config
 * evaluated?" is a plain filesystem question rather than a matter of reading output text.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

const SIDE_EFFECT = "config-was-imported.txt";

/** A module config whose import is observable, and which would exclude `a.ts` if honoured. */
const OBSERVABLE_CONFIG = `
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(here, ${JSON.stringify(SIDE_EFFECT)}), "yes", "utf8");

export default { excludePatterns: ["a.ts"] };
`;

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-config-scope-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0","type":"module"}\n');
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(dir, "b.ts"), "export const b = 2;\n");
  fs.writeFileSync(path.join(dir, "snapshot.config.mjs"), OBSERVABLE_CONFIG);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args) {
  return execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function imported(dir) {
  return fs.existsSync(path.join(dir, SIDE_EFFECT));
}

function manifestOf(dir, outDir) {
  return JSON.parse(fs.readFileSync(path.join(dir, outDir, "manifest.json"), "utf8"));
}

test("generate imports the repository config (control)", (t) => {
  const dir = makeRepo(t);
  run(["generate", "--cwd", dir, "--out-dir", "out"]);

  assert.equal(imported(dir), true, "a normal run does evaluate the config");
  const files = manifestOf(dir, "out").files.map((file) => file.relativePath);
  assert.ok(!files.includes("a.ts"), "the config's excludePatterns is applied");
});

test("diff never imports the repository config", (t) => {
  const dir = makeRepo(t);
  run(["generate", "--cwd", dir, "--out-dir", "out"]);
  fs.rmSync(path.join(dir, SIDE_EFFECT), { force: true });

  const manifest = path.join(dir, "out", "manifest.json");
  run(["diff", manifest, manifest]);

  assert.equal(imported(dir), false, "diff read the manifests without executing repository code");
});

test("--no-config is accepted by diff instead of being a usage error", (t) => {
  const dir = makeRepo(t);
  run(["generate", "--cwd", dir, "--out-dir", "out"]);
  fs.rmSync(path.join(dir, SIDE_EFFECT), { force: true });
  const manifest = path.join(dir, "out", "manifest.json");

  // execFileSync throws on a non-zero exit, so not throwing is the assertion: before 4.0.9
  // this was a usage error (exit 2). The summary is written to stderr, so stdout is empty.
  run(["diff", manifest, manifest, "--no-config"]);
  assert.equal(imported(dir), false, "diff still did not import the config");
});

test("the contract advertises --no-config for diff", () => {
  const contract = JSON.parse(run(["describe", "--format", "json"]));
  const option = contract.options.find((entry) => entry.flag === "--no-config");
  assert.ok(option, "the contract lists --no-config");
  assert.ok(
    option.appliesTo.includes("diff"),
    `describe says --no-config applies to ${option.appliesTo}`
  );
});
