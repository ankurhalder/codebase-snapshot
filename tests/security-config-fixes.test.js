/**
 * Fixes for the two redaction leaks, the Brotli misclassification and the two silent
 * config fallbacks found by the 4.2.0 audit.
 *
 * Each test reproduces the reported defect as it was, so the suite fails on the old code:
 *
 *   - a quoted credential containing an escaped quote was masked only up to the backslash,
 *     leaving the rest of the value in clear and the line syntactically broken;
 *   - an unquoted value stopped at the first `%`, so a percent-encoded token kept its tail;
 *   - `.br` was missing from the binary list, so a Brotli blob was emitted as mojibake text;
 *   - `export default null` generated with built-in defaults and exit 0;
 *   - an unknown key such as `maxPartByte` was dropped without a word.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function makeDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-config-"));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(dir, args = ["generate"]) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8" });
  if (result.error) throw result.error;
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

const allParts = (dir) => {
  const partsDir = path.join(dir, "snapshot", "parts");
  if (!fs.existsSync(partsDir)) return "";
  return fs
    .readdirSync(partsDir)
    .map((name) => fs.readFileSync(path.join(partsDir, name), "utf8"))
    .join("\n");
};

test("a credential with an escaped quote is masked to the value, not to the backslash", (t) => {
  const dir = makeDir(t, {
    "package.json": '{"name":"f","version":"1.0.0"}',
    "src/a.ts": 'export const a1 = JSON.parse(\'{"password": "p\\"ssw0rdINVENTED"}\');\n',
  });

  assert.equal(run(dir).code, 0);
  const parts = allParts(dir);

  assert.ok(parts.includes("[REDACTED"), "the value is masked");
  assert.equal(parts.includes("ssw0rdINVENTED"), false, "no part of the value may survive");
  // The mask must replace the WHOLE value, leaving a well-formed statement behind: the old
  // behaviour emitted `"[REDACTED…]"ssw0rdINVENTED"` and broke the line's syntax.
  assert.match(parts, /"password": "\[REDACTED[^"]*"\}/, "one quoted value, one mask");
});

test("a percent-encoded unquoted value is masked whole", (t) => {
  const dir = makeDir(t, {
    "package.json": '{"name":"f","version":"1.0.0"}',
    "src/b.ts":
      'const a2 = "https://api.example.test/cb?access_token=abc123XYZ%2Edef456INVENTED&scope=read";\n',
  });

  assert.equal(run(dir).code, 0);
  const parts = allParts(dir);

  assert.ok(parts.includes("[REDACTED"), "the token is masked");
  assert.equal(parts.includes("abc123XYZ%2Edef456INVENTED"), false, "the tail must not survive");
});

test("a Brotli file is skipped as binary, not emitted as mojibake", (t) => {
  // A real Brotli stream: `sherlock.br` in ripgrep is 186 bytes of exactly this shape.
  const compressed = brotliCompressSync(Buffer.from("hello world ".repeat(200)));
  const dir = makeDir(t, { "package.json": '{"name":"f","version":"1.0.0"}' });
  fs.mkdirSync(path.join(dir, "tests", "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "data", "sherlock.br"), compressed);

  assert.equal(run(dir).code, 0);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8")
  );
  const skipped = manifest.skipped.find((entry) => entry.path === "tests/data/sherlock.br");

  assert.ok(skipped, "the .br file is recorded as skipped");
  assert.equal(skipped.reason, "binary");
  assert.equal(
    allParts(dir).includes("\uFFFD"),
    false,
    "no replacement characters may reach the parts"
  );
});

test("a Latin-1 text file is still included when only some bytes are invalid", (t) => {
  const dir = makeDir(t, { "package.json": '{"name":"f","version":"1.0.0"}' });
  // Mostly ASCII with a handful of Latin-1 bytes: the binary heuristic must not drop this.
  const latin1 = Buffer.concat([
    Buffer.from("export const name = '"),
    Buffer.from([0xe9, 0xe8, 0xea]),
    Buffer.from("caf\u00e9';\n"),
  ]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "latin1.ts"), latin1);

  assert.equal(run(dir).code, 0);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8")
  );
  const entry = manifest.files.find((file) => file.relativePath === "src/latin1.ts");

  assert.ok(entry, "a mostly-ASCII Latin-1 file is still included");
  assert.equal(entry.encoding, "utf-8-lossy");
});

test("a config that exports null is a hard error, not built-in defaults", (t) => {
  const dir = makeDir(t, {
    "package.json": '{"name":"f","version":"1.0.0"}',
    "src/a.ts": "export const a = 1;\n",
    "snapshot.config.mjs": "export default null;\n",
  });

  const result = run(dir);

  assert.equal(result.code, 1, `expected a refusal, got: ${result.output}`);
  assert.match(result.output, /does not export a configuration object/);
  assert.equal(
    fs.existsSync(path.join(dir, "snapshot", "manifest.json")),
    false,
    "nothing may be written from a config that exported nothing"
  );
});

test("an unknown config key is rejected by name", (t) => {
  const dir = makeDir(t, {
    "package.json": '{"name":"f","version":"1.0.0"}',
    "src/a.ts": "export const a = 1;\n",
    "snapshot.config.json": '{"outDir":"snap","maxPartByte":4096}\n',
  });

  const result = run(dir);

  assert.equal(result.code, 1, `expected a refusal, got: ${result.output}`);
  assert.match(result.output, /maxPartByte/, "the offending key is named");
  assert.equal(fs.existsSync(path.join(dir, "snap")), false, "nothing was generated");
});
