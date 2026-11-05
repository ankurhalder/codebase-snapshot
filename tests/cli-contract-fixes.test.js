import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

function run(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-contract-fixes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("usage errors honour --format json with one parseable document", () => {
  const cases = [
    ["--format", "json", "--bogus"],
    ["validate", "--format", "json", "extra"],
    ["generate", "--format", "json", "--max-part-bytes", "nope"],
    ["generate", "--format=json", "--cwd", path.join(os.tmpdir(), "cs-missing-dir")],
  ];
  for (const args of cases) {
    const result = run(args, os.tmpdir());
    assert.equal(result.status, 2, `${args.join(" ")}: exit`);
    assert.ok(result.stdout.length > 0, `${args.join(" ")}: stdout must not be empty`);
    const document = JSON.parse(result.stdout);
    assert.equal(document.error.exitCode, 2, `${args.join(" ")}: exitCode`);
    assert.equal(typeof document.error.message, "string");
    assert.ok(result.stderr.includes("❌"), `${args.join(" ")}: human line on stderr`);
  }
});

test("report rejects a manifest without totals in text and JSON modes", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "snapshot"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "snapshot", "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: "3.0.0",
        generatedAt: "2026-01-01T00:00:00.000Z",
        fingerprint: "a".repeat(64),
        counts: { totalFiles: 0, totalLines: 0, totalSizeBytes: 0, partsCount: 0 },
        layers: {},
        files: [],
      },
      null,
      2
    )
  );

  const text = run(["report", "--cwd", dir]);
  assert.equal(text.status, 1);
  assert.match(text.stderr, /is not a snapshot manifest/);
  assert.doesNotMatch(text.stderr, /Codebase Snapshot Report/);

  const json = run(["report", "--cwd", dir, "--format", "json"]);
  assert.equal(json.status, 1);
  const document = JSON.parse(json.stdout);
  assert.equal(document.error.exitCode, 1);
  assert.match(document.error.message, /is not a snapshot manifest/);
  assert.doesNotMatch(json.stderr, /Codebase Snapshot Report/);
});

test("describe exposes check and --mode", () => {
  const result = run(["describe", "--format", "json"], os.tmpdir());
  assert.equal(result.status, 0);
  const contract = JSON.parse(result.stdout);

  const validate = contract.commands.find((command) => command.name === "validate");
  assert.ok(validate, "validate command must exist");
  assert.ok(validate.aliases.includes("check"), "validate.aliases must include check");
  assert.match(validate.summary, /check.*alias|alias.*check/i);
  // Canonical names come from the contract itself; an alias (`check`) is not one, and a hard-coded
  // second list here is one more place a new command can be forgotten.
  const canonical = new Set(contract.commands.map((command) => command.name));
  for (const option of contract.options) {
    const tokens = option.appliesTo.split("/");
    assert.ok(tokens.every((token) => canonical.has(token)), `${option.flag}: prose or aliased token`);
  }

  const mode = contract.options.find((option) => option.flag === "--mode");
  assert.ok(mode, "--mode must be in describe.options");
  assert.equal(mode.type, "string");
  assert.match(mode.summary, /contradict/i);
});

test("the help sentence matches boolean --option=value behaviour", () => {
  const help = run(["--help"], os.tmpdir());
  assert.equal(help.status, 0);
  assert.match(help.stdout, /value-taking options.*--option=value/);
  assert.doesNotMatch(help.stdout, /All options also accept/);

  const booleanEquals = run(["generate", "--help=true"], os.tmpdir());
  assert.equal(booleanEquals.status, 2);
  assert.match(booleanEquals.stderr, /does not take an argument/);
});
