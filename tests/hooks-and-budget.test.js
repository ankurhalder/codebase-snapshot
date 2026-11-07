import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  enforceBudget,
  generateSnapshot,
  generateSnapshotAsync,
  resolveConfig,
} from "../dist/index.js";

/**
 * The after-generate hook and the byte bound, from the 0.9.12 audit.
 *
 * The hook is documented as the way to write your own artifact into the snapshot directory, and
 * the snapshot directory is only replaceable while `.codebase-snapshot` accounts for every file in
 * it. A hook that wrote a file and was not recorded therefore did not fail — it succeeded, and then
 * broke the *next* run, which refused the directory as foreign.
 */

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-budget-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const configWithHook = (root, hook) =>
  resolveConfig(
    { cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", hooks: { afterGenerate: hook } },
    {},
    root
  );

const markerEntries = (root) =>
  JSON.parse(fs.readFileSync(path.join(root, "snapshot", ".codebase-snapshot"), "utf8")).entries;

test("an async hook's file is recorded, so the next run may replace the directory", async (t) => {
  const root = makeRepo(t);
  const config = configWithHook(root, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(path.join(root, "snapshot", "CUSTOM.md"), "written by the hook\n");
  });

  await generateSnapshotAsync(config);
  assert.ok(
    fs.existsSync(path.join(root, "snapshot", "CUSTOM.md")),
    "the async form must resolve only after the hook has finished"
  );
  assert.ok(
    markerEntries(root).includes("CUSTOM.md"),
    "the ownership marker must list what the hook wrote"
  );

  // The real consequence: a second run must be able to replace its own output.
  const again = await generateSnapshotAsync(config);
  assert.equal(again.validation.status, "passed");
});

test("a synchronous hook that resolves later in the same way is still recorded", async (t) => {
  // `generateSnapshot` cannot await, so the re-ship happens when the promise settles. This is the
  // path a caller of the synchronous API takes.
  const root = makeRepo(t);
  const config = configWithHook(root, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    fs.writeFileSync(path.join(root, "snapshot", "LATE.md"), "late\n");
  });

  generateSnapshot(config);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(markerEntries(root).includes("LATE.md"), "the marker caught up once the hook landed");
  assert.doesNotThrow(() => generateSnapshot(config), "and the directory is still replaceable");
});

test("a failing async hook is a warning, not a crash and not an unhandled rejection", async (t) => {
  const root = makeRepo(t);
  const config = configWithHook(root, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error("hook blew up");
  });

  const manifest = await generateSnapshotAsync(config);
  assert.equal(manifest.validation.status, "passed", "the snapshot itself is fine");
  assert.ok(
    manifest.warnings.some((warning) => warning.includes("hooks.afterGenerate failed")),
    `the failure is recorded: ${JSON.stringify(manifest.warnings)}`
  );
  const shipped = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.ok(
    shipped.warnings.some((warning) => warning.includes("hook blew up")),
    "and it reached the manifest on disk"
  );
});

test("a clipped part stays inside the budget its token line is rewritten into", () => {
  // The last-resort clip reserved room for the truncation marker but not for the token count that
  // is rewritten afterwards — or inserted, when the clip cut the header away. Where the reserve
  // does not cover both, the "guarantee" is a marker plus 30 bytes of bookkeeping over the ceiling.
  //
  // Swept rather than pinned to one number: `truncateToBytes` keeps a variable amount of a short
  // corpus, so the boundary is not a single budget. A real configuration cannot request budgets
  // this small (`--max-part-bytes` has a floor), which is exactly why the invariant is asserted
  // here on `enforceBudget` itself — the function says the byte bound is a guarantee, and it has to
  // hold at every budget it accepts. A budget too small to hold the notice at all is refused
  // rather than answered with a part that is bigger than its own ceiling.
  const MARKER = "\n... [part truncated: cannot fit budget] ...\n";
  const smallest = Buffer.byteLength(MARKER, "utf8") + 1;
  const header = "# Part 001\n\n- Files: 1\n\n## Contents\n";
  const body = Array.from({ length: 60 }, (_, index) => `- line ${index} ${"y".repeat(20)}`).join(
    "\n"
  );
  const markdown = `${header}${body}`;
  const partAt = (budget) => ({
    filename: "part-001.md",
    markdown,
    metadata: {
      index: 1,
      filename: "part-001.md",
      byteSize: Buffer.byteLength(markdown, "utf8"),
      estimatedTokens: 0,
      budgetBytes: budget,
      sha256: "placeholder",
      lines: 1,
      fileCount: 1,
      layersCovered: [],
      includedFiles: [],
    },
  });

  const over = [];
  for (let budget = smallest; budget <= 300; budget += 1) {
    const [clipped] = enforceBudget([partAt(budget)], budget);
    if (clipped.metadata.byteSize > budget) over.push(`${budget}: ${clipped.metadata.byteSize}`);
  }
  assert.deepEqual(over, [], "no budget may produce a part larger than itself");

  assert.throws(
    () => enforceBudget([partAt(smallest)], Buffer.byteLength(MARKER, "utf8") - 1),
    /cannot hold the truncation notice/,
    "a budget that cannot hold the notice is refused, not silently exceeded"
  );
});

test("every part of a real snapshot fits the budget it was built for", (t) => {
  const root = makeRepo(t);
  for (let index = 0; index < 40; index += 1) {
    fs.writeFileSync(
      path.join(root, "src", `file-${index}.ts`),
      `export const value${index} = "${"y".repeat(200)}";\n`.repeat(40)
    );
  }
  const manifest = generateSnapshot(
    resolveConfig(
      { cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", maxPartBytes: 16384 },
      {},
      root
    )
  );
  const oversized = manifest.parts.filter((part) => part.byteSize > part.budgetBytes);
  assert.deepEqual(
    oversized.map((part) => `${part.filename}: ${part.byteSize} > ${part.budgetBytes}`),
    [],
    "the byte bound is a guarantee, not an aspiration"
  );
});
