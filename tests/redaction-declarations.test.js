import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

import { DEFAULT_SECRET_PATTERNS, scanAndRedactSecrets } from "../dist/index.js";

/**
 * The redactor must not edit the program it is documenting.
 *
 * `credential-assignment-unquoted` exists for `.env`, YAML and compose files, where everything
 * after `NAME=` is a literal. In a source file the same shape is an **expression**, and the
 * `valueGroup` it captured could begin with `/` — so `const SINGLE_TOKEN = /[^\sA-Za-z0-9_]/g;`
 * was emitted by this tool as
 * `const SINGLE_TOKEN = [REDACTED: …][^\sA-Za-z0-9_]/g;`
 * — the pattern deleted and the line no longer parseable. That is data loss, not over-redaction,
 * and it was visible in the package's own snapshot at part-005.
 */

const scan = (line) => scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, "probe.ts").redacted;

const untouched = (line, why) => {
  assert.equal(scan(line), line, why);
};

const redacted = (line, why) => {
  assert.match(scan(line), /\[REDACTED/, why);
};

test("a regex literal assigned to a *_TOKEN constant survives", () => {
  untouched("const SINGLE_TOKEN = /[^\\sA-Za-z0-9_]/g;", "the observed corruption");
  untouched("const LINE_BREAK_RUN = /\\n+/g;", "the neighbouring declaration");
  untouched("const ACCESS_KEY = /^[A-Z0-9]+$/;", "a KEY name with a regex value");
  untouched("const SECRET_PASSWORD = /^.{8,}$/;", "a PASSWORD name with a regex value");
});

test("a class field initialised with a regex literal survives", () => {
  untouched("  private readonly apiKey = /^k-/;", "a declaration inside a class body");
  untouched("  static SECRET = /x/;", "a static field");
});

test("a bareword or index expression assigned to a credential-looking name survives", () => {
  untouched("const accessToken = tokens[0];", "an index expression, not a credential");
  untouched("const apiKey = someVariable;", "a reference");
  untouched("let password = computePassword();", "a call");
  untouched("const secretKey = config.secretKey;", "a member expression");
});

test("this repository's own tokenize.ts is not rewritten by its own redactor", () => {
  const source = fs.readFileSync(new URL("../src/tokenize.ts", import.meta.url), "utf8");
  const { redacted: output } = scanAndRedactSecrets(
    source,
    DEFAULT_SECRET_PATTERNS,
    "src/tokenize.ts"
  );
  assert.ok(
    output.includes("const SINGLE_TOKEN = /[^\\sA-Za-z0-9_]/g;"),
    "the line that the 0.9.10 snapshot corrupted"
  );
  assert.ok(
    output.includes("const WORD_RUN = /[A-Za-z0-9_]+/g;"),
    "every regex literal in the file, not just the one that was reported"
  );
});

test("real credentials in data files are still masked", () => {
  redacted("API_KEY=sk_live_abcdef1234567890", "an unquoted .env assignment");
  redacted("POSTGRES_PASSWORD: hunter2", "an unquoted YAML assignment");
  redacted("dbPassword: 'correct horse battery'", "a quoted YAML assignment");
  redacted('const API_KEY = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";', "a real literal in code");
  redacted("SECRET=abc/def+ghi/jkl=", "a base64-shaped value");
  redacted("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "an AWS key");
});

test("the weak names keep their length floor, so `pass: 3` stays readable", () => {
  untouched("pass: 3", "a number is not a credential");
  untouched("credentials: none", "nor is a keyword");
});

test("the declaration guard is bounded, so a long line is not quadratic", () => {
  // The guard walks left from each match. An unbounded walk (or a whole-prefix slice) turned a
  // 236 KB line with 4,000 assignments into 2.7 s of CPU.
  const line = ("API_KEY=" + "x".repeat(50) + " ").repeat(4000);
  const started = performance.now();
  scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, "probe.env");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, `scanning ${line.length} chars took ${elapsed.toFixed(0)}ms`);
});
