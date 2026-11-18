/**
 * Workspace generation: one snapshot per member, plus the index that makes them one deliverable.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

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

test("a workspace records which member imports which", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-links-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const member of ["app", "shared"]) {
    fs.mkdirSync(path.join(root, member, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, member, "package.json"), JSON.stringify({ name: member, version: "1.0.0" }) + "\n");
  }
  fs.writeFileSync(path.join(root, "shared", "src", "util.ts"), "export const util = 1;\n");
  fs.writeFileSync(
    path.join(root, "app", "src", "index.ts"),
    'import { util } from "../../shared/src/util.js";\nexport const app = util;\n'
  );

  const result = run(["generate", "--workspace", "app,shared"], root);
  assert.equal(result.code, 0, result.out);
  const workspace = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "WORKSPACE.json"), "utf8"));
  const link = workspace.links.find((entry) => entry.from === "app" && entry.to === "shared");
  assert.ok(link, "the edge is recorded");
  assert.ok(link.specifiers >= 1);
  assert.ok(link.examples.includes("src/index.ts"));
  assert.match(result.out, /app imports shared/);
});

test("health audits every member of a workspace", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate", "--workspace", "api,web"], root).code, 0);
  const healthy = run(["health", "--all-members"], root);
  assert.equal(healthy.code, 0, healthy.out);
  assert.match(healthy.out, /Workspace health/);
  assert.match(healthy.out, /Combined score:/);
  for (const member of ["api", "web"]) assert.match(healthy.out, new RegExp(member));

  const part = path.join(root, "snapshot", "api", "parts", "part-001.md");
  fs.writeFileSync(part, fs.readFileSync(part, "utf8") + "\ntampered\n");
  const broken = run(["health", "--all-members"], root);
  assert.equal(broken.code, 1, broken.out);
  assert.match(broken.out, /api/);
});

test("health --all-members names the missing index", (t) => {
  const root = makeRepo(t);
  const result = run(["health", "--all-members"], root);
  assert.equal(result.code, 1);
  assert.match(result.out, /No workspace index/);
});

test("health --all-members --format json returns one record per member", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate", "--workspace", "api,web"], root).code, 0);
  const result = spawnSync(process.execPath, [BIN, "health", "--all-members", "--format", "json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.members.length, 2);
  for (const member of report.members) {
    assert.ok(["api", "web"].includes(member.name));
    assert.equal(typeof member.score, "number");
    assert.ok(member.counts.pass > 0);
    assert.equal(member.error, undefined);
  }
  assert.equal(report.score, Math.min(...report.members.map((member) => member.score)));
});

test("health notices an index that disagrees with a member", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate", "--workspace", "api,web"], root).code, 0);
  const index = path.join(root, "snapshot", "WORKSPACE.json");
  const document = JSON.parse(fs.readFileSync(index, "utf8"));
  const api = document.members.find((member) => member.name === "api");
  api.fingerprint = "f".repeat(64);
  fs.writeFileSync(index, JSON.stringify(document, null, 2) + "\n");

  const audited = run(["health", "--cwd", "api", "--out-dir", "../snapshot/api"], root);
  assert.match(audited.out, /The workspace index agrees with this member/);
  assert.match(audited.out, /disagrees with this member on: fingerprint/);

  // Regenerating the workspace makes the index agree again.
  assert.equal(run(["generate", "--workspace", "api,web"], root).code, 0);
  const clean = run(["health", "--cwd", "api", "--out-dir", "../snapshot/api"], root);
  assert.match(clean.out, /matches the index fingerprint/);
});
