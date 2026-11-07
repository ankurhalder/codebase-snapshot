import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  DEFAULT_SECRET_PATTERNS,
  generateSarifReport,
  generateSnapshot,
  resolveConfig,
} from "../dist/index.js";

/**
 * SARIF export, from the 0.9.9 audit.
 *
 * `reports/audit.md` tells a human what was masked, and nothing could *gate* on it: a CI job
 * that wanted to fail a build over a leaked key had to scrape markdown. SARIF is what GitHub
 * Code Scanning reads, so the same findings go straight into an alert.
 *
 * The property that matters most is a negative one: this artefact is uploaded to a third
 * party, so it must never contain the value it is reporting on. A path and a line number are
 * enough to act on; a second copy of the secret in someone else's retention policy is not.
 */

const manifestStub = { fingerprint: "a".repeat(64) };

test("the document is SARIF 2.1.0 with one result per finding", () => {
  const findings = [
    { path: "src/a.ts", line: 3, rules: ["credential-assignment"] },
    { path: "src/b.ts", line: 1, rules: ["aws-access-key-id"] },
  ];
  const log = JSON.parse(
    generateSarifReport(manifestStub, findings, DEFAULT_SECRET_PATTERNS, "9.9.9")
  );

  assert.equal(log.version, "2.1.0");
  assert.equal(log.$schema, "https://json.schemastore.org/sarif-2.1.0.json");
  assert.equal(log.runs.length, 1);

  const run = log.runs[0];
  assert.equal(run.tool.driver.name, "codebase-snapshot");
  assert.equal(run.tool.driver.version, "9.9.9");
  assert.equal(run.results.length, 2);
  assert.equal(run.automationDetails.id, `codebase-snapshot/${manifestStub.fingerprint}`);

  const first = run.results[0];
  assert.equal(first.locations[0].physicalLocation.artifactLocation.uri, "src/a.ts");
  assert.equal(first.locations[0].physicalLocation.region.startLine, 3);
  assert.equal(first.level, "note", "a redaction is the tool doing its job, not a failure");
  // The rule id in the result must resolve in the rule catalogue.
  assert.equal(run.tool.driver.rules[first.ruleIndex].id, first.ruleId);
  assert.equal(run.tool.driver.rules[first.ruleIndex].name, "credential-assignment");
});

test("the reported value never appears in the artefact", () => {
  const secret = "hunter2hunter2";
  const log = generateSarifReport(
    manifestStub,
    [{ path: "src/a.ts", line: 1, rules: ["credential-assignment"] }],
    DEFAULT_SECRET_PATTERNS,
    "9.9.9"
  );

  assert.equal(log.includes(secret), false, "an upload must not carry the secret");
  assert.equal(log.includes("REDACTED"), false, "nor an excerpt of the masked line");
});

test("rule identifiers are stable for the same configuration", () => {
  const findings = [{ path: "a.ts", line: 1, rules: ["jwt-token"] }];
  const first = JSON.parse(generateSarifReport(manifestStub, findings, DEFAULT_SECRET_PATTERNS, "1"));
  const second = JSON.parse(generateSarifReport(manifestStub, findings, DEFAULT_SECRET_PATTERNS, "1"));

  assert.deepEqual(
    first.runs[0].tool.driver.rules.map((rule) => [rule.id, rule.name]),
    second.runs[0].tool.driver.rules.map((rule) => [rule.id, rule.name]),
    "an id that moved between runs would orphan every open alert"
  );
});

test("--sarif writes the artefact and records it in the manifest", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sarif-"));
  const write = (relative, content) => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
  write("package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write("src/a.ts", 'const apiKey = "abcdefgh12345678";\nexport const a = 1;\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const manifest = generateSnapshot(
    resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", sarif: true })
  );

  const sarifPath = path.join(dir, "snapshot", "reports", "audit.sarif");
  assert.ok(fs.existsSync(sarifPath), "the file is written beside audit.md");
  const log = JSON.parse(fs.readFileSync(sarifPath, "utf8"));
  assert.ok(log.runs[0].results.length >= 1, "the fixture's key is a finding");

  assert.ok(manifest.artifacts.sarif, "and the manifest names it");
  assert.equal(manifest.artifacts.sarif.byteSize, fs.statSync(sarifPath).size);
  assert.match(String(manifest.artifacts.sarif.sha256), /^[0-9a-f]{64}$/);
});

test("without the flag there is no artefact", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sarif-off-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, "src", "a.ts"), 'const apiKey = "abcdefgh12345678";\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const manifest = generateSnapshot(
    resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" })
  );

  assert.equal(fs.existsSync(path.join(dir, "snapshot", "reports", "audit.sarif")), false);
  assert.equal(manifest.artifacts.sarif, undefined);
});

test("it works when the markdown audit report is switched off", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sarif-noaudit-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, "src", "a.ts"), 'const apiKey = "abcdefgh12345678";\n');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  generateSnapshot(
    resolveConfig({
      cwd: dir,
      outDir: "snapshot",
      tmpDir: "snapshot.tmp",
      sarif: true,
      artifacts: { audit: false },
    })
  );

  // The gate is for CI, where nobody reads the markdown; asking for SARIF alone must work.
  assert.equal(fs.existsSync(path.join(dir, "snapshot", "reports", "audit.md")), false);
  assert.ok(fs.existsSync(path.join(dir, "snapshot", "reports", "audit.sarif")));
});
