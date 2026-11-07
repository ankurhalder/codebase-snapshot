import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SECRET_PATTERNS,
  configDigest,
  generateSarifReport,
  generateSnapshot,
  resolveConfig,
  validateSnapshot,
} from "../dist/index.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

/**
 * `--sarif` from the 0.9.10 audit: five gaps around one artifact.
 *
 * The log itself worked; what surrounded it did not. The monolith embedded a manifest written
 * before `artifacts.sarif` existed, `validate` never looked at the file at all, the config digest
 * could not tell two runs apart, the summary claimed nothing had been written, and the rule ids
 * moved when an unrelated rule was added.
 */

function makeRepo(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sarif-int-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  // A real finding, so the log has results and the rule catalogue has an entry.
  fs.writeFileSync(
    path.join(dir, ".env"),
    "API_KEY=sk_live_abcdef1234567890\n",
    "utf8"
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return { dir, options: { cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", sarif: true, ...extra } };
}

const ruleIdOf = (log, name) =>
  log.runs[0].tool.driver.rules.find((rule) => rule.name === name)?.id;

test("the manifest inside full-codebase.json also declares the SARIF file", (t) => {
  const { dir, options } = makeRepo(t, { includeMonolith: true });

  const manifest = generateSnapshot(options);
  assert.ok(manifest.artifacts.sarif, "the shipped manifest records it");

  const monolith = JSON.parse(
    fs.readFileSync(path.join(dir, "snapshot", "full-codebase.json"), "utf8")
  );
  assert.deepEqual(
    monolith.manifest.artifacts.sarif,
    manifest.artifacts.sarif,
    "two copies of one manifest must not disagree about what the run produced"
  );
});

test("validate notices a SARIF file that no longer matches its digest", (t) => {
  const { dir, options } = makeRepo(t);
  generateSnapshot(options);

  assert.equal(validateSnapshot(options).valid, true, "the snapshot is sound to begin with");

  fs.writeFileSync(path.join(dir, "snapshot", "reports", "audit.sarif"), "{}\n", "utf8");
  const result = validateSnapshot(options);

  assert.equal(result.valid, false, "a third-party security report must be verified");
  assert.ok(
    result.drift.partIssues.some((issue) => issue.part === "reports/audit.sarif"),
    JSON.stringify(result.drift.partIssues)
  );
});

test("validate notices a missing SARIF file", (t) => {
  const { dir, options } = makeRepo(t);
  generateSnapshot(options);
  fs.rmSync(path.join(dir, "snapshot", "reports", "audit.sarif"));

  const result = validateSnapshot(options);
  assert.equal(result.valid, false);
  assert.ok(
    result.drift.partIssues.some(
      (issue) => issue.part === "reports/audit.sarif" && /missing/.test(issue.issue)
    )
  );
});

test("--sarif is part of the configuration digest", () => {
  const base = { cwd: process.cwd(), outDir: "snapshot", tmpDir: "snapshot.tmp" };
  const without = resolveConfig(base);
  const with_ = resolveConfig({ ...base, sarif: true });

  assert.notEqual(
    configDigest(without),
    configDigest(with_),
    "the two runs write different directories, so they are different snapshots"
  );
});

test("a run that writes only the SARIF does not claim to have written nothing", (t) => {
  const { dir } = makeRepo(t);
  // The CLI summary had its own copy of the claim, and it was the one a reader actually sees.
  const result = spawnSync(
    process.execPath,
    [
      BIN,
      "generate",
      "--sarif",
      "--skip-artifacts",
      "readme,manifest,parts,navigation,projectTree,audit",
      "--cwd",
      dir,
    ],
    { cwd: dir, encoding: "utf8", timeout: 60_000 }
  );

  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(
    output,
    /all disabled/i,
    `the summary must not contradict the directory:\n${output}`
  );
  assert.ok(
    fs.existsSync(path.join(dir, "snapshot", "reports", "audit.sarif")),
    "and the file it was denying really is there"
  );
  assert.match(output, /audit\.sarif/, "the summary names what it wrote");
});

test("the same rule keeps its id when a custom rule is added", () => {
  const finding = { rules: ["credential-assignment"], line: 3, path: "src/a.ts" };
  const stub = { fingerprint: "fingerprint" };

  const before = JSON.parse(
    generateSarifReport(stub, [finding], DEFAULT_SECRET_PATTERNS, "0.0.0")
  );
  // Sorts before every built-in name, which is what shifted the whole numbering scheme.
  const custom = { rule: "acme-key", pattern: /ACME-[A-Z0-9]{8}/ };
  const after = JSON.parse(
    generateSarifReport(stub, [finding], [...DEFAULT_SECRET_PATTERNS, custom], "0.0.0")
  );

  assert.equal(
    ruleIdOf(after, "credential-assignment"),
    ruleIdOf(before, "credential-assignment"),
    "an added rule must not re-point existing alerts at another rule"
  );
  assert.ok(
    ruleIdOf(after, "acme-key"),
    "and the custom rule gets an id of its own"
  );
});

test("a custom rule's id is derived from its name, not its position", () => {
  const stub = { fingerprint: "fingerprint" };
  const finding = { rules: ["acme-key"], line: 1, path: "a.ts" };
  const custom = { rule: "acme-key", pattern: /ACME-[A-Z0-9]{8}/ };

  const alone = JSON.parse(generateSarifReport(stub, [finding], [custom], "0.0.0"));
  const crowded = JSON.parse(
    generateSarifReport(stub, [finding], [...DEFAULT_SECRET_PATTERNS, custom], "0.0.0")
  );

  assert.equal(ruleIdOf(alone, "acme-key"), ruleIdOf(crowded, "acme-key"));
});

test("built-in rule ids are three digits and custom ids are eight hex digits", () => {
  const log = JSON.parse(
    generateSarifReport(
      { fingerprint: "f" },
      [{ rules: ["credential-assignment"], line: 1, path: "a.ts" }],
      [...DEFAULT_SECRET_PATTERNS, { rule: "acme-key", pattern: /ACME-[A-Z0-9]{8}/ }],
      "0.0.0"
    )
  );
  const ids = log.runs[0].tool.driver.rules.map((rule) => rule.id);

  for (const id of ids) {
    assert.match(id, /^CS(?:[0-9]{3}|[0-9A-F]{8})$/, `${id} is not a stable-shaped id`);
  }
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
});
