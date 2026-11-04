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

/** Mirrors the package's own check: Node can `import()` a `.ts` file. */
function supportsTypeScriptImportsForTests() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 6);
}
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

function runCli(cliArgs, options = {}) {
  const result = spawnSync(process.execPath, [BIN, ...cliArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
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
    ["--force"],
  ]) {
    const result = runCli(["generate", ...flag]);
    assert.equal(result.code, 2, `generate ${flag.join(" ")} must be a usage error`);
    assert.match(result.stderr, /do not apply to `generate`|does not apply to `generate`/);
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

// Ownership must not be inferred from filenames: `README.md` is both an artifact
// name and a very common *user* filename, so a name allowlist treated
// `--out-dir docs` (holding only docs/README.md) as a previous snapshot and
// replaced the user's documentation.
test("generate refuses a directory that merely looks like an artifact name", () => {
  const userDoc = "# user documentation\n";
  for (const [label, args, configFile, configBody] of [
    ["outDir", ["--out-dir", "docs"], null, null],
    ["tmpDir", [], "snapshot.config.json", JSON.stringify({ tmpDir: "scratch" })],
  ]) {
    const target = label === "outDir" ? "docs" : "scratch";
    const files = {
      "package.json": '{"name":"fixture"}',
      "a.ts": "export const a = 1;\n",
      [`${target}/README.md`]: userDoc,
    };
    if (configFile) files[configFile] = configBody;
    const dir = makeRepo(`cli-own-name-${label}-`, files);

    const result = runCli(["generate", "--cwd", dir, ...args]);
    assert.equal(result.code, 1, `${label}=${target} must be refused, got ${result.code}`);
    assert.equal(
      fs.readFileSync(path.join(dir, target, "README.md"), "utf8"),
      userDoc,
      `${label}=${target}: user README must survive`
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// hooks.afterGenerate is documented as the way to write your own artifacts into
// the output directory. Any ownership check that rejects unknown files makes that
// feature break reruns forever.
test("a hook-written artifact does not block later runs", () => {
  const dir = makeRepo("cli-hook-rerun-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
    "snapshot.config.mjs":
      'import * as fs from "node:fs";\n' +
      "export default {\n" +
      '  hooks: { afterGenerate: () => fs.writeFileSync("snapshot/custom-report.txt", "x") },\n' +
      "};\n",
  });
  for (const run of [1, 2, 3]) {
    // Run from inside the repo so the hook's relative path resolves the way it
    // does for a developer typing `snap` in their project.
    const result = runCli(["generate"], { cwd: dir });
    assert.equal(result.code, 0, `run ${run} must succeed: ${result.stderr}`);
    assert.ok(fs.existsSync(path.join(dir, "snapshot", "custom-report.txt")));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// A directory of user assets may well contain a manifest.json with a
// schemaVersion. Ownership must require *our* generator identity, or that
// directory gets replaced by a snapshot.
test("generate refuses a directory whose manifest.json is not ours", () => {
  const userAsset = '{"schemaVersion":"1.0","name":"my user assets","files":["logo.svg"]}';
  const dir = makeRepo("cli-own-foreign-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
    "assets/manifest.json": userAsset,
    "assets/logo.svg": "<svg/>\n",
  });

  const result = runCli(["generate", "--cwd", dir, "--out-dir", "assets"]);
  assert.equal(result.code, 1, `expected refusal, got ${result.code}`);
  assert.equal(fs.readFileSync(path.join(dir, "assets", "manifest.json"), "utf8"), userAsset);
  assert.equal(fs.readFileSync(path.join(dir, "assets", "logo.svg"), "utf8"), "<svg/>\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

// `maxPartBytes: 0` used to be swallowed as "use the 300 KB default" while
// `maxPartBytes: 1000` threw, so a clearly wrong setting silently did nothing.
test("a non-positive budget in the config is an error, not a silent default", () => {
  for (const value of [0, -100]) {
    const dir = makeRepo(`cli-budget-neg-`, {
      "package.json": '{"name":"fixture"}',
      "a.ts": "export const a = 1;\n",
      "snapshot.config.json": JSON.stringify({ maxPartBytes: value }),
    });
    const result = runCli(["generate", "--cwd", dir]);
    assert.notEqual(result.code, 0, `maxPartBytes: ${value} must not be accepted`);
    assert.match(result.stderr, /positive byte count/);
    assert.equal(fs.existsSync(path.join(dir, "snapshot")), false, "nothing must be written");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A parseable file is not necessarily a snapshot; the text report used to die
// with a raw TypeError out of the formatter.
test("report rejects a manifest that is not a snapshot", () => {
  const dir = makeRepo("cli-report-foreign-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
    "snapshot/manifest.json": '{"schemaVersion":"1.0","name":"not a snapshot"}',
  });
  const result = runCli(["report", "--cwd", dir]);
  assert.equal(result.code, 1, `expected exit 1, got ${result.code}`);
  assert.match(result.stderr, /is not a snapshot manifest/);
  assert.doesNotMatch(result.stderr, /TypeError/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── contract polish (2.1.1) ──────────────────────────────────────────────────

test("validate lists the bookkeeping values that disagree", () => {
  const dir = makeRepo("pol-m2-", {
    "package.json": '{"name":"fixture"}',
    "a.ts": "export const a = 1;\n",
  });
  assert.equal(runCli(["generate", "--cwd", dir]).code, 0);
  const manifestPath = path.join(dir, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.counts.totalFiles = 999;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const result = runCli(["validate", "--cwd", dir]);
  assert.equal(result.code, 1);
  // It used to print only "1 manifest bookkeeping value(s) disagree".
  assert.match(result.stderr, /counts\.totalFiles/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("generate only reports the artifacts it actually wrote", () => {
  // Human-readable progress goes to stderr; stdout stays pure for --format json.
  const onlyParts = makeRepo("pol-m3a-", { "package.json": '{"name":"f"}', "a.ts": "export const a=1;\n" });
  const partsOut = runCli(["generate", "--cwd", onlyParts, "--only-artifacts", "parts"]).stderr;
  assert.match(partsOut, /Parts written/);
  assert.doesNotMatch(partsOut, /Reports:/);
  assert.doesNotMatch(partsOut, /Manifest:/);
  fs.rmSync(onlyParts, { recursive: true, force: true });

  const noManifest = makeRepo("pol-m3b-", { "package.json": '{"name":"f"}', "a.ts": "export const a=1;\n" });
  const noManifestOut = runCli(["generate", "--cwd", noManifest, "--skip-artifacts", "manifest"]).stderr;
  assert.doesNotMatch(noManifestOut, /Manifest:/);
  fs.rmSync(noManifest, { recursive: true, force: true });

  const none = makeRepo("pol-m3c-", { "package.json": '{"name":"f"}', "a.ts": "export const a=1;\n" });
  const noneOut = runCli([
    "generate", "--cwd", none,
    "--skip-artifacts", "readme,manifest,parts,navigation,projectTree,audit,monolith",
  ]).stderr;
  assert.match(noneOut, /all disabled/);
  fs.rmSync(none, { recursive: true, force: true });
});

test("a tracked-but-deleted file is reported once, not twice", () => {
  const dir = makeRepo("pol-l1-", {
    "package.json": '{"name":"fixture"}',
    "src/index.ts": "export const a = 1;\n",
  });
  assert.equal(runCli(["generate", "--cwd", dir]).code, 0);
  fs.rmSync(path.join(dir, "src", "index.ts"));

  const result = runCli(["validate", "--cwd", dir, "--format", "json"]);
  assert.equal(result.code, 1);
  const drift = JSON.parse(result.stdout).drift;
  assert.deepEqual(drift.missingOnDisk, ["src/index.ts"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a bad --cwd is a usage error (exit 2), not a generation failure", () => {
  const dir = makeRepo("pol-l2-", { "package.json": '{"name":"fixture"}', "notes.txt": "x\n" });
  assert.equal(runCli(["generate", "--cwd", path.join(dir, "notes.txt")]).code, 2);
  assert.equal(runCli(["generate", "--cwd", path.join(dir, "definitely-missing")]).code, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a negative option value gets a message that names the fix", () => {
  const result = runCli(["--max-part-bytes", "-5"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /looks like another flag/);
});

test("empty option values are usage errors, not silent defaults", () => {
  const dir = makeRepo("pol-l4-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a=1;\n" });
  // An unset shell variable used to silently redirect output to ./snapshot.
  const out = runCli(["generate", "--cwd", dir, "--out-dir", ""]);
  assert.equal(out.code, 2);
  assert.equal(fs.existsSync(path.join(dir, "snapshot")), false);
  assert.equal(runCli(["generate", "--cwd", ""]).code, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("diff reports missing and malformed targets without raw Node errors", () => {
  const dir = makeRepo("pol-l5-", {
    "package.json": '{"name":"fixture"}',
    "snap/manifest.json": '{"files":[]}',
  });
  const missing = runCli(["diff", "nope", "nope"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /does not exist/);
  assert.doesNotMatch(missing.stderr, /ENOENT/);

  const malformed = runCli(["diff", "snap", "snap"], { cwd: dir });
  assert.equal(malformed.code, 1);
  assert.match(malformed.stderr, /no "counts" object/);
  assert.doesNotMatch(malformed.stderr, /TypeError/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a detached HEAD records the fallback branch instead of 'HEAD'", () => {
  const dir = makeRepo("pol-l6-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a=1;\n" });
  execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: dir, stdio: "ignore" });

  assert.equal(runCli(["generate", "--cwd", dir]).code, 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
  assert.equal(manifest.git.branch, "main", "a detached HEAD cannot name a branch");

  const validated = runCli(["validate", "--cwd", dir]);
  assert.equal(validated.code, 0);
  assert.doesNotMatch(validated.stderr, /branch "HEAD"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a wrong-typed 'snapshot' key in package.json is warned about", () => {
  const dir = makeRepo("pol-l8-", {
    "package.json": '{"name":"fixture","snapshot":"not-an-object"}',
    "a.ts": "export const a=1;\n",
  });
  // Not fatal on purpose: other tools use a "snapshot" key too.
  const result = runCli(["generate", "--cwd", dir]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /must be an object/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the all-artifacts-disabled warning names what is actually written", () => {
  const dir = makeRepo("pol-l9-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a=1;\n" });
  const result = runCli([
    "generate", "--cwd", dir,
    "--skip-artifacts", "readme,manifest,parts,navigation,projectTree,audit,monolith",
  ]);
  assert.equal(result.code, 0);
  // It claimed the directory "will be empty" while the marker is always written.
  assert.match(result.stderr, /ownership marker/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// `fs.chmod` cannot revoke write access on Windows, so this one is POSIX-only.
test(
  "a read-only output directory fails with a clear message",
  { skip: process.platform === "win32" },
  () => {
    const dir = makeRepo("pol-l7-", { "package.json": '{"name":"fixture"}', "a.ts": "export const a=1;\n" });
    assert.equal(runCli(["generate", "--cwd", dir]).code, 0);
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 2;\n");
    fs.chmodSync(path.join(dir, "snapshot"), 0o500);
    try {
      const result = runCli(["generate", "--cwd", dir]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /permission denied/);
      assert.ok(fs.existsSync(path.join(dir, "snapshot", "manifest.json")), "previous snapshot survives");
    } finally {
      fs.chmodSync(path.join(dir, "snapshot"), 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

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
  // `largeFileBytes` is above the fixture on purpose: this test is about a WHOLE
  // file whose summary alone exceeds the part budget. Previewed files are no longer
  // summarised at all (see tests/summary-preview.test.js), so keeping the default
  // 200 KB threshold here would test a path that no longer builds a summary.
  const manifest = generateSnapshot(
    baseConfig(dir, { maxPartBytes, largeFileBytes: 10_000_000 })
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
  // The rule matched, so the line is counted as redacted. It used to be found by searching
  // `warnings` for `acme`, which is exactly the conflation 4.1.2 removed: a masked value is not
  // a warning, and the rule names live in reports/audit.md.
  assert.equal(
    manifest.totals.redactedLines,
    1,
    "the custom rule must still match after a spread copy"
  );
  const audit = fs.readFileSync(path.join(dir, "snapshot", "reports", "audit.md"), "utf8");
  assert.match(audit, /`acme`/, "the custom rule name is recorded in the audit");
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
  // Explaining a file that would be skipped is a successful explanation, not a
  // failure: exit 1 is reserved for drift and refusals, so the verdict is the
  // `included` flag rather than the exit code.
  assert.equal(skipped.code, 0, "explaining a skipped path is not an error");
  assert.equal(JSON.parse(skipped.stdout).included, false);
  assert.equal(JSON.parse(skipped.stdout).reason, "sensitive-file");

  const missing = runCli(["explain", "does/not/exist.ts", "--cwd", dir, "--format", "json"]);
  assert.equal(missing.code, 0);
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
  // A preset's own ecosystem ignore is a built-in rule, not a user glob, so it
  // reports `default-ignore`; `excluded` is reserved for the user's patterns.
  assert.equal(dropped.reason, "default-ignore");
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

// ── agent surface (2.2.0) ────────────────────────────────────────────────────

test("describe emits a machine contract an agent can act on", () => {
  const result = runCli(["describe", "--format", "json"]);
  assert.equal(result.code, 0, result.stderr);
  const contract = JSON.parse(result.stdout);

  assert.equal(contract.package, "codebase-snapshot");
  assert.equal(contract.generator, contract.package);
  assert.match(contract.invocation.oneShot, /@latest/, "the one-shot invocation must be pinned");
  assert.ok(contract.workflow.length >= 5, "the workflow must be step by step");
  assert.deepEqual(
    contract.workflow.map((step) => step.step),
    contract.workflow.map((_, index) => index + 1),
    "steps are numbered in order"
  );
  assert.equal(contract.presets.length, 25);
  assert.ok(contract.options.some((option) => option.flag === "--out-dir"));
  assert.ok(contract.artifacts.some((artifact) => artifact.name === "parts"));
  assert.equal(contract.exitCodes["2"].startsWith("usage error"), true);
  assert.ok(contract.troubleshooting.length > 0);
});

test("describe defaults match the real config defaults", () => {
  const contract = JSON.parse(runCli(["describe", "--format", "json"]).stdout);
  const dir = makeRepo("agent-defaults-", { "package.json": '{"name":"fixture"}' });
  const probe = runCli(["generate", "--cwd", dir, "--dry-run", "--format", "json"]);
  assert.equal(probe.code, 0, probe.stderr);
  const manifest = JSON.parse(probe.stdout);

  // If these drift, the contract is lying to agents, so fail loudly.
  const setting = (key) => contract.config.settings.find((item) => item.key === key);
  assert.equal(setting("maxPartBytes").default, manifest.config.maxPartBytes);
  assert.equal(setting("largeFileBytes").default, manifest.config.largeFileBytes);
  assert.equal(setting("includeMonolith").default, manifest.config.includeMonolith);
  assert.equal(setting("previewHeadLines").default, manifest.config.previewHeadLines);
  assert.equal(setting("previewTailLines").default, manifest.config.previewTailLines);

  // outDir is not recorded in manifest.config, so prove it by writing for real.
  assert.equal(setting("outDir").default, "snapshot");
  assert.equal(runCli(["generate", "--cwd", dir]).code, 0);
  assert.ok(fs.existsSync(path.join(dir, "snapshot", "manifest.json")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("describe has a readable text form too", () => {
  const result = runCli(["describe"]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /Workflow:/);
  assert.match(result.stderr, /describe --format json/);
});

test("skill prints a SKILL.md with the frontmatter agents look for", () => {
  const result = runCli(["skill"]);
  assert.equal(result.code, 0);
  // Printed on stdout so an agent can capture it directly.
  assert.match(result.stdout, /^---\nname: codebase-snapshot\n/);
  assert.match(result.stdout, /description:/);
  assert.match(result.stdout, /describe --format json/);
  assert.match(result.stdout, /@latest/);
});

test("skill --install writes the two registries, ignores them, and is idempotent", () => {
  const dir = makeRepo("agent-install-", { "package.json": '{"name":"fixture"}' });

  const first = runCli(["skill", "--install", "--cwd", dir, "--format", "json"]);
  assert.equal(first.code, 0, first.stderr);
  const payload = JSON.parse(first.stdout);
  assert.deepEqual(
    payload.written.map((item) => item.target).sort(),
    ["claude", "cursor"],
    "only the two skill registries are targets"
  );
  assert.deepEqual(
    [...payload.gitignored].sort(),
    [".claude/skills/codebase-snapshot/SKILL.md", ".cursor/rules/codebase-snapshot.mdc"],
    "what it creates is ignored, with forward slashes"
  );
  assert.ok(fs.existsSync(path.join(dir, ".claude", "skills", "codebase-snapshot", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(dir, ".cursor", "rules", "codebase-snapshot.mdc")));
  assert.equal(
    fs.existsSync(path.join(dir, "AGENTS.md")),
    false,
    "AGENTS.md belongs to the project, so it is not a target"
  );

  const second = runCli(["skill", "--install", "--cwd", dir, "--format", "json"]);
  assert.equal(second.code, 0);
  assert.ok(
    JSON.parse(second.stdout).written.every((item) => item.action === "unchanged"),
    "a second install must not rewrite anything"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// The footprint is the product. `init` used to leave the package undeclared, so nothing
// reached node_modules and `npm run snapshot` fetched @latest on every run; a `--minimal`
// flag could also write a config listing five settings out of twenty-six. Both are gone,
// and an agent file is never part of an install.
test("init's whole footprint is the config, package.json and .gitignore", () => {
  const dir = makeRepo(
    "init-footprint-",
    { "package.json": '{"name":"fixture","version":"1.0.0"}\n' },
    { git: false }
  );

  const result = runCli(["init", "--yes", "--cwd", dir]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    [".gitignore", "package.json", "snapshot.config.mjs"],
    "exactly three paths, and no markdown or agent file"
  );

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.match(
    String(pkg.devDependencies["codebase-snapshot"]),
    /^\^4\./,
    "the package is declared, so npm install puts it in node_modules"
  );

  const config = fs.readFileSync(path.join(dir, "snapshot.config.mjs"), "utf8");
  for (const key of ["preset:", "outDir:", "maxPartBytes:", "previewHeadLines:", "layersMode:", "artifacts:", "hooks:"]) {
    assert.ok(config.includes(key), `the one config file must list every setting: ${key}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("skill-only flags are rejected elsewhere, and --target is validated", () => {
  assert.equal(runCli(["skill", "--install", "--target", "nope"]).code, 2);
  assert.equal(runCli(["skill", "--install", "--target", "agents"]).code, 2, "AGENTS.md was removed as a target");
  assert.equal(runCli(["generate", "--install"]).code, 2);
  assert.equal(runCli(["generate", "--target", "claude"]).code, 2);
});

// ── init → generate round trip (2.2.0) ───────────────────────────────────────
// `snap init` used to write a config the very next `snap generate` could not
// load: the file imported `defineConfig` from this package (absent in the npx
// flow) and was written as `.ts` even in CommonJS projects, where Node refuses
// `export default`. A zero-context agent hit this on its first run.

test("init writes a config that generate can actually load (CommonJS project)", () => {
  const dir = makeRepo("rt-cjs-", { "package.json": '{"name":"fixture","version":"1.0.0"}' });

  const init = runCli(["init", "--yes", "--cwd", dir]);
  assert.equal(init.code, 0, init.stderr);

  const written = fs.readdirSync(dir).filter((name) => name.startsWith("snapshot.config"));
  assert.equal(written.length, 1, `expected exactly one config, got ${written.join(", ")}`);
  assert.equal(written[0], "snapshot.config.mjs", "a CommonJS project cannot load a .ts ESM config");

  const text = fs.readFileSync(path.join(dir, written[0]), "utf8");
  // Name-independent on purpose: the header comment legitimately names the generator, so
  // matching the package string would forbid the tool from saying who wrote the file. What
  // must never happen is the config importing the package, which would make it unloadable
  // in the very project it is meant for.
  assert.doesNotMatch(
    text,
    /^\s*(?:import\b|const\s+\w+\s*=\s*require\()/m,
    "the config must not import the package"
  );

  // The whole point: the next command works.
  const generated = runCli(["generate", "--cwd", dir]);
  assert.equal(generated.code, 0, `generate must load the config it just wrote:\n${generated.stderr}`);
  assert.ok(fs.existsSync(path.join(dir, "snapshot", "manifest.json")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("init writes a .ts config for an ESM project when Node can load it", () => {
  const dir = makeRepo("rt-esm-", {
    "package.json": '{"name":"fixture","version":"1.0.0","type":"module"}',
  });
  const init = runCli(["init", "--yes", "--cwd", dir]);
  assert.equal(init.code, 0, init.stderr);

  const configName = fs.readdirSync(dir).find((name) => name.startsWith("snapshot.config"));
  if (supportsTypeScriptImportsForTests()) {
    assert.equal(configName, "snapshot.config.ts");
  } else {
    assert.equal(configName, "snapshot.config.mjs");
  }

  const generated = runCli(["generate", "--cwd", dir]);
  assert.equal(generated.code, 0, `generate must load ${configName}:\n${generated.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a generated config is a plain object, not a defineConfig call", () => {
  const dir = makeRepo("rt-plain-", {
    "package.json": '{"name":"fixture","version":"1.0.0","type":"module"}',
  });
  assert.equal(runCli(["init", "--yes", "--cwd", dir]).code, 0);
  const configName = fs.readdirSync(dir).find((name) => name.startsWith("snapshot.config"));
  const text = fs.readFileSync(path.join(dir, configName), "utf8");
  assert.match(text, /export default config;/, "the object is exported by name");
  assert.doesNotMatch(text, /export default \{/, "an anonymous default export is a lint error in Next.js");
  assert.doesNotMatch(text, /defineConfig/);
  fs.rmSync(dir, { recursive: true, force: true });
});
