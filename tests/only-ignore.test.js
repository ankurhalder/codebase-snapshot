/**
 * Per-run include and exclude: `--only` and `--ignore`.
 *
 * Both tools this is compared with let a single run narrow the files without editing a config.
 * The precedence is deliberate: `--only` replaces the allow-list (a statement about the whole run),
 * `--ignore` adds to the deny-list (naturally cumulative with what the config already excludes).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "only-ignore-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "r", version: "1.0.0" }) + "\n");
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "export const b = 2;\n");
  return root;
}

const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
};

const filesOf = (root, outDir) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, outDir, "manifest.json"), "utf8"));
  return manifest.files.map((file) => file.relativePath).sort();
};

test("--ignore adds to the exclude list for one run", (t) => {
  const root = repo(t);
  assert.equal(run(["generate", "--ignore", "src/b.ts"], root).code, 0);
  assert.deepEqual(filesOf(root, "snapshot"), ["package.json", "src/a.ts"]);
  const skipped = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8")).skipped;
  assert.ok(skipped.some((record) => record.path === "src/b.ts"), "the ignored path is recorded, not dropped");

  // `validate` compares the config digest, so it needs the same flag; without it the run is drift.
  assert.equal(run(["validate", "--ignore", "src/b.ts"], root).code, 0);
  assert.notEqual(run(["validate"], root).code, 0);
});

test("--only replaces the allow-list for one run", (t) => {
  const root = repo(t);
  assert.equal(run(["generate", "--only", "src/a.ts"], root).code, 0);
  assert.deepEqual(filesOf(root, "snapshot"), ["src/a.ts"]);
});

test("explain knows a file the run ignored", (t) => {
  const root = repo(t);
  assert.equal(run(["generate", "--ignore", "src/b.ts"], root).code, 0);
  const explained = run(["explain", "src/b.ts", "--ignore", "src/b.ts"], root);
  assert.equal(explained.code, 0, explained.out);
  assert.match(explained.out, /excluded/i);
});
