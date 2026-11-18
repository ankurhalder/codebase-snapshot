/**
 * Redaction is idempotent: the marker is not a secret.
 *
 * `scanAndRedactSecrets` runs on source at generation and on the emitted artifacts at audit time.
 * A repository that quotes a snapshot — this one's docs describe redaction verbatim — contains the
 * marker literally, and a second scan found `token: [REDACTED: …]` to be a credential assignment.
 * The audit then failed a snapshot it had just redacted, 7 artifacts at 70/100, and the drift test
 * had no case for "the output of the scanner fed back into the scanner". These do.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SECRET_PATTERNS, scanAndRedactSecrets } from "../dist/index.js";

const MARKER = "[REDACTED: potential secret-like value omitted from snapshot]";

const scan = (text, path = "example.ts") => scanAndRedactSecrets(text, DEFAULT_SECRET_PATTERNS, path);

test("a line that is already the marker produces no finding", () => {
  for (const line of [
    "token: " + MARKER,
    "const TOKEN = `" + MARKER + "`;",
    "assert.equal(value, \"" + MARKER + "\");",
  ]) {
    const result = scan(line);
    assert.deepEqual(result.findings, [], line, );
    assert.equal(result.redacted, line, "and the line is left alone");
  }
});

test("a block whose value lines are markers produces no finding", () => {
  const text = ["secret:", "  " + MARKER, "  " + MARKER, ""].join("\n");
  const result = scan(text, ".gitguardian.yaml");
  assert.deepEqual(result.findings, []);
  assert.equal(result.redacted, text);
});

test("a real secret in the same shapes is still a finding", () => {
  // Unquoted values in a source file are expressions, so the control lives in a config file —
  // the shape .gitguardian.yaml actually has.
  assert.equal(scan("token: hunter2hunter2hunter2", "example.yaml").findings.length, 1);
  const block = scan(["secret:", "  hunter2hunter2hunter2", ""].join("\n"), ".gitguardian.yaml");
  assert.equal(block.findings.length, 1);
  assert.match(block.redacted, /REDACTED/);
});
