/**
 * Health, part two: the checks that compare the snapshot with what it claims.
 *
 * The first suite proves the manifest, the parts and the artifacts agree with each other. These
 * cases prove the next link: a summary names a symbol the body contains, a report quotes this run,
 * a section sits where the manifest says, a pack carries the same body, an index names an included
 * file, and (with --deep) a full body replays from the source bytes.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

const cli = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return {
    code: result.status,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    stdout: result.stdout ?? "",
  };
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function repoWithSnapshot(t, files = {}, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "health-quality-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\nexport function alpha() { return a; }\n");
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), content);
  }
  const result = cli(["generate", ...extraArgs], dir);
  assert.equal(result.code, 0, result.out);
  return dir;
}

const manifestPath = (dir) => path.join(dir, "snapshot", "manifest.json");
const readManifest = (dir) => JSON.parse(fs.readFileSync(manifestPath(dir), "utf8"));
const writeManifest = (dir, manifest) =>
  fs.writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2) + "\n");

const healthReport = (dir, ...extra) => {
  const result = cli(["health", "--format", "json", ...extra], dir);
  return { result, report: JSON.parse(result.stdout) };
};
const find = (report, id) => report.checks.find((check) => check.id === id);

test("the quality checks pass on a clean snapshot, including the deep replay", (t) => {
  const dir = repoWithSnapshot(t);
  const { result, report } = healthReport(dir, "--deep");
  assert.equal(result.code, 0, result.out);
  assert.equal(report.score, 100);
  for (const id of [
    "summary.truth",
    "report.truth",
    "indexes.consistent",
    "markdown.structure",
    "fidelity.bodies",
    "tokens.fit",
  ]) {
    const item = find(report, id);
    assert.ok(item, `${id} is reported`);
    assert.notEqual(item.status, "fail", `${id}: ${item.detail}`);
  }
  assert.equal(find(report, "fidelity.bodies").status, "pass", find(report, "fidelity.bodies").detail);
});

test("without --deep the replay is a skip, not a silent pass", (t) => {
  const dir = repoWithSnapshot(t);
  const { report } = healthReport(dir);
  const item = find(report, "fidelity.bodies");
  assert.equal(item.status, "skip");
  assert.match(item.detail, /--deep/);
});

test("a summary that names a symbol the body does not contain fails the audit", (t) => {
  const dir = repoWithSnapshot(t);
  const manifest = readManifest(dir);
  const entry = manifest.files.find((file) => file.relativePath === "src/a.ts");
  entry.summary.exports.push("ghostExport");
  writeManifest(dir, manifest);

  const { result, report } = healthReport(dir);
  assert.equal(result.code, 1);
  const item = find(report, "summary.truth");
  assert.equal(item.status, "fail");
  assert.match(item.detail, /src\/a\.ts \(exports\)/);
  assert.doesNotMatch(result.out, /ghostExport/, "the audit never prints the claimed symbol");
});

test("a report that quotes another run fails the audit", (t) => {
  const dir = repoWithSnapshot(t);
  const readmePath = path.join(dir, "snapshot", "README.md");
  fs.writeFileSync(
    readmePath,
    fs.readFileSync(readmePath, "utf8").replace("**Total Tracked Files:** \`2\`", "**Total Tracked Files:** \`999\`")
  );
  // Re-digest the edited README so the artifact check passes and this isolates report.truth.
  const manifest = readManifest(dir);
  manifest.artifacts.readme.sha256 = sha256(fs.readFileSync(readmePath));
  writeManifest(dir, manifest);

  const { result, report } = healthReport(dir);
  assert.equal(result.code, 1);
  const item = find(report, "report.truth");
  assert.equal(item.status, "fail");
  assert.match(item.detail, /README total files/);
  assert.match(item.detail, /999/);
});

test("an index entry that names a file outside the snapshot fails the audit", (t) => {
  const dir = repoWithSnapshot(t);
  const manifest = readManifest(dir);
  manifest.indexes.imports.byFile.push({ path: "src/ghost.ts", imports: [], exports: [] });
  writeManifest(dir, manifest);

  const { result, report } = healthReport(dir);
  assert.equal(result.code, 1);
  const item = find(report, "indexes.consistent");
  assert.equal(item.status, "fail");
  assert.match(item.detail, /src\/ghost\.ts/);
});

test("a section missing from a part fails the structural check", (t) => {
  const dir = repoWithSnapshot(t);
  const manifest = readManifest(dir);
  const part = manifest.parts[0];
  const partPath = path.join(dir, "snapshot", "parts", part.filename);
  const text = fs.readFileSync(partPath, "utf8");
  const heading = "### FILE: src/a.ts";
  const start = text.indexOf(heading);
  assert.ok(start > 0, "the fixture part holds src/a.ts");
  const next = text.indexOf("### FILE:", start + heading.length);
  const cut = text.slice(0, start) + (next === -1 ? "" : text.slice(next));
  fs.writeFileSync(partPath, cut);
  const bytes = fs.readFileSync(partPath);
  part.byteSize = bytes.length;
  part.sha256 = sha256(bytes);
  writeManifest(dir, manifest);

  const { result, report } = healthReport(dir);
  assert.equal(result.code, 1);
  const item = find(report, "markdown.structure");
  assert.equal(item.status, "fail");
  assert.match(item.detail, /no section|holds/);
});

test("a JSON pack whose body differs from its part fails the audit", (t) => {
  const dir = repoWithSnapshot(t, {}, ["--pack", "json"]);
  const packPath = path.join(dir, "snapshot", "full-codebase.json");
  const pack = JSON.parse(fs.readFileSync(packPath, "utf8"));
  const entry = pack.files.find((file) => file.relativePath === "src/a.ts");
  assert.ok(entry, "the fixture pack holds src/a.ts");
  entry.content = "export const a = 999;\n";
  fs.writeFileSync(packPath, JSON.stringify(pack, null, 2) + "\n");
  const manifest = readManifest(dir);
  manifest.artifacts.fullJson.sha256 = sha256(fs.readFileSync(packPath));
  writeManifest(dir, manifest);

  const { result, report } = healthReport(dir);
  assert.equal(result.code, 1);
  const item = find(report, "packs.bodies");
  assert.equal(item.status, "fail", item.detail);
  assert.match(item.detail, /src\/a\.ts/);
});

test("--deep replays a full body and fails when it is not the source", (t) => {
  const dir = repoWithSnapshot(t);
  // Change the source and record its new hash in the manifest. The part still holds the old body,
  // which is exactly the shape of a generator that read the source correctly the first time and
  // wrote the wrong bytes: the cheap checks all pass because they compare the snapshot with itself.
  const sourcePath = path.join(dir, "src", "a.ts");
  const changed = "export const a = 2;\nexport function alpha() { return a; }\n";
  fs.writeFileSync(sourcePath, changed);
  const manifest = readManifest(dir);
  const entry = manifest.files.find((file) => file.relativePath === "src/a.ts");
  entry.hashSha256 = sha256(Buffer.from(changed));
  writeManifest(dir, manifest);

  const shallow = healthReport(dir);
  assert.equal(find(shallow.report, "fidelity.bodies").status, "skip");

  const { result, report } = healthReport(dir, "--deep");
  assert.equal(result.code, 1);
  const item = find(report, "fidelity.bodies");
  assert.equal(item.status, "fail", item.detail);
  assert.match(item.detail, /src\/a\.ts line 1/);
});

test("a PEM block is a redaction, not a fidelity failure", (t) => {
  const dir = repoWithSnapshot(t, {
    "src/key.ts":
      'export const key = "-----BEGIN RSA PRIVATE KEY-----\\n' +
      'MIIEowIBAAKCAQEASENTINELBODYSECRET1234567890abcdefghijklmn\\n' +
      '-----END RSA PRIVATE KEY-----";\n',
  });
  const { result, report } = healthReport(dir, "--deep");
  assert.equal(result.code, 0, result.out);
  assert.equal(find(report, "fidelity.bodies").status, "pass", find(report, "fidelity.bodies").detail);
});
