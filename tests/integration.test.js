import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  GENERATOR_VERSION,
  SCHEMA_VERSION,
  generateSnapshot,
  isResolvedConfig,
  resolveConfig,
  resolveSafeOutputDirs,
  validateSnapshot,
} from "../dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");
const PACKAGE_JSON = JSON.parse(
  fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")
);

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEASENTINELBODYSECRET1234567890abcdefghijklmn",
  "mnopqrstuvwxyzSENTINELBODYSECRET111111111111111111111111111",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

function makeRepo(prefix, files, { git = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"],
      { cwd: dir, stdio: "ignore" }
    );
  }
  return dir;
}

function readAll(root) {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  })(root);
  return out;
}

function readAllText(root) {
  return readAll(root)
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}

function runCli(cliArgs) {
  const result = spawnSync(process.execPath, [BIN, ...cliArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const baseConfig = (cwd, overrides = {}) =>
  resolveConfig({ cwd, outDir: "snapshot", tmpDir: "snapshot.tmp", ...overrides });

// -------------------------------------------------------------- version sync

test("GENERATOR_VERSION matches package.json", () => {
  assert.equal(GENERATOR_VERSION, PACKAGE_JSON.version);
});

// ------------------------------------------------------------------ generate

test("generate writes the documented layout exactly once", () => {
  const dir = makeRepo("gen-", {
    "package.json": '{"name":"fixture"}',
    "src/index.ts": "export const message = 'hello';\n",
    "README.md": "# Fixture\n",
  });

  const manifest = generateSnapshot(baseConfig(dir));

  assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
  assert.equal(manifest.counts.totalFiles, 3);
  for (const rel of [
    "manifest.json",
    "README.md",
    "parts/part-001.md",
    "reports/navigation.md",
    "reports/project-tree.md",
    "reports/audit.md",
  ]) {
    assert.ok(fs.existsSync(path.join(dir, "snapshot", rel)), `${rel} should exist`);
  }
  assert.equal(
    fs.existsSync(path.join(dir, "snapshot", "project-tree.md")),
    false,
    "the duplicate root project-tree.md must not be written"
  );
  assert.equal(fs.existsSync(path.join(dir, "snapshot.tmp")), false, "tmp dir is consumed");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("no artifact leaks a redacted secret", () => {
  const dir = makeRepo("leak-", {
    "package.json": '{"name":"fixture"}',
    "src/aws.ts": `export const awsKey = "${AWS_KEY}"; export const region = "us-east-1";\n`,
    "src/key.pem": `${PEM}\n`,
    ".env": "DB_PASSWORD=hunter2\nOPENAI_API_KEY=sk-proj-AAAA1111BBBB2222CCCC3333\n",
  });

  const manifest = generateSnapshot(baseConfig(dir));
  const text = readAllText(path.join(dir, "snapshot"));

  assert.ok(!text.includes(AWS_KEY), "the audit report must not re-print a redacted secret");
  assert.ok(!text.includes("SENTINELBODYSECRET"), "private key bodies must be redacted");
  assert.ok(!text.includes("hunter2"), ".env values must never reach the snapshot");
  assert.ok(!text.includes("sk-proj-AAAA1111"), "vendor keys must never reach the snapshot");

  // Sensitive files are skipped, not silently dropped.
  assert.equal(manifest.files.some((file) => file.relativePath === ".env"), false);
  assert.ok(manifest.skipped.some((skip) => skip.reason === "sensitive-file"));

  // Span-only redaction keeps the rest of the line.
  const parts = readAll(path.join(dir, "snapshot", "parts")).map((file) =>
    fs.readFileSync(file, "utf8")
  );
  assert.ok(parts.some((content) => content.includes("us-east-1")));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("sensitive files are included only when explicitly requested", () => {
  const dir = makeRepo("sens-", {
    "package.json": '{"name":"fixture"}',
    ".env.local": "API_TOKEN=tok_value_123456\n",
  });
  const manifest = generateSnapshot(
    baseConfig(dir, { includeSensitiveFiles: true })
  );
  assert.ok(manifest.files.some((file) => file.relativePath === ".env.local"));
  assert.equal(manifest.config.includeSensitiveFiles, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("manifest reports truthful totals, inclusion modes and indexes", () => {
  const bigLine = `${Array.from({ length: 12 }, (_, i) => (i === 5 ? `export const blob = "${"a".repeat(50000)}";` : `export const v${i} = ${i};`)).join("\n")}\n`;
  const dir = makeRepo("truth-", {
    "package.json": '{"name":"fixture"}',
    "src/a.ts": "import './b';\nexport const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
    "src/big.ts": bigLine,
  });

  const manifest = generateSnapshot(
    baseConfig(dir, { largeFileBytes: 1000, previewHeadLines: 2, previewTailLines: 1 })
  );

  const big = manifest.files.find((file) => file.relativePath === "src/big.ts");
  assert.ok(big.isLarge);
  assert.equal(big.isPreviewTruncated, true);
  assert.equal(big.inclusionMode, "preview");

  assert.equal(
    manifest.totals.fullFiles + manifest.totals.previewFiles,
    manifest.totals.includedFiles
  );
  assert.equal(manifest.totals.previewFiles, manifest.counts.truncatedPreviewCount);
  assert.notEqual(
    manifest.totals.totalContentBytes,
    manifest.totals.totalSourceBytes,
    "emitted bytes must be measured, not mirrored from source bytes"
  );

  assert.ok(manifest.indexes.imports.byFile.length >= 2, "imports index must be populated");
  assert.ok(
    manifest.indexes.imports.byFile.some((entry) => entry.path === "src/a.ts"),
    "per-file imports must be recorded"
  );
  assert.ok(Array.isArray(manifest.indexes.directives));
  assert.equal(manifest.validation.status, "passed");
  assert.deepEqual(manifest.validation.errors, []);
  assert.equal(manifest.generator.version, PACKAGE_JSON.version);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("navigation anchors resolve to anchors emitted in the parts", () => {
  const dir = makeRepo("anchor-", {
    "package.json": '{"name":"fixture"}',
    "src/x.ts": "export const x = 1;\n",
    "src/y.ts": "export const y = 2;\n",
  });
  generateSnapshot(baseConfig(dir));

  const navigation = fs.readFileSync(path.join(dir, "snapshot", "reports", "navigation.md"), "utf8");
  const partText = readAll(path.join(dir, "snapshot", "parts"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");

  const anchors = [...navigation.matchAll(/\.\.\/parts\/[^)#]*#([a-z0-9-]+)\)/g)].map((m) => m[1]);
  assert.ok(anchors.length >= 2, "navigation must link to files");
  for (const anchor of anchors) {
    assert.ok(
      partText.includes(`<a id="${anchor}"></a>`),
      `anchor ${anchor} is not emitted by any part`
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the part byte budget is a hard bound", () => {
  const dir = makeRepo("budget-", {
    "package.json": '{"name":"fixture"}',
    "vendor.min.js": "const a=1;".repeat(200000),
    "src/small.ts": "export const s = 1;\n",
  });
  const maxPartBytes = 100 * 1024;
  const manifest = generateSnapshot(
    baseConfig(dir, { maxPartBytes, largeFileBytes: 50 * 1024 })
  );

  assert.ok(manifest.parts.length >= 1);
  for (const part of manifest.parts) {
    assert.ok(
      part.byteSize <= maxPartBytes,
      `${part.filename} is ${part.byteSize}B, budget ${maxPartBytes}B`
    );
    const onDisk = fs.statSync(path.join(dir, "snapshot", "parts", part.filename)).size;
    assert.equal(onDisk, part.byteSize, "recorded byteSize must equal the file on disk");
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("non-ASCII filenames are preserved", () => {
  const dir = makeRepo("unicode-", {
    "package.json": '{"name":"fixture"}',
    "src/café.ts": "export const a = 1;\n",
    "src/日本語.ts": "export const b = 2;\n",
  });
  const manifest = generateSnapshot(baseConfig(dir));
  const paths = manifest.files.map((file) => file.relativePath);
  assert.ok(paths.includes("src/café.ts"));
  assert.ok(paths.includes("src/日本語.ts"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the non-git fallback honours .gitignore and still skips secrets", () => {
  const dir = makeRepo(
    "nogit-",
    {
      "package.json": '{"name":"fixture"}',
      ".gitignore": "secret-notes.txt\n.env\n",
      "secret-notes.txt": "note\n",
      ".env": "API_TOKEN=tok_1234567890\n",
      "src/app.ts": "export const a = 1;\n",
    },
    { git: false }
  );

  const manifest = generateSnapshot(baseConfig(dir));
  const paths = manifest.files.map((file) => file.relativePath);
  assert.ok(paths.includes("src/app.ts"));
  assert.equal(paths.includes("secret-notes.txt"), false, ".gitignore must be honoured without git");
  assert.equal(paths.includes(".env"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("monolith artifacts are recorded and fenced safely", () => {
  const dir = makeRepo("mono-", {
    "package.json": '{"name":"fixture"}',
    "docs.md": "# Docs\n\n```js\nconst x = 1;\n```\nINJECTED HEADING\n",
  });
  const manifest = generateSnapshot(
    baseConfig(dir, { includeMonolith: true })
  );

  assert.ok(manifest.artifacts.fullJson);
  assert.ok(manifest.artifacts.fullMarkdown);

  const markdown = fs.readFileSync(path.join(dir, "snapshot", "full-codebase.md"), "utf8");
  // The block must not close on the inner 3-backtick fence.
  const fence = markdown.match(/^(`{4,})markdown$/m);
  assert.ok(fence, "a fence longer than the content's longest run must be used");

  const json = fs.readFileSync(path.join(dir, "snapshot", "full-codebase.json"), "utf8");
  assert.equal(JSON.parse(json).manifest.parts.length, manifest.parts.length);

  // The manifest is written once, already containing the artifact digests.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
  assert.ok(onDisk.artifacts.fullJson);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("maxMonolithBytes skips oversized artifacts and records a warning", () => {
  const dir = makeRepo("monomax-", {
    "package.json": '{"name":"fixture"}',
    "src/a.ts": "export const a = 1;\n",
  });
  const manifest = generateSnapshot(
    baseConfig(dir, { includeMonolith: true, maxMonolithBytes: 10 })
  );
  assert.equal(manifest.artifacts.fullJson, null);
  assert.ok(manifest.warnings.some((warning) => warning.includes("maxMonolithBytes")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("monolithContent is not required and the API is synchronous", () => {
  const dir = makeRepo("sync-", { "package.json": '{"name":"fixture"}' });
  const result = generateSnapshot(baseConfig(dir));
  assert.equal(typeof result.then, "undefined", "generateSnapshot must not return a promise");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dry run computes a manifest without touching the disk", () => {
  const dir = makeRepo("dry-", { "package.json": '{"name":"fixture"}' });
  const manifest = generateSnapshot(baseConfig(dir), { dryRun: true });
  assert.equal(manifest.counts.totalFiles, 1);
  assert.equal(fs.existsSync(path.join(dir, "snapshot")), false);
  assert.equal(fs.existsSync(path.join(dir, "snapshot.tmp")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------- output paths

test("unsafe outDir/tmpDir combinations are refused", () => {
  const cwd = process.cwd();
  for (const [outDir, tmpDir] of [
    [".", "snapshot.tmp"],
    ["./", "snapshot.tmp"],
    ["..", "snapshot.tmp"],
    ["out", "out/.tmp"],
    ["out", "out"],
    ["snapshot", "."],
  ]) {
    assert.throws(
      () => resolveSafeOutputDirs({ cwd, outDir, tmpDir }),
      /Refusing to generate/,
      `expected refusal for outDir=${outDir} tmpDir=${tmpDir}`
    );
  }
  assert.doesNotThrow(() => resolveSafeOutputDirs({ cwd, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
});

test("generating over an existing snapshot replaces it atomically", () => {
  const dir = makeRepo("swap-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a=1;\n" });
  generateSnapshot(baseConfig(dir));
  const first = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));

  fs.writeFileSync(path.join(dir, "b.ts"), "export const b=2;\n");
  const second = generateSnapshot(baseConfig(dir));

  assert.equal(first.counts.totalFiles, 2);
  assert.equal(second.counts.totalFiles, 3);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
  assert.equal(onDisk.counts.totalFiles, 3);
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes(".backup-"));
  assert.deepEqual(leftovers, [], "the backup directory must be cleaned up");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ validate

test("validate passes right after generate", () => {
  const dir = makeRepo("val-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a=1;\n" });
  const config = baseConfig(dir);
  generateSnapshot(config);
  const result = validateSnapshot(config);
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.equal(result.manifestPresent, true);
  assert.deepEqual(result.errors, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("validate detects a modified source file", () => {
  const dir = makeRepo("valmod-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a=1;\n" });
  const config = baseConfig(dir);
  generateSnapshot(config);
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a=2;\n");
  const result = validateSnapshot(config);
  assert.equal(result.valid, false);
  assert.equal(result.drift.hashMismatches.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("validate has no phantom drift for invalid UTF-8 files", () => {
  const dir = makeRepo("valutf-", { "package.json": '{"name":"fixture"}' });
  fs.writeFileSync(path.join(dir, "latin1.ts"), Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0xe9, 0x0a]));
  const config = baseConfig(dir);
  generateSnapshot(config);
  const result = validateSnapshot(config);
  assert.equal(result.valid, true, result.errors.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("validate detects a deleted or corrupted part", () => {
  const dir = makeRepo("valpart-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a=1;\n" });
  const config = baseConfig(dir);
  generateSnapshot(config);

  const partPath = path.join(dir, "snapshot", "parts", "part-001.md");
  fs.writeFileSync(partPath, "corrupted");
  const corrupted = validateSnapshot(config);
  assert.equal(corrupted.valid, false);
  assert.ok(corrupted.drift.partIssues.length > 0);

  fs.rmSync(partPath);
  const deleted = validateSnapshot(config);
  assert.equal(deleted.valid, false);
  assert.ok(deleted.drift.partIssues.some((issue) => issue.issue.includes("missing")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("validate detects configuration drift", () => {
  const dir = makeRepo("valcfg-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a=1;\n" });
  generateSnapshot(baseConfig(dir, { maxPartBytes: 64 * 1024 }));
  const result = validateSnapshot(baseConfig(dir, { maxPartBytes: 128 * 1024 }));
  assert.equal(result.valid, false);
  assert.ok(result.drift.configMismatches.some((m) => m.includes("maxPartBytes")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("validate reports a malformed manifest instead of throwing", () => {
  const dir = makeRepo("valbad-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a=1;\n" });
  const config = baseConfig(dir);
  fs.mkdirSync(path.join(dir, "snapshot"), { recursive: true });

  for (const payload of ['{"files":"nope"}', '{"files":[],"skipped":[]}', "not json at all"]) {
    fs.writeFileSync(path.join(dir, "snapshot", "manifest.json"), payload);
    const result = validateSnapshot(config);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.length > 0 && typeof result.errors[0] === "string");
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------- CLI

test("CLI accepts --option=value and emits parseable JSON on stdout", () => {
  const dir = makeRepo("cli-eq-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a=1;\n" });

  const result = runCli(["generate", `--cwd=${dir}`, "--format=json"]);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.counts.totalFiles, 2);
  assert.equal(parsed.schemaVersion, SCHEMA_VERSION);

  const validated = runCli(["validate", `--cwd=${dir}`, "--format", "json"]);
  assert.equal(validated.code, 0);
  assert.equal(JSON.parse(validated.stdout).valid, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI rejects unknown flags, unknown commands and bad numbers", () => {
  assert.equal(runCli(["--nonsense"]).code, 2);
  assert.equal(runCli(["frobnicate"]).code, 2);
  assert.equal(runCli(["generate", "--max-part-bytes", "abc"]).code, 2);
  assert.equal(runCli(["generate", "--max-part-bytes", "100"]).code, 2);
  assert.equal(runCli(["generate", "--format", "yaml"]).code, 2);
  assert.equal(runCli(["generate", "extra"]).code, 2);
  assert.equal(runCli(["--version"]).code, 0);
});

// These flags only configure `init`; they are not runtime overrides. Accepting
// them on `generate` used to be a silent no-op: the run detected its own preset
// while the developer believed --preset had been applied.
test("CLI rejects init-only flags on non-init commands", () => {
  for (const flag of [
    ["--preset", "nextjs"],
    ["--include", "src/**"],
    ["--exclude", "**/*.test.ts"],
    ["--yes"],
    ["--minimal"],
    ["--force"],
  ]) {
    const result = runCli(["generate", ...flag]);
    assert.equal(result.code, 2, `generate ${flag.join(" ")} must be a usage error`);
    assert.match(result.stderr, /only valid with `init`/);
  }
  // ...but they stay valid for init itself.
  const dir = makeRepo("cli-init-only-", { "package.json": '{"name":"fixture"}' });
  const init = runCli(["init", "--preset", "go", "--yes", "--cwd", dir]);
  assert.equal(init.code, 0, init.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A mistyped outDir/tmpDir is a plausible mistake; destroying the directory it
// names is not an acceptable outcome. The swap renames the previous output aside
// and deletes it, and the scratch dir is deleted outright, so both must refuse to
// touch a directory containing anything this generator did not write.
test("generate refuses to replace a directory holding user files", () => {
  for (const [label, config] of [
    ["outDir", { outDir: "src" }],
    ["tmpDir", { tmpDir: "src" }],
  ]) {
    const keep = "export const keep = 1;\n";
    const dir = makeRepo(`cli-safety-${label}-`, {
      "package.json": '{"name":"fixture"}',
      "src/keep.ts": keep,
      "snapshot.config.json": JSON.stringify(config),
    });
    const result = runCli(["generate", "--cwd", dir]);
    assert.equal(result.code, 1, `${label}=src must be refused, got exit ${result.code}`);
    assert.match(result.stderr, /Refusing to replace/);
    assert.equal(
      fs.readFileSync(path.join(dir, "src", "keep.ts"), "utf8"),
      keep,
      `${label}=src must leave the source tree intact`
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("generate refuses when outDir already exists as a file", () => {
  const dir = makeRepo("cli-safety-file-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
    snapshot: "user content that must survive\n",
  });
  const result = runCli(["generate", "--cwd", dir]);
  assert.equal(result.code, 1, `expected exit 1, got ${result.code}`);
  assert.equal(fs.readFileSync(path.join(dir, "snapshot"), "utf8"), "user content that must survive\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("generate accepts an existing empty outDir and re-runs over its own output", () => {
  const dir = makeRepo("cli-safety-empty-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
  });
  fs.mkdirSync(path.join(dir, "snapshot"));
  assert.equal(runCli(["generate", "--cwd", dir]).code, 0, "an empty outDir is replaceable");
  assert.equal(runCli(["generate", "--cwd", dir]).code, 0, "its own output is replaceable");
  fs.rmSync(dir, { recursive: true, force: true });
});

// generate resolves outDir against cwd, so the readers must too — otherwise an
// absolute --out-dir produces "<cwd>\<absolute path>" and reports a missing
// manifest immediately after a successful generate.
test("an absolute --out-dir is honoured by generate, validate, report and explain", () => {
  const dir = makeRepo("cli-abs-out-", {
    "package.json": '{"name":"fixture"}',
    "src/a.ts": "export const a = 1;\n",
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "abs-out-"));
  const out = path.join(outside, "result");

  assert.equal(runCli(["generate", "--cwd", dir, "--out-dir", out]).code, 0);
  assert.ok(fs.existsSync(path.join(out, "manifest.json")), "generate must write to the absolute path");
  assert.equal(runCli(["validate", "--cwd", dir, "--out-dir", out]).code, 0, "validate must find it");
  assert.equal(runCli(["report", "--cwd", dir, "--out-dir", out]).code, 0, "report must find it");
  const explained = runCli(["explain", "src/a.ts", "--cwd", dir, "--out-dir", out]);
  assert.equal(explained.code, 0);
  assert.doesNotMatch(explained.stdout, /not in the last snapshot/, "explain must read the manifest");

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

// docs/configuration.md promises an error listing every valid preset.
test("init rejects an unknown preset instead of falling back to detection", () => {
  const dir = makeRepo("cli-init-badpreset-", { "package.json": '{"name":"fixture"}' });
  const result = runCli(["init", "--yes", "--preset", "nope-9000", "--cwd", dir]);
  assert.equal(result.code, 2, `expected usage error (2), got ${result.code}`);
  assert.match(result.stderr, /Unknown preset "nope-9000"/);
  assert.equal(fs.existsSync(path.join(dir, "snapshot.config.ts")), false, "no config must be written");
  fs.rmSync(dir, { recursive: true, force: true });
});

// A config that exists but cannot be read must fail, not fall back to defaults:
// a silent fallback produces a snapshot with none of the developer's settings.
test("CLI fails when an existing config cannot be parsed", () => {
  const dir = makeRepo("cli-broken-config-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a=1;\n",
    "snapshot.config.json": "{ this is not json",
  });
  const result = runCli(["generate", "--cwd", dir]);
  assert.equal(result.code, 1, `expected exit 1, got ${result.code}: ${result.stderr}`);
  assert.match(result.stderr, /could not be read/);
  assert.equal(fs.existsSync(path.join(dir, "snapshot")), false, "no snapshot must be written");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI --dry-run writes nothing", () => {
  const dir = makeRepo("cli-dry-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a=1;\n" });
  const result = runCli(["generate", "--cwd", dir, "--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Dry run/);
  assert.equal(fs.existsSync(path.join(dir, "snapshot")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI init creates a config the loader can read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-init-"));
  const result = runCli(["init", "--cwd", dir]);
  assert.equal(result.code, 0, result.stderr);
  const created = fs.readdirSync(dir).filter((name) => name.startsWith("snapshot.config."));
  assert.equal(created.length, 1, `expected exactly one config file, got ${created.join(",")}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI exits non-zero when the snapshot has drifted", () => {
  const dir = makeRepo("cli-drift-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a=1;\n" });
  assert.equal(runCli(["generate", "--cwd", dir]).code, 0);
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 99;\n");
  const result = runCli(["validate", "--cwd", dir]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /validation failed/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------ budget vs metadata interplay

test("a summary larger than the part budget is dropped, not emitted oversized", () => {
  const lines = Array.from({ length: 800 }, (_, i) => `export const variable${i} = ${i};`).join("\n");
  const dir = makeRepo("bigsum-", {
    "package.json": '{"name":"fixture"}',
    "src/huge.ts": `${lines}\n`,
  });

  const maxPartBytes = 4096;
  const manifest = generateSnapshot(
    baseConfig(dir, { maxPartBytes, largeFileBytes: 100 })
  );

  for (const part of manifest.parts) {
    assert.ok(part.byteSize <= maxPartBytes, `${part.filename} is ${part.byteSize}B > ${maxPartBytes}B`);
  }
  const entry = manifest.files.find((file) => file.relativePath === "src/huge.ts");
  assert.equal(entry.summaryOmitted, true, "an oversized summary must be dropped and flagged");
  assert.equal(entry.summary, undefined);

  const text = readAllText(path.join(dir, "snapshot"));
  assert.ok(text.includes("Summary: (omitted"), "the omission must be visible in the part");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("counts and totals agree when the byte budget (not the line preview) truncates", () => {
  const dir = makeRepo("cnt-", {
    "package.json": '{"name":"fixture"}',
    "src/wide.ts": `const x = "${"a".repeat(50000)}";\n`,
  });

  const manifest = generateSnapshot(
    // largeFileBytes is huge, so only byte-budget truncation can apply
    baseConfig(dir, { maxPartBytes: 8192, largeFileBytes: 10_000_000 })
  );

  const entry = manifest.files.find((file) => file.relativePath === "src/wide.ts");
  assert.equal(entry.isPreviewTruncated, true);
  assert.equal(
    manifest.counts.truncatedPreviewCount,
    manifest.totals.previewFiles,
    "counts.truncatedPreviewCount must match totals.previewFiles"
  );
  assert.equal(manifest.totals.previewFiles, 1);
  assert.equal(manifest.validation.status, "passed", manifest.validation.errors.join("; "));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------- residuals from adversarial review

test("a spread copy of a resolved config keeps its custom secret rules", () => {
  const dir = makeRepo("spreadcfg-", {
    "package.json": '{"name":"fixture"}',
    "a.txt": "TOKEN_ID=ACME_abcdefgh1234\n",
  });
  const resolved = resolveConfig({
    cwd: dir,
    outDir: "snapshot",
    tmpDir: "snapshot.tmp",
    secrets: { customPatterns: [{ rule: "acme", pattern: /ACME_[a-z0-9]{10}/ }] },
  });

  // A spread loses the non-enumerable brand; the rules must NOT be dropped.
  const spread = { ...resolved, maxPartBytes: 64 * 1024 };
  assert.equal(isResolvedConfig(spread), true);

  const manifest = generateSnapshot(spread);
  assert.ok(
    manifest.warnings.some((warning) => warning.includes("acme")),
    "custom rule must still match after a spread copy"
  );
  const text = readAllText(path.join(dir, "snapshot"));
  assert.ok(!text.includes("ACME_abcdefgh1234"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an oversized summary is dropped without zeroing the body", () => {
  // Summary far larger than the budget (thousands of exports), generous budget:
  // dropping the summary must free room for the body, not consume it.
  const lines = Array.from(
    { length: 20000 },
    (_, i) => `export const exportedThing${i} = ${i};`
  ).join("\n");
  const dir = makeRepo("r3-", {
    "package.json": '{"name":"fixture"}',
    "src/huge.ts": `${lines}\n`,
  });

  const manifest = generateSnapshot(
    baseConfig(dir, { maxPartBytes: 300 * 1024, largeFileBytes: 10_000_000 })
  );
  const entry = manifest.files.find((file) => file.relativePath === "src/huge.ts");

  assert.ok(entry.summaryOmitted === true || entry.includedBytes > 0);
  assert.ok(
    entry.includedBytes > 50_000,
    `body must keep most of the budget, got ${entry.includedBytes} bytes`
  );
  for (const part of manifest.parts) {
    assert.ok(part.byteSize <= 300 * 1024);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a huge layer name cannot push a part over the budget", () => {
  const hugeLayer = "L".repeat(6000);
  const dir = makeRepo("hugelayer-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
  });

  const manifest = generateSnapshot(
    baseConfig(dir, { maxPartBytes: 4096, layers: [{ name: hugeLayer, match: "**" }] })
  );

  for (const part of manifest.parts) {
    assert.ok(part.byteSize <= 4096, `${part.filename} is ${part.byteSize}B`);
  }
  assert.equal(manifest.validation.status, "passed", manifest.validation.errors.join("; "));
  const partText = fs.readFileSync(
    path.join(dir, "snapshot", "parts", manifest.parts[0].filename),
    "utf8"
  );
  assert.ok(!partText.includes(hugeLayer), "metadata must be capped in the rendered part");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("validate detects tampered counts/totals/budgets", () => {
  const dir = makeRepo("tamper-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a = 1;\n" });
  const config = baseConfig(dir);
  generateSnapshot(config);
  const manifestPath = path.join(dir, "snapshot", "manifest.json");
  const pristine = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const mutations = [
    ["counts.totalFiles", (m) => { m.counts.totalFiles = 999; }],
    ["totals.includedFiles", (m) => { m.totals.includedFiles = 999; }],
    ["totals.totalSourceBytes", (m) => { m.totals.totalSourceBytes = 1; }],
    ["totals.totalContentBytes", (m) => { m.totals.totalContentBytes = 1; }],
    ["totals.warningCount", (m) => { m.totals.warningCount = 42; }],
    ["budgets.maxPartBytes", (m) => { m.budgets.maxPartBytes = 1; }],
  ];

  for (const [label, mutate] of mutations) {
    const tampered = JSON.parse(JSON.stringify(pristine));
    mutate(tampered);
    fs.writeFileSync(manifestPath, JSON.stringify(tampered, null, 2));
    const result = validateSnapshot(config);
    assert.equal(result.valid, false, `${label} tampering must fail validation`);
    assert.ok(result.drift.totalsMismatches.length > 0, `${label} must be reported`);
  }

  fs.writeFileSync(manifestPath, JSON.stringify(pristine, null, 2));
  assert.equal(validateSnapshot(config).valid, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("validate warns when HEAD moved past the snapshot commit", () => {
  const dir = makeRepo("commitdrift-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a = 1;\n" });
  const config = baseConfig(dir);
  generateSnapshot(config);

  fs.writeFileSync(path.join(dir, "b.ts"), "export const b = 2;\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "second"], {
    cwd: dir,
    stdio: "ignore",
  });

  const result = validateSnapshot(config);
  assert.ok(
    result.warnings.some((warning) => /HEAD is/.test(warning)),
    `expected a commit warning, got ${JSON.stringify(result.warnings)}`
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a JSON clone of a resolved config fails loudly instead of dropping rules", () => {
  const dir = makeRepo("lossy-", { "package.json": '{"name":"fixture"}', "a.txt": "x\n" });
  const resolved = resolveConfig({
    cwd: dir,
    outDir: "snapshot",
    tmpDir: "snapshot.tmp",
    secrets: { customPatterns: [{ rule: "acme", pattern: /ACME_[a-z0-9]{10}/ }] },
  });

  // A RegExp becomes {} through JSON, so the clone can no longer carry the
  // rules. Silently falling back to defaults would let those secrets through.
  const clone = JSON.parse(JSON.stringify({ ...resolved, cwd: dir }));
  assert.throws(() => generateSnapshot(clone), /cannot survive JSON serialization/);

  // The object itself still works.
  assert.doesNotThrow(() => generateSnapshot(resolved));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------- artifact selection

const DEFAULT_ARTIFACTS = [
  "README.md",
  "manifest.json",
  path.join("parts", "part-001.md"),
  path.join("reports", "audit.md"),
  path.join("reports", "navigation.md"),
  path.join("reports", "project-tree.md"),
];

test("every artifact is written by default", () => {
  const dir = makeRepo("artifacts-all-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
  });
  generateSnapshot(baseConfig(dir));

  for (const rel of DEFAULT_ARTIFACTS) {
    assert.ok(
      fs.existsSync(path.join(dir, "snapshot", rel)),
      `${rel} should be generated by default`
    );
  }
  // The monolith stays opt-in: it duplicates the whole payload.
  assert.equal(fs.existsSync(path.join(dir, "snapshot", "full-codebase.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "snapshot", "full-codebase.md")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("individual artifacts can be switched off without disabling the rest", () => {
  const dir = makeRepo("artifacts-off-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
  });
  generateSnapshot(baseConfig(dir, { artifacts: { audit: false, navigation: false } }));

  assert.equal(fs.existsSync(path.join(dir, "snapshot", "reports", "audit.md")), false);
  assert.equal(fs.existsSync(path.join(dir, "snapshot", "reports", "navigation.md")), false);

  // Everything not switched off is still there.
  for (const rel of [
    "README.md",
    "manifest.json",
    path.join("parts", "part-001.md"),
    path.join("reports", "project-tree.md"),
  ]) {
    assert.ok(fs.existsSync(path.join(dir, "snapshot", rel)), `${rel} should still be generated`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--skip-artifacts omits the named artifacts and rejects unknown ones", () => {
  const dir = makeRepo("artifacts-cli-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
  });

  const ok = runCli(["generate", "--cwd", dir, "--skip-artifacts", "readme,projectTree"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(fs.existsSync(path.join(dir, "snapshot", "README.md")), false);
  assert.equal(fs.existsSync(path.join(dir, "snapshot", "reports", "project-tree.md")), false);
  assert.ok(fs.existsSync(path.join(dir, "snapshot", "manifest.json")));

  const bad = runCli(["generate", "--cwd", dir, "--dry-run", "--skip-artifacts", "nope"]);
  assert.equal(bad.code, 2, "an unknown artifact name is a usage error");
  assert.match(bad.stderr, /Unknown artifact/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unknown artifact key in config is rejected rather than ignored", () => {
  const dir = makeRepo("artifacts-typo-", { "package.json": '{"name":"fixture"}', "a.ts": "x\n" });
  assert.throws(
    () => baseConfig(dir, { artifacts: { audot: false } }),
    /Unknown artifact "audot"/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("disabling parts does not make validate report missing parts", () => {
  const dir = makeRepo("artifacts-noparts-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
  });
  const config = baseConfig(dir, { artifacts: { parts: false, navigation: false } });
  generateSnapshot(config);

  assert.equal(fs.existsSync(path.join(dir, "snapshot", "parts")), false);

  const result = validateSnapshot(config);
  assert.deepEqual(result.drift.partIssues, [], "no part file should be expected");
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("changing the artifact selection is reported as config drift", () => {
  const dir = makeRepo("artifacts-drift-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
  });
  generateSnapshot(baseConfig(dir, { artifacts: { audit: false } }));

  const result = validateSnapshot(baseConfig(dir));
  assert.equal(result.valid, false);
  assert.ok(
    result.drift.configMismatches.some((entry) => entry.includes("artifacts.audit")),
    `expected artifact drift, got ${JSON.stringify(result.drift.configMismatches)}`
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("navigation without parts is recorded as a warning, not a silent dead end", () => {
  const dir = makeRepo("artifacts-warn-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
  });
  const manifest = generateSnapshot(baseConfig(dir, { artifacts: { parts: false } }));

  assert.ok(
    manifest.warnings.some((warning) => warning.includes("navigation.md")),
    `expected a navigation warning, got ${JSON.stringify(manifest.warnings)}`
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--only-artifacts writes exactly the named artifacts", () => {
  const dir = makeRepo("only-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
  });

  const result = runCli(["generate", "--cwd", dir, "--only-artifacts", "parts"]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(dir, "snapshot", "parts", "part-001.md")));
  assert.equal(fs.existsSync(path.join(dir, "snapshot", "manifest.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "snapshot", "README.md")), false);
  assert.equal(fs.existsSync(path.join(dir, "snapshot", "reports")), false);

  const both = runCli([
    "generate",
    "--cwd",
    dir,
    "--dry-run",
    "--skip-artifacts",
    "audit",
    "--only-artifacts",
    "parts",
  ]);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /cannot be combined/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("include is an allow-list and records why files were left out", () => {
  const dir = makeRepo("include-", {
    "package.json": '{"name":"fixture"}',
    "src/a.ts": "export const a = 1;\n",
    "docs/guide.md": "# guide\n",
  });
  const manifest = generateSnapshot(baseConfig(dir, { include: ["src/**"] }));

  assert.deepEqual(
    manifest.files.map((file) => file.relativePath),
    ["src/a.ts"]
  );
  assert.deepEqual(manifest.config.include, ["src/**"]);

  const omitted = manifest.skipped.find((entry) => entry.path === "docs/guide.md");
  assert.ok(omitted, "the excluded file must still be recorded");
  assert.equal(omitted.reason, "excluded");
  assert.match(omitted.detail, /include pattern/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("include composes with excludePatterns, applied first", () => {
  const dir = makeRepo("include-exclude-", {
    "package.json": '{"name":"fixture"}',
    "src/a.ts": "export const a = 1;\n",
    "src/b.test.ts": "export const b = 2;\n",
    "docs/x.md": "# x\n",
  });
  const manifest = generateSnapshot(
    baseConfig(dir, { include: ["src/**"], excludePatterns: ["**/*.test.ts"] })
  );

  assert.deepEqual(
    manifest.files.map((file) => file.relativePath),
    ["src/a.ts"]
  );
  const excludedByPattern = manifest.skipped.find((entry) => entry.path === "src/b.test.ts");
  assert.equal(excludedByPattern?.reason, "excluded");
  assert.match(excludedByPattern.detail, /exclude pattern/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("excludePatterns now records the files it dropped", () => {
  const dir = makeRepo("exclude-records-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
    "b.lock": "x\n",
  });
  const manifest = generateSnapshot(baseConfig(dir, { excludePatterns: ["**/*.lock"] }));

  const dropped = manifest.skipped.find((entry) => entry.path === "b.lock");
  assert.equal(dropped?.reason, "excluded");
  assert.equal(manifest.counts.skippedCount, manifest.skipped.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("changing the include allow-list is reported as config drift", () => {
  const dir = makeRepo("include-drift-", {
    "package.json": '{"name":"fixture"}',
    "src/a.ts": "export const a = 1;\n",
    "docs/x.md": "# x\n",
  });
  generateSnapshot(baseConfig(dir, { include: ["src/**"] }));

  const result = validateSnapshot(baseConfig(dir));
  assert.equal(result.valid, false);
  assert.ok(
    result.drift.configMismatches.some((entry) => entry.startsWith("include:")),
    `expected include drift, got ${JSON.stringify(result.drift.configMismatches)}`
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("byte budgets accept human-readable units from CLI and config", () => {  const dir = makeRepo("units-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
  });

  const fromConfig = generateSnapshot(
    baseConfig(dir, { maxPartBytes: "120k", largeFileBytes: "1mb" })
  );
  assert.equal(fromConfig.config.maxPartBytes, 122880);
  assert.equal(fromConfig.config.largeFileBytes, 1048576);

  const viaCli = runCli([
    "generate",
    "--cwd",
    dir,
    "--dry-run",
    "--format",
    "json",
    "--max-part-bytes",
    "40k",
  ]);
  assert.equal(viaCli.code, 0, viaCli.stderr);
  assert.equal(JSON.parse(viaCli.stdout).config.maxPartBytes, 40960);

  const bad = runCli(["generate", "--cwd", dir, "--dry-run", "--max-part-bytes", "12x"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /byte count/);

  const tooSmall = runCli(["generate", "--cwd", dir, "--dry-run", "--max-part-bytes", "1k"]);
  assert.equal(tooSmall.code, 2);
  assert.match(tooSmall.stderr, /at least 4096/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------- explain

test("explain reports how a path would be treated", () => {
  const dir = makeRepo("explain-", {
    "package.json": '{"name":"fixture"}',
    "src/a.ts": "export const a = 1;\n",
    ".env": "DB_PASSWORD=hunter2\n",
  });
  generateSnapshot(baseConfig(dir));

  const included = runCli(["explain", "src/a.ts", "--cwd", dir, "--format", "json"]);
  assert.equal(included.code, 0, included.stderr);
  const info = JSON.parse(included.stdout);
  assert.equal(info.included, true);
  assert.equal(info.part, "part-001.md");
  assert.equal(info.language, "typescript");
  assert.ok(info.layerMatch, "the matching layer rule should be reported");

  const skipped = runCli(["explain", ".env", "--cwd", dir, "--format", "json"]);
  assert.equal(skipped.code, 1, "an excluded path exits non-zero");
  assert.equal(JSON.parse(skipped.stdout).reason, "sensitive-file");

  const missing = runCli(["explain", "does/not/exist.ts", "--cwd", dir, "--format", "json"]);
  assert.equal(missing.code, 1);
  assert.equal(JSON.parse(missing.stdout).reason, "missing");

  const arity = runCli(["explain", "--cwd", dir]);
  assert.equal(arity.code, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------- diff

test("diff compares two snapshots file by file", () => {
  const dir = makeRepo("difftest-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
  });
  generateSnapshot(baseConfig(dir));

  const saved = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "diffa-")), "manifest.json");
  fs.copyFileSync(path.join(dir, "snapshot", "manifest.json"), saved);

  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 2;\n");
  fs.writeFileSync(path.join(dir, "b.ts"), "export const b = 3;\n");
  generateSnapshot(baseConfig(dir));

  const result = runCli(["diff", saved, path.join(dir, "snapshot"), "--format", "json"]);
  assert.equal(result.code, 0, result.stderr);
  const diff = JSON.parse(result.stdout);
  assert.ok(diff.added.includes("b.ts"), `expected b.ts added, got ${JSON.stringify(diff.added)}`);
  assert.ok(
    diff.changed.includes("a.ts"),
    `expected a.ts changed, got ${JSON.stringify(diff.changed)}`
  );
  assert.equal(diff.removed.length, 0);

  const badArity = runCli(["diff", saved]);
  assert.equal(badArity.code, 2);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.dirname(saved), { recursive: true, force: true });
});

// ------------------------------------------------------- budgets / presets / hooks

test("per-layer budgets split parts and bound each layer", () => {
  const dir = makeRepo("layerbudget-", {
    "package.json": '{"name":"fixture"}',
    "src/big.ts": `export const x = "${"a".repeat(9000)}";\n`,
    "docs/x.md": "# x\n",
  });
  const manifest = generateSnapshot(
    baseConfig(dir, { budgets: { default: 60000, byLayer: { src: 4096 } } })
  );

  assert.equal(manifest.config.budgets.byLayer.src, 4096);
  assert.equal(manifest.config.budgets.default, 60000);
  assert.ok(manifest.parts.length >= 2, "files under different budgets must not share a part");
  for (const part of manifest.parts) {
    assert.ok(part.byteSize <= 60000, `${part.filename} is ${part.byteSize} B`);
  }
  const big = manifest.files.find((file) => file.relativePath === "src/big.ts");
  assert.equal(big?.inclusionMode, "preview", "the src file exceeds its own 4 KB budget");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("user layers extend the preset by default and replace it on request", () => {
  const dir = makeRepo("presetmerge-", {
    "package.json": '{"name":"fixture","dependencies":{"next":"14"}}',
    "next.config.js": "module.exports = {};\n",
    "src/app/page.tsx": "export default function P() { return null; }\n",
    "docs/x.md": "# x\n",
  });
  const custom = [{ name: "custom", match: "docs/**" }];

  const merged = baseConfig(dir, { layers: custom });
  assert.ok(merged.layers.some((layer) => layer.name === "custom"));
  assert.ok(
    merged.layers.some((layer) => layer.name === "app"),
    "the detected preset must survive a merge"
  );

  const replaced = baseConfig(dir, { layers: custom, layersMode: "replace" });
  assert.equal(replaced.layers.length, 1);

  assert.throws(
    () => baseConfig(dir, { layersMode: "nonsense" }),
    /layersMode/
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hooks.afterGenerate runs, and a throwing hook is downgraded to a warning", () => {
  const dir = makeRepo("hooks-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
  });

  let seen = null;
  const manifest = generateSnapshot(
    baseConfig(dir, {
      hooks: {
        afterGenerate: (value) => {
          seen = value;
        },
      },
    })
  );
  assert.equal(seen, manifest, "the hook receives the manifest");

  const warned = generateSnapshot(
    baseConfig(dir, {
      hooks: {
        afterGenerate: () => {
          throw new Error("boom");
        },
      },
    })
  );
  assert.ok(
    warned.warnings.some((warning) => warning.includes("boom")),
    `expected the hook failure to be recorded, got ${JSON.stringify(warned.warnings)}`
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("default-ignored files are recorded instead of vanishing", () => {
  const dir = makeRepo("defaultignore-", {
    "package.json": '{"name":"fixture"}',
    "dist/bundle.js": "module.exports = {};\n",
    "a.ts": "export const a = 1;\n",
  });
  const manifest = generateSnapshot(baseConfig(dir));
  const ignored = manifest.skipped.find((entry) => entry.path === "dist/bundle.js");
  assert.equal(ignored?.reason, "default-ignore");
  assert.match(ignored.detail, /dist/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("math: monolith carries the full file even when the part budget truncates", () => {
  const dir = makeRepo("monolith-full-", {
    "package.json": '{"name":"fixture"}',
    "big.ts": `export const big = "${"b".repeat(40000)}";\n`,
  });
  const manifest = generateSnapshot(
    baseConfig(dir, { maxPartBytes: 4096, includeMonolith: true })
  );

  const entry = manifest.files.find((file) => file.relativePath === "big.ts");
  assert.equal(entry?.inclusionMode, "preview", "the part must be truncated");

  const monolith = JSON.parse(
    fs.readFileSync(path.join(dir, "snapshot", "full-codebase.json"), "utf8")
  );
  const monoEntry = monolith.files.find((file) => file.relativePath === "big.ts");
  assert.equal(
    monoEntry.content.length,
    40000 + 'export const big = "";\n'.length,
    "the monolith must hold the whole file, not the truncated part body"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------- summary quality

test("summaries record how they were produced", () => {
  const dir = makeRepo("quality-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
    "b.py": "def hello():\n    pass\n",
    "c.json": '{"a":1}',
  });
  const manifest = generateSnapshot(baseConfig(dir));
  const byPath = new Map(manifest.files.map((file) => [file.relativePath, file]));

  assert.equal(byPath.get("a.ts").summaryQuality, "ast");
  assert.equal(byPath.get("b.py").summaryQuality, "heuristic");
  assert.equal(byPath.get("c.json").summaryQuality, "structural");

  // The part must not present a line-scan as if it were a parse.
  const partText = fs.readFileSync(path.join(dir, "snapshot", "parts", "part-001.md"), "utf8");
  assert.match(partText, /- Summary Quality: heuristic/);
  assert.match(partText, /- Summary Quality: ast/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a Python file is summarized, redacted and budgeted like any other", () => {
  const dir = makeRepo("python-", {
    "package.json": '{"name":"fixture"}',
    "app.py": 'import os\nAPI_KEY = "sk-proj-AAAAAAAAAAAAAAAAAAAA"\ndef main():\n    return os.getcwd()\n',
  });
  const manifest = generateSnapshot(baseConfig(dir));
  const entry = manifest.files.find((file) => file.relativePath === "app.py");

  assert.ok(entry, "the .py file must be included");
  assert.equal(entry.summaryQuality, "heuristic");
  assert.ok(entry.summary.imports.includes("os"));
  assert.ok(entry.summary.functions.includes("main"));

  const text = fs.readFileSync(path.join(dir, "snapshot", "parts", "part-001.md"), "utf8");
  assert.ok(!text.includes("AKIA") && !text.includes("sk-proj-AAAAAAAA"), "secrets stay redacted");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------- preset ecosystem

test("the detected preset contributes its ecosystem ignores", () => {
  const dir = makeRepo("presetignore-", {
    "manage.py": "print('x')\n",
    "app/views.py": "def home():\n    pass\n",
    "__pycache__/module.cpython-311.pyc": "compiled\n",
  });
  const manifest = generateSnapshot(baseConfig(dir));

  assert.equal(manifest.config.preset, "python-django");
  const dropped = manifest.skipped.find((entry) => entry.path.includes("__pycache__"));
  assert.ok(dropped, "__pycache__ must be skipped by the python preset");
  assert.equal(dropped.reason, "excluded");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ init CLI

test("CLI init writes a config in non-interactive mode", () => {
  const dir = makeRepo("cli-init-", {
    "package.json": '{"name":"fixture","version":"1.0.0"}',
    "go.mod": "module example.com/app\n",
  });

  const result = runCli(["init", "--cwd", dir, "--yes", "--max-part-bytes", "120k"]);
  assert.equal(result.code, 0, result.stderr);

  const configName = fs.readdirSync(dir).find((name) => name.startsWith("snapshot.config"));
  assert.ok(configName, "a config file must be written");

  const text = fs.readFileSync(path.join(dir, configName), "utf8");
  assert.ok(text.includes('preset: "go"'));
  assert.ok(text.includes('maxPartBytes: "120k"'));
  assert.ok(text.includes("artifacts:"), "the full annotated config is written by default");
  fs.rmSync(dir, { recursive: true, force: true });
});
