import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { DEFAULT_SECRET_PATTERNS, loadConfigFileDetailed, scanAndRedactSecrets } from "../dist/index.js";

/**
 * 4.1.0 regression cover for three small honesty defects found by a read-only security wave.
 *
 * A17 — masking walked left through a URL path, so `https://example.com/v1/<key>` came out as
 *       `https://example.[REDACTED]`, contradicting "only the matched span is masked".
 * B6b — `package.json#snapshot` as an array was passed to the resolver as though it were a config
 *       and then silently ignored, with no warning.
 * B9 — an unreadable `snapshot.config.json` reported a bare `EISDIR` with no filename.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-honesty-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const scan = (content) => scanAndRedactSecrets(content, DEFAULT_SECRET_PATTERNS, "fixture.ts");

test("A17: a key inside a URL is masked without swallowing the path", () => {
  // Assembled at runtime so the repository never contains a literal live-key shape.
  const key = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
  const { redacted } = scan(`const url = "https://example.com/v1/${key}/data";\n`);

  assert.match(redacted, /https:\/\/example\.com\/v1\//, "the path survives");
  assert.doesNotMatch(redacted, /AKIA/, "the key does not");
  assert.doesNotMatch(redacted, /example\.\[REDACTED/, "the host is not part of the mask");
});

test("A17: a scheme-only host does not swallow the path either", () => {
  const key = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
  const { redacted } = scan(`const url = "http://localhost:8080/v1/${key}";\n`);

  assert.match(redacted, /http:\/\/localhost:8080\/v1\//);
  assert.doesNotMatch(redacted, /AKIA/);
});

test("A17: base64 credentials containing a slash are still masked whole", () => {
  // A 40-character AWS secret value with a slash and a plus, assigned as a value.
  const secret = ["wJalrXUtnFEMI", "/K7MDENG", "+bPxRfiCY", "EXAMPLEKEY"].join("");
  const { redacted } = scan(`awsSecret: "${secret}"\n`);

  assert.doesNotMatch(redacted, /wJalrXUtnFEMI/, "the left half is masked too");
  assert.doesNotMatch(redacted, /EXAMPLEKEY/);
});

test("B6b: package.json#snapshot as an array is warned about, not silently ignored", async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "1.0.0", snapshot: [{ maxPartBytes: 4096 }] }, null, 2)}\n`,
    "utf8"
  );

  const loaded = await loadConfigFileDetailed(dir);

  const warning = loaded.warnings.find((entry) => /"snapshot" key must be an object/.test(entry));
  assert.ok(warning, `an array must be reported: ${JSON.stringify(loaded.warnings)}`);
  assert.match(warning, /array/, "the warning names the type it saw");
  assert.equal(loaded.config, null, "and the array is not used as a config");
});

test("B9: an unreadable config file names itself in the error", async (t) => {
  const dir = tempDir(t);
  // A directory where the config file should be: readable as a path, unreadable as a file.
  fs.mkdirSync(path.join(dir, "snapshot.config.json"), { recursive: true });

  const loaded = await loadConfigFileDetailed(dir);
  const message = [...loaded.warnings, ...loaded.errors].join("\n");

  assert.match(message, /snapshot\.config\.json/, "the failing file is named");
  assert.match(message, /EISDIR|directory|read/i, "and the reason is kept");
});
