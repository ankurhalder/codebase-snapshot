import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  DEFAULT_SECRET_PATTERNS,
  anchorForPath,
  countLines,
  DEFAULT_ANSWERS,
  defineConfig,
  detectLanguage,
  detectPreset,
  listPresetNames,
  generateProjectTree,
  globToRegExp,
  isBinaryBuffer,
  isBinaryExtension,
  isBinaryFile,
  isResolvedConfig,
  isSensitivePath,
  loadConfigFile,
  loadConfigFileDetailed,
  matchRule,
  matchesExclude,
  parseByteSize,
  profileForPath,
  renderConfig,
  resolveConfig,
  runInit,
  scanAndRedactSecrets,
  summarizeJson,
  summarizeMarkdown,
  summarizeTypeScriptSource,
  summarizeWithProfile,
  supportsTypeScriptImports,
  truncatePreview,
  truncateToBytes,
} from "../dist/index.js";

// ---------------------------------------------------------------- utilities

test("detectLanguage identifies language from extension and basename", () => {
  assert.equal(detectLanguage("src/app/page.tsx"), "tsx");
  assert.equal(detectLanguage("src/lib/utils.ts"), "typescript");
  assert.equal(detectLanguage("src/lib/utils.mts"), "typescript");
  assert.equal(detectLanguage("package.json"), "json");
  assert.equal(detectLanguage("README.md"), "markdown");
  assert.equal(detectLanguage("Dockerfile"), "dockerfile");
  assert.equal(detectLanguage(".env.local"), "dotenv");
});

test("countLines uses one consistent convention", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("\n"), 1);
});

test("truncateToBytes never splits a multi-byte character", () => {
  const text = "héllo wörld";
  const result = truncateToBytes(text, 4);
  assert.equal(result.isTruncated, true);
  assert.ok(!result.content.includes("\uFFFD"));
  assert.ok(Buffer.byteLength(result.content, "utf8") <= 4);
  assert.equal(truncateToBytes(text, 1000).isTruncated, false);
});

test("isBinary helpers detect binary extensions and buffers", () => {
  assert.equal(isBinaryExtension("image.png"), true);
  assert.equal(isBinaryExtension("font.woff2"), true);
  assert.equal(isBinaryExtension("code.ts"), false);
  assert.equal(isBinaryBuffer(Buffer.from("clean text")), false);
  assert.equal(isBinaryBuffer(Buffer.from([0x89, 0x50, 0x00, 0x0a])), true);
  assert.equal(isBinaryFile("does-not-exist.png"), true);
});

test("truncatePreview preserves head and tail and reports real line counts", () => {
  const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n");
  const result = truncatePreview(lines, 20, 10);
  assert.equal(result.isTruncated, true);
  assert.equal(result.originalLines, 150);
  assert.equal(result.includedLines, 31);
  assert.ok(result.content.startsWith("line 1\n"));
  assert.ok(result.content.endsWith("\nline 150"));
  assert.ok(result.content.includes("120 lines omitted"));

  const small = truncatePreview("a\nb", 20, 10);
  assert.equal(small.isTruncated, false);
  assert.equal(small.originalLines, 2);
  assert.equal(small.includedLines, 2);
});

test("summarizeJson and summarizeMarkdown extract structured summaries", () => {
  const jsonSummary = summarizeJson('{"name":"app","version":"1.0.0","scripts":{}}');
  assert.equal(jsonSummary.shape, "object");
  assert.equal(jsonSummary.itemCount, 3);
  assert.ok(jsonSummary.keys.includes("name"));

  assert.equal(summarizeJson("[1,2,3]").shape, "array");
  assert.equal(summarizeJson("{bad").shape, "invalid-json");
  assert.equal(summarizeJson("\uFEFF{\"a\":1}").shape, "object");

  const mdSummary = summarizeMarkdown("# Title\n\n## Subtitle\n\n---\nname: x\n---\n");
  assert.equal(mdSummary.headings.length, 2);
  assert.equal(mdSummary.headings[0], "# Title");
  assert.equal(mdSummary.headings[1], "## Subtitle");
});

test("summarizeTypeScriptSource extracts declarations, directives and exports", () => {
  const source = `
    "use client";
    import { useState } from "react";
    import type { User } from "./types";

    export interface Props { id: string }
    export type Status = "active" | "idle";
    export function useCounter() { return useState(0); }
    export function UserCard(props: Props) { return <div>{props.id}</div>; }
    export async function GET(req: Request) { return new Response("ok"); }
    function notExportedRoute() {}
    export const PATCH = () => null;
    const notExported = 1;
    export * from "./star";
    export default function () {}
  `;
  const summary = summarizeTypeScriptSource("src/test.tsx", source);

  assert.deepEqual(summary.directives, ["use client"]);
  assert.ok(summary.imports.includes("react"));
  assert.ok(summary.imports.includes("./star"), "export * records its specifier");
  assert.ok(summary.reExports.includes("./star"), "export * is tracked separately");
  assert.ok(summary.interfaces.includes("Props"));
  assert.ok(summary.types.includes("Status"));
  assert.ok(summary.hooks.includes("useCounter"));
  assert.ok(summary.reactComponents.includes("UserCard"));
  assert.ok(summary.exports.includes("default"), "anonymous default export is recorded");

  // Route handlers must be exported, uniformly for functions and variables.
  assert.deepEqual(summary.routeHandlers, ["GET", "PATCH"]);
  assert.ok(!summary.routeHandlers.includes("notExportedRoute"));
});

test("a deeply nested source file no longer overflows the stack", () => {
  const chain = Array.from({ length: 20000 }, (_, i) => `a${i}`).join(" && ");
  const summary = summarizeTypeScriptSource("src/chain.js", `const x = ${chain};`);
  assert.ok(summary.variables.includes("x"));
});

test("generateProjectTree is deterministic and marks directories", () => {
  const tree = generateProjectTree(["src/app/page.tsx", "src/lib/utils.ts", "package.json"]);
  assert.ok(tree.includes("package.json"));
  assert.ok(tree.includes("src/"));
  assert.ok(tree.includes("page.tsx"));

  const a = generateProjectTree(["B.ts", "a.ts", "Ä.ts"]);
  const b = generateProjectTree(["B.ts", "a.ts", "Ä.ts"]);
  assert.equal(a, b, "ordering must not depend on locale");
});

test("anchorForPath is stable and injective", () => {
  assert.equal(anchorForPath("src/a.ts"), anchorForPath("src/a.ts"));
  assert.notEqual(anchorForPath("src/a-b.ts"), anchorForPath("src/a/b.ts"));
  assert.match(anchorForPath("src/App.Page.tsx"), /^[a-z0-9-]+$/);
});

// ------------------------------------------------------------ path matching

test("parseByteSize accepts raw bytes and human-readable units", () => {
  assert.equal(parseByteSize(122880), 122880);
  assert.equal(parseByteSize("122880"), 122880);
  assert.equal(parseByteSize("120k"), 122880);
  assert.equal(parseByteSize("120KB"), 122880);
  assert.equal(parseByteSize("120 kib"), 122880);
  assert.equal(parseByteSize("1.5mb"), 1572864);
  assert.equal(parseByteSize("2 GB"), 2147483648);
  // Anything unreadable is `undefined`, so callers can fail loudly instead of
  // silently falling back to the default budget.
  for (const bad of ["12x", "", "k", "1.2.3mb", "abc"]) {
    assert.equal(parseByteSize(bad), undefined, `"${bad}" should not parse`);
  }
  assert.equal(parseByteSize(Number.NaN), undefined);
  assert.equal(parseByteSize(null), undefined);
});

test("resolveConfig accepts human-readable budgets and rejects nonsense", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytes-"));
  const config = resolveConfig({ cwd: dir, maxPartBytes: "120k", largeFileBytes: "1mb" });
  assert.equal(config.maxPartBytes, 122880);
  assert.equal(config.largeFileBytes, 1048576);
  assert.equal(config.maxMonolithBytes, null);

  assert.throws(() => resolveConfig({ cwd: dir, maxPartBytes: "12x" }), /byte count/);
  assert.throws(() => resolveConfig({ cwd: dir, include: "src/**" }), /array of glob strings/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("globToRegExp supports brace groups and character classes", () => {
  const extensions = globToRegExp("*.{ts,tsx}");
  assert.ok(extensions.test("a.ts"), "a.ts should match *.{ts,tsx}");
  assert.ok(extensions.test("deep/b.tsx"), "b.tsx should match *.{ts,tsx}");
  assert.ok(!extensions.test("c.js"), "c.js should not match *.{ts,tsx}");

  assert.ok(globToRegExp("src/[ab].ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/[!ab].ts").test("src/a.ts"));
  assert.ok(globToRegExp("src/[!ab].ts").test("src/c.ts"));
});

test("summarizeJson reads JSONC comments and ignores comment-like strings", () => {
  const summary = summarizeJson(
    ['{', '  // line comment', '  "a": 1, /* block */', '  "b": "http://x//y"', "}"].join("\n")
  );
  assert.equal(summary.shape, "object");
  assert.deepEqual(summary.keys, ["a", "b"], "a URL must not be treated as a comment");
});

test("named default exports record both the name and default", () => {
  const summary = summarizeTypeScriptSource(
    "a.ts",
    "export default function Foo() { return 1; }\n"
  );
  assert.ok(summary.exports.includes("Foo"));
  assert.ok(summary.exports.includes("default"), "the default export must be recorded");

  const klass = summarizeTypeScriptSource("b.ts", "export default class Bar {}\n");
  assert.ok(klass.exports.includes("default"));
});

test("syntax errors are surfaced on the summary instead of looking clean", () => {
  const summary = summarizeTypeScriptSource("broken.ts", "export function ( {\n");
  assert.ok(
    typeof summary.parseErrors === "number" && summary.parseErrors > 0,
    `expected parse errors, got ${JSON.stringify(summary.parseErrors)}`
  );

  const fine = summarizeTypeScriptSource("ok.ts", "export const a = 1;\n");
  assert.equal(fine.parseErrors, undefined);
});

test("globToRegExp and matchesExclude use segment semantics", () => {
  assert.equal(matchesExclude("test/a.ts", "test"), true);
  assert.equal(matchesExclude("src/test/b.ts", "test"), true);
  assert.equal(matchesExclude("contest/entry.ts", "test"), false, "substring match is a bug");
  assert.equal(matchesExclude("attest/words.ts", "test"), false);
  assert.equal(matchesExclude("tests/fixtures/a.ts", "tests/fixtures"), true);
  assert.equal(matchesExclude("src/app/main.ts", "**/*.ts"), true);
  assert.equal(matchesExclude("src/app/main.js", "**/*.ts"), false);
  assert.equal(globToRegExp("**/*.ts").test("a/b/c.ts"), true);
});

test("matchRule gives globs real path-boundary semantics", () => {
  assert.equal(matchRule("src/app/route.ts", "src/app/**"), true);
  assert.equal(matchRule("src/apple/pie.ts", "src/app/**"), false, "must not match src/apple");
  assert.equal(matchRule("src/application/server.ts", "src/app/**"), false);
  assert.equal(matchRule("src/app2/x.ts", "src/app/**"), false);
  assert.equal(matchRule("src/features/x/y.ts", "**/features/**"), true);
  assert.equal(matchRule("a.test.ts", /\.test\.ts$/), true);
  const stateful = /x/g;
  assert.equal(matchRule("x", stateful), true);
  assert.equal(matchRule("x", stateful), true, "a /g rule must not be stateful");
});

test("isSensitivePath protects credential files but not templates", () => {
  for (const sensitive of [
    ".env",
    ".env.local",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    "id_rsa",
    "keys/id_ed25519",
    "certs/server.pem",
    "server.key",
    ".kube/config",
    "infra/terraform.tfstate",
  ]) {
    assert.equal(isSensitivePath(sensitive), true, `${sensitive} should be sensitive`);
  }
  for (const deep of [
    ".env.production.local",
    ".env.a.b.c",
    ".env.development",
    ".env-",
    ".env_",
    ".envbackup",
    ".env_backup",
    ".netrc.bak",
    ".npmrc.bak",
    "id_rsa.bak",
    "credentials.json",
    "service-account.json",
    "secrets.json",
    "terraform.tfvars",
  ]) {
    assert.equal(isSensitivePath(deep), true, `${deep} should be sensitive`);
  }
  for (const safe of [
    ".env.example",
    ".env.sample",
    ".env.production.example",
    "credentials.example.json",
    "id_rsa.template",
    ".npmrc.sample",
    ".environment",
    "src/index.ts",
    "certs/server.crt",
  ]) {
    assert.equal(isSensitivePath(safe), false, `${safe} should not be sensitive`);
  }
});

// -------------------------------------------------------------------- config

test("defineConfig is identity and resolveConfig applies defaults", () => {
  const config = defineConfig({ branch: "trunk" });
  assert.equal(config.branch, "trunk");

  const resolved = resolveConfig({ branch: "trunk" }, undefined, process.cwd());
  assert.equal(resolved.branch, "trunk");
  assert.equal(resolved.outDir, "snapshot");
  assert.equal(resolved.tmpDir, "snapshot.tmp");
  assert.equal(resolved.includeSensitiveFiles, false);
  assert.ok(resolved.maxPartBytes >= 4096);
  assert.ok(resolved.secretRules.length >= DEFAULT_SECRET_PATTERNS.length);
  assert.equal(isResolvedConfig(resolved), true);
  assert.equal(isResolvedConfig(config), false);
});

test("resolveConfig honours CLI overrides and rejects a bad cwd", () => {
  const resolved = resolveConfig({}, { cwd: process.cwd(), maxPartBytes: 8192 }, undefined);
  assert.equal(resolved.maxPartBytes, 8192);
  assert.throws(() => resolveConfig({}, { cwd: path.join(os.tmpdir(), "nope-does-not-exist-xyz") }), /does not exist/);
  assert.throws(
    () => resolveConfig({ maxPartBytes: 512 }, undefined, process.cwd()),
    /at least 4096/,
    "a budget smaller than a part header must be rejected, not silently clamped"
  );
});

test("resolveConfig compiles string custom patterns from JSON configs", () => {
  const resolved = resolveConfig(
    { secrets: { customPatterns: [{ rule: "corp", pattern: "CORP-[A-Z0-9]{8}" }] } },
    undefined,
    process.cwd()
  );
  const rule = resolved.secretRules.find((entry) => entry.rule === "corp");
  assert.ok(rule);
  assert.ok(rule.pattern instanceof RegExp);
});

test("resolveConfig strips stateful flags from custom patterns", () => {
  const resolved = resolveConfig(
    { secrets: { customPatterns: [{ rule: "tok", pattern: "/TOK_[0-9]+/g" }] } },
    undefined,
    process.cwd()
  );
  const rule = resolved.secretRules.find((entry) => entry.rule === "tok");
  assert.ok(rule);
  assert.ok(!rule.pattern.flags.includes("g"));
});

test("detectPreset recognises the shipped presets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-"));
  const setPackage = (deps, extra = {}) =>
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ ...extra, dependencies: deps }));

  setPackage({ next: "15.0.0" });
  assert.equal(detectPreset(dir).presetName, "nextjs");

  setPackage({ nuxt: "3.0.0" });
  assert.equal(detectPreset(dir).presetName, "nuxt");

  setPackage({ "@sveltejs/kit": "2.0.0" });
  assert.equal(detectPreset(dir).presetName, "sveltekit");

  setPackage({ astro: "4.0.0" });
  assert.equal(detectPreset(dir).presetName, "astro");

  setPackage({ "@angular/core": "17.0.0" });
  assert.equal(detectPreset(dir).presetName, "angular");

  setPackage({ react: "18.0.0", vite: "6.0.0" });
  assert.equal(detectPreset(dir).presetName, "react-vite");

  setPackage({ vue: "3.0.0", vite: "6.0.0" });
  assert.equal(detectPreset(dir).presetName, "vue-vite");

  setPackage({ "@nestjs/core": "10.0.0" });
  assert.equal(detectPreset(dir).presetName, "nest");

  setPackage({ express: "4.0.0" });
  assert.equal(detectPreset(dir).presetName, "node-express");

  // A workspace root is a monorepo, not just another package.
  setPackage({}, { workspaces: ["packages/*"] });
  assert.equal(detectPreset(dir).presetName, "monorepo");

  setPackage({});
  assert.equal(detectPreset(dir).presetName, "node-lib");
  fs.rmSync(dir, { recursive: true, force: true });

  const fixture = (prefix, files) => {
    const made = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(made, name), body);
    return made;
  };

  const go = fixture("preset-go-", { "go.mod": "module example.com/app\n" });
  assert.equal(detectPreset(go).presetName, "go");
  fs.rmSync(go, { recursive: true, force: true });

  const rust = fixture("preset-rs-", { "Cargo.toml": '[package]\nname = "x"\n' });
  assert.equal(detectPreset(rust).presetName, "rust");
  fs.rmSync(rust, { recursive: true, force: true });

  const django = fixture("preset-py-", { "manage.py": "print('x')\n" });
  assert.equal(detectPreset(django).presetName, "python-django");
  fs.rmSync(django, { recursive: true, force: true });

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "preset-empty-"));
  assert.equal(detectPreset(empty).presetName, "generic");
  fs.rmSync(empty, { recursive: true, force: true });
});

test("the preset registry exposes every preset and honours a forced preset", () => {
  const names = listPresetNames();
  for (const expected of [
    "nextjs", "nuxt", "sveltekit", "remix", "astro", "angular", "solid",
    "vue-vite", "react-vite", "nest", "node-express", "node-lib",
    "python-django", "python-fastapi", "python-lib", "go", "rust",
    "java-spring", "dotnet", "php-laravel", "ruby-rails",
    "monorepo", "docs", "infra", "generic",
  ]) {
    assert.ok(names.includes(expected), `missing preset ${expected}`);
  }
  assert.ok(names.length >= 25, `expected at least 25 presets, got ${names.length}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-force-"));
  fs.writeFileSync(path.join(dir, "go.mod"), "module x\n");

  assert.equal(detectPreset(dir).presetName, "go");
  assert.equal(detectPreset(dir, "react-vite").presetName, "react-vite", "a forced preset wins");
  assert.throws(() => resolveConfig({ cwd: dir, preset: "nope" }), /Unknown preset/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadConfigFile reads json, mjs and ts configs and reports failures", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  fs.writeFileSync(path.join(dir, "snapshot.config.json"), JSON.stringify({ branch: "json-branch" }));
  const fromJson = await loadConfigFile(dir);
  assert.equal(fromJson.branch, "json-branch");

  const broken = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-broken-"));
  fs.writeFileSync(path.join(broken, "snapshot.config.mjs"), "export default { branch: ");
  const detailed = await loadConfigFileDetailed(broken);
  assert.equal(detailed.config, null);
  assert.ok(detailed.warnings.length > 0, "a broken config must be reported, not swallowed");
  assert.ok(detailed.errors.length > 0, "a broken config is fatal, not a silent fallback to defaults");

  if (supportsTypeScriptImports()) {
    const tsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-ts-"));
    fs.writeFileSync(path.join(tsDir, "snapshot.config.ts"), "export default { branch: 'ts-branch' };\n");
    const fromTs = await loadConfigFile(tsDir);
    assert.equal(fromTs.branch, "ts-branch");
    fs.rmSync(tsDir, { recursive: true, force: true });
  }

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(broken, { recursive: true, force: true });
});

// ------------------------------------------------------------------ security

test("scanAndRedactSecrets redacts only the matched span", () => {
  const code =
    'export const awsKey = "AKIAIOSFODNN7EXAMPLE"; export const region = "us-east-1"; const retries = 3;';
  const { redacted, findings } = scanAndRedactSecrets(code, DEFAULT_SECRET_PATTERNS, "test.ts");

  assert.ok(!redacted.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(redacted.includes("us-east-1"), "unrelated code on the same line must survive");
  assert.ok(redacted.includes("retries"));
  assert.equal(findings[0].rule, "aws-access-key-id");
  assert.equal(findings[0].path, "test.ts");
});

test("secret findings never carry source text", () => {
  const { findings } = scanAndRedactSecrets(
    'const k = "AKIAIOSFODNN7EXAMPLE";',
    DEFAULT_SECRET_PATTERNS,
    "a.ts"
  );
  const serialized = JSON.stringify(findings);
  assert.ok(!serialized.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.equal(findings[0].snippet, undefined, "the snippet field was the audit.md leak vector");
});

test("multi-line private keys are redacted as a block", () => {
  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAsecretbodyline1",
    "secretbodyline2",
    "-----END RSA PRIVATE KEY-----",
    "after = 1;",
  ].join("\n");
  const { redacted, findings } = scanAndRedactSecrets(pem, DEFAULT_SECRET_PATTERNS, "id_rsa");

  assert.ok(!redacted.includes("secretbodyline1"));
  assert.ok(!redacted.includes("secretbodyline2"));
  assert.ok(!redacted.includes("-----END RSA PRIVATE KEY-----"));
  assert.ok(redacted.includes("after = 1;"));
  assert.ok(findings.some((finding) => finding.rule === "private-key-block"));
});

test("an unterminated private key block (cut by truncation) is still redacted", () => {
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n";
  const { redacted } = scanAndRedactSecrets(pem, DEFAULT_SECRET_PATTERNS, "id_ed25519");
  assert.ok(!redacted.includes("b3BlbnNzaC1rZXktdjEAAAAA"));
});

test("default patterns cover modern vendor formats and .env assignments", () => {
  const samples = [
    ['OPENAI_API_KEY=sk-proj-AAAA1111BBBB2222CCCC3333', "modern/llm provider keys"],
    ["const k = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa';", "anthropic keys"],
    ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "npm tokens"],
    ["DB_PASSWORD=hunter2", "unquoted .env assignment"],
    ["SECRET_KEY=supersecretvalue123", "unquoted .env assignment"],
    ["https://user:s3cr3tpass@example.com/repo.git", "basic-auth URL"],
    ["GOCSPX-abcdefghijklmnopqrstuvwxyz12", "google oauth secret"],
    ["github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789", "github fine-grained PAT"],
    ["SG." + "a".repeat(22) + "." + "b".repeat(43), "sendgrid keys"],
    ["dop_v1_" + "a".repeat(64), "digitalocean tokens"],
    ["AKIAIOSFODNN7EXAMPLE", "aws access key ids"],
    ['"aws_secret_access_key": "' + "a".repeat(40) + '"', "aws secret in JSON"],
    // `.invalid` is a reserved TLD that can never resolve, so this fixture
    // exercises the database-uri rule without ever resembling a usable
    // credential (and without tripping secret scanning).
    ["mongodb+srv://testuser:testpass@example.invalid/prod", "database URIs"],
  ];

  for (const [sample, label] of samples) {
    const { redacted } = scanAndRedactSecrets(sample, DEFAULT_SECRET_PATTERNS, "sample.txt");
    assert.ok(redacted.includes("[REDACTED"), `${label} must be redacted: ${sample}`);
  }
});

test("ordinary source is not over-redacted", () => {
  const clean = [
    "export function add(a: number, b: number) { return a + b; }",
    "const tokenizer = new Tokenizer();",
    "password: req.body.password,",
    "if (authToken !== undefined) return;",
    "const url = 'https://example.com/api/v1';",
    "MAX_RETRIES = 3",
    "const region = 'us-east-1';",
  ];
  for (const line of clean) {
    const { redacted } = scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, "clean.ts");
    assert.equal(redacted, line, `false positive on: ${line}`);
  }
});

test("a stateful /g custom rule does not skip every other match", () => {
  const rule = { rule: "custom-token", pattern: /^X=SECRET_[A-Z]+$/g };
  const content = Array.from({ length: 8 }, () => "X=SECRET_ABC").join("\n");
  const { redacted, findings } = scanAndRedactSecrets(content, [rule], "a.txt");

  assert.equal(redacted.split("\n").filter((line) => line.includes("[REDACTED")).length, 8);
  assert.equal(findings.length, 8);
});

test("no default rule is quadratic on a long single line", () => {
  // A single 240 KB identifier used to cost ~5.6 s of CPU in
  // `env-secret-assignment` because the name was matched with unbounded
  // quantifiers on both sides of the keyword alternation.
  const shapes = [
    "A".repeat(240000),
    ("API_KEY=" + "x".repeat(50) + " ").repeat(4000),
    "eyJ".repeat(60000),
    "a".repeat(240000) + "_TOKEN",
  ];
  for (const shape of shapes) {
    const started = performance.now();
    scanAndRedactSecrets(shape, DEFAULT_SECRET_PATTERNS, "probe.txt");
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1500, `scanning ${shape.length} chars took ${elapsed.toFixed(0)}ms`);
  }
});

test("jwt rule is not quadratic on an eyJ-dense line", () => {
  const line = "eyJ".repeat(20000);
  const started = performance.now();
  scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, "blob.txt");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `JWT scan took ${elapsed.toFixed(0)}ms on a 60KB eyJ-dense line`);
  assert.deepEqual(ruleFlagsWithoutState(DEFAULT_SECRET_PATTERNS), []);
});

function ruleFlagsWithoutState(rules) {
  return rules.filter((rule) => /[gy]/.test(rule.pattern.flags)).map((rule) => rule.rule);
}

// ------------------------------------------------------------ language profiles

test("language profiles extract structure for Python", () => {
  const { summary, quality } = summarizeWithProfile(
    "app/models.py",
    [
      "import os",
      "from django.db import models",
      "class User(models.Model):",
      "    def save(self):",
      "        pass",
      "def create_user(name):",
      "    return name",
      "@app.get('/health')",
      "def health():",
      "    return 'ok'",
      "MAX_RETRIES = 3",
    ].join("\n")
  );

  assert.equal(quality, "heuristic");
  assert.ok(summary.imports.includes("os"));
  assert.ok(summary.imports.includes("django.db"));
  assert.ok(summary.classes.includes("User"));
  assert.ok(summary.functions.includes("create_user"));
  assert.ok(summary.routeHandlers.includes("health"), "a route decorator marks a handler");
  assert.ok(summary.variables.includes("MAX_RETRIES"));
  assert.ok(summary.exports.includes("create_user"));
  assert.ok(!summary.functions.includes("save"), "methods are not module functions");
});

test("language profiles extract structure for Go", () => {
  const { summary, quality } = summarizeWithProfile(
    "internal/server/handler.go",
    [
      "package server",
      "import (",
      '    "net/http"',
      '    "github.com/gin-gonic/gin"',
      ")",
      "type Server struct {",
      "    Port int",
      "}",
      "type Handler interface {",
      "    Handle()",
      "}",
      "func NewServer() *Server {",
      "    return nil",
      "}",
      "func (s *Server) Start() {}",
      "const MaxRetries = 3",
    ].join("\n")
  );

  assert.equal(quality, "heuristic");
  assert.ok(summary.imports.includes("net/http"));
  assert.ok(summary.imports.includes("github.com/gin-gonic/gin"));
  assert.ok(summary.classes.includes("Server"));
  assert.ok(summary.interfaces.includes("Handler"));
  assert.ok(summary.functions.includes("NewServer"));
  assert.ok(summary.functions.includes("Start"), "methods on a receiver are functions");
  assert.ok(summary.exports.includes("NewServer"), "capitalised identifiers are exported");
  assert.ok(!summary.exports.includes("handle"));
});

test("language profiles extract structure for Rust", () => {
  const { summary } = summarizeWithProfile(
    "src/lib.rs",
    [
      "use std::collections::HashMap;",
      "pub struct Config {",
      "    pub name: String,",
      "}",
      "pub trait Runner {",
      "    fn run(&self);",
      "}",
      "pub fn start() {}",
      "fn private_helper() {}",
      "pub enum Mode { Fast }",
    ].join("\n")
  );

  assert.ok(summary.imports.includes("std::collections::HashMap"));
  assert.ok(summary.classes.includes("Config"));
  assert.ok(summary.interfaces.includes("Runner"));
  assert.ok(summary.enums.includes("Mode"));
  assert.ok(summary.exports.includes("start"));
  assert.ok(!summary.exports.includes("private_helper"), "non-pub items are not exported");
});

test("language profiles extract structure for C#, PHP, Ruby and Java", () => {
  const cs = summarizeWithProfile(
    "Controllers/UserController.cs",
    ["using System.Linq;", "public class UserController {", "    public User Get(int id) { return null; }", "}"].join("\n")
  ).summary;
  assert.ok(cs.imports.includes("System.Linq"));
  assert.ok(cs.classes.includes("UserController"));
  assert.ok(cs.functions.includes("Get"));

  const php = summarizeWithProfile(
    "app/Models/User.php",
    ["namespace App\\Models;", "use Illuminate\\Database\\Eloquent\\Model;", "class User extends Model {", "    public function save() {}", "}"].join("\n")
  ).summary;
  assert.ok(php.imports.some((entry) => entry.includes("Model")));
  assert.ok(php.classes.includes("User"));

  const ruby = summarizeWithProfile(
    "app/models/user.rb",
    ["require 'json'", "class User", "  def save", "  end", "end"].join("\n")
  ).summary;
  assert.ok(ruby.imports.includes("json"));
  assert.ok(ruby.classes.includes("User"));

  const java = summarizeWithProfile(
    "src/main/java/UserService.java",
    ["import java.util.List;", "public class UserService {", "    public List find() { return null; }", "}"].join("\n")
  ).summary;
  assert.ok(java.imports.includes("java.util.List"));
  assert.ok(java.classes.includes("UserService"));
});

test("Vue/Svelte script blocks are parsed with the real compiler", () => {
  const sfc = [
    "<template><div /></template>",
    '<script setup lang="ts">',
    'import { ref } from "vue";',
    "const count = ref(0);",
    "export function increment() { count.value++; }",
    "</script>",
  ].join("\n");

  const { summary, quality } = summarizeWithProfile("src/components/Counter.vue", sfc);
  assert.equal(quality, "ast", "the script block is real TypeScript");
  assert.ok(summary.imports.includes("vue"));
  assert.ok(summary.functions.includes("increment"));
  assert.ok(summary.exports.includes("Counter"));
});

test("a template-only component still gets an index entry", () => {
  const { summary, quality } = summarizeWithProfile("src/Logo.vue", "<template><svg /></template>");
  assert.equal(quality, "heuristic");
  assert.ok(summary.exports.includes("Logo"));
});

// In Astro the leading `---` fence *is* the component script, and most real
// components have no <script> tag at all — so parsing only <script> blocks made
// the common case fall back to heuristic.
test("Astro frontmatter is parsed as TypeScript, not as markup", () => {
  const astro = [
    "---",
    'import Layout from "../layouts/Base.astro";',
    'const title: string = "Hello";',
    "export function greet(name: string) {",
    "  return `hi ${name}`;",
    "}",
    "---",
    "<Layout><h1>{title}</h1></Layout>",
  ].join("\n");

  const { summary, quality } = summarizeWithProfile("src/pages/index.astro", astro);
  assert.equal(quality, "ast", "the --- fence is the component script");
  assert.ok(summary.imports.length > 0, "imports come from the frontmatter");
  assert.ok(summary.functions.includes("greet"), "frontmatter functions are extracted");
  assert.ok(summary.exports.includes("index"), "the component is still indexed");
});

test("an Astro <script> tag still works without frontmatter", () => {
  const { summary, quality } = summarizeWithProfile(
    "src/pages/plain.astro",
    "<h1>Hi</h1>\n<script>\nexport function ping() { return 1; }\n</script>\n"
  );
  assert.equal(quality, "ast");
  assert.ok(summary.functions.includes("ping"));
});

test("files no profile claims are left alone", () => {
  assert.equal(profileForPath("notes.txt"), null);
  assert.equal(profileForPath("Makefile"), null);
  assert.equal(summarizeWithProfile("notes.txt", "hello"), null);
  assert.equal(profileForPath("app.module.ts"), null, "TypeScript is handled by the compiler, not a profile");
  assert.equal(profileForPath("main.py").id, "python");
});

// ---------------------------------------------------------------------- wizard

const quietIO = {
  input: { isTTY: false },
  output: { isTTY: false, write() {} },
};

test("the generated config exposes every setting at its default", () => {
  const text = renderConfig(DEFAULT_ANSWERS);

  for (const key of [
    "preset:", "branch:", "outDir:", "tmpDir:", "maxPartBytes:", "largeFileBytes:",
    "previewHeadLines:", "previewTailLines:", "budgets:", "include:", "excludePatterns:",
    "discovery:",
    "layersMode:", "layers:", "kinds:", "includeSensitiveFiles:", "secrets:",
    "customPatterns:", "disableDefaultPatterns:", "artifacts:", "maxMonolithBytes:", "hooks:",
  ]) {
    assert.ok(text.includes(key), `config should mention ${key}`);
  }

  // Every artifact by name, so nobody has to guess what is available.
  for (const artifact of ["readme", "manifest", "parts", "navigation", "projectTree", "audit", "monolith"]) {
    assert.ok(new RegExp(`\\b${artifact}:`).test(text), `config should mention artifact ${artifact}`);
  }

  // Deliberately no package import: `snap init` usually runs through npx, where
  // the package is not installed, and an import made the file unloadable.
  assert.ok(text.includes("export default {"));
  assert.ok(!text.includes("defineConfig"));
  assert.ok(text.includes("// ── Size"), "sections are grouped for scanning");
});

test("runInit writes a config from flags without a TTY", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  fs.writeFileSync(path.join(dir, "go.mod"), "module x\n");

  const result = await runInit({ cwd: dir, yes: true, io: quietIO, maxPartBytes: "120k" });
  assert.equal(result.written, true);
  assert.equal(result.preset, "go", "the detected preset is used");
  assert.ok(result.configText.includes('maxPartBytes: "120k"'));
  // One canonical config: the settings the run did not touch are still listed, because
  // this file is where the user goes to change them.
  assert.ok(result.configText.includes("previewHeadLines:"), "the complete config is the only shape");

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.snapshot, "npx @ankurhalder/codebase-snapshot generate");
  assert.equal(pkg.scripts["snapshot:validate"], "npx @ankurhalder/codebase-snapshot validate");
  // Without this entry nothing reaches node_modules and `npm run snapshot` resolves
  // @latest from the registry on every run.
  assert.match(
    String(pkg.devDependencies["@ankurhalder/codebase-snapshot"]),
    /^\^4\./,
    "the package is declared as a devDependency"
  );
  assert.equal(result.dependency.added, true);
  assert.ok(fs.readFileSync(path.join(dir, ".gitignore"), "utf8").includes("snapshot/"));
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    [".gitignore", "go.mod", "package.json", "snapshot.config.mjs"],
    "no markdown or agent file is part of an install"
  );

  await assert.rejects(() => runInit({ cwd: dir, yes: true, io: quietIO }), /already exists/);
  const forced = await runInit({ cwd: dir, yes: true, io: quietIO, force: true });
  assert.equal(forced.written, true, "--force overwrites");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("runInit keeps a version the project already pinned", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-pin-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0", devDependencies: { "@ankurhalder/codebase-snapshot": "4.0.0" } })
  );
  fs.writeFileSync(path.join(dir, "go.mod"), "module x\n");

  const result = await runInit({ cwd: dir, yes: true, io: quietIO });

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.devDependencies["@ankurhalder/codebase-snapshot"], "4.0.0", "a pin is a decision");
  assert.equal(result.dependency.added, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("runInit --dry-run renders without touching the disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-dry-"));
  fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "x"\n');

  const result = await runInit({ cwd: dir, yes: true, io: quietIO, dryRun: true });
  assert.equal(result.written, false);
  assert.equal(result.preset, "rust");
  assert.ok(result.configText.includes('preset: "rust"'));
  assert.equal(fs.existsSync(result.configPath), false);
  assert.equal(fs.existsSync(path.join(dir, ".gitignore")), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("runInit honours the artifact selection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-art-"));
  const result = await runInit({ cwd: dir, yes: true, io: quietIO, onlyArtifacts: ["parts"] });

  assert.ok(/parts: true/.test(result.configText));
  assert.ok(/audit: false/.test(result.configText));
  assert.ok(/readme: false/.test(result.configText));

  fs.rmSync(dir, { recursive: true, force: true });
});
