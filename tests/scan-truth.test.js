import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  DEFAULT_SECRET_PATTERNS,
  collectFiles,
  isSensitivePath,
  loadConfigFileDetailed,
  resolveConfig,
  scanAndRedactSecrets,
} from "../dist/index.js";

/** A fresh directory outside the repository, so the walker (not git) is used. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-truth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

const scan = (content) => scanAndRedactSecrets(content, DEFAULT_SECRET_PATTERNS, "fixture.ts");

/** Runs `git init` in `dir`; false when git is unavailable on this host. */
function initGitRepository(dir) {
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- F1 / S5 / S16

test("F1: camelCase and snake_case credential assignments are redacted, keys survive", () => {
  // Assembled at runtime so the repository never contains a literal live-key
  // shape: push protection cannot distinguish a detection fixture from a leak,
  // and it is right not to try. The scanner sees the same bytes either way.
  const secretValues = [
    ["wJalrXUtnFEMI/K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/"),
    ["sk_", "live_", "51H8xQ2eZvKYlo2CxT9pQ3rS4tU5vW6xY7zA8bC9dE0fG"].join(""),
    "hunter2",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  ];
  const content = [
    `  awsSecret: "${secretValues[0]}",`,
    `  apiKey: "${secretValues[1]}",`,
    `  dbPassword: "${secretValues[2]}",`,
    `  token: "${secretValues[3]}",`,
    '  normal: "not a secret",',
  ].join("\n");

  const { redacted, findings } = scan(content);

  for (const value of secretValues) {
    assert.equal(redacted.includes(value), false, `value must not survive: ${value}`);
  }
  // The key every value was assigned to must still be readable.
  for (const key of ["awsSecret:", "apiKey:", "dbPassword:", "token:", "normal:"]) {
    assert.ok(redacted.includes(key), `the assignment key must survive: ${key}`);
  }
  assert.ok(redacted.includes("not a secret"), "an ordinary string must not be touched");
  assert.ok(findings.length >= 4);
});

test("F1: short unquoted values in .env and compose files are redacted", () => {
  const content = [
    "DB_PASS=backupTildeSecret1234",
    'POSTGRES_PASSWORD: "pw1"',
    "AWS_SECRET_ACCESS_KEY: yamlSecretKey1234567890",
    "password: credentialsYamlValue1234",
  ].join("\n");

  const { redacted } = scan(content);

  assert.equal(redacted.includes("backupTildeSecret1234"), false);
  assert.equal(redacted.includes("pw1"), false);
  assert.equal(redacted.includes("yamlSecretKey1234567890"), false);
  assert.equal(redacted.includes("credentialsYamlValue1234"), false);
});

test("S1/S16: CRLF, trailing comments and trailing spaces do not disable the env rule", () => {
  const values = [
    "crlfDeployToken123456",
    "tokenWithTrailingComment1234",
    "passwordWithTrailingSpaces1234",
    "secretBeforeSpaceAndComment1234",
    "plainTokenNoTrailingJunk1234",
  ];
  const crlf = [
    `export GITHUB_DEPLOY_TOKEN=${values[0]}`,
    `export API_TOKEN=${values[1]} # rotate quarterly`,
    `export DB_PASSWORD=${values[2]}   `,
    `export SESSION_SECRET=${values[3]}  # note`,
    `export AUTH_TOKEN=${values[4]}`,
  ].join("\r\n");

  const { redacted } = scan(crlf);

  for (const value of values) {
    assert.equal(redacted.includes(value), false, `CRLF/trailing text must not leak: ${value}`);
  }
  assert.ok(redacted.includes("rotate quarterly"), "the trailing comment must survive");
  assert.ok(redacted.includes("GITHUB_DEPLOY_TOKEN="), "the variable name must survive");
  assert.ok(redacted.includes("\r\n"), "line terminators must be preserved");

  // The same content with LF endings must behave identically.
  const lf = scan(crlf.replace(/\r\n/g, "\n")).redacted;
  assert.equal(lf.includes(values[0]), false, "the LF baseline must also be redacted");
});

test("a value is masked without destroying the surrounding statement", () => {
  const content = 'const url = "https://user:pass@host"; const neighbour = "KEEP_ME";';
  const { redacted } = scan(content);

  assert.equal(redacted.includes("user:pass@host"), false);
  assert.ok(redacted.includes('const neighbour = "KEEP_ME";'), "the closing quote and statement must survive");
});

test("assignments that reference a value instead of holding one are untouched", () => {
  const clean = [
    "password: req.body.password,",
    "const token = getToken();",
    "const secret = process.env.SECRET;",
    "token: string;",
    "const tokenizer = new Tokenizer();",
    "if (authToken !== undefined) return;",
    "MAX_RETRIES = 3",
  ];
  for (const line of clean) {
    assert.equal(scan(line).redacted, line, `false positive on: ${line}`);
  }
});

test("S6: a 40-char AWS secret value is redacted, a 40-char git SHA is not", () => {
  const aws = scan('export const AWS_SEC = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";').redacted;
  assert.equal(aws.includes("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"), false);

  const sha = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
  const commit = `const commit = "${sha}";`;
  assert.equal(scan(commit).redacted, commit, "a 40-char git SHA must never be masked");
});

test("the built-in rule set is 30 rules and none is stateful", () => {
  // 29 vendor/assignment rules plus `base64-private-key` (4.3.0), which matches the base64 of a
  // PEM header so a wrapped key is found without a decoder.
  assert.equal(DEFAULT_SECRET_PATTERNS.length, 30);
  assert.ok(
    DEFAULT_SECRET_PATTERNS.some((rule) => rule.rule === "base64-private-key"),
    "the wrapped-key rule is part of the default set"
  );
  for (const rule of DEFAULT_SECRET_PATTERNS) {
    assert.equal(/[gy]/.test(rule.pattern.flags), false, `${rule.rule} must not be stateful`);
  }
});

// ------------------------------------------------------------------- S4/S11/S5

test("S4/S11: backup suffixes and trailing spaces cannot bypass the deny list", () => {
  for (const sensitive of [".env", ".env~", ".env.bak", ".npmrc", ".npmrc ", ".env.swp", "id_rsa~"]) {
    assert.equal(isSensitivePath(sensitive), true, `${JSON.stringify(sensitive)} must be denied`);
  }
  for (const extension of ["credentials.yaml", "credentials.yml", "credentials.toml", "credentials.json"]) {
    assert.equal(isSensitivePath(extension), true, `${extension} must be denied`);
  }
  // Templates stay emittable, and ordinary files stay untouched.
  assert.equal(isSensitivePath(".env.example"), false);
  assert.equal(isSensitivePath("credentials.example.json"), false);
  assert.equal(isSensitivePath("src/app.ts"), false);
});

// ------------------------------------------------------------------------ S2

test("S2: a file whose name holds a secret is skipped and its path is masked", (t) => {
  const dir = tempDir(t);
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "docs/leak-AKIAIOSFODNN7EXAMPLE.txt", "innocuous\n");

  const { files, skipped } = collectFiles(dir, {});

  assert.deepEqual(files, ["src/a.ts"]);
  const record = skipped.find((entry) => entry.reason === "sensitive-path");
  assert.ok(record, "a sensitive-path skip record must exist");
  assert.equal(
    JSON.stringify(skipped).includes("AKIAIOSFODNN7EXAMPLE"),
    false,
    "the skipped[] record must not reproduce the secret"
  );
  assert.ok(record.detail.includes("aws-access-key-id"));
});

// -------------------------------------------------------------------- S8 / C18

test("S8/C18: ignored files are recorded without git, including a gitignored .env", (t) => {
  const dir = tempDir(t);
  write(dir, ".gitignore", ".env\nsecret-notes.txt\n");
  write(dir, ".env", "DB_PASSWORD=realSecretValue1234\n");
  write(dir, "secret-notes.txt", "note\n");
  write(dir, "node_modules/pkg/index.js", "module.exports = 1;\n");
  write(dir, "src/a.ts", "export const a = 1;\n");

  const { files, skipped } = collectFiles(dir, {});

  assert.deepEqual(files, [".gitignore", "src/a.ts"]);
  const paths = skipped.map((entry) => entry.path);
  assert.equal(paths.includes(".env"), true, `the gitignored .env must be recorded: ${JSON.stringify(skipped)}`);
  assert.ok(
    skipped.some((entry) => entry.reason === "default-ignore" && entry.path.startsWith("node_modules")),
    "an ignored directory must be recorded, not dropped silently"
  );
  assert.ok(
    skipped.some((entry) => entry.path === "secret-notes.txt" && entry.reason === "gitignore"),
    "a gitignored file must be recorded"
  );
});

// ------------------------------------------------------------------------ S9

test("S9: a directory symlink leaving the repository is not followed", (t) => {
  const root = tempDir(t);
  const outside = tempDir(t);
  write(root, "docs/hello.md", "# hi\n");
  write(outside, "notes.md", "outside\n");

  let created = true;
  try {
    fs.symlinkSync(outside, path.join(root, "vendor-link"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    created = false;
  }
  if (!created) return; // symlinks unavailable on this host

  const { files, skipped } = collectFiles(root, {});

  assert.deepEqual(files, ["docs/hello.md"]);
  const record = skipped.find((entry) => entry.reason === "outside-root");
  assert.ok(record, `an outside-root skip record must exist: ${JSON.stringify(skipped)}`);
  assert.equal(
    files.some((file) => file.startsWith("vendor-link")),
    false,
    "content from outside the root must not be included"
  );
});

test("C22: a directory link inside the root is never followed, and says why", (t) => {
  const root = tempDir(t);
  write(root, "zzz-target/UNIQUE.ts", "export const unique = 1;\n");
  write(root, "src/a.ts", "export const a = 1;\n");

  let created = true;
  try {
    fs.symlinkSync(
      path.join(root, "zzz-target"),
      path.join(root, "aaa-link"),
      process.platform === "win32" ? "junction" : "dir"
    );
  } catch {
    created = false;
  }
  if (!created) return; // symlinks unavailable on this host

  const { files, skipped } = collectFiles(root, {});

  assert.deepEqual(files, ["src/a.ts", "zzz-target/UNIQUE.ts"]);
  assert.equal(
    files.some((file) => file.startsWith("aaa-link")),
    false,
    "the same content must never be included twice"
  );
  const record = skipped.find((entry) => entry.reason === "symlink");
  assert.ok(record, `a symlink skip record must exist: ${JSON.stringify(skipped)}`);
  assert.equal(record.path, "aaa-link");
  assert.match(record.detail, /^directory link not followed \(target: /);
});

// ----------------------------------------------------------------------- C21

test("C21: a preset ignore is default-ignore, a user glob is excluded", (t) => {
  const dir = tempDir(t);
  write(dir, "Cargo.toml", "[package]\nname = \"x\"\n");
  write(dir, "src/main.rs", "fn main() {}\n");
  write(dir, "target/debug/out.txt", "build output\n");
  write(dir, "custom/keep.txt", "x\n");

  const { files, skipped } = collectFiles(dir, { excludePatterns: ["target", "custom"] });

  assert.deepEqual(files, ["Cargo.toml", "src/main.rs"]);
  const presetRecord = skipped.find((entry) => entry.path === "target/debug/out.txt");
  assert.equal(presetRecord.reason, "default-ignore", "a preset ignore is built-in, not user-excluded");
  assert.equal(presetRecord.detail, 'preset ignore: "target"');

  const userRecord = skipped.find((entry) => entry.path === "custom/keep.txt");
  assert.equal(userRecord.reason, "excluded");
  assert.equal(userRecord.detail, 'matches exclude pattern "custom"');
});

// ----------------------------------------------------------------------- C19

test("C19: --include-monolith outranks artifacts.monolith: false in the config", (t) => {
  const dir = tempDir(t);

  const cliWins = resolveConfig({ artifacts: { monolith: false } }, { includeMonolith: true }, dir);
  assert.equal(cliWins.artifacts.monolith, true);
  assert.equal(cliWins.includeMonolith, true);

  const configWins = resolveConfig({ artifacts: { monolith: true } }, undefined, dir);
  assert.equal(configWins.artifacts.monolith, true);

  const suppressed = resolveConfig(
    {},
    { includeMonolith: true, skipArtifacts: ["monolith"] },
    dir
  );
  assert.equal(suppressed.artifacts.monolith, false, "an explicit suppression still wins");
});

// ------------------------------------------------------------------------ C1

test("C1: JSONC stripping keeps // and /* */ inside strings", async (t) => {
  const dir = tempDir(t);
  write(
    dir,
    "snapshot.config.json",
    [
      "{",
      "  // a real comment",
      '  "branch": "feat//release",',
      '  "outDir": "snapshot", /* block comment */',
      '  "excludePatterns": ["**/*.test.ts", "a//b"],',
      "}",
    ].join("\n")
  );

  const loaded = await loadConfigFileDetailed(dir);

  assert.deepEqual(loaded.errors, [], "a valid JSONC config must not produce errors");
  assert.ok(loaded.config, "the config must load");
  assert.equal(loaded.config.branch, "feat//release");
  assert.deepEqual(loaded.config.excludePatterns, ["**/*.test.ts", "a//b"]);

  const resolved = resolveConfig(loaded.config, undefined, dir);
  assert.equal(resolved.branch, "feat//release");
});

test("C1: a package.json with // in a string is not mangled", async (t) => {
  const dir = tempDir(t);
  write(
    dir,
    "package.json",
    JSON.stringify({ name: "slashy", version: "1.0.0", scripts: { build: "tsc && echo done//ok" } })
  );

  const loaded = await loadConfigFileDetailed(dir);
  assert.deepEqual(loaded.errors, [], "package.json must parse");
});

test("C1: a trailing comma is accepted like any other JSONC", async (t) => {
  const dir = tempDir(t);
  write(dir, ".snapshotrc.json", '{ "branch": "main", "excludePatterns": ["a"], }');

  const loaded = await loadConfigFileDetailed(dir);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.config.branch, "main");
});

// ------------------------------------------------------------------------ C2

test("C2: a thenable export is a hard error, never an empty config", async (t) => {
  const dir = tempDir(t);
  write(dir, "snapshot.config.mjs", 'export default Promise.resolve({ outDir: "custom-out" });\n');

  const loaded = await loadConfigFileDetailed(dir);

  assert.equal(loaded.config, null);
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0], /Promise/);
});

test("C2: array and primitive exports are hard errors naming what was received", async (t) => {
  for (const [source, expected] of [
    ["export default [{ outDir: 'x' }];\n", /array/],
    ["export default 42;\n", /number/],
  ]) {
    const dir = tempDir(t);
    write(dir, "snapshot.config.mjs", source);
    const loaded = await loadConfigFileDetailed(dir);
    assert.equal(loaded.config, null);
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0], expected);
  }
});

test("C2: a plain object export still loads", async (t) => {
  const dir = tempDir(t);
  write(dir, "snapshot.config.mjs", 'export default { outDir: "custom-out" };\n');

  const loaded = await loadConfigFileDetailed(dir);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.config.outDir, "custom-out");
});

// ------------------------------------------------------------------------ C3

test("C3: the resolved outDir and tmpDir are excluded from scanning", (t) => {
  const dir = tempDir(t);
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, ".context/manifest.json", "{}\n");
  write(dir, ".context/parts/part-001.md", "# part\n");

  const config = resolveConfig({ outDir: ".context" }, undefined, dir);

  assert.ok(config.presetExclude.includes(".context/**"), `presetExclude: ${config.presetExclude}`);
  assert.ok(config.presetExclude.includes("snapshot.tmp/**"));

  const collection = collectFiles(dir, {
    includePatterns: config.include,
    excludePatterns: [...config.excludePatterns, ...config.presetExclude],
    includeSensitiveFiles: config.includeSensitiveFiles,
  });

  assert.deepEqual(collection.files, ["src/a.ts"]);
  assert.equal(
    collection.files.some((file) => file.startsWith(".context/")),
    false,
    "output must never be scanned as source"
  );
});

test("C3: an absolute outDir inside cwd is excluded, one outside is not", (t) => {
  const dir = tempDir(t);
  const inside = resolveConfig({ outDir: path.join(dir, "dist") }, undefined, dir);
  assert.ok(inside.presetExclude.includes("dist/**"));

  const outside = resolveConfig({ outDir: path.join(os.tmpdir(), "elsewhere-out") }, undefined, dir);
  assert.equal(
    outside.presetExclude.some((pattern) => pattern.includes("elsewhere-out")),
    false,
    "a directory outside cwd is never scanned anyway"
  );
});

// ------------------------------------------------------------------------ C5

test("C5: an explicit --max-part-bytes wins and is the budget actually used", (t) => {
  const dir = tempDir(t);
  const config = resolveConfig(
    { budgets: { default: "300k", byLayer: { api: "500k" } } },
    { maxPartBytes: 4096 },
    dir
  );

  assert.equal(config.maxPartBytes, 4096);
  assert.equal(config.budgets.default, 4096, "the printed budget must be the applied budget");
  assert.equal(config.budgets.byLayer.api, 4096, "a per-layer budget may not exceed the ceiling");
});

test("C5: budgets.default governs when no explicit maxPartBytes is set", (t) => {
  const dir = tempDir(t);
  const config = resolveConfig({ budgets: { default: "300k" } }, undefined, dir);

  assert.equal(config.budgets.default, 300 * 1024);
  assert.equal(config.maxPartBytes, config.budgets.default);
});

// ------------------------------------------------------------------------ C6

test("C6: the documented { layer, match } shape is accepted as { name, match }", (t) => {
  const dir = tempDir(t);
  const aliased = resolveConfig(
    { layers: [{ layer: "api", match: "src/api/**" }], layersMode: "replace" },
    undefined,
    dir
  );
  assert.equal(aliased.layers[0].name, "api");
  assert.equal(aliased.layers[0].match, "src/api/**");

  // The documented shape — and what `LayerRule` declares — must work too.
  const canonical = resolveConfig(
    { layers: [{ name: "billing", match: "src/features/billing/**" }], layersMode: "replace" },
    undefined,
    dir
  );
  assert.equal(canonical.layers[0].name, "billing");

  const kinds = resolveConfig(
    { kinds: [{ name: "route", match: "src/routes/**" }], layersMode: "replace" },
    undefined,
    dir
  );
  assert.equal(kinds.kinds[0].kind, "route", "`name` works as an alias for kinds too");
});

test("C6: a bad layer rule is a validation error naming the index", (t) => {
  const dir = tempDir(t);

  assert.throws(
    () => resolveConfig({ layers: [{ match: "src/**" }] }, undefined, dir),
    /layers\[0\] is missing `name`.*received keys: match/s
  );
  assert.throws(
    () => resolveConfig({ layers: [{ name: "api" }] }, undefined, dir),
    /layers\[0\]\.match is required/
  );
  assert.throws(
    () => resolveConfig({ layers: [{ name: "api", match: 42 }] }, undefined, dir),
    /layers\[0\]\.match must be a string/
  );
  assert.throws(() => resolveConfig({ layers: {} }, undefined, dir), /`layers` must be an array/);
});

test("C6: a bad kind rule is a validation error naming the index", (t) => {
  const dir = tempDir(t);
  assert.throws(
    () => resolveConfig({ kinds: [{ match: "src/**" }] }, undefined, dir),
    /kinds\[0\].*missing `kind`/s
  );
});

// ------------------------------------------------------------------------ C7

test("C7: preset detected/auto mean detect, and an unknown name still errors", (t) => {
  const dir = tempDir(t);
  for (const preset of ["detected", "auto", "DETECTED"]) {
    const config = resolveConfig({ preset }, undefined, dir);
    assert.equal(typeof config.preset, "string");
    assert.ok(config.preset.length > 0);
    assert.ok(config.layers.length > 0);
  }
  assert.throws(() => resolveConfig({ preset: "no-such-preset" }, undefined, dir), /Unknown preset/);
  assert.throws(() => resolveConfig({ preset: 42 }, undefined, dir), /`preset` must be a preset name/);
});

// ------------------------------------------------------------------------ C8

test("C8: wrong-typed settings are hard errors, not silent no-ops", (t) => {
  const dir = tempDir(t);
  const cases = [
    [{ excludePatterns: "src/**" }, /`excludePatterns` must be an array/],
    [{ excludePatterns: ["ok", 42] }, /`excludePatterns` must be an array/],
    [{ previewHeadLines: 0 }, /`previewHeadLines` must be a positive integer/],
    [{ previewTailLines: "20" }, /`previewTailLines` must be a positive integer/],
    [{ includeMonolith: "yes" }, /`includeMonolith` must be true or false/],
    [{ includeSensitiveFiles: 1 }, /`includeSensitiveFiles` must be true or false/],
    [{ outDir: 42 }, /`outDir` must be a non-empty string/],
    [{ branch: {} }, /`branch` must be a non-empty string/],
    [{ maxPartBytes: "abc" }, /maxPartBytes must be a byte count/],
    [{ largeFileBytes: 0 }, /largeFileBytes must be a positive byte count/],
    [{ maxMonolithBytes: -1 }, /maxMonolithBytes must be a positive byte count/],
  ];
  for (const [config, expected] of cases) {
    assert.throws(() => resolveConfig(config, undefined, dir), expected, JSON.stringify(config));
  }
});

// ------------------------------------------------------------------------ D2

test("D2: a bare RegExp or string custom pattern is accepted and named", (t) => {
  const dir = tempDir(t);
  const resolved = resolveConfig(
    { secrets: { customPatterns: [/ghp_[A-Za-z0-9]{36}/, "CORP-[A-Z0-9]{8}"] } },
    undefined,
    dir
  );

  const names = resolved.secretRules.map((rule) => rule.rule);
  assert.ok(names.includes("custom-1"), `got ${names.join(", ")}`);
  assert.ok(names.includes("custom-2"));
  assert.equal(resolved.secretRules.length, DEFAULT_SECRET_PATTERNS.length + 2);

  const { redacted } = scanAndRedactSecrets(
    "const token = \"ghp_0123456789abcdefghijklmnopqrstuvwxyz\"; const id = \"CORP-ABCD1234\";",
    resolved.secretRules,
    "a.ts"
  );
  assert.equal(redacted.includes("ghp_0123456789abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(redacted.includes("CORP-ABCD1234"), false);
});

test("D2: { rule, pattern } is still accepted, and bad shapes name the index", (t) => {
  const dir = tempDir(t);
  const named = resolveConfig(
    { secrets: { customPatterns: [{ rule: "internal", pattern: /INT_[a-z]{4}/ }] } },
    undefined,
    dir
  );
  assert.ok(named.secretRules.some((rule) => rule.rule === "internal"));

  assert.throws(
    () => resolveConfig({ secrets: { customPatterns: [{ pattern: /x/ }] } }, undefined, dir),
    /secrets\.customPatterns\[0\] is missing `rule`/
  );
  assert.throws(
    () => resolveConfig({ secrets: { customPatterns: [42] } }, undefined, dir),
    /secrets\.customPatterns\[0\] must be a RegExp, a string, or \{ rule, pattern \}/
  );
  assert.throws(
    () => resolveConfig({ secrets: { customPatterns: "ghp_x" } }, undefined, dir),
    /`secrets.customPatterns` must be an array/
  );
  assert.throws(
    () => resolveConfig({ secrets: { customPatterns: [{ rule: "broken", pattern: "([a-z" }] } }, undefined, dir),
    /Invalid regular expression for secret rule "broken"/
  );
});

// ------------------------------------------------------- S18/S19/S20/S21/S22

test("S18: ordinary code that merely contains a credential-ish word is untouched", () => {
  const lines = [
    "id-token: write",
    "{ pass: 3, total: 5 }",
    'const s = `${pass ? "  PASS" : "  FAIL"}`;',
    "…not credentials: none of them…",
    "fast: 3, compass: 5, bypass: true",
  ];
  for (const line of lines) {
    assert.equal(scan(line).redacted, line, `false positive on: ${line}`);
  }
});

test("S20: Authorization headers are masked, a bare scheme is not", () => {
  const bearer = scan('headers = { Authorization: "Bearer abcdef1234567890abcdefXYZ" };').redacted;
  assert.equal(bearer.includes("abcdef1234567890abcdefXYZ"), false);
  assert.ok(bearer.includes("Bearer"), "the scheme must stay readable");

  const basic = scan('headers = { Authorization: "Basic dXNlcjpwYXNzd29yZA==" };').redacted;
  assert.equal(basic.includes("dXNlcjpwYXNzd29yZA=="), false);

  for (const clean of ['const scheme = "Bearer";', "Basic authentication is supported.", "Bearer"]) {
    assert.equal(scan(clean).redacted, clean, `false positive on: ${clean}`);
  }
});

test("S21: vendor token prefixes are detected", () => {
  const samples = [
    "glpat-abcdefghij1234567890",
    "hvs.CAESIJabcdefghij1234567890",
    "s.abcdefghijklmnopqrstuvwx1234",
    "whsec_abcdefghij1234567890",
    "dckr_pat_abcdefghij1234567890",
    "hf_abcdefghijklmnopqrstuvwxyz123456",
    "ya29.a0AfH6SMBabcdefghij1234567890",
    "xoxc-1234567890-abcdefghij",
    "xoxd-abcdefghij1234567890",
  ];
  for (const sample of samples) {
    assert.equal(scan(sample).redacted.includes(sample), false, `prefix not covered: ${sample}`);
  }
});

test("S22: credential file names without key=value content are denied", () => {
  for (const name of [
    ".vault-token",
    "config/vault-agent-token",
    "prod.env",
    "env",
    ".env",
    "config/secrets.toml",
    "deploy/credentials.toml",
  ]) {
    assert.equal(isSensitivePath(name), true, `${name} must be denied`);
  }
  for (const name of ["env.example", "environment.ts", "src/env.ts", "docs/env.md"]) {
    assert.equal(isSensitivePath(name), false, `${name} must stay readable`);
  }
});

test("S19: partially overlapping spans produce a single marker", () => {
  const rules = [
    { rule: "wide", pattern: /SECRET_[A-Z]+/ },
    { rule: "tail", pattern: /[A-Z]+_[0-9]+/ },
  ];
  const { redacted } = scanAndRedactSecrets("x = SECRET_ABC_123;", rules, "a.ts");
  assert.equal(redacted.split("[REDACTED").length - 1, 1, redacted);

  const real = scan('const o = { dbPassword: "hunter2hunter2" };').redacted;
  assert.equal(real.split("[REDACTED").length - 1, 1, real);
  assert.ok(real.includes("dbPassword:"));
});

test("S19: a shorter prefix match never leaves a fragment of the value behind", () => {
  const token = "npm_" + "a".repeat(33) + "stu";
  const { redacted } = scan(`const t = "${token}";`);

  assert.equal(redacted.includes(token), false);
  assert.equal(redacted.includes("stu"), false, `fragment survived: ${redacted}`);
  assert.equal(redacted.split("[REDACTED").length - 1, 1, redacted);
});

// ------------------------------------------------------------- S23/S24/S25

test("S23: smtp/ldap/mssql/oracle credential URIs are redacted", () => {
  const urls = [
    "smtp://mailer:smtpSecret1234@mail.example.invalid",
    "smtps://mailer:smtpSecret1234@mail.example.invalid",
    "ldap://binduser:ldapSecret1234@dir.example.invalid",
    "ldaps://binduser:ldapSecret1234@dir.example.invalid",
    "mssql://sa:mssqlSecret1234@db.example.invalid",
    "oracle://scott:oracleSecret1234@db.example.invalid",
  ];
  for (const url of urls) {
    const { redacted } = scan(`const dsn = "${url}";`);
    assert.equal(redacted.includes(url), false, `scheme not covered: ${url}`);
  }
});

test("S23: any scheme is covered by the scheme-less userinfo rule", () => {
  const urls = [
    "mysqlx://user:secretpass123@db.host/x",
    "imap://mailer:imapsecret123@mail.host",
    "pop3://poper:popsecret123@mail.host",
    "svn://builder:svnsecret123@svn.host/repo",
    "telnet://operator:telnetsecret123@host",
    "nntp://reader:nntpsecret123@news.host",
    "kafka://producer:kafkasecret123@broker.host:9092",
    "elasticsearch://elastic:es-secret123@search.host:9200",
  ];
  for (const url of urls) {
    const { redacted } = scan(`const dsn = "${url}";`);
    assert.equal(redacted.includes(url), false, `scheme leaked: ${url}`);
  }

  // Comment prose must survive: the `//` has to be followed by the userinfo.
  for (const line of [
    "// see user:pass@host for details",
    "// remember: ask a@b about this",
    "// note: the URL is https://example.com",
  ]) {
    assert.equal(scan(line).redacted, line, `false positive on: ${line}`);
  }
});

test("the mask stops at a token boundary and keeps the assignment name", () => {
  const env = scan("DB_PASSWORD=hunter2").redacted;
  assert.ok(env.includes("DB_PASSWORD"), `the name must survive: ${env}`);
  assert.equal(env.includes("hunter2"), false);

  const named = scan("const npmToken = 1;").redacted;
  assert.equal(named, "const npmToken = 1;", "an identifier must not be masked");
});

test("S24/S25: unquoted STRONG names keep short values, WEAK names need length", () => {
  for (const line of [
    "POSTGRES_PASSWORD: hunter2",
    "MYSQL_ROOT_PASSWORD: abc123",
    "pass: hunter2hunter2",
    "credentials: hunter2hunter2",
  ]) {
    const { redacted } = scan(line);
    assert.ok(redacted.includes("[REDACTED"), `not masked: ${line}`);
    assert.equal(redacted.includes("hunter2"), false, `not masked: ${line}`);
    assert.equal(redacted.includes("abc123"), false, `not masked: ${line}`);
  }

  // The S18 regression set must still be untouched by the wider floor.
  for (const line of ["pass: 3", "id-token: write", "credentials: none", "{ pass: 3, total: 5 }"]) {
    assert.equal(scan(line).redacted, line, `false positive on: ${line}`);
  }
});

test("S17c: a raw { secretRules } object is applied, never silently dropped", (t) => {
  const dir = tempDir(t);
  const config = resolveConfig(
    { secretRules: [{ rule: "acme", pattern: /ACME_[a-z0-9]{6}/ }] },
    undefined,
    dir
  );

  const { redacted, findings } = scanAndRedactSecrets(
    "const k = 'ACME_abc123';",
    config.secretRules,
    "a.ts"
  );
  assert.equal(redacted.includes("ACME_abc123"), false);
  assert.ok(findings.some((finding) => finding.rules.includes("acme")));

  assert.throws(
    () => resolveConfig({ secretRules: "nope" }, undefined, dir),
    /`secretRules` must be an array/
  );
});

// ----------------------------------------------------------------- C25/gitignore

test("a .gitignore'd file is recorded in a git repository too", (t) => {
  const dir = tempDir(t);
  write(dir, ".gitignore", "notes.txt\n");
  write(dir, "notes.txt", "note\n");
  write(dir, "src/a.ts", "export const a = 1;\n");

  if (!initGitRepository(dir)) return; // git unavailable on this host

  const { files, skipped } = collectFiles(dir, {});

  assert.deepEqual(files, [".gitignore", "src/a.ts"]);
  assert.ok(
    skipped.some((entry) => entry.path === "notes.txt" && entry.reason === "gitignore"),
    `a gitignored file must be recorded with git too: ${JSON.stringify(skipped)}`
  );
});

test("C25: the tool's own output never appears in skipped[]", (t) => {
  const dir = tempDir(t);
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, ".context/.codebase-snapshot", "{}\n");
  write(dir, ".context/manifest.json", "{}\n");
  write(dir, ".context/parts/part-001.md", "# part\n");
  write(dir, "snapshot/.codebase-snapshot", "{}\n");
  write(dir, "snapshot/manifest.json", "{}\n");
  fs.mkdirSync(path.join(dir, "snapshot.backup-123-456"), { recursive: true });
  write(dir, "snapshot.backup-123-456/manifest.json", "{}\n");

  const config = resolveConfig({ outDir: ".context" }, undefined, dir);
  const options = {
    includePatterns: config.include,
    excludePatterns: [...config.excludePatterns, ...config.presetExclude],
    includeSensitiveFiles: config.includeSensitiveFiles,
  };

  const first = collectFiles(dir, options);
  // A second identical run must produce an identical manifest payload.
  const second = collectFiles(dir, options);

  assert.deepEqual(first.files, ["src/a.ts"]);
  assert.deepEqual(first, second, "identical runs must produce identical results");
  for (const entry of second.skipped) {
    assert.equal(
      /^(?:\.context|snapshot)(?:\/|$)/.test(entry.path),
      false,
      `tool-owned path leaked into skipped[]: ${entry.path}`
    );
  }
});

test("C26: --out-dir only excludes the resolved path, not same-named nested dirs", (t) => {
  const dir = tempDir(t);
  write(dir, "src/docs/README.md", "# nested docs\n");
  write(dir, "docs/manifest.json", "{}\n");
  write(dir, "docs/.codebase-snapshot", "{}\n");
  write(dir, "src/a.ts", "export const a = 1;\n");

  for (const [outDir, nested] of [
    ["docs", "src/docs/README.md"],
    ["lib", null],
    ["app", null],
  ]) {
    const config = resolveConfig({ outDir }, undefined, dir);
    assert.ok(
      config.presetExclude.includes(`${outDir}/**`),
      `${outDir} must be excluded as a rooted path: ${config.presetExclude}`
    );
  }

  const config = resolveConfig({ outDir: "docs" }, undefined, dir);
  const { files } = collectFiles(dir, {
    includePatterns: config.include,
    excludePatterns: [...config.excludePatterns, ...config.presetExclude],
    includeSensitiveFiles: config.includeSensitiveFiles,
  });

  assert.ok(files.includes("src/docs/README.md"), `nested docs must survive: ${files}`);
  assert.equal(
    files.some((file) => file.startsWith("docs/")),
    false,
    "the resolved output directory must still be excluded"
  );
});

test("C22: the git path does not follow directory links either", (t) => {
  const root = tempDir(t);
  write(root, "src/a.ts", "export const a = 1;\n");
  write(root, "zzz-target/UNIQUE.ts", "export const unique = 1;\n");

  let created = true;
  try {
    fs.symlinkSync(
      path.join(root, "zzz-target"),
      path.join(root, "aaa-link"),
      process.platform === "win32" ? "junction" : "dir"
    );
  } catch {
    created = false;
  }
  if (!created) return;
  if (!initGitRepository(root)) return;
  try {
    execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  } catch {
    return;
  }

  const { files, skipped } = collectFiles(root, {});

  assert.deepEqual(files, ["src/a.ts", "zzz-target/UNIQUE.ts"]);
  assert.equal(
    files.some((file) => file.startsWith("aaa-link")),
    false,
    "content must never be emitted twice"
  );
  const record = skipped.find((entry) => entry.path === "aaa-link");
  assert.ok(record, `the link must be reported: ${JSON.stringify(skipped)}`);
  assert.ok(record.reason === "symlink" || record.reason === "outside-root");
});

// -------------------------------------------------------- path masking, all reasons

const TOKEN_IN_NAME = "AKIA1234567890ABCDEF";

test("a credential file whose NAME holds a token is masked in skipped[], with its reason", (t) => {
  const dir = tempDir(t);
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, `certs/${TOKEN_IN_NAME}.key`, "not a real key\n");

  const { files, skipped } = collectFiles(dir, {});

  assert.deepEqual(files, ["src/a.ts"]);
  const record = skipped.find((entry) => entry.reason === "sensitive-file");
  assert.ok(record, JSON.stringify(skipped));
  assert.equal(record.path.includes(TOKEN_IN_NAME), false, "the skip path must be masked");
  assert.ok(record.path.includes("[REDACTED"), record.path);
  assert.equal(
    record.detail,
    "credential-bearing file; enable includeSensitiveFiles to emit it",
    "the reason's detail must survive masking"
  );
  assert.equal(
    JSON.stringify(skipped).includes(TOKEN_IN_NAME),
    false,
    "no skip record may carry the token"
  );
});

test("gitignored and excluded files with a token in the name are masked too", (t) => {
  const dir = tempDir(t);
  write(dir, ".gitignore", `${TOKEN_IN_NAME}.txt\n`);
  write(dir, `${TOKEN_IN_NAME}.txt`, "note\n");
  write(dir, `excluded/${TOKEN_IN_NAME}.ts`, "export const x = 1;\n");
  write(dir, "src/a.ts", "export const a = 1;\n");

  const { skipped } = collectFiles(dir, { excludePatterns: ["excluded"] });

  const gitignored = skipped.find((entry) => entry.reason === "gitignore");
  assert.ok(gitignored, JSON.stringify(skipped));
  assert.equal(gitignored.path.includes(TOKEN_IN_NAME), false);

  const excluded = skipped.find((entry) => entry.reason === "excluded");
  assert.ok(excluded, JSON.stringify(skipped));
  assert.equal(excluded.path.includes(TOKEN_IN_NAME), false);

  assert.equal(
    JSON.stringify(skipped).includes(TOKEN_IN_NAME),
    false,
    "no skip record may carry the token"
  );
});

test("custom secret rules also protect file names", (t) => {
  const dir = tempDir(t);
  const corpToken = `CORP-${"A".repeat(32)}`;
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, `src/${corpToken}.ts`, "export const x = 1;\n");

  const { files, skipped } = collectFiles(dir, {
    secretRules: [{ rule: "corp", pattern: /CORP-[A-Z0-9]{32}/ }],
  });

  assert.deepEqual(files, ["src/a.ts"]);
  const record = skipped.find((entry) => entry.reason === "sensitive-path");
  assert.ok(record, JSON.stringify(skipped));
  assert.ok(record.detail.includes("corp"));
  assert.equal(
    JSON.stringify(skipped).includes(corpToken),
    false,
    "the custom token must not reach skipped[]"
  );
});

test("masking preserves reason and detail, and leaves clean paths alone", (t) => {
  const dir = tempDir(t);
  write(dir, `certs/${TOKEN_IN_NAME}.pem`, "not a real key\n");
  write(dir, "src/fine.ts", "export const a = 1;\n");

  const { skipped } = collectFiles(dir, {});

  const masked = skipped.find((entry) => entry.reason === "sensitive-file");
  assert.ok(masked, JSON.stringify(skipped));
  assert.equal(masked.detail, "credential-bearing file; enable includeSensitiveFiles to emit it");
  assert.equal(masked.path.includes(TOKEN_IN_NAME), false);

  assert.equal(
    skipped.some((entry) => entry.path === "src/fine.ts"),
    false,
    "an included file is not a skip record"
  );
});
