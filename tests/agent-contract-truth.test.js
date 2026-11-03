import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The agent contract is an agent's only source of truth before it has context,
 * so its steps must be runnable *today* — not on the day this release happened
 * to be the newest one on the registry — and its field inventory must not
 * promise optional fields unconditionally.
 *
 * Each test below fails against the 4.0.9 contract strings:
 *   - step 1 pinned `v<exact patch>` against a floating `@latest` tag;
 *   - step 3 claimed `snapshot.config.ts` for every project;
 *   - `output.notes` promised a structural summary for every `files[]` entry.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function run(args, options = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

/** The machine contract exactly as an agent receives it. */
function describeJson() {
  const result = run(["describe", "--format", "json"]);
  assert.equal(result.status, 0, `describe failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** Fixture with a CommonJS package.json (no `"type": "module"`). */
function makeCommonJsFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-contract-cjs-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "contract-cjs-fixture", version: "1.0.0" })
  );
  fs.writeFileSync(path.join(dir, "app.py"), "value = 1\n");
  return dir;
}

test("B-1: workflow step 1 cannot contradict the version it runs", () => {
  const contract = describeJson();
  const major = String(contract.version).split(".")[0];
  const escapedVersion = contract.version.replace(/\./g, "\\.");
  const step = contract.workflow[0];

  // The probe still runs the floating tag...
  assert.match(step.run, /@latest\s+--version/, `step 1 must probe @latest: ${step.run}`);

  // ...but the *requirement* is the contract's major, so a lagging registry tag
  // (or a newer one) cannot make step 1 impossible.
  assert.match(
    step.expect,
    new RegExp(`prints v${major} or newer on stdout and exits 0`),
    `step 1 must require the contract major v${major}: ${step.expect}`
  );

  // The old contract form — "prints v<exact patch> on stdout and exits 0" — must
  // be gone: that is the string that contradicts a floating @latest.
  assert.doesNotMatch(
    step.expect,
    new RegExp(`prints v${escapedVersion} on stdout`),
    `step 1 must not require the exact running patch: ${step.expect}`
  );

  // The build version may appear only as clearly-labelled context, never as the
  // expectation an agent compares @latest against.
  if (step.expect.includes(`v${contract.version}`)) {
    assert.match(
      step.expect,
      new RegExp(`this build is v${escapedVersion}`),
      `the exact version must be labelled as build context: ${step.expect}`
    );
  }

  // No workflow entry may require an exact patch of a floating tag.
  for (const entry of contract.workflow.slice(1)) {
    assert.doesNotMatch(
      entry.expect,
      /\bv\d+\.\d+\.\d+\b/,
      `workflow step ${entry.step} (${entry.id}) pins an exact patch: ${entry.expect}`
    );
  }
  for (const entry of contract.workflow) {
    assert.doesNotMatch(
      entry.run,
      /@\d+\.\d+\.\d+/,
      `workflow step ${entry.step} (${entry.id}) pins an exact version in its command: ${entry.run}`
    );
  }
});

test("B-2: the configure step matches init's real config filename", () => {
  const contract = describeJson();
  const step = contract.workflow.find((entry) => entry.id === "configure");
  assert.ok(step, "the contract must keep a configure step");

  // Real behaviour: a CommonJS project gets snapshot.config.mjs on every
  // supported Node version (a .ts config needs Node >= 22.6 *and* an ES module).
  const dir = makeCommonJsFixture();
  try {
    const result = run(["init", "--yes", "--cwd", dir]);
    assert.equal(result.status, 0, `init failed: ${result.stderr}`);
    assert.ok(
      fs.existsSync(path.join(dir, "snapshot.config.mjs")),
      "init must write snapshot.config.mjs for a CommonJS project"
    );
    assert.equal(
      fs.existsSync(path.join(dir, "snapshot.config.ts")),
      false,
      "init must not write snapshot.config.ts for a CommonJS project"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const text = `${step.expect} ${step.notes ?? ""}`;
  assert.match(text, /snapshot\.config\.mjs/, `the configure step must mention .mjs: ${text}`);
  assert.match(
    text,
    /ES module|"type"\s*:\s*"module"|type: module/i,
    `the configure step must name the ES-module condition: ${text}`
  );
  assert.match(
    text,
    /22\.6|strip types|type stripping/i,
    `the configure step must name the Node requirement for a .ts config: ${text}`
  );
  assert.doesNotMatch(
    step.expect,
    /^writes snapshot\.config\.ts\b/,
    `the configure step must not claim .ts unconditionally: ${step.expect}`
  );
});

test("B-3: output.notes says the per-file summary is conditional", () => {
  const contract = describeJson();
  const notes = contract.output.notes.join("\n");

  assert.match(
    notes,
    /summaryOmitted/,
    `output.notes must explain summaryOmitted: ${notes}`
  );
  assert.match(
    notes,
    /summary[\s\S]{0,200}(absent|omit|only when|conditional|optional)/i,
    `output.notes must say the summary can be missing: ${notes}`
  );
  assert.doesNotMatch(
    notes,
    /carries[^.\n]*and a structural summary\./,
    "output.notes must not promise a summary for every files[] entry"
  );
});

test("the shipped skill repeats the same honest rules", () => {
  const contract = describeJson();
  const major = String(contract.version).split(".")[0];
  const result = run(["skill"]);
  assert.equal(result.status, 0, `skill failed: ${result.stderr}`);
  const skill = result.stdout;

  assert.match(
    skill,
    new RegExp(`v${major}\`?\\s+or\\s+newer`),
    `the skill must verify the major version, not the patch: ${skill.slice(0, 600)}`
  );
  assert.doesNotMatch(
    skill,
    new RegExp(`v${contract.version.replace(/\./g, "\\.")}\\b`),
    "the skill must not pin the exact patch against @latest"
  );
  assert.match(skill, /snapshot\.config\.mjs/, "the skill must mention the .mjs config fallback");
  assert.match(skill, /22\.6|strip types|type stripping/i, "the skill must name the Node requirement");
  assert.match(skill, /summaryOmitted/, "the skill must explain summaryOmitted");
});
