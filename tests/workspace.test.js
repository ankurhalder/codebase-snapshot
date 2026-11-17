/**
 * Workspace generation: one snapshot per member, plus the index that makes them one deliverable.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "dist", "bin.js");

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const member of ["api", "web"]) {
    const dir = path.join(root, member);
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: member, version: "1.0.0" }) + "\n");
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const name = '" + member + "';\n");
  }
  return root;
}

const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
};

test("each member gets a snapshot and the workspace index lists them", (t) => {
  const root = makeRepo(t);
  const result = run(["generate", "--workspace", "api,web"], root);
  assert.equal(result.code, 0, result.out);

  const workspace = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "WORKSPACE.json"), "utf8"));
  assert.equal(workspace.members.length, 2);
  for (const member of workspace.members) {
    assert.match(member.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(member.files >= 2, member.name + " has files");
    assert.ok(fs.existsSync(path.join(root, "snapshot", member.name, "manifest.json")));
  }
});

test("a missing member is reported and makes the run exit 1, after the others are written", (t) => {
  const root = makeRepo(t);
  const result = run(["generate", "--workspace", "api,missing"], root);
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /Workspace member missing: missing/);
  assert.ok(fs.existsSync(path.join(root, "snapshot", "api", "manifest.json")), "the good member was written");
  const workspace = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "WORKSPACE.json"), "utf8"));
  assert.equal(workspace.members.length, 1);
});

test("--workspace refuses to combine with --delta", (t) => {
  const root = makeRepo(t);
  const result = run(["generate", "--workspace", "api", "--delta", "web"], root);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /do not combine/);
});
