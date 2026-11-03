import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
const ESC = "\u001b";
const CSI = `${ESC}[2J${ESC}[31m`;
const OSC = `${ESC}]0;PWNED TITLE\u0007`;
const C1 = "\u009b31m";
const RLO = "\u202e";
const RLO_BYTES = Buffer.from(RLO, "utf8");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-terminal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  write(path.join(dir, "package.json"), '{"name":"terminal","version":"1.0.0"}\n');
  write(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  write(path.join(dir, "src", "café.ts"), "export const café = 1;\n");
  const generated = run(["generate", "--no-config", "--cwd", dir]);
  assert.equal(generated.status, 0, generated.stderr.toString("utf8"));
  return dir;
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: null,
    timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  return {
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

function combined(result) {
  return Buffer.concat([result.stdout, result.stderr]);
}

function assertNoRawControls(buffer, label) {
  assert.equal(buffer.includes(0x1b), false, `${label}: raw ESC byte`);
  assert.equal(buffer.includes(0x9b), false, `${label}: raw C1 byte`);
  assert.equal(buffer.includes(0x07), false, `${label}: raw BEL byte`);
  assert.equal(buffer.includes(Buffer.from(RLO, "utf8")), false, `${label}: raw RLO bytes`);
}

function assertShows(buffer, fragment, label) {
  assert.ok(
    buffer.toString("utf8").includes(fragment),
    `${label}: expected visible escape ${JSON.stringify(fragment)}`
  );
}

function manifestFile(dir) {
  return path.join(dir, "snapshot", "manifest.json");
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(manifestFile(dir), "utf8"));
}

function updateManifest(dir, mutate) {
  const manifest = readManifest(dir);
  mutate(manifest);
  write(manifestFile(dir), `${JSON.stringify(manifest, null, 2)}\n`);
}

test("validate text escapes manifest part names and file paths", (t) => {
  const dir = makeRepo(t);
  updateManifest(dir, (manifest) => {
    manifest.parts[0].filename = `${OSC}.md`;
    const file = manifest.files.find((entry) => entry.relativePath === "src/a.ts");
    assert.ok(file);
    file.relativePath = `src/${CSI}PWNED-FILE${ESC}[0m.ts`;
  });

  const result = run(["validate", "--cwd", dir]);
  assert.equal(result.status, 1);
  assertNoRawControls(combined(result), "validate");
  assertShows(combined(result), "\\u001B]0;PWNED TITLE\\u0007", "validate OSC part");
  assertShows(combined(result), "\\u001B[2J", "validate CSI file");
});

test("report text escapes layer names", (t) => {
  const dir = makeRepo(t);
  updateManifest(dir, (manifest) => {
    manifest.layers = { [`${C1}${RLO}PWNED-LAYER`]: 1, src: 1 };
  });

  const result = run(["report", "--cwd", dir]);
  assert.equal(result.status, 0);
  assertNoRawControls(combined(result), "report");
  assertShows(combined(result), "\\u009B31m", "report C1 layer");
  assertShows(combined(result), "\\u202E", "report bidi layer");
});

test("explain text escapes a manifest part name", (t) => {
  const dir = makeRepo(t);
  updateManifest(dir, (manifest) => {
    const file = manifest.files.find((entry) => entry.relativePath === "src/a.ts");
    assert.ok(file);
    file.part = `${CSI}PWNED-EXPLAIN.md`;
  });

  const result = run(["explain", "--cwd", dir, "src/a.ts"]);
  assert.equal(result.status, 0);
  assertNoRawControls(combined(result), "explain");
  assertShows(combined(result), "\\u001B[2J", "explain CSI part");
});

test("diff text escapes manifest file paths", (t) => {
  const dir = makeRepo(t);
  const before = path.join(dir, "before");
  fs.cpSync(path.join(dir, "snapshot"), before, { recursive: true });
  updateManifest(dir, (manifest) => {
    const file = manifest.files.find((entry) => entry.relativePath === "src/a.ts");
    assert.ok(file);
    file.relativePath = `src/${CSI}PWNED-DIFF${ESC}[0m.ts`;
  });

  const result = run(["diff", path.join(before, "manifest.json"), manifestFile(dir)]);
  assert.equal(result.status, 0);
  assertNoRawControls(combined(result), "diff");
  assertShows(combined(result), "\\u001B[2J", "diff CSI path");
});

test("--format json keeps control characters only as JSON escapes", (t) => {
  const dir = makeRepo(t);
  updateManifest(dir, (manifest) => {
    manifest.parts[0].filename = `${CSI}PWNED-JSON${ESC}[0m.md`;
  });

  const result = run(["validate", "--format", "json", "--cwd", dir]);
  assert.equal(result.status, 1);
  assertNoRawControls(result.stdout, "validate json stdout");
  assertNoRawControls(result.stderr, "validate json stderr");
  const text = result.stdout.toString("utf8");
  assert.match(text, /\\u001[bB]\[2J/);
  const parsed = JSON.parse(text);
  const parts = parsed.drift.partIssues.map((issue) => issue.part);
  assert.ok(parts.some((part) => part.includes(ESC)), "parsed JSON keeps the control code point");
});

test("ordinary Unicode output is unchanged", (t) => {
  const dir = makeRepo(t);
  const result = run(["explain", "--cwd", dir, "src/café.ts"]);
  assert.equal(result.status, 0);
  assertNoRawControls(combined(result), "explain café");
  assert.ok(combined(result).toString("utf8").includes("src/café.ts"));
  assert.ok(combined(result).toString("utf8").includes("café"), "café is not escaped");
});
