import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SECRET_PATTERNS,
  isSensitivePath,
  resolveConfig,
  scanAndRedactSecrets,
} from "../dist/index.js";

/**
 * The redaction findings from the 0.9.16 audit (SEC-01 … SEC-08, SCOPE-07).
 *
 * Each case is a credential that reached `parts/*.md` in clear, or a rewrite that changed the
 * program the snapshot describes. The assertions are on the emitted text, not on the finding
 * list: a finding without a mask is the failure mode that matters.
 */

const scan = (content, filePath = "fixture.ts") =>
  scanAndRedactSecrets(content, DEFAULT_SECRET_PATTERNS, filePath);

const assertMasked = (content, secret, filePath, label) => {
  const { redacted } = scan(content, filePath);
  assert.equal(
    redacted.includes(secret),
    false,
    `${label ?? "the value"} must not survive: ${JSON.stringify(redacted)}`
  );
  assert.ok(redacted.includes("[REDACTED"), `${label ?? "the value"} must be masked: ${JSON.stringify(redacted)}`);
};

const PEM_BODY = [
  "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH0001",
  "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH0002",
  "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH0003",
];

const assertNoPemBody = (redacted, label) => {
  for (const line of PEM_BODY) {
    assert.equal(redacted.includes(line), false, `${label}: the base64 body survived`);
  }
};

test("SEC-01 a PEM block keeps the syntax around it", () => {
  // An array of quoted lines used to be welded into one string: the block was replaced by
  // one marker plus blank lines, which removed every intermediate quote and comma.
  const array = `const key = [\n  "-----BEGIN PRIVATE KEY-----",\n${PEM_BODY.map(
    (line) => `  "${line}"`
  ).join(",\n")},\n  "-----END PRIVATE KEY-----",\n].join("\\n");`;
  const arrayOut = scan(array).redacted;
  assertNoPemBody(arrayOut, "array");
  assert.doesNotThrow(() => new Function(arrayOut), "the array section must parse");
  assert.ok(arrayOut.includes(","), "the element separators survive");

  // A concatenation used to lose its `+` operators.
  const concatSource = `"-----BEGIN PRIVATE KEY-----\\n" +\n${PEM_BODY.map(
    (line) => `  "${line}\\n" +`
  ).join("\n")}\n  "-----END PRIVATE KEY-----"`;
  const concatOut = scan(`const key = ${concatSource};`).redacted;
  assertNoPemBody(concatOut, "concat");
  assert.doesNotThrow(() => new Function(concatOut), "the concatenation must parse");
  assert.equal((concatOut.match(/\+/g) ?? []).length, (concatSource.match(/\+/g) ?? []).length);

  // A CRLF block keeps CRLF.
  const crlf = `const key = [\r\n  "-----BEGIN PRIVATE KEY-----",\r\n${PEM_BODY.map(
    (line) => `  "${line}",`
  ).join("\r\n")}\r\n  "-----END PRIVATE KEY-----",\r\n];`;
  const crlfOut = scan(crlf).redacted;
  assertNoPemBody(crlfOut, "crlf");
  assert.ok(crlfOut.includes("\r\n"), "CRLF survives");
  assert.doesNotThrow(() => new Function(crlfOut), "the CRLF array must parse");
});

test("SEC-02 a credential split across a concatenation is masked without touching the operator", () => {
  // The value literal is masked; the `+` and both sets of quotes stay, so the line parses.
  const line = `const s = "export API_KEY=" + "hunter2hunter2";`;
  const { redacted, findings } = scan(line);
  assert.equal(redacted.includes("hunter2hunter2"), false, redacted);
  assert.ok(redacted.includes('" + "'), "the operator and the quotes survive: " + redacted);
  assert.doesNotThrow(() => new Function(redacted), "the emitted line must parse");
  assert.ok(findings.length > 0);

  // A variable is not a credential and the audit's example must stay byte-identical.
  const auditExample = `const t = 'export API_KEY="' + secretVar + '"';`;
  assert.equal(scan(auditExample).redacted, auditExample);
});

test("SEC-03 a quoted value containing the other quote character is masked whole", () => {
  const cases = [
    [`{"password": "hunter'2"}`, "hunter'2", "config.json"],
    [`api_key: 'abc"def'`, 'abc"def', "config.yaml"],
    [`password: "p\\"ss'w0rd"`, "ss'w0rd", "config.yaml"],
  ];
  for (const [line, secret, filePath] of cases) {
    assertMasked(line, secret, filePath, line);
  }
  // The control: the same shape without the inner quote is still masked.
  assertMasked(`{"password": "hunter2"}`, "hunter2", "config.json");
});

test("SEC-04 a YAML block scalar and a next-line value are masked", () => {
  const block = "password: |\n  hunter2hunter2hunter2\nhost: db";
  const blockOut = scan(block, "app.yaml").redacted;
  assert.equal(blockOut.includes("hunter2hunter2hunter2"), false, blockOut);
  assert.ok(blockOut.includes("password: |"), "the indicator survives");
  assert.ok(blockOut.includes("host: db"), "the next key survives");

  const folded = "secret: >-\n  hunter2hunter2\nhost: db";
  assert.equal(scan(folded, "app.yaml").redacted.includes("hunter2hunter2"), false);

  const json = '{\n  "password":\n    "hunter2hunter2"\n}';
  const jsonOut = scan(json, "config.json").redacted;
  assert.equal(jsonOut.includes("hunter2hunter2"), false, jsonOut);
  assert.doesNotThrow(() => JSON.parse(jsonOut), "the masked JSON must parse");

  // The same shape in source code is an expression, not a value.
  const source = "{\n  password:\n    compute()\n}";
  assert.equal(scan(source, "app.ts").redacted, source);
});

test("SEC-05 every authorization scheme is masked, and prose is not", () => {
  const token = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
  for (const scheme of ["Bearer", "Basic", "Token", "ApiKey", "Splunk", "AWS4-HMAC-SHA256"]) {
    assertMasked(`Authorization: ${scheme} ${token}`, token, "app.ts", scheme);
  }
  assertMasked(`authorization: Token ${token}`, token, "app.ts", "lowercase header");
  for (const prose of ["Authorization: Bearer authentication", "Authorization: Basic authentication"]) {
    assert.equal(scan(prose).redacted, prose);
  }
});

test("SEC-06 Docker's space-separated ENV form is masked, and nothing else is", () => {
  assertMasked("ENV API_KEY abc123def456ghi789", "abc123def456ghi789", "Dockerfile");
  assertMasked("ENV API_KEY=abc123def456ghi789", "abc123def456ghi789", "Dockerfile");
  const path = "ENV PATH /usr/bin";
  assert.equal(scan(path, "Dockerfile").redacted, path);
  // In a shell script `env KEY value` is a command, not an assignment.
  const shell = "env API_KEY abc123def456ghi789";
  assert.equal(scan(shell, "run.sh").redacted, shell);
});

test("SEC-07 credential files that were missing from the deny list are skipped", () => {
  for (const path of [
    "config/.pypirc",
    "auth.json",
    ".composer-auth.json",
    ".config/gcloud/application_default_credentials.json",
    ".terraform/credentials.tfrc.json",
  ]) {
    assert.equal(isSensitivePath(path), true, `${path} must be sensitive`);
  }
  // Templates of credential files are still readable.
  assert.equal(isSensitivePath("credentials.example.json"), false);
  assert.equal(isSensitivePath(".env.example"), false);
});

test("SCOPE-07 a key whose name contains a template word is still a key", () => {
  assert.equal(isSensitivePath("id_rsa.example.pem"), true);
  assert.equal(isSensitivePath("certs/server.sample.key"), true);
  assert.equal(isSensitivePath("credentials.example.json"), false);
});

test("SEC-08 a rule that can match the empty string is rejected with its name", () => {
  for (const pattern of [/(?:)/gu, /x*/, "a?"]) {
    assert.throws(
      () =>
        resolveConfig(
          { cwd: process.cwd(), secrets: { customPatterns: [pattern] } },
          {},
          process.cwd()
        ),
      /can match the empty string/,
      `${String(pattern)} must be refused`
    );
  }
  assert.doesNotThrow(() =>
    resolveConfig(
      { cwd: process.cwd(), secrets: { customPatterns: [/corp-[A-Z0-9]{8}/] } },
      {},
      process.cwd()
    )
  );
});
