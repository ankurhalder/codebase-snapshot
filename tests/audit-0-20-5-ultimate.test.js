/**
 * Regressions for the 0.20.5 ultimate-audit findings.
 *
 * The audit's pattern was a guard on one route and none on its twin. Each test therefore names
 * the route it exercises rather than only the helper it calls.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SECRET_PATTERNS,
  cloneRepository,
  generateSnapshot,
  installPreCommitHook,
  resolveConfig,
  scanAndRedactSecrets,
  validateSnapshot,
} from "../dist/index.js";
import { parseCliArgs } from "../dist/cli.js";
import { buildResourceProvider, buildTools, startHttpTransport } from "../dist/mcp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function tempDir(t, prefix = "audit-0205-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, "git " + args.join(" ") + ": " + (result.stderr ?? ""));
  return (result.stdout ?? "").trim();
}

function initRepo(t, files = {}) {
  const root = tempDir(t);
  write(root, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  for (const [relative, content] of Object.entries(files)) write(root, relative, content);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "audit@example.test"]);
  git(root, ["config", "user.name", "Audit"]);
  return root;
}

function contextFor(root) {
  return { cwd: root, roots: [root], log: () => {} };
}

const scan = (text, filePath) => scanAndRedactSecrets(text, DEFAULT_SECRET_PATTERNS, filePath);

test("CF-01: an uppercase AUTHORIZATION header is redacted", () => {
  const { redacted } = scan(
    "extraheader = AUTHORIZATION: basic dXNlcjpwYXNz",
    ".git/config"
  );
  assert.doesNotMatch(redacted, /dXNlcjpwYXNz/);
  assert.match(redacted, /REDACTED/);
});

test("CF-01: a tracked symlink to .git/config is not emitted", (t) => {
  const root = initRepo(t, { "src/a.ts": "export const a = 1;\n" });
  fs.appendFileSync(
    path.join(root, ".git", "config"),
    "\n[credential]\n\textraheader = AUTHORIZATION: basic dXNlcjpwYXNz\n"
  );
  try {
    fs.symlinkSync(".git/config", path.join(root, "notes.txt"));
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return t.skip("symlinks unavailable");
    throw error;
  }
  git(root, ["add", "notes.txt", "src/a.ts"]);

  const result = generateSnapshot(resolveConfig({ outDir: "snapshot" }, {}, root));
  assert.equal(result.files.some((file) => file.relativePath === "notes.txt"), false);
  const part = fs.readFileSync(path.join(root, "snapshot", "parts", "part-001.md"), "utf8");
  assert.doesNotMatch(part, /dXNlcjpwYXNz/);
});

test("CF-02: a symlinked PROMPT.md is refused by the resource reader", async (t) => {
  const root = initRepo(t, { "src/a.ts": "export const a = 1;\n" });
  generateSnapshot(resolveConfig({ outDir: "snapshot" }, {}, root));
  const outside = path.join(root, "..", path.basename(root) + "-outside.txt");
  fs.writeFileSync(outside, "HOST-SECRET\n");
  t.after(() => fs.rmSync(outside, { force: true }));

  const prompt = path.join(root, "snapshot", "PROMPT.md");
  fs.rmSync(prompt);
  try {
    fs.symlinkSync(outside, prompt);
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return t.skip("symlinks unavailable");
    throw error;
  }

  const provider = buildResourceProvider();
  await assert.rejects(
    () => provider.read("snapshot://prompt", contextFor(root)),
    (error) => {
      assert.equal(error.name, "ResourceNotFoundError");
      assert.doesNotMatch(error.message, /HOST-SECRET/);
      return true;
    }
  );
});

test("CF-03: a non-ASCII sensitive path is omitted from reports/diff.md", (t) => {
  const root = initRepo(t, { "src/a.ts": "export const a = 1;\n" });
  write(root, "café/.env", "CUSTOM_LINE=secret_payload_123\n");
  write(root, "src/a.ts", "export const a = 2;\n");
  git(root, ["add", "café/.env", "src/a.ts"]);

  generateSnapshot(
    resolveConfig({ outDir: "snapshot", artifacts: { diff: true } }, {}, root)
  );
  const report = path.join(root, "snapshot", "reports", "diff.md");
  assert.ok(fs.existsSync(report), "the safe change still produces a report");
  const text = fs.readFileSync(report, "utf8");
  assert.doesNotMatch(text, /secret_payload_123/);
  assert.doesNotMatch(text, /café/);
  assert.match(text, /src\/a\.ts/);
});

test("CF-04: a secret in an owner-brief heading is masked in PROMPT.md", (t) => {
  const root = initRepo(t);
  const token = "ghp_123456789012345678901234567890123456";
  write(root, "BRIEF.md", "## Incident " + token + "\n\nDetails.\n");
  generateSnapshot(resolveConfig({ outDir: "snapshot", brief: "BRIEF.md" }, {}, root));
  const prompt = fs.readFileSync(path.join(root, "snapshot", "PROMPT.md"), "utf8");
  assert.doesNotMatch(prompt, new RegExp(token));
  assert.match(prompt, /REDACTED/);
});

test("CF-05: snapshot_search refuses a catastrophic regex without running it", async (t) => {
  const root = initRepo(t, { "src/a.ts": "export const a = 1;\n" });
  const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
  await tools.get("snapshot_generate").handler({}, contextFor(root));
  const started = Date.now();
  const result = await tools.get("snapshot_search").handler(
    { query: "(a+)+$", regex: true },
    contextFor(root)
  );
  assert.equal(result.isError, true);
  assert.ok(Date.now() - started < 1000, "the refusal is immediate");
  assert.match(result.text, /refused|complex/i);

  const optionalNested = await tools.get("snapshot_search").handler(
    { query: "(a?)+$", regex: true },
    contextFor(root)
  );
  assert.equal(optionalNested.isError, true);
});

test("CF-05: HTTP MCP rejects a flood of concurrent tool calls", async (t) => {
  const root = initRepo(t);
  const transport = await startHttpTransport({
    cwd: root,
    host: "127.0.0.1",
    port: 0,
    token: null,
    log: () => {},
  });
  t.after(() => transport.close());
  const initialized = await fetch(transport.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "audit", version: "1" },
      },
    }),
  });
  const sessionId = initialized.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize establishes a session");
  const request = (id) =>
    fetch(transport.url, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "snapshot_generate", arguments: {} },
      }),
    }).then((response) => response.json());
  const answers = await Promise.all(Array.from({ length: 12 }, (_, index) => request(index)));
  assert.ok(
    answers.some((answer) => answer.error?.code === -32001),
    "at least one call is refused while four are in flight"
  );
});

test("CF-08: --workspace --dry-run writes nothing", (t) => {
  const root = initRepo(t, { "pkg-a/package.json": '{"name":"a","version":"1.0.0"}\n' });
  const result = spawnSync(
    process.execPath,
    [BIN, "generate", "--cwd", root, "--workspace", "pkg-a", "--dry-run"],
    { cwd: root, encoding: "utf8", windowsHide: true }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(root, "snapshot")), false);

  const refused = spawnSync(
    process.execPath,
    [BIN, "generate", "--cwd", root, "--workspace", "pkg-a", "--out-dir", "."],
    { cwd: root, encoding: "utf8", windowsHide: true }
  );
  assert.notEqual(refused.status, 0);
  assert.equal(fs.existsSync(path.join(root, "WORKSPACE.json")), false);
});

test("CF-07: a failed clone removes its temporary directory", async (t) => {
  const root = tempDir(t);
  const dest = path.join(root, "clone");
  await assert.rejects(() =>
    cloneRepository(
      { kind: "file", url: "file:///definitely-not-a-repository", host: "file", owner: "", repo: "x", ref: null },
      { dest }
    )
  );
  assert.equal(fs.existsSync(dest), false);
});

test("CF-12: snapshot_symbol finds a call site in a later part", async (t) => {
  const root = initRepo(t);
  write(root, "000-def.ts", "export function target() { return 1; }\n");
  for (let index = 0; index < 15; index += 1) {
    write(root, "filler-" + String(index).padStart(2, "0") + ".ts", "// filler\n".repeat(2000));
  }
  write(root, "zzz-call.ts", 'import { target } from "./000-def.js";\ntarget();\n');

  const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
  const generated = await tools.get("snapshot_generate").handler({}, contextFor(root));
  assert.equal(generated.isError, undefined);
  const found = await tools.get("snapshot_symbol").handler({ name: "target" }, contextFor(root));
  assert.equal(found.isError, undefined);
  assert.ok(
    found.structured.references.some((site) => site.path === "zzz-call.ts"),
    JSON.stringify(found.structured)
  );
});

test("CF-09: validate --staged accepts a staged file deleted from the worktree", (t) => {
  const root = initRepo(t);
  write(root, "staged-only.ts", "export const x = 1;\n");
  git(root, ["add", "staged-only.ts"]);
  fs.rmSync(path.join(root, "staged-only.ts"));

  const config = resolveConfig({ outDir: "snapshot", staged: true }, {}, root);
  generateSnapshot(config);
  const result = validateSnapshot(config);
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("CF-10: --port 0 is accepted and bounded", () => {
  assert.equal(parseCliArgs(["mcp", "--http", "--port", "0"]).port, 0);
  assert.throws(() => parseCliArgs(["mcp", "--http", "--port", "65536"]), /65535/);
});

test("CF-10: snapshot_validate accepts the only/ignore used to generate", async (t) => {
  const root = initRepo(t, {
    "src/a.ts": "export const a = 1;\n",
    "docs/b.md": "# B\n",
  });
  const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
  const generated = await tools.get("snapshot_generate").handler(
    { only: ["src/**"] },
    contextFor(root)
  );
  assert.equal(generated.isError, undefined);
  const validated = await tools.get("snapshot_validate").handler(
    { only: ["src/**"] },
    contextFor(root)
  );
  assert.equal(validated.structured.current, true, validated.text);
});

test("CF-11: installPreCommitHook refuses a symlinked hook", (t) => {
  const root = initRepo(t);
  fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  const outside = path.join(root, "..", path.basename(root) + "-outside-hook");
  t.after(() => fs.rmSync(outside, { force: true }));
  try {
    fs.symlinkSync(outside, path.join(root, ".git", "hooks", "pre-commit"));
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return t.skip("symlinks unavailable");
    throw error;
  }

  const result = installPreCommitHook(root);
  assert.equal(result.written, false);
  assert.equal(fs.existsSync(outside), false);
});

test("CF-13: a YAML secret section is not over-redacted", () => {
  const { redacted } = scan(
    "secret:\n  ignored_paths:\n    - docs/example.md\n    - src/a.ts\n",
    ".gitguardian.yaml"
  );
  assert.match(redacted, /ignored_paths/);
  assert.match(redacted, /docs\/example\.md/);
});

test("CF-14: full-file line totals agree, and README steps are numbered once", (t) => {
  const root = initRepo(t, { "src/a.ts": "export const a = 1;\n\n" });
  const manifest = generateSnapshot(resolveConfig({ outDir: "snapshot" }, {}, root));
  assert.equal(manifest.totals.emittedLines, manifest.totals.sourceLines);
  assert.equal(manifest.counts.incompleteCount, 0);
  const readme = fs.readFileSync(path.join(root, "snapshot", "README.md"), "utf8");
  assert.doesNotMatch(readme, /1\. Read/);
});
