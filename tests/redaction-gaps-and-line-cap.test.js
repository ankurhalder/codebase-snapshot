import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { DEFAULT_SECRET_PATTERNS, scanAndRedactSecrets } from "../dist/index.js";
import { MAX_LINE_BYTES, createLineReader } from "../dist/mcp.js";

/**
 * 0.9.14 — four gaps, all of them fail-open.
 *
 * 2.1 — every unquoted `${VAR:-fallback}` was emitted in clear text. The value starts with `$`,
 * and every unquoted rule refuses a value that does not start with a word character: `.env`,
 * docker-compose, GitHub Actions and shell scripts are exactly where that idiom lives.
 * 2.2 — `readonly` and `declare` were treated as JavaScript declaration keywords everywhere, so
 * `readonly api_key=hunter2` in a `.envrc` was read as a declaration and its literal was left
 * alone. `declare` cannot even introduce an initialised binding in JS/TS (`declare const` can, and
 * the word before the name there is `const`).
 * 2.3 — a match that began inside a string literal was rejected outright, so
 * `"password=secret"` — a DSN, a query string, a `curl -d` body — was invisible.
 * 2.4 — the MCP line reader checked `MAX_LINE_BYTES` on the buffer it had just appended to, not on
 * the tail left after a discarded line, and measured UTF-16 code units rather than UTF-8 bytes.
 */

const scan = (content, filePath) =>
  scanAndRedactSecrets(content, DEFAULT_SECRET_PATTERNS, filePath ?? "fixture.txt");

const assertMasked = (content, secret, filePath, label) => {
  const { redacted } = scan(content, filePath);
  assert.equal(
    redacted.includes(secret),
    false,
    `${label ?? "the value"} must not survive: ${JSON.stringify(redacted)}`
  );
};

const assertUntouched = (content, filePath, label) => {
  const { redacted } = scan(content, filePath);
  assert.equal(redacted, content, `${label} must survive untouched`);
};

// ---------------------------------------------------------------------------
// 2.1 — unquoted parameter expansion with a default
// ---------------------------------------------------------------------------

test("an unquoted shell or compose default-value interpolation is masked", () => {
  assertMasked(
    "POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-MyProdPassword123!}",
    "MyProdPassword123!",
    ".env",
    "the fallback in a .env"
  );
  assertMasked(
    "    POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-MyProdPassword123!}",
    "MyProdPassword123!",
    "docker-compose.yml",
    "the fallback in compose"
  );
  assertMasked(
    "export DB_PASSWORD=${DB_PASSWORD:=S3cretFallbackValue}",
    "S3cretFallbackValue",
    "deploy.sh",
    "the := form"
  );
  assertMasked(
    "env:\n  API_TOKEN: ${API_TOKEN:?A token is required}",
    "A token is required",
    "workflow.yml",
    "the :? form"
  );
});

test("a parameter expansion that is not a credential keeps its default", () => {
  assertUntouched("PORT=${PORT:-3000}", "docker-compose.yml", "a port default");
  assertUntouched(
    "SERVICE_URL=${SERVICE_URL:-http://localhost:8080}",
    "docker-compose.yml",
    "a URL default"
  );
  assertUntouched("timeout: ${TIMEOUT:-30}", "app.yml", "a non-credential name");
});

// ---------------------------------------------------------------------------
// 2.2 — shell declarations are not JavaScript declarations
// ---------------------------------------------------------------------------

test("readonly and declare assignments in a shell file are masked", () => {
  assertMasked(
    "readonly api_key=hunter2_live_secret",
    "hunter2_live_secret",
    ".envrc",
    "a readonly shell assignment"
  );
  assertMasked(
    "declare api_key=hunter2_live_secret",
    "hunter2_live_secret",
    "bootstrap.sh",
    "a declare shell assignment"
  );
  assertMasked(
    "declare -x AUTH_TOKEN=abcdef123456",
    "abcdef123456",
    ".zshrc",
    "declare -x"
  );
});

test("a readonly class field in a source file is still a declaration", () => {
  // The same word, the opposite meaning: `private readonly apiKey = someValue` initialises a field
  // with an expression, and masking the expression edits the program.
  assertUntouched(
    "  private readonly apiKey = someValue;",
    "service.ts",
    "a readonly class field"
  );
  assertUntouched("const apiKey = someValue;", "service.ts", "a module constant");
});

// ---------------------------------------------------------------------------
// 2.3 — a credential at the start of a string literal
// ---------------------------------------------------------------------------

test("a credential assignment inside a string literal is masked", () => {
  assertMasked(
    'const dsn = "password=MySuperSecretPassword123;host=db.internal";',
    "MySuperSecretPassword123",
    "db.ts",
    "a DSN"
  );
  assertMasked(
    'curl -d "password=MySuperSecretPassword123" https://api.example.com',
    "MySuperSecretPassword123",
    "deploy.sh",
    "a curl body"
  );
  assertMasked(
    "const q = 'api_secret=MySuperSecretKey123456';",
    "MySuperSecretKey123456",
    "client.ts",
    "a single-quoted query string"
  );
});

test("a list of credential key names still survives", () => {
  // The shape NOT_AFTER_QUOTE was added for: a quoted key name whose separator is inside the
  // literal. It is protected by the *value* now starting a word character, not by the quote.
  assertUntouched(
    'for (const key of ["awsSecret:", "apiKey:", "dbPassword:", "token:", "normal:"]) {',
    "names.ts",
    "a key-name list"
  );
  assertUntouched("const names = ['password:', 'secret:'];", "names.ts", "a single-quoted list");
});

// ---------------------------------------------------------------------------
// 2.4 — the MCP line reader's byte cap
// ---------------------------------------------------------------------------

/** Collects what a reader delivers, so a test can assert on the payload rather than on timing. */
function readChunks(chunks) {
  const lines = [];
  const overflows = [];
  const stop = createLineReader(Readable.from(chunks), {
    onLine: (line) => lines.push(line),
    onOverflow: (bytes) => overflows.push(bytes),
  });
  return new Promise((resolve) => {
    // `Readable.from` ends on the next tick after the last chunk.
    setImmediate(() => {
      stop();
      resolve({ lines, overflows });
    });
  });
}

test("a line over the cap is never delivered, even after a discarded one", async () => {
  // The discarded line's terminator arrives in a chunk that also carries the start of the next
  // message, and that remainder was never re-checked: it sat in the buffer until the stream ended,
  // and `onEnd` handed it to `onLine` unmeasured.
  const payload = "b".repeat(MAX_LINE_BYTES * 2);
  const { lines, overflows } = await readChunks([
    "a".repeat(MAX_LINE_BYTES + 16),
    `\n${payload}`,
  ]);

  assert.equal(lines.length, 0, "neither line may be delivered");
  assert.ok(overflows.length >= 1, "the oversized line is reported");
});

test("the cap is measured in UTF-8 bytes, not UTF-16 code units", async () => {
  // Half as many characters, twice as many bytes: a client can stay under the character count and
  // still hand `JSON.parse` a payload twice the ceiling.
  const line = "\u{1F600}".repeat(MAX_LINE_BYTES / 2);
  assert.equal(line.length, MAX_LINE_BYTES, "under the cap if this were measured in code units");
  const { lines, overflows } = await readChunks([`${line}\n`]);

  assert.equal(lines.length, 0, "a line over the byte cap is not delivered");
  assert.equal(overflows.length, 1);
});

test("ordinary messages are still delivered", async () => {
  const { lines } = await readChunks([
    '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\r\n',
    "\n",
    '{"jsonrpc":"2.0","id":3,"method":"ping"}',
  ]);
  assert.deepEqual(lines, [
    '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    '{"jsonrpc":"2.0","id":3,"method":"ping"}',
  ]);
});

// ---------------------------------------------------------------------------
// 2.5 — the 1.0.0 audit's remaining miss-shapes, all proven leaks
// ---------------------------------------------------------------------------

test("URL userinfo with an empty user part is masked", () => {
  // Redis, SMTP, AMQP and FTP omit the username routinely, and every scheme-listed rule
  // required at least one character before the colon, so the password was emitted in clear.
  assertMasked("redis://:redisHunter2@redis.example.net:6379/0", "redisHunter2", "urls.yaml", "redis");
  assertMasked("  url: smtp://:commaHunter2@smtp.example.net:587", "commaHunter2", "urls.yaml", "smtp");
  assertMasked("  url: amqp://:amqpHunter2@broker.example.net:5672", "amqpHunter2", "urls.yaml", "amqp");
});

test("command-line userinfo is masked, and ordinary flags are not", () => {
  // `curl -u user:password` sends the same userinfo as a URL without a scheme; no rule saw it.
  assertMasked("curl -u admin:SuperSecretPassw0rd https://api.example.com", "SuperSecretPassw0rd", "deploy.sh", "curl -u");
  assertMasked("curl --user admin:SuperSecretPassw0rd https://api.example.com", "SuperSecretPassw0rd", "deploy.sh", "curl --user");
  assertMasked("curl --user=admin:SuperSecretPassw0rd https://api.example.com", "SuperSecretPassw0rd", "deploy.sh", "curl --user=");
  assertUntouched("grep -u root file.txt", "deploy.sh", "a flag with no credential");
  assertUntouched("docker run -u root myimage", "deploy.sh", "a user with no password");
  assertUntouched("curl --fail https://api.example.com", "deploy.sh", "a curl flag without -u");
});

test("a short Basic credential with no digit and no padding is masked", () => {
  // The base64 of `user:pass` is 12 characters with no digit and no padding, so the three
  // earlier tests all declined it and the credential reached the parts in clear.
  assertMasked("Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz", "notes.txt", "short Basic");
  // The prose the old heuristics protected stays readable.
  assertUntouched("Basic authentication is supported.", "notes.ts", "Basic prose");
  assertUntouched("Bearer authentication", "notes.ts", "Bearer prose");
});

test("vendor service tokens with a fixed shape are masked", () => {
  assertMasked(
    "Telegram bot: 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX",
    "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX",
    "README.md",
    "Telegram bot token"
  );
  assertMasked(
    "Discord: MTk4NjIyNDgzNDcxOTI1MjQ4.Cl2FMQ.ZnCjm1XVW7vRze4b7Cq4se7kKWs",
    "ZnCjm1XVW7vRze4b7Cq4se7kKWs",
    "README.md",
    "Discord bot token"
  );
  assertMasked(
    "Shopify admin: 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",
    "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",
    "README.md",
    "Shopify admin token"
  );
  // Exactly 52 alphanumerics that mix case and digits.
  const adoPat = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6";
  assert.equal(adoPat.length, 52, "the Azure DevOps fixture is exactly 52 characters");
  assertMasked("Azure DevOps PAT: " + adoPat, adoPat, "README.md", "Azure DevOps PAT");
  assertMasked(
    "# SAS: ?sv=2022-11-02&ss=b&srt=sco&sp=rwdlac&sig=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
    "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
    "main.tf",
    "Azure SAS signature"
  );
});

test("the fixed-shape rules do not mask ordinary dotted or numeric text", () => {
  assertUntouched("Telegram: hello world", "notes.md", "a bare vendor name");
  assertUntouched("const time = 12:30;", "app.ts", "a clock time");
  assertUntouched("const version = 1.2.3;", "app.ts", "a semver string");
  assertUntouched("const host = 127.0.0.1;", "app.ts", "an IPv4 address");
  assertUntouched("const pat = process.env.PAT;", "app.ts", "a reference, not a literal");
});

// ---------------------------------------------------------------------------
// 2.6 — the 0.9.15 limitation: lowercase KEY=value outside .env-style files
// ---------------------------------------------------------------------------

test("a lowercase key=value credential in a data file is masked whole", () => {
  // INI, properties and .conf files use lowercase keys, and the uppercase-only env rule plus the
  // value alphabet left `pa&ss`-style values in clear (the alphabet stops at the symbol).
  for (const filePath of ["app.ini", "app.properties", "app.conf"]) {
    assertMasked("password=pa&ss", "pa&ss", filePath, "a lowercase password");
    assertMasked("token=a<b", "a<b", filePath, "a value containing an angle bracket");
    assertMasked("client_secret=x|y", "x|y", filePath, "a value containing a pipe");
    assertMasked("private_key=abc\\def", "abc\\def", filePath, "a value containing a backslash");
    assertMasked("db_password=q&r", "q&r", filePath, "a prefixed credential key");
    assertMasked("apiKey=q&r", "q&r", filePath, "camelCase");
    assertMasked("access_key=zz&yy", "zz&yy", filePath, "access_key");
    assertMasked("password=pa&ss # rotate", "pa&ss", filePath, "a trailing comment is kept");
  }
});

test("a KEY=value credential on a shell command line is masked", () => {
  assertMasked("--token=abc&def", "abc&def", "run.sh", "a long option");
  assertMasked("export API_TOKEN=abc&def", "abc&def", "run.sh", "an exported name");
  assertMasked(
    "curl -u admin:SuperSecretPassw0rd https://api.example.com",
    "SuperSecretPassw0rd",
    "run.sh",
    "curl userinfo"
  );
});

test("keys that merely contain a credential word survive in data files", () => {
  for (const line of ["tokenCount=3", "secretary=Jane", "passwordlessEnabled=true"]) {
    assertUntouched(line, "app.ini", "a non-credential key");
    assertUntouched(line, "app.properties", "a non-credential key");
  }
});

test("the equals form is not extended to source files", () => {
  // A declared expression is a program; `token=a<b` in TypeScript has no credential meaning at
  // all, and the whole-value branch must not fire there.
  assertUntouched("const password = compute(a & b);", "app.ts", "a declared expression");
  assertUntouched("token=a<b", "app.ts", "no source rule matches this");
  assertUntouched("client_secret=x|y", "app.ts", "no source rule matches this");
});

test("a URL query keeps its parameters after the equals-form change", () => {
  // The key of a query parameter is not an assignment: the value is masked by the rules that
  // already see it, and the parameters after it survive in a source file and in a data file.
  for (const filePath of ["app.ts", "app.properties"]) {
    const line = 'url="https://api.example.test/cb?access_token=abc123&expires=3600"';
    const { redacted } = scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, filePath);
    assert.ok(redacted.includes("[REDACTED"), `${filePath}: the token is masked: ${redacted}`);
    assert.ok(redacted.includes("&expires=3600"), `${filePath}: the next parameter survives: ${redacted}`);
  }
});

// ---------------------------------------------------------------------------
// 2.7 — a credential assignment masks the whole value, symbols included
// ---------------------------------------------------------------------------

test("a credential assignment masks the whole value whatever symbols it contains", () => {
  // The red team's frozen-build fixture produced `DB_PASSWORD=[REDACTED]&*()`: the env/whole-value
  // paths stopped at a symbol and left the tail in clear. A mask must cover the value or not fire.
  const values = [
    "envpass!@#$%^&*()",
    "!@#$%^&*()<>|\\",
    "pa$$w0rd!@#",
    'env"pass!@#',
    "abc&def#ghi",
    "A!@#b$%^c&*(d)",
  ];
  const forms = [
    [".env", (value) => "DB_PASSWORD=" + value, "DB_PASSWORD"],
    [".envrc", (value) => "export API_KEY=" + value, "export API_KEY"],
    ["run.sh", (value) => "export DB_PASSWORD=" + value, "export DB_PASSWORD"],
    ["run.sh", (value) => "--token=" + value, "--token"],
  ];
  for (const [filePath, line, key] of forms) {
    for (const value of values) {
      const { redacted, findings } = scan(line(value), filePath);
      assert.ok(findings.length > 0, "a finding is expected: " + filePath + " " + line(value));
      assert.equal(redacted.includes(value), false, "the value must not survive: " + JSON.stringify(redacted));
      for (const run of value.match(/[A-Za-z0-9]{2,}/g) ?? []) {
        assert.equal(
          redacted.includes(run),
          false,
          "fragment " + JSON.stringify(run) + " survived in " + JSON.stringify(redacted)
        );
      }
      assert.ok(redacted.includes("[REDACTED"), "a marker is expected: " + JSON.stringify(redacted));
      assert.ok(redacted.includes(key.replace(/^export /, "")), "the key is kept: " + JSON.stringify(redacted));
    }
  }
  // The exact fixture: the mask must reach the end of the line, not stop at a prefix.
  const exact = scan("DB_PASSWORD=envpass!@#$%^&*()", ".env").redacted;
  assert.equal(exact.includes("envpass"), false, exact);
  assert.ok(exact.endsWith("snapshot]"), "a punctuation tail survived: " + exact);
  // A trailing comment is not part of the value.
  for (const value of values) {
    const redacted = scan("DB_PASSWORD=" + value + " # rotate", ".env").redacted;
    assert.equal(redacted.includes(value), false, "comment-case value survived: " + JSON.stringify(redacted));
    assert.ok(redacted.includes("# rotate"), "the comment must survive: " + JSON.stringify(redacted));
  }
});

test("a mask inside a data-file assignment never leaves a tail", () => {
  // The invariant, not one key: DB_PASSWORD0 / AWS_SECRET_ACCESS_KEY_2 / GITHUB_TOKEN_7 are
  // credential names with a numeric suffix, so a weaker rule matched the value prefix and the
  // marker was followed by the rest of the value. In a data or shell file any mask that lands in
  // an assignment value must run to the end of the whitespace-delimited value.
  const noTail = /\[REDACTED[^\]]*\](?:\s+#.*)?$/;
  const cases = [
    ["DB_PASSWORD0=envpass!@#$%^&*()", ".env"],
    ["AWS_SECRET_ACCESS_KEY_2=a!b#c", ".env"],
    ["GITHUB_TOKEN_7=x!y#z", ".env"],
    ["AWS_SECRET_ACCESS_KEY_2=a!b#c", "run.sh"],
    ["GITHUB_TOKEN_7=x!y#z", "run.sh"],
    ["DB_PASSWORD0=envpass!@#$%^&*() # rotate", ".env"],
    ["DB_PASSWORD=envpass!@#$%^&*()", ".env"],
    ["API_TOKEN=abc&def#ghi", ".env"],
    ["CLIENT_SECRET=Secret!Value#123", ".env"],
  ];
  for (const [line, filePath] of cases) {
    const { redacted, findings } = scan(line, filePath);
    assert.ok(findings.length > 0, "a finding is expected: " + line);
    assert.match(redacted, noTail, "a tail survived: " + line + " -> " + redacted);
    assert.ok(redacted.includes(line.slice(0, line.indexOf("=") + 1)), "the key is kept: " + redacted);
  }
  for (const filePath of [".env", ".envrc", "run.sh", ".properties", ".ini"]) {
    for (const key of [
      "DB_PASSWORD",
      "DB_PASSWORD0",
      "AWS_SECRET_ACCESS_KEY_2",
      "GITHUB_TOKEN_7",
      "API_TOKEN",
      "CLIENT_SECRET",
      "--token",
    ]) {
      for (const value of [
        "envpass!@#$%^&*()",
        "!@#$%^&*()<>|\\",
        "pa$$w0rd!@#",
        'env"pass!@#',
        "abc&def#ghi",
      ]) {
        const { redacted, findings } = scan(key + "=" + value, filePath);
        if (findings.length === 0) continue;
        assert.match(redacted, noTail, "tail after mask: " + filePath + " " + key + "=" + value + " -> " + redacted);
      }
    }
  }
  // Exemptions unchanged: a URL query keeps its parameters, and a source file is not an
  // assignment file at all.
  const propertiesUrl = scan('url="https://x.test/cb?access_token=abc&expires=3600"', "app.properties").redacted;
  assert.ok(propertiesUrl.includes("&expires=3600"), "the properties URL tail must survive: " + propertiesUrl);
  const sourceUrl = 'url="https://x.test/cb?access_token=abc&expires=3600"';
  const sourceOut = scan(sourceUrl, "src/a.ts").redacted;
  assert.ok(sourceOut.includes("&expires=3600"), "the source URL tail must survive: " + sourceOut);
  const expression = "const password = compute(a & b);";
  assert.equal(scan(expression, "src/a.ts").redacted, expression, "a source expression is not a value");
});
