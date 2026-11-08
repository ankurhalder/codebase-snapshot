import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SECRET_PATTERNS, scanAndRedactSecrets } from "../dist/index.js";

/**
 * Quoted JSON/YAML keys whose name ends in a credential word.
 *
 * The 0.9.x rule matched a credential name as a *tail* of a bare key (`dbPassword:`) but its
 * quoted-key alternative required the whole quoted string to be the credential word, so only
 * `"password"` matched. The spelling every JSON config uses — `"dbPassword"`, `"discordToken"`,
 * `"awsSecret"`, `"sessionKey"` — reached `parts/*.md` with the value in clear, while the same
 * field spelled without quotes was masked. These fixtures are the 1.0.0 audit's proof.
 */

const scan = (content, filePath = "config.json") =>
  scanAndRedactSecrets(content, DEFAULT_SECRET_PATTERNS, filePath);

const assertMaskedKeepingKey = (line, secret, key, filePath) => {
  const { redacted, findings } = scan(line, filePath);
  assert.ok(findings.length > 0, "${JSON.stringify(line)}: a finding is expected");
  assert.equal(
    redacted.includes(secret),
    false,
    "${JSON.stringify(line)}: the value must not survive: ${JSON.stringify(redacted)}"
  );
  assert.ok(
    redacted.includes(key),
    "${JSON.stringify(line)}: the key is readable context and must be kept"
  );
};

const assertUntouched = (line, filePath = "config.json") => {
  const { redacted } = scan(line, filePath);
  assert.equal(redacted, line, "${JSON.stringify(line)} must survive verbatim");
};

test("a quoted camelCase key with a quoted value is masked, and the key survives", () => {
  const cases = [
    ['{"dbPassword": "hunter2"}', "hunter2", '"dbPassword"'],
    ['{"discordToken": "opaqueTokenValue123"}', "opaqueTokenValue123", '"discordToken"'],
    ['{"botToken": "opaqueBotToken456789"}', "opaqueBotToken456789", '"botToken"'],
    ['{"awsSecret": "opaqueAwsSecretValue"}', "opaqueAwsSecretValue", '"awsSecret"'],
    ['{"appSecret": "opaqueAppSecretValue"}', "opaqueAppSecretValue", '"appSecret"'],
    ['{"jwtSecret": "opaqueJwtSecretValue"}', "opaqueJwtSecretValue", '"jwtSecret"'],
    ['{"sessionKey": "opaqueSessionKey12345"}', "opaqueSessionKey12345", '"sessionKey"'],
    ['{"my_api_key": "abcdef12345678"}', "abcdef12345678", '"my_api_key"'],
    ['  "clientSecret": "opaqueClientSecret76",', "opaqueClientSecret76", '"clientSecret"'],
    ['"refreshToken": "opaqueRefreshToken123",', "opaqueRefreshToken123", '"refreshToken"'],
  ];
  for (const [line, secret, key] of cases) assertMaskedKeepingKey(line, secret, key);
});

test("an indented JSON object loses every credential value and keeps its keys", () => {
  const block = [
    "{",
    '  "name": "service",',
    '  "dbPassword": "hunter2",',
    '  "discordToken": "opaqueTokenValue123",',
    '  "awsSecret": "opaqueAwsSecretValue",',
    '  "sessionKey": "opaqueSessionKey12345",',
    '  "jwtSecret": "opaqueJwtSecretValue"',
    "}",
  ].join("\n");
  const { redacted, findings } = scan(block);
  assert.ok(findings.length >= 5, "each credential line is one finding");
  for (const secret of [
    "hunter2",
    "opaqueTokenValue123",
    "opaqueAwsSecretValue",
    "opaqueSessionKey12345",
    "opaqueJwtSecretValue",
  ]) {
    assert.equal(redacted.includes(secret), false, "${secret} must not survive:\n${redacted}");
  }
  for (const key of ['"dbPassword"', '"discordToken"', '"awsSecret"', '"sessionKey"', '"jwtSecret"']) {
    assert.ok(redacted.includes(key), "${key} must stay readable:\n${redacted}");
  }
});

test("a quoted key with an unquoted YAML value is masked (the JSON/YAML split does not matter)", () => {
  assertMaskedKeepingKey('"dbPassword": hunter2hunter2', "hunter2hunter2", '"dbPassword"', "config.yaml");
  assertMaskedKeepingKey("dbPassword: hunter2hunter2", "hunter2hunter2", "dbPassword", "config.yaml");
});

test("keys that merely contain or extend a credential word are not credentials", () => {
  assertUntouched('  "maxTokens": 512,');
  assertUntouched('{"tokenType": "bearer"}');
  assertUntouched('{"passwordless": "true"}');
  assertUntouched('{"tokenizer": "cl100k_base"}');
  assertUntouched('{"secretary": "front desk"}');
  assertUntouched('  "description": "the password is stored elsewhere",');
  // Values that are numbers or references are not credentials, even under a credential key.
  assertUntouched('  { "apiKey": 1, "password": 2 },');
});

test("the key-name list and self-naming constant shapes still survive", () => {
  assertUntouched('for (const key of ["awsSecret:", "apiKey:", "dbPassword:", "token:", "normal:"]) {');
  assertUntouched("const names = ['password:', 'secret:'];");
  assertUntouched('  "access_token:",');
  assertUntouched('  progressToken: "progressToken",', "fixture.ts");
});
