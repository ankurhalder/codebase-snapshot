import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  DEFAULT_SECRET_PATTERNS,
  explainPath,
  generateSnapshot,
  resolveConfig,
  scanAndRedactSecrets,
} from "../dist/index.js";

// Assembled at runtime so the repository never holds a literal live-token shape:
// push protection cannot tell a detection fixture from a leak, and the scanner
// sees the same bytes either way.
const JWT = {
  full: [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ].join("."),
  shortSignature: [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "abc123",
  ].join("."),
  twoSegments: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0"].join("."),
  padded: "eyJhbGciOiJIUzI1NiJ9=.eyJzdWIiOiIxMjM0NTY3ODkwIn0=.abc123=",
  // The form a URL encoder produces when it escapes `.` — it used to walk
  // straight past the rule.
  percentSeparators: [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "abc123",
  ].join("%2E"),
};

const scan = (content) => scanAndRedactSecrets(content, DEFAULT_SECRET_PATTERNS, "fixture.ts");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-jwt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

test("every JWT shape is masked and the code around it survives", () => {
  // The variable name is deliberately not a credential name, so only the JWT rule
  // can be the reason these lines are masked.
  for (const jwt of Object.values(JWT)) {
    const line = `const v = "${jwt}";`;
    const { redacted } = scan(line);
    assert.equal(redacted.includes(jwt), false, `unmasked JWT: ${jwt.slice(0, 24)}`);
    assert.match(redacted, /^const v = "\[REDACTED: /, "the assignment must survive");
    assert.match(redacted, /";$/, "the closing quote and semicolon must survive");
  }
});

test("the JWT is attributed to the jwt-token rule", () => {
  const { findings } = scan(JWT.shortSignature);
  assert.ok(
    findings.some((finding) => finding.rule === "jwt-token"),
    `expected a jwt-token finding, got ${JSON.stringify(findings)}`
  );
});

test("a JWT inside a URL or an Authorization header is masked, the context survives", () => {
  const url = `const url = "https://api.example.com/v1?access_token=${JWT.shortSignature}&expires=3600";`;
  const redactedUrl = scan(url).redacted;
  assert.equal(redactedUrl.includes(JWT.shortSignature), false);
  assert.ok(redactedUrl.includes("https://api.example.com/v1?access_token="));
  assert.ok(redactedUrl.includes("&expires=3600"));

  const header = `const h = "Authorization: Bearer ${JWT.shortSignature}";`;
  const redactedHeader = scan(header).redacted;
  assert.equal(redactedHeader.includes(JWT.shortSignature), false);
  assert.ok(redactedHeader.includes('const h = "Authorization: Bearer '));
});

test("percent-encoded separators do not shake the rule off", () => {
  // A URL encoder that escapes `.` turns `a.b.c` into `a%2Eb%2Ec`; the token is
  // the same credential and must still be masked, with the query string intact.
  const encoded = JWT.percentSeparators;
  assert.equal(encoded.includes("."), false, "the fixture must really be percent-encoded");
  const url = `const url = "https://api.example.com/v1?access_token=${encoded}&expires=3600";`;
  const { redacted, findings } = scan(url);
  assert.equal(redacted.includes(encoded), false, "the percent-encoded JWT must not survive");
  assert.ok(redacted.includes("https://api.example.com/v1?access_token="));
  assert.ok(redacted.includes("&expires=3600"));
  assert.ok(findings.some((finding) => finding.rule === "jwt-token"));
});

test("source that merely looks like a JWT is left alone", () => {
  const untouched = [
    'const header = "eyJhbGciOiJIUzI1NiJ9";',
    'const short = "eyJhbGciOi";',
    'const prose = "The eyJhbGciOiJIUzI1NiJ9 header appears alone in this sentence.";',
    'const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ=";',
    'const commit = "da39a3ee5e6b4b0d3255bfef95601890afd80709";',
    'const half = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIi";',
  ];
  for (const line of untouched) {
    assert.equal(scan(line).redacted, line, `over-redacted: ${line}`);
  }
});

test("a JWT never reaches the part, the manifest or the audit", (t) => {
  const dir = tempDir(t);
  write(dir, "src/creds.ts", `export const g = "${JWT.shortSignature}";\n`);
  write(dir, "README.md", "# fixture\n");
  const manifest = generateSnapshot({ cwd: dir });
  const artifacts = {
    part: fs.readFileSync(path.join(dir, "snapshot", "parts", manifest.parts[0].filename), "utf8"),
    manifest: fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"),
    audit: fs.readFileSync(path.join(dir, "snapshot", "reports", "audit.md"), "utf8"),
  };
  for (const [label, text] of Object.entries(artifacts)) {
    assert.equal(text.includes(JWT.shortSignature), false, `${label} contains the JWT`);
    for (let i = 0; i + 8 <= JWT.shortSignature.length; i += 8) {
      const fragment = JWT.shortSignature.slice(i, i + 8);
      assert.equal(text.includes(fragment), false, `${label} contains the fragment ${fragment}`);
    }
  }
  assert.ok(artifacts.part.includes("[REDACTED"), "the part must carry the redaction marker");
});

test("explain reports the JWT finding without printing the token", (t) => {
  const dir = tempDir(t);
  write(dir, "src/creds.ts", `export const g = "${JWT.shortSignature}";\n`);
  const explained = explainPath(resolveConfig({ cwd: dir }), "src/creds.ts");
  assert.ok(explained.secretCount > 0, "explain must see a secret");
  assert.ok(
    explained.secrets.some((secret) => secret.rule === "jwt-token"),
    `expected a jwt-token finding, got ${JSON.stringify(explained.secrets)}`
  );
  assert.equal(JSON.stringify(explained).includes(JWT.shortSignature), false);
});

test("the JWT rule is not stateful", () => {
  const rule = DEFAULT_SECRET_PATTERNS.find((entry) => entry.rule === "jwt-token");
  assert.ok(rule, "the jwt-token rule must exist");
  assert.equal(/[gy]/.test(rule.pattern.flags), false, "the jwt-token rule must not be stateful");

  const line = `a = "${JWT.shortSignature}"; b = "${JWT.shortSignature}";`;
  const first = scan(line).redacted;
  assert.equal(scan(line).redacted, first, "a second scan must produce the same bytes");
  assert.equal(first.split("[REDACTED").length - 1, 2, "both occurrences on a line are masked");
});

test("the JWT rule is not quadratic on an eyJ-dense line", () => {
  const line = "eyJ".repeat(20_000);
  const started = performance.now();
  scan(line);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `JWT scan took ${elapsed.toFixed(0)}ms on a 60KB eyJ-dense line`);
});
