import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

/**
 * `report` reads `manifest.json` and prints what is there; a generation setting cannot change
 * its answer. It used to accept seven of them and ignore them (identical output, exit 0) while
 * correctly rejecting `--discovery` — the silent fallback the scope table exists to prevent.
 * The parser and `describe`'s `appliesTo` read the same table, so both are asserted here.
 */
const REPORT_GENERATION_FLAGS = [
  ["--skip-artifacts", "parts"],
  ["--only-artifacts", "manifest"],
  ["--include-monolith"],
  ["--max-part-bytes", "4096"],
  ["--large-file-bytes", "1"],
  ["--include-sensitive-files"],
];

test("report rejects generation flags instead of accepting silent no-ops", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');

  for (const flag of REPORT_GENERATION_FLAGS) {
    const result = run(["report", "--cwd", dir, ...flag], os.tmpdir());
    assert.equal(result.status, 2, `${flag.join(" ")}: report cannot apply it`);
    assert.match(result.stderr, /does not apply to `report`/, `${flag[0]}: names the command`);
    assert.match(result.stderr, /accepted by:/, `${flag[0]}: names a command that does accept it`);
  }

  const contract = JSON.parse(run(["describe", "--format", "json"], os.tmpdir()).stdout);
  for (const [flag] of REPORT_GENERATION_FLAGS) {
    const option = contract.options.find((entry) => entry.flag === flag);
    assert.ok(option, `${flag} is still described`);
    assert.equal(
      option.appliesTo.split("/").includes("report"),
      false,
      `describe must not advertise ${flag} on report`
    );
  }
  // The settings a manifest reader genuinely needs stay in report's scope.
  for (const flag of ["--cwd", "--out-dir", "--format", "--no-config"]) {
    const option = contract.options.find((entry) => entry.flag === flag);
    assert.ok(option.appliesTo.split("/").includes("report"), `${flag} must still apply to report`);
  }
});

test("a consumer that closes stdout early is an early exit, not an EPIPE crash", { timeout: 60_000 }, async (t) => {
  // A manifest big enough to overflow the OS pipe buffer, so the truncated write really fails:
  // small payloads fit in the buffer and hid this crash from every existing test.
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, "snapshot.config.json"), '{"discovery":"walk"}\n');
  for (let index = 0; index < 600; index += 1) {
    const name = `f${String(index).padStart(3, "0")}.ts`;
    fs.writeFileSync(path.join(dir, name), `export const value${index} = "${"x".repeat(120)}";\n`);
  }

  const child = spawn(process.execPath, [BIN, "generate", "--format", "json", "--cwd", dir], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let closedEarly = false;
  child.stdout.on("data", () => {
    if (closedEarly) return;
    closedEarly = true;
    // The reader's decision: stop consuming the payload half way through.
    child.stdout.destroy();
  });
  child.stdout.on("error", () => {});
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exit = await new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  assert.equal(closedEarly, true, "the payload was large enough to be cut off");
  assert.equal(exit.code, 0, `a closed reader is not a command failure:\\n${stderr}`);
  assert.doesNotMatch(stderr, /Unhandled 'error' event|EPIPE/);
});
