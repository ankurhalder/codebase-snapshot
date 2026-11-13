/**
 * How redaction and warnings are *reported*, which is where 4.1.1 went wrong.
 *
 * Four defects reached a real repository, and the suite was blind to all four because it
 * asserted the mechanism (a value was masked) and never the report (what a human reads):
 *
 *   1. One line matching two rules produced two findings, so an unquoted `AUTH_TOKEN=` line
 *      counted twice and `reports/audit.md` printed the same file:line on two rows.
 *   2. Every finding was also appended to `manifest.warnings`, so a clean repository reported
 *      `Warnings: 156` — a number that reads as 156 problems.
 *   3. The summary printed `warnings.slice(0, 10)` with no hint that 146 rows existed elsewhere.
 *   4. `reports/audit.md` and the snapshot `README.md` formatted counts with `toLocaleString()`
 *      and no locale, so the same repository produced `1,24,976` on an `en-IN` machine and
 *      `124,976` on an `en-US` one — different artifact bytes from the same commit.
 *
 * These tests drive the real CLI, so they see exactly what the user sees.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function makeRepo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redaction-reporting-"));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(dir, args = []) {
  const result = spawnSync(process.execPath, [BIN, "generate", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

const readManifest = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
const readAudit = (dir) =>
  fs.readFileSync(path.join(dir, "snapshot", "reports", "audit.md"), "utf8");

/** Two unquoted assignments; each line matches both credential rules. */
const TWO_RULE_LINES = "JWT_SECRET=replace-with-base64url-48-bytes\nAPI_TOKEN=abc123\n";

test("one line that matches two rules is one finding, not two", (t) => {
  const dir = makeRepo(t, { "package.json": '{"name":"fixture"}', ".env.example": TWO_RULE_LINES });

  const result = run(dir);
  assert.equal(result.status, 0, result.output);

  const manifest = readManifest(dir);
  assert.equal(
    manifest.totals.redactedLines,
    2,
    "two lines were masked, so the count is two — it was four when each (line, rule) pair counted"
  );

  const audit = readAudit(dir);
  const rows = audit.split("\n").filter((line) => line.startsWith("| `.env.example` |"));
  assert.equal(rows.length, 2, `one row per line, got: ${JSON.stringify(rows)}`);
  for (const row of rows) {
    assert.match(row, /credential-assignment-unquoted/, "the row names the rule that matched");
    assert.match(row, /env-secret-assignment/, "and the other one too");
  }
  assert.match(audit, /2 line\(s\) contain values that were redacted/);
});

test("a redaction is not a warning, and the summary says where the detail is", (t) => {
  const dir = makeRepo(t, { "package.json": '{"name":"fixture"}', ".env.example": TWO_RULE_LINES });

  const result = run(dir);
  const manifest = readManifest(dir);

  assert.equal(manifest.totals.warningCount, 0, "a masked value is the tool working, not a problem");
  assert.deepEqual(manifest.warnings, []);
  assert.equal(
    manifest.warnings.some((warning) => /credential-assignment|env-secret-assignment/.test(warning)),
    false,
    "redaction rows must not be folded into the warning list"
  );

  assert.match(result.output, /Redacted:\s+2 line\(s\)/, "the summary reports the count");
  assert.match(result.output, /reports[\\/]audit\.md/, "and points at the detail");
});

test("with the audit artifact disabled, the count is not lost silently", (t) => {
  const dir = makeRepo(t, { "package.json": '{"name":"fixture"}', ".env.example": TWO_RULE_LINES });

  const result = run(dir, ["--skip-artifacts", "audit"]);
  assert.equal(result.status, 0, result.output);

  const manifest = readManifest(dir);
  assert.equal(manifest.totals.redactedLines, 2, "the count survives");
  assert.ok(
    manifest.warnings.some((warning) => /reports\/audit\.md is disabled/.test(warning)),
    `the manifest must say the per-line detail was not written: ${JSON.stringify(manifest.warnings)}`
  );
  assert.match(result.output, /audit\.md is disabled/);
});

test("warnings beyond the tenth are not silently dropped", (t) => {
  const files = { "package.json": '{"name":"fixture"}' };
  // A parse error is one warning per file, so twelve broken files exceed the ten-row preview.
  for (let index = 0; index < 12; index += 1) {
    files[`src/broken-${index}.ts`] = "export const = ;\n";
  }
  const dir = makeRepo(t, files);

  const result = run(dir);
  const manifest = readManifest(dir);
  const total = manifest.warnings.length;

  assert.ok(total > 10, `the fixture must produce more than ten warnings, got ${total}`);
  assert.match(result.output, new RegExp(`Warnings:\\s+${total}`), "the count is stated");
  assert.ok(
    result.output.includes(`… and ${total - 10} more in manifest.warnings[]`),
    `the summary must say where the rest are: ${result.output}`
  );
});

test("artifact counts do not depend on the machine's locale", (t) => {
  // Five digits, where en-US groups `100,000` and en-IN groups `1,00,000`. The artifact must
  // read the same on both, or the same commit produces different snapshot bytes per machine.
  const body = `${"x\n".repeat(100000)}`;
  const dir = makeRepo(t, { "package.json": '{"name":"fixture"}', "big.txt": body });

  const result = run(dir);
  assert.equal(result.status, 0, result.output);

  const audit = readAudit(dir);
  assert.match(
    audit,
    /\*\*Source Lines:\*\* \d{3},\d{3}/,
    "counts use three-digit grouping regardless of the host locale"
  );
  assert.equal(audit.includes("1,00,"), false, "no en-IN grouping may leak into the artifact");

  const readme = fs.readFileSync(path.join(dir, "snapshot", "README.md"), "utf8");
  assert.equal(readme.includes("1,00,"), false, "the snapshot README is locale-independent too");
});
