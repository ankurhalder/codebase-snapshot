import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, resolveConfig, validateSnapshot } from "../dist/index.js";
import { buildTools } from "../dist/mcp.js";

/**
 * A scoped snapshot has to be verifiable in both directions, and the MCP surface has to be able to
 * describe the run it is looking at.
 *
 * The scope is the interesting half: `--staged` and `--changed-since` narrow the snapshot to a set
 * of paths that exists only for a moment. When that moment passes, the bytes on disk do not change,
 * so a hash comparison cannot see anything wrong — the snapshot is stale because its *scope* is
 * stale, not because a file moved.
 */

const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
const contextFor = (root) => ({ cwd: root, roots: [root], log: () => {} });

async function call(name, args, root) {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} exists`);
  return tool.handler(args, contextFor(root));
}

function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-parity-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const git = (root, args) =>
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

/** A commit, so `git add`/`git reset` have a clean starting point. */
function initRepo(t, files) {
  const root = makeRepo(t, files);
  if (!gitAvailable) return root;
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "one"]);
  return root;
}

const reasonHints = (result) =>
  [...result.drift.configMismatches, ...result.drift.missingInSnapshot].join("\n");

test(
  "a file that left the staging area is drift, even though its bytes did not change",
  { skip: !gitAvailable },
  (t) => {
    // `git add src/a.ts`, generate with `--staged`, then `git reset src/a.ts`. The file on disk is
    // byte-identical, so the hash comparison passes, and `validate --staged` reported "valid and up
    // to date" for a snapshot whose entire reason for including that file no longer existed. The
    // unchanged-scope check only ran for files that were *not* in the snapshot.
    const root = initRepo(t, { "src/a.ts": "export const a = 1;\n" });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2;\n");
    git(root, ["add", "src/a.ts"]);

    const config = resolveConfig(
      { cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", staged: true },
      {},
      root
    );
    const manifest = generateSnapshot(config);
    assert.deepEqual(
      manifest.files.map((file) => file.relativePath),
      ["src/a.ts"],
      "the staged file is what the snapshot holds"
    );

    assert.equal(validateSnapshot(config).valid, true, "while it is staged, the snapshot is current");

    git(root, ["reset", "-q", "HEAD", "--", "src/a.ts"]);
    const afterReset = validateSnapshot(config);
    assert.equal(afterReset.valid, false, "once it is no longer staged, the snapshot is stale");
    assert.match(reasonHints(afterReset), /no longer in the changed-files scope/);

    // Committing has the same effect on the index, and the same answer.
    git(root, ["add", "src/a.ts"]);
    git(root, ["commit", "-qm", "two"]);
    const afterCommit = validateSnapshot(config);
    assert.equal(afterCommit.valid, false, "a commit empties the staged set too");
    assert.match(reasonHints(afterCommit), /no longer in the changed-files scope/);
  }
);

test("snapshot_validate accepts the flags the snapshot was generated with", async (t) => {
  // `WorkspaceOverrides` knew only `maxPartBytes` and `outDir`. `validate` re-derives the effective
  // configuration and compares digests, so a snapshot generated with `--skeleton` could not be
  // validated over MCP at all: every field of the comparison disagreed with a configuration the
  // server had no way to describe.
  const root = makeRepo(t, {
    "src/app.ts": "export function compute() {\n  return 6 * 7;\n}\n",
  });

  const generated = await call("snapshot_generate", { skeleton: true }, root);
  assert.ok(!generated.isError, generated.text);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8")
  );
  assert.equal(manifest.config.skeleton, true, "the flag reached the generator");
  const app = manifest.files.find((file) => file.relativePath === "src/app.ts");
  assert.equal(app.inclusionMode, "signatures", "and it compressed the file");

  const validated = await call("snapshot_validate", { skeleton: true }, root);
  const structured = validated.structured;
  assert.equal(structured.current, true, `the snapshot validates: ${validated.text}`);
  assert.equal(structured.drift.configMismatches.count, 0, "no configuration drift");

  // Without the flag the comparison is against a different configuration, which is real drift and
  // must still be reported — the flag has to be *doing* something.
  const withoutFlag = await call("snapshot_validate", {}, root);
  assert.equal(withoutFlag.structured.current, false, "the flag is not ignored");
});

test("snapshot_plan honours a token budget the same way the CLI does", async (t) => {
  // `--max-part-tokens` narrows the byte budget, and the plan output reports the effective bytes.
  // The server could not pass it, so an agent planning with tokens was planning against a figure
  // nothing would honour.
  const root = makeRepo(t, { "src/app.ts": "export const app = 1;\n" });
  const planned = await call("snapshot_plan", { maxPartTokens: "4k" }, root);
  assert.ok(!planned.isError, planned.text);
  assert.equal(planned.structured.maxPartBytes, 16384, "4 096 tokens is 16 384 bytes");

  const invalid = await call("snapshot_plan", { maxPartTokens: "nonsense" }, root);
  assert.equal(invalid.isError, true, "an unparseable budget is an error, not the default");
});

test("snapshot_generate can build a scoped snapshot over MCP", { skip: !gitAvailable }, async (t) => {
  const root = initRepo(t, { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2;\n");
  git(root, ["add", "src/a.ts"]);

  const generated = await call("snapshot_generate", { staged: true }, root);
  assert.ok(!generated.isError, generated.text);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8")
  );
  assert.equal(manifest.config.staged, true);
  assert.deepEqual(
    manifest.files.map((file) => file.relativePath),
    ["src/a.ts"],
    "only the staged file is in it"
  );

  const validated = await call("snapshot_validate", { staged: true }, root);
  assert.equal(validated.structured.current, true, `and it validates: ${validated.text}`);
});

test("the tools that do not take a scope say so", () => {
  // The advertised schema and the applied override come from one definition, so a flag cannot be
  // offered by a tool that ignores it.
  for (const name of ["snapshot_plan", "snapshot_generate", "snapshot_validate", "snapshot_explain"]) {
    const properties = tools.get(name).inputSchema.properties;
    for (const flag of ["skeleton", "sarif", "changedSince", "staged", "withDependents", "maxPartTokens"]) {
      assert.ok(flag in properties, `${name} advertises ${flag}`);
    }
  }
  for (const name of ["snapshot_status", "snapshot_locate", "snapshot_dependents", "snapshot_read"]) {
    const properties = tools.get(name).inputSchema.properties;
    assert.equal("skeleton" in properties, false, `${name} does not offer what it would ignore`);
  }
});
