import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { generateSnapshot, normalizeResolvedConfig, resolveConfig } from "../dist/index.js";

/**
 * Two budget bugs from the 0.9.10 audit.
 *
 * 1. `{ ...resolved, maxPartBytes: 64 * 1024 }` is a resolved config by every structural test,
 *    so `normalizeResolvedConfig` kept the **old** `budgets` object and the new number was
 *    dropped. The partitioner reads `budgets.default`, so a caller who lowered the budget got
 *    300 KB parts and a manifest that recorded 64 KB.
 * 2. `--max-part-tokens 200` is 800 bytes, below the 4096-byte floor. It was accepted and raised
 *    to 1024 tokens without a word — the setting never applied, and the number printed back was
 *    a different one. Rule 1 says an impossible budget is an error.
 */

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

function tempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n", "utf8");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.error, undefined);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("a spread config's new maxPartBytes reaches budgets.default", () => {
  const resolved = resolveConfig({ cwd: process.cwd(), maxPartBytes: 300 * 1024 });
  assert.equal(resolved.budgets.default, 300 * 1024);

  const spread = { ...resolved, maxPartBytes: 64 * 1024 };
  const normalized = normalizeResolvedConfig(spread);

  assert.equal(normalized.maxPartBytes, 64 * 1024);
  assert.equal(normalized.budgets.default, 64 * 1024, "the partitioner reads budgets.default");
});

test("a spread config's budget caps the per-layer budgets as well", () => {
  const resolved = resolveConfig({
    cwd: process.cwd(),
    maxPartBytes: 300 * 1024,
    budgets: { default: "300k", byLayer: { docs: "200k", api: "400k" } },
  });
  const normalized = normalizeResolvedConfig({ ...resolved, maxPartBytes: 64 * 1024 });

  assert.equal(normalized.budgets.default, 64 * 1024);
  assert.equal(normalized.budgets.byLayer.docs, 64 * 1024, "capped, not left above the budget");
  assert.equal(normalized.budgets.byLayer.api, 64 * 1024);
});

test("a smaller budget on a spread config is what the partitioner enforces", (t) => {
  const dir = tempRepo(t);
  // ~150 KB of text, so a 64 KB budget must split it and a 300 KB one would not.
  fs.writeFileSync(
    path.join(dir, "big.ts"),
    "export const big = [\n" +
      Array.from({ length: 3000 }, (_, index) => `  "line ${index} of padding text here",`).join("\n") +
      "\n];\n",
    "utf8"
  );

  const resolved = resolveConfig({
    cwd: dir,
    outDir: "snapshot",
    tmpDir: "snapshot.tmp",
    maxPartBytes: 300 * 1024,
  });
  const manifest = generateSnapshot({ ...resolved, maxPartBytes: 64 * 1024 });

  assert.ok(
    manifest.counts.partsCount >= 2,
    `a 64 KB budget cannot fit 150 KB in one part (got ${manifest.counts.partsCount})`
  );
  for (const part of manifest.parts) {
    assert.ok(
      part.byteSize <= 64 * 1024,
      `${part.filename} is ${part.byteSize} bytes, over the spread budget`
    );
  }
});

test("a config that only sets budgets.default still records that budget", (t) => {
  const dir = tempRepo(t);
  const manifest = generateSnapshot({
    cwd: dir,
    outDir: "snapshot",
    tmpDir: "snapshot.tmp",
    budgets: { default: "100k" },
  });

  // The partitioner read `budgets.default`; the manifest recorded `maxPartBytes`, which used to
  // stay at the 300 KB default. One snapshot describing two different budgets is a lie either way.
  assert.equal(manifest.config.maxPartBytes, 100 * 1024);
});

test("--max-part-tokens below the floor is a usage error, not a silent clamp", (t) => {
  const dir = tempRepo(t);
  const result = run(["generate", "--max-part-tokens", "200", "--cwd", dir], dir);

  assert.equal(result.status, 2, "a usage error, not a run");
  assert.match(result.stderr, /max-part-tokens/);
  assert.match(result.stderr, /at least 1024/, "the floor it needs, in the unit it was written in");
});

test("--max-part-tokens rejects a byte count with advice about tokens", (t) => {
  const dir = tempRepo(t);
  const result = run(["generate", "--max-part-tokens", "many", "--cwd", dir], dir);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /token count/, "the unit that was asked for");
  assert.doesNotMatch(result.stderr, /expects a byte count/);
});

test("--max-part-tokens at the floor is accepted", (t) => {
  const dir = tempRepo(t);
  const result = run(
    ["generate", "--max-part-tokens", "1024", "--cwd", dir, "--skip-artifacts", "monolith"],
    dir
  );

  assert.equal(result.status, 0, result.stderr);
});
