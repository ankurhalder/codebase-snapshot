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
