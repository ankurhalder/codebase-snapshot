import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildTools } from "../dist/mcp.js";

/**
 * `snapshot_plan` reads and parses every file in the repository, so it blocks the server for as
 * long as a generate does — the failure the worker thread was added to fix. The worker was applied
 * to one of the two generate call sites.
 *
 * The threading itself has no observable output: a dry run writes nothing either way, and a
 * tool-call timeout is what the fix prevents, not what it produces. So the wiring is asserted from
 * the source text — the same technique this repository uses for the three properties that have no
 * behavioural signal — and the behaviour (same numbers, nothing written, config honoured) is
 * asserted against the tool.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_SOURCE = fs.readFileSync(path.join(HERE, "..", "src", "mcp", "tools.ts"), "utf8");
const WORKER_SOURCE = fs.readFileSync(
  path.join(HERE, "..", "src", "mcp", "generate-worker.ts"),
  "utf8"
);

const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
const contextFor = (root) => ({ cwd: root, roots: [root], log: () => {} });

async function call(name, args, context) {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} exists`);
  return tool.handler(args, context);
}

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-plan-"));
  const write = (relative, content) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
  write("package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write("src/a.ts", "export const a = 1;\n");
  write("src/b.ts", "export const b = 2;\n");
  write("notes/ignored.md", "# ignored\n");
  // A config the *worker* has to load: if the tool planned from the calling thread's resolved
  // config, the exclusion would still apply, so this is a shape check rather than a discriminator.
  write("snapshot.config.json", '{ "outDir": "ctx", "excludePatterns": ["notes/**"] }\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("snapshot_plan does its generate on the worker thread", () => {
  const plan = TOOLS_SOURCE.slice(TOOLS_SOURCE.indexOf("const planTool"));
  const generate = TOOLS_SOURCE.slice(TOOLS_SOURCE.indexOf("const generateTool"));

  assert.match(
    plan,
    /await generateInWorker\(\s*workspace\.root,\s*workspace\.cliOptions,\s*\{ dryRun: true \}/,
    "the plan handler must await the worker with a dry run"
  );
  assert.doesNotMatch(plan, /generateSnapshot\(/, "and must not generate on the RPC thread");
  assert.match(generate, /await generateInWorker\(/, "the generate handler keeps its worker call");
  assert.match(
    WORKER_SOURCE,
    /workerData\.dryRun === true/,
    "the worker applies the dry-run flag it is given"
  );
  assert.match(WORKER_SOURCE, /dryRun: options\.dryRun === true/, "the caller passes it across");
});

test("a plan reports the run it would make and writes nothing", async (t) => {
  const root = makeProject(t);
  const context = contextFor(root);

  const plan = await call("snapshot_plan", {}, context);
  assert.ok(!plan.isError, plan.text);
  assert.match(plan.text, /Dry run — nothing was written/);
  assert.equal(plan.structured.preset, "node-lib", "the fixture is a Node library");
  // package.json, snapshot.config.json, src/a.ts, src/b.ts — and notes/ignored.md is skipped by
  // the config's excludePatterns, which is the part that proves the worker loaded the file.
  assert.equal(plan.structured.files, 4);
  assert.equal(plan.structured.skipped, 1);
  assert.deepEqual(plan.structured.skipReasons, [{ reason: "excluded", count: 1 }]);
  assert.ok(plan.structured.parts >= 1);
  assert.ok(!fs.existsSync(path.join(root, "ctx")), "a plan writes no output directory");
  assert.ok(
    !fs.existsSync(path.join(root, "snapshot")),
    "and not the default one either"
  );

  // The same numbers a real dry run would produce, from the manifest the tool asks for.
  const generated = await call("snapshot_generate", {}, context);
  assert.ok(!generated.isError, generated.text);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "ctx", "manifest.json"), "utf8"));
  assert.equal(plan.structured.files, manifest.counts.totalFiles);
  assert.equal(plan.structured.parts, manifest.counts.partsCount);
  assert.equal(plan.structured.skipped, manifest.counts.skippedCount);
  assert.equal(plan.structured.emittedBytes, manifest.totals.totalContentBytes);
});

test("a plan lists the skip reasons the worker ranked", async (t) => {
  const root = makeProject(t);
  const context = contextFor(root);
  const plan = await call("snapshot_plan", { root: "." }, context);
  assert.ok(!plan.isError, plan.text);
  assert.ok(Array.isArray(plan.structured.skipReasons));
  assert.ok(
    plan.structured.skipReasons.every((entry) => typeof entry.reason === "string" && entry.count > 0),
    JSON.stringify(plan.structured.skipReasons)
  );
  for (const entry of plan.structured.skipReasons) {
    assert.match(plan.text, new RegExp(`${entry.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(${entry.count}\\)`));
  }
});
