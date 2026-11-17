import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SECRET_PATTERNS, scanAndRedactSecrets } from "../dist/index.js";

/**
 * A quoted assignment whose closing quote is not on the line.
 *
 * Every quoted rule requires its delimiter, so `API_KEY="zq7Xk2nvalue` matched nothing: no mask,
 * no finding, and the run reported zero redactions. That is the shape a truncated file, a
 * hand-edited `.env` and a string continued on the next line all produce.
 *
 * The second half is the balance guard. When a mask would turn a balanced line into an unbalanced
 * one, the old code left the line untouched **and recorded nothing**; it now masks around the
 * delimiters, which cannot change the parity the guard measures.
 */

const scan = (line, filePath) => scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, filePath);

const LEAKING = [
  ['API_KEY="zq7Xk2nvalue', ".env"],
  ["API_KEY='zq7Xk2nvalue", ".env"],
  ['const API_KEY = "zq7Xk2nv', "src/a.ts"],
  ['{"password": "hunter2', "config.json"],
  ['dbPassword: "hunter2', "config.yaml"],
  ['TOKEN="ghp_abcdefghijklmnopqrstuvwxyz0123456789', "a.sh"],
];

test("an unterminated quoted credential is masked, with a finding", () => {
  for (const [line, filePath] of LEAKING) {
    const { redacted, findings } = scan(line, filePath);
    assert.equal(findings.length, 1, `no finding for ${line}`);
    assert.equal(
      findings[0].rules.includes("credential-assignment-unterminated"),
      true,
      `the rule is named: ${JSON.stringify(findings[0].rules)}`
    );
    assert.equal(redacted.includes("zq7Xk2nvalue"), false, `the value survives: ${redacted}`);
    assert.match(redacted, /\[REDACTED/, "the value is replaced with the marker");
    assert.match(redacted, /^(?:const )?(?:\{|)?\s*["']?(?:API_KEY|password|dbPassword|TOKEN)/i,
      `the key stays readable: ${redacted}`);
  }
});

test("a balanced quoted value still takes the ordinary rule", () => {
  const { redacted, findings } = scan('API_KEY="zq7Xk2nvalue"', ".env");
  assert.equal(findings.length, 1);
  assert.equal(
    findings[0].rules.includes("credential-assignment-unterminated"),
    false,
    "the unterminated rule must not match a closed literal"
  );
  assert.equal(redacted, 'API_KEY="[REDACTED: potential secret-like value omitted from snapshot]"');
});

test("a later quote of the same kind disables the unterminated rule", () => {
  const line = 'password: "abc" and "def"';
  const { redacted } = scan(line, "a.yml");
  assert.equal(
    redacted.includes('and "def"'),
    true,
    "the text after the closed literal is not swallowed by the unterminated rule"
  );
});

test("a mask that would unbalance a balanced line is narrowed, not skipped", () => {
  // A custom rule that spans a literal boundary: the match includes the opening quote and the
  // value, but not the closing quote. Masking the whole span leaves one quote and breaks the
  // line's balance.
  const rules = [{ rule: "custom-spanning", pattern: /API_KEY="[a-z0-9]+/ }];
  const line = 'API_KEY="abc123"';
  const { redacted, findings } = scanAndRedactSecrets(line, rules, ".env");

  assert.equal(findings.length, 1, "the match is reported even though the mask had to change shape");
  assert.equal(redacted.includes("abc123"), false, `the value survives: ${redacted}`);
  const quotes = (value) => (value.match(/"/g) ?? []).length;
  assert.equal(quotes(redacted), quotes(line), "every quote is still where it was");
  assert.match(redacted, /\[REDACTED/);
});
