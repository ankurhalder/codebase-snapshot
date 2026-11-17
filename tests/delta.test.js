/**
 * Delta packs: what changed since a base snapshot, plus the files that import it.
 *
 * The honesty property is the important one: an unchanged file is not dropped silently. It is
 * absent from files[] and present in skipped[] with reason "unchanged" and in delta.unchanged, so a
 * reader can account for every scanned path.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "dist", "bin.js");

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delta-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"d","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "src", "user.ts"), "export function getUser() { return 1; }\n");
  fs.writeFileSync(path.join(root, "src", "auth.ts"), 'import { getUser } from "./user.js";\nexport const auth = getUser;\n');
  fs.writeFileSync(path.join(root, "src", "unrelated.ts"), "export const unrelated = 1;\n");
  return root;
}

const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
};

test("a delta contains the changed file and its importer, and accounts for the rest", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate"], root).code, 0);
  const base = path.join(root, "snapshot");
  const before = JSON.parse(fs.readFileSync(path.join(base, "manifest.json"), "utf8"));
  assert.equal(before.files.length, 4);

  fs.appendFileSync(path.join(root, "src", "user.ts"), "export const version = 2;\n");
  const result = run(["generate", "--out-dir", "delta", "--delta", base], root);
  assert.equal(result.code, 0, result.out);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "delta", "manifest.json"), "utf8"));
  assert.ok(manifest.delta, "the manifest records the delta");
  assert.deepEqual(manifest.delta.changed, ["src/user.ts"]);
  assert.deepEqual(manifest.delta.added, []);
  assert.deepEqual(manifest.delta.removed, []);
  assert.deepEqual(manifest.delta.unchanged.sort(), ["package.json", "src/unrelated.ts"]);

  const inParts = manifest.files.map((file) => file.relativePath).sort();
  assert.deepEqual(inParts, ["src/auth.ts", "src/user.ts"], "the importer is included: " + inParts.join(","));

  const unchanged = manifest.skipped.filter((record) => record.reason === "unchanged").map((record) => record.path);
  assert.ok(unchanged.includes("src/unrelated.ts"));
  assert.ok(unchanged.includes("package.json"));

  const body = fs.readFileSync(path.join(root, "delta", "parts", "part-001.md"), "utf8");
  assert.match(body, /version = 2/);
  assert.doesNotMatch(body, /unrelated/);
});

test("a new file shows as added and a deleted one as removed", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate"], root).code, 0);
  fs.writeFileSync(path.join(root, "src", "fresh.ts"), "export const fresh = true;\n");
  fs.rmSync(path.join(root, "src", "unrelated.ts"));

  assert.equal(run(["generate", "--out-dir", "delta", "--delta", root + "/snapshot"], root).code, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "delta", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.delta.added, ["src/fresh.ts"]);
  assert.deepEqual(manifest.delta.removed, ["src/unrelated.ts"]);
});

test("an unreadable base is an error, not a full scan", (t) => {
  const root = makeRepo(t);
  const result = run(["generate", "--delta", path.join(root, "missing")], root);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /No manifest at/);
});
