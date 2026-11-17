import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_SECRET_PATTERNS, scanAndRedactSecrets } from "../dist/index.js";

/**
 * The placeholder exemption is a closed list, and the documentation now says so.
 *
 * `docs/configuration.md` claimed "a placeholder is indistinguishable from a secret", which is
 * false: `replace-me-…` and `sk-...` survive while `replace-with-…` is masked. A test asserted
 * the opposite for its own examples. Both were right about their examples and wrong as
 * generalisations, because neither page listed the exempt spellings.
 *
 * These tests pin the list itself and the page that documents it, so the two cannot drift.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIGURATION_DOC = fs.readFileSync(path.join(here, "..", "docs", "configuration.md"), "utf8");

const scan = (line, filePath) => scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, filePath);

/** One example per documented shape, with the file that shape is written in. */
const EXEMPT = [
  ["replace-me-with-the-read-tier-key", ".env"],
  ["change-me", ".env"],
  ["your-api-key-here", ".env"],
  ["your_api_key", ".env"],
  ["example-token", ".env"],
  ["sample-value", ".env"],
  ["<fine-grained PAT>", "a.sh"],
  ["<missing-bracket", ".yaml"],
  ["...", ".env"],
  ["sk-...", ".env"],
  ["xxxx", ".env"],
  ["****", ".env"],
];

test("every documented placeholder shape survives the scan", () => {
  for (const [value, filePath] of EXEMPT) {
    const line = `API_KEY=${value}`;
    const { redacted } = scan(line, filePath);
    assert.equal(redacted, line, `${value} is documented as exempt but was masked`);
  }
});

test("a value outside the list is masked, including the near miss", () => {
  // The rule keys on `-me`, so `replace-with-…` — the exact string the old paragraph used as
  // its masking example — is masked. If this ever flips, the doc's table is wrong.
  for (const [value, filePath] of [
    ["replace-with-base64url-48-bytes", ".env"],
    ["my-example-secret", ".env"],
    ["hunter2hunter2", ".env"],
  ]) {
    const line = `API_KEY=${value}`;
    assert.match(scan(line, filePath).redacted, /\[REDACTED/, `${value} must be masked`);
  }
});

test("the documentation lists every exempt example it relies on", () => {
  for (const [value] of EXEMPT) {
    assert.ok(
      CONFIGURATION_DOC.includes(value),
      `docs/configuration.md does not mention ${value}, so the list is not the documented one`
    );
  }
  assert.match(
    CONFIGURATION_DOC,
    /PLACEHOLDER_PATTERNS/,
    "the page names the source of truth rather than paraphrasing it"
  );
  assert.doesNotMatch(
    CONFIGURATION_DOC,
    /a placeholder is indistinguishable from a secret/i,
    "the claim this test exists to correct is gone"
  );
});
