import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

/**
 * The experimental `maxParts` mode: a fixed part count, with the per-part budget growing to
 * honour it. It is off unless asked for, it may exceed `maxPartBytes` (and says so), and the
 * manifest records both the configured ceiling and the one the parts actually honour.
 */

function tempDir(t, prefix = "snap-maxparts-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Enough small files that the minimum budget produces far more parts than a chat takes. */
function makeManyFiles(t) {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"big","version":"1.0.0"}\n', "utf8");
  for (let index = 0; index < 64; index += 1) {
    const name = `f${String(index).padStart(2, "0")}`;
    fs.writeFileSync(path.join(dir, "src", `${name}.ts`), `export const ${name} = "${"x".repeat(400)}";\n`, "utf8");
  }
  return dir;
}

const cli = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const manifestOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));

test("--max-parts grows the budget instead of adding parts", (t) => {
  const dir = makeManyFiles(t);
  assert.equal(cli(["generate", "--max-part-bytes", "4096"], dir).code, 0);
  const before = manifestOf(dir);
  assert.ok(before.parts.length > 10, `the fixture needs many parts (got ${before.parts.length})`);
  assert.equal(before.config.maxParts, null, "the mode is off by default");

  const generated = cli(["generate", "--max-part-bytes", "4096", "--max-parts", "5"], dir);
  assert.equal(generated.code, 0, generated.out);
  const after = manifestOf(dir);

  assert.ok(after.parts.length <= 5, `at most five parts (got ${after.parts.length})`);
  assert.equal(after.config.maxParts, 5, "the ceiling is recorded");
  assert.equal(after.config.maxPartBytes, 4096, "the configured ceiling is still recorded as configured");
  assert.ok(
    after.budgets.maxPartBytes > after.config.maxPartBytes,
    "the parts honour a budget the setting grew"
  );
  assert.ok(
    after.warnings.some((warning) => /maxParts 5: the part budget grew/.test(warning)),
    "the growth is a recorded warning, not a silent change"
  );
  assert.ok(
    after.warnings.some((warning) => /above the configured maxPartBytes/.test(warning)),
    "and the cost of exceeding the ceiling is stated"
  );
});

test("maxParts in the config holds, and validate still passes", (t) => {
  const dir = makeManyFiles(t);
  fs.writeFileSync(
    path.join(dir, "snapshot.config.mjs"),
    "export default { maxPartBytes: 4096, maxParts: 4 };\n",
    "utf8"
  );
  assert.equal(cli(["generate"], dir).code, 0);

  const manifest = manifestOf(dir);
  assert.ok(manifest.parts.length <= 4, `at most four parts (got ${manifest.parts.length})`);
  assert.equal(manifest.config.maxParts, 4);

  const validated = cli(["validate"], dir);
  assert.equal(validated.code, 0, `validate must accept a derived ceiling: ${validated.out}`);
});

test("--max-parts 0 is a usage error, and the contract documents the flag", (t) => {
  const dir = makeManyFiles(t);
  const bad = cli(["generate", "--max-parts", "0"], dir);
  assert.equal(bad.code, 2, "zero parts is not a configuration");
  assert.match(bad.out, /--max-parts must be at least 1/);

  const contract = JSON.parse(cli(["describe", "--format", "json"], dir).out);
  const option = contract.options.find((entry) => entry.flag === "--max-parts");
  assert.ok(option, "the flag is in the contract");
  assert.match(option.summary, /Experimental/, "it is labelled as experimental");
  const setting = contract.config.settings.find((entry) => entry.key === "maxParts");
  assert.ok(setting, "the setting is in the contract");
  assert.equal(setting.default, null, "off by default");
});

test("maxParts is inert when the parts are not written", (t) => {
  const dir = makeManyFiles(t);
  // Parts disabled: a part ceiling has nothing to constrain, so the run must neither grow the
  // budget nor warn about part sizes that are never emitted.
  const result = cli(["generate", "--max-part-bytes", "4096", "--max-parts", "3", "--skip-artifacts", "parts"], dir);
  assert.equal(result.code, 0, result.out);
  assert.equal(fs.existsSync(path.join(dir, "snapshot", "parts")), false, "no parts were written");
  assert.doesNotMatch(result.out, /maxParts 3: the part budget grew/, "and nothing claims to have grown");
  assert.equal(manifestOf(dir).config.maxParts, 3, "the setting is still recorded");
});

test("growing the budget leaves every file in a part", (t) => {
  // The failure this pins: probing re-partitions the same file records, which have already been
  // assigned and truncated by the previous probe. A run then dropped files from the layout, wrote
  // parts without them, and exited 1 saying "Snapshot generated". Uneven sizes are what made the
  // probes disagree with each other, so the fixture is uneven on purpose.
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"uneven","version":"1.0.0"}\n', "utf8");
  for (let index = 0; index < 27; index += 1) {
    const lines = 20 + ((index * 37) % 260);
    const body = Array.from({ length: lines }, (_, line) => `export const v${line} = ${line};`).join("\n");
    fs.writeFileSync(path.join(dir, "src", `f${index}.ts`), `${body}\n`, "utf8");
  }

  const generated = cli(["generate", "--max-part-bytes", "4k", "--max-parts", "3"], dir);
  assert.equal(generated.code, 0, generated.out);
  assert.match(generated.out, /Integrity:\s+passed/, "the run it reports is the run it verified");

  const manifest = manifestOf(dir);
  const partNames = new Set(manifest.parts.map((part) => part.filename));
  for (const file of manifest.files) {
    assert.ok(file.part && partNames.has(file.part), `${file.relativePath} is in a part that exists`);
  }
  const declared = manifest.parts.reduce((total, part) => total + part.fileCount, 0);
  assert.equal(declared, manifest.files.length, "the parts account for every file exactly once");
  assert.equal(manifest.validation.status, "passed");
  assert.equal(cli(["validate", "--max-part-bytes", "4k", "--max-parts", "3"], dir).code, 0);
});
