import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { DEFAULT_SECRET_PATTERNS, scanAndRedactSecrets } from "../dist/index.js";

/**
 * Redaction that corrupted the text it was protecting, from the 0.9.12 audit.
 *
 * Every case here was found *inside this repository's own snapshot*: the tool rewrote its own
 * documentation and its own tests into sentences that no longer meant what they said. That is the
 * worse half of redaction's failure surface — a missed secret leaks, but an over-eager mask
 * changes the meaning of code a model is about to reason from, and it does so silently.
 */

const scan = (content) => scanAndRedactSecrets(content, DEFAULT_SECRET_PATTERNS, "fixture.ts");

const assertUntouched = (content, label) => {
  const { redacted, findings } = scan(content);
  assert.equal(redacted, content, `${label}: the line must survive verbatim`);
  assert.equal(findings.length, 0, `${label}: no finding may be reported`);
};

test("prose that happens to contain `secret: ` keeps its words", () => {
  // docs/configuration.md:271, exactly as it reached part-001.md with the `a` masked.
  assertUntouched(
    "Redaction is **fail-closed**, so a placeholder is indistinguishable from a secret: a",
    "documentation sentence"
  );
  assertUntouched("indistinguishable from a secret: a value", "prose, mid-line");
  assertUntouched("worse than a missed secret: the snapshot is", "prose with a longer word");
  // A test comment that named a variable after the colon.
  assertUntouched(
    "// A branch name is user input and can carry a token: x reaches the manifest",
    "source comment"
  );
});

test("a quoted template interpolation is code, not a credential", () => {
  // tests/explain-ignored-descendant.test.js, as emitted with `"${appliesTo}"` masked.
  assertUntouched(
    'assert.ok(token.length > 0, `${option.flag} appliesTo has an empty token: "${appliesTo}"`);',
    "template literal"
  );
  assertUntouched('const message = `count: "${String(value)}"`;', "wrapped expression");
});

test("a doubly-escaped quote does not end the value", () => {
  // A quoted value inside a quoted string — how every fixture that embeds JSON is written. The
  // match used to stop at the inner `\\"`, leaving `ssw0rdINVENTED` in clear and the line broken.
  const line = `'export const a1 = JSON.parse(\\'{"password": "p@\\\\"ssw0rdINVENTED"}\\');\\n'`;
  const { redacted, findings } = scan(line);
  assert.ok(findings.length > 0, "the value is still recognised as a credential");
  assert.equal(redacted.includes("ssw0rdINVENTED"), false, "no fragment of it may survive");
  assert.equal(
    redacted,
    `'export const a1 = JSON.parse(\\'{"password": "[REDACTED: potential secret-like value omitted from snapshot]"}\\');\\n'`,
    "the emitted line must still parse"
  );
});

test("a one-character bare value is not a credential", () => {
  // `secret: a` in prose and `PASSWORD=a` are the same shape; one is a sentence, the other is a
  // terrible password. A single character protects nothing, and masking it cost the sentence.
  assertUntouched("the token: a", "prose ending in a one-character word");
  assertUntouched("for (const key of ['a']) {}", "one-character string element");
  // Quoting is evidence that a value was meant, so the quoted rule keeps its one-character floor.
  const quoted = scan('password: "h"');
  assert.ok(quoted.findings.length > 0, "a quoted one-character value is still masked");
});

test("real credentials in the shapes the prose guard could have broken", () => {
  const cases = [
    "dbPassword: hunter2",
    "dbPassword: hunter2  # rotate",
    'dbPassword: "hunter2"',
    "POSTGRES_PASSWORD=hunter2",
    "      POSTGRES_PASSWORD: hunter2hunter2",
    '{"apiKey": "abcdefgh12345678"}',
    "awsSecret: hunter2hunter2",
    "DB_PASSWORD=abc123 node app.js",
  ];
  for (const line of cases) {
    const { redacted, findings } = scan(line);
    assert.ok(findings.length > 0, `a finding is expected for: ${line}`);
    assert.equal(/hunter2|abcdefgh|abc123/.test(redacted), false, `the value leaked: ${line}`);
  }
});

test("no documentation line in this repository is rewritten by redaction", () => {
  const offenders = [];
  for (const file of fs.readdirSync("docs")) {
    if (!file.endsWith(".md")) continue;
    const full = path.join("docs", file);
    for (const line of fs.readFileSync(full, "utf8").split("\n")) {
      if (!/\b(?:secret|token|password|credential)\b\s*:/i.test(line)) continue;
      const { redacted } = scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, full);
      if (redacted !== line) offenders.push(`${full}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a documentation sentence is prose, not an assignment, and must survive untouched"
  );
});
