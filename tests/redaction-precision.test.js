import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { DEFAULT_SECRET_PATTERNS, scanAndRedactSecrets } from "../dist/index.js";

/**
 * Redaction precision, from the 0.9.9 audit.
 *
 * The scanner had four false-positive classes that corrupted *this* repository's
 * own source inside its snapshot: comparison operators read as assignments, an
 * indented reassignment read as an env assignment, the closing quote of one string
 * pairing with the opening quote of the next, and a constant whose value spells its
 * own name. Each one rewrote a line of valid TypeScript into something that no
 * longer means what it said, which is worse than a missed secret: the snapshot is
 * the artefact a model reasons from.
 */

const scan = (content) => scanAndRedactSecrets(content, DEFAULT_SECRET_PATTERNS, "fixture.ts");

/** Asserts `content` comes back byte-identical and reports no finding. */
function assertUntouched(content, label) {
  const { redacted, findings } = scan(content);
  assert.equal(redacted, content, `${label}: the line must survive verbatim`);
  assert.equal(findings.length, 0, `${label}: no finding may be reported`);
}

test("comparison operators are not assignment separators", () => {
  const lines = [
    "const heritage = (node.heritageClauses ?? []).find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);",
    'if (token === "--") break;',
    "if (token !== expected) return false;",
    "if (apiKey === cached) reuse();",
    "if (attempts >= maxAttempts) fail();",
    "if (tokens <= 0) return;",
    "const same = secret == other;",
    'if (token >= "abc") ok();',
    "status = a <= b ? 1 : 0;",
    'const eq = pass === "yes";',
  ];
  for (const line of lines) assertUntouched(line, line);
});

test("an indented reassignment is not an env assignment", () => {
  // The exact line from src/index.ts that the 0.9.9 snapshot emitted as
  // `  key = [REDACTED](stagingRoot);`.
  const lines = [
    "  key = fs.realpathSync(stagingRoot);",
    "    key = JSON.parse(fs.readFileSync(lockPath, \"utf8\"));",
    "  token = await refreshToken(client);",
    "  secret = deriveSecret(salt);",
    "const key = computeKey(input);",
  ];
  for (const line of lines) assertUntouched(line, line);
});

test("a list of credential key names survives", () => {
  // The exact line from tests/scan-truth.test.js that was emitted as
  // `["awsSecret:"[REDACTED]"apiKey:"[REDACTED]…]`.
  const line = 'for (const key of ["awsSecret:", "apiKey:", "dbPassword:", "token:", "normal:"]) {';
  assertUntouched(line, "key-name list");

  // Single-quoted spelling, and a list split across lines.
  assertUntouched("const names = ['password:', 'secret:'];", "single-quoted list");
  assertUntouched('  "access_token:",', "trailing element");
  assertUntouched('  { "apiKey": 1, "password": 2 },', "object literal keys");
});

test("a constant whose value spells its own name survives", () => {
  // The exact line from src/mcp/protocol.ts that was emitted as
  // `progressToken: "[REDACTED…]"`.
  assertUntouched('  progressToken: "progressToken",', "MCP protocol constant");
  assertUntouched('  clientInfo: "clientInfo",', "constant, no credential word");
  assertUntouched('  headerName: "headerName",', "camelCase self-reference");
});

test("real credentials in the same shapes are still redacted", () => {
  const cases = [
    ['const dbPassword = "hunter2";', "hunter2"],
    ['{"apiKey": "abcdefgh12345678"}', "abcdefgh12345678"],
    ["POSTGRES_PASSWORD=hunter2", "hunter2"],
    ["export GITHUB_DEPLOY_TOKEN=ghp_secretvalue", "secretvalue"],
    ['  token = "hunter2hunter2";', "hunter2hunter2"],
    ["awsSecret: hunter2hunter2", "hunter2hunter2"],
  ];
  for (const [line, secret] of cases) {
    const { redacted, findings } = scan(line);
    assert.ok(findings.length > 0, `a finding is expected for: ${line}`);
    assert.equal(redacted.includes(secret), false, `the value must not survive: ${line}`);
  }
});

test("a lowercase word assigned to itself stays redacted (fail-closed)", () => {
  const { findings } = scan('password = "password"');
  assert.equal(findings.length, 1, "a weak credential is not a symbol table entry");
});

test("no comparison operator in this repository's own source is masked away", () => {
  const roots = ["src", "scripts"];
  const operators = ["===", "!==", ">=", "<=", "==", "!="];
  const countOf = (text, needle) => text.split(needle).length - 1;
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:ts|mjs|js)$/.test(entry.name)) {
        for (const line of fs.readFileSync(full, "utf8").split("\n")) {
          if (!operators.some((operator) => line.includes(operator))) continue;
          const { redacted } = scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, full);
          for (const operator of operators) {
            if (countOf(redacted, operator) < countOf(line, operator)) {
              offenders.push(`${full}: ${operator} lost from ${line.trim()}`);
            }
          }
        }
      }
    }
  };
  for (const root of roots) walk(root);

  assert.deepEqual(offenders, [], "a comparison must never be read as a credential assignment");
});
