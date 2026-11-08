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

/**
 * A mask must cover the whole value, or the rule must not fire at all.
 *
 * The unquoted literal class stopped at the first `$`, `!` or `@`, so a password with a symbol in it
 * was emitted as a redaction marker followed by the rest of the password:
 * `db_password: [REDACTED]$$w0rdSecr3t`, `api_token: [REDACTED]!en$value`. That is worse than
 * no mask — the artefact looks redacted and is not. The cases below assert the ENTIRE value is
 * absent; the last group asserts the other half of the contract: when the matcher cannot bound
 * the value (a call expression, or a character that ends a token only in code) it must leave the
 * line alone rather than emit a marker implying coverage it does not have.
 */
test("a punctuation-heavy credential is masked whole, never to a prefix", () => {
  const cases = [
    ["db_password: pa$$w0rdSecr3t", "pa$$w0rdSecr3t", "fixture.yaml"],
    ["api_token: tok!en$value", "tok!en$value", "fixture.yaml"],
    ["secret: p@ssw0rd-value", "p@ssw0rd-value", "fixture.yaml"],
    ["password: s3cr3t^&*?~%", "s3cr3t^&*?~%", "fixture.yaml"],
    ["db_password: a!b@c^d&e*f?g~h$i", "a!b@c^d&e*f?g~h$i", "fixture.yaml"],
    ["client_secret: abc$def!ghi", "abc$def!ghi", "fixture.yaml"],
    ["POSTGRES_PASSWORD=hunter2!@$%^&*", "hunter2!@$%^&*", ".env"],
    ["PASSWORD=ab$cd!ef", "ab$cd!ef", ".env"],
  ];
  for (const [line, secret, filePath] of cases) {
    const { redacted, findings } = scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, filePath);
    assert.ok(findings.length > 0, "a finding is expected for: " + line);
    assert.equal(redacted.includes(secret), false, "the value must not survive in: " + line + " -> " + redacted);
    // Not just the whole string: no six-character run of the value may be left behind either.
    for (let offset = 0; offset + 6 <= secret.length; offset += 1) {
      const fragment = secret.slice(offset, offset + 6);
      assert.equal(
        redacted.includes(fragment),
        false,
        "fragment " + JSON.stringify(fragment) + " survived in " + JSON.stringify(redacted) + " for: " + line
      );
    }
  }
});

test("a value the rules cannot bound is left whole, not half-masked", () => {
  // `p(a)ssw0rd` is an expression shape, and the three metacharacters below end a token only in
  // code — masking their prefix would print a marker next to the rest of the password.
  const unquoted = ["password: p(a)ssw0rd", "password: abc|def", "password: abc<def", "password: abc>def"];
  for (const line of unquoted) {
    const { redacted } = scan(line, "fixture.yaml");
    assert.equal(redacted, line, "no marker may imply coverage for: " + line);
  }
  // A quoted value IS bounded by its quotes, so it is masked whole.
  const quoted = scan('password: "abc\\def"', "fixture.yaml").redacted;
  assert.ok(quoted.includes("[REDACTED"), "a quoted value is still masked");
});

test("a credential value is masked even when it begins with punctuation", () => {
  // A generator-made password starts with `$`, `!`, `@` or `#` as often as with a letter, and the
  // literal class began with a word character — so the whole value was emitted with no match and
  // no marker. The JSON form is asserted separately: `api_token: !en` is a YAML tag only because
  // YAML gives `!` that meaning, and the quoted JSON spelling has no such ambiguity.
  const cases = [
    ["secret: $$w0rdSecr3t", "$$w0rdSecr3t", "fixture.yaml"],
    ["api_token: !en$value", "!en$value", "fixture.yaml"],
    ["token: @dm1n!", "@dm1n!", "fixture.yaml"],
    ["api_key: #hash123", "#hash123", "fixture.yaml"],
    ["password: Sup3r!Secret#Pass", "Sup3r!Secret#Pass", "fixture.yaml"],
    ['{"api_token": "!en$value"}', "!en$value", "config.json"],
    ['{"secret": "$$w0rdSecr3t"}', "$$w0rdSecr3t", "config.json"],
    // An opener-led value is a literal in a data file; it is masked when it closes.
    ["password: (hunter2)", "(hunter2)", "app.yaml"],
    ["password: [hunter2]", "[hunter2]", "app.yaml"],
  ];
  for (const [line, secret, filePath] of cases) {
    const { redacted, findings } = scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, filePath);
    assert.ok(findings.length > 0, "a finding is expected for: " + line);
    assert.equal(redacted.includes(secret), false, "the value must not survive in: " + line + " -> " + redacted);
    for (let offset = 0; offset + 6 <= secret.length; offset += 1) {
      const fragment = secret.slice(offset, offset + 6);
      assert.equal(
        redacted.includes(fragment),
        false,
        "fragment " + JSON.stringify(fragment) + " survived in " + JSON.stringify(redacted) + " for: " + line
      );
    }
  }
});

test("punctuation that is syntax, not a value, is left alone", () => {
  // The token has to look like a credential — a digit or a second punctuation character — so the
  // YAML/CloudFormation tags and a bare operator do not become findings.
  const unchanged = (line, filePath) =>
    assert.equal(
      scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, filePath).redacted,
      line,
      "must survive verbatim: " + line
    );
  unchanged("subnet: !Ref PrivateSubnet", "template.yaml");
  unchanged("resource: !GetAtt Function.Arn", "template.yaml");
  unchanged("css: !important", "app.css");
  // In source code an opener-led value is an expression, not a literal; only a data file masks it.
  unchanged("opts.token: (value)", "app.ts");
  unchanged("opts.token: [a, b]", "app.ts");
});

test("a credential containing & is masked whole, and a URL query keeps its separators", () => {
  // The colon form is an assignment in a data file: the strong credential name is the evidence
  // that the rest of the line is a value, so the whole value is masked whatever symbols it holds.
  const cases = [
    ["password: pa&ss", "pa&ss", "app.yaml"],
    ["token: a&b&c&d", "a&b&c&d", "app.yaml"],
    ["secret: &&w0rd", "&&w0rd", "app.yaml"],
    ["password: pa&ss # rotate", "pa&ss", "app.yaml"],
    ['{"password": "pa&ss"}', "pa&ss", "config.json"],
    ['{"secret": "a&b&c&d"}', "a&b&c&d", "config.json"],
  ];
  for (const [line, secret, filePath] of cases) {
    const { redacted, findings } = scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, filePath);
    assert.ok(findings.length > 0, "a finding is expected for: " + line);
    assert.equal(redacted.includes(secret), false, "the value must not survive: " + line + " -> " + redacted);
    for (let offset = 0; offset + 4 <= secret.length; offset += 1) {
      const fragment = secret.slice(offset, offset + 4);
      assert.equal(
        redacted.includes(fragment),
        false,
        "fragment " + JSON.stringify(fragment) + " survived for: " + line + " -> " + redacted
      );
    }
  }

  // `&` is a query separator, not part of the value: the JWT is masked and the tail survives.
  const jwt = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "abc123",
  ].join(".");
  for (const filePath of ["fixture.ts", "config.yaml"]) {
    const line = 'const url = "https://api.example.com/v1?access_token=' + jwt + '&expires=3600";';
    const { redacted } = scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, filePath);
    assert.equal(redacted.includes(jwt), false, "the token must be masked (" + filePath + ")");
    assert.ok(redacted.includes("&expires=3600"), "the query tail must survive (" + filePath + "): " + redacted);
  }

  // A source file keeps its expressions: only a data or shell file may be masked this way.
  const expression = "password: getPassword() & 0xff";
  assert.equal(scanAndRedactSecrets(expression, DEFAULT_SECRET_PATTERNS, "app.ts").redacted, expression);

  // The suite fixture that caught the reverse regression: a URL query credential inside a .ts
  // source file must still be masked, and the separator after it must survive. The data-file
  // colon form and the source-file query form are the two halves of this rule — a change that
  // fixes one must not break the other.
  const query = 'const a2 = "https://api.example.test/cb?access_token=abc123XYZ%2Edef456INVENTED&scope=read";';
  const queryOut = scanAndRedactSecrets(query, DEFAULT_SECRET_PATTERNS, "src/b.ts").redacted;
  assert.ok(queryOut.includes("[REDACTED"), "a source-file query credential is masked: " + queryOut);
  assert.equal(queryOut.includes("abc123XYZ%2Edef456INVENTED"), false, "the query token must not survive");
  assert.ok(queryOut.includes("&scope=read"), "the separator and the next parameter survive: " + queryOut);
  // The same value in colon form and in a data file is one value, so it is masked whole.
  for (const colonForm of ["password: pa&ss", "secret: &&w0rd", "token: a&b&c&d"]) {
    const out = scanAndRedactSecrets(colonForm, DEFAULT_SECRET_PATTERNS, "app.yaml").redacted;
    assert.equal(out.includes(colonForm.slice(colonForm.indexOf(": ") + 2)), false, "the value must not survive: " + out);
  }
});

test("the equals form follows the file type, like the colon form", () => {
  // INI, .properties and .conf files spell credentials lowercase with `=`; the value is one
  // credential whatever symbols it contains. In source code the same line is a program and the
  // whole-value branch must not fire.
  for (const [line, value] of [
    ["password=pa&ss", "pa&ss"],
    ["token=a<b", "a<b"],
    ["client_secret=x|y", "x|y"],
    ["private_key=abc\\def", "abc\\def"],
  ]) {
    for (const filePath of ["app.ini", "app.properties", "app.conf"]) {
      const data = scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, filePath).redacted;
      assert.equal(data.includes(value), false, "${filePath}: the value must not survive: ${data}");
      assert.ok(data.includes("="), "${filePath}: the key and separator stay readable: ${data}");
    }
  }
  for (const line of ["token=a<b", "client_secret=x|y"]) {
    assert.equal(scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, "app.ts").redacted, line);
  }
});

test("the id-token permission is not a credential", () => {
  // `id-token: write` is a GitHub Actions permission declaration; the quoted JSON spelling was
  // masked and destroyed it. A real credential under the same key is still caught by the rule that
  // recognises its shape.
  for (const line of [
    '{"id-token": "write"}',
    '{"id-token":"write"}',
    '{"id-token": "read"}',
    '{"id-token": "none"}',
    "id-token: write",
    'id-token: "write"',
    "id-token: read",
  ]) {
    assert.equal(
      scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, "config.json").redacted,
      line,
      "a permission is not a secret: " + line
    );
  }
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "abc"].join(".");
  for (const [line, secret] of [
    ['{"id-token": "' + jwt + '"}', jwt],
    ['{"id-token": "ghp_' + "a".repeat(36) + '"}', "ghp_" + "a".repeat(36)],
    ['{"token": "hunter2hunter2"}', "hunter2hunter2"],
    ['{"jwttoken": "opaqueTokenValue123"}', "opaqueTokenValue123"],
    ['{"idToken": "opaqueTokenValue123"}', "opaqueTokenValue123"],
  ]) {
    const { redacted, findings } = scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, "config.json");
    assert.ok(findings.length > 0, "a real credential is still a finding: " + line);
    assert.equal(redacted.includes(secret), false, "the credential must not survive: " + line);
  }
});
