import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { bytesForTokens, estimateTokens, generateSnapshot, resolveConfig } from "../dist/index.js";

/**
 * Token estimates, from the 0.9.9 audit.
 *
 * Every budget in the tool is in bytes and every reason to read a snapshot is in tokens. The
 * estimate has to be deterministic (it is recorded in a manifest and compared between runs),
 * it has to be in the right order of magnitude, and the `--max-part-tokens` ceiling has to be
 * a real ceiling rather than a second, ignored number.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-estimate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the estimate is deterministic and proportional", () => {
  const source = [
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
    "const label = \"a string with spaces and punctuation!\";",
  ].join("\n");

  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(source), estimateTokens(source), "same input, same number");
  assert.ok(estimateTokens(source) > 10, "a five-line program is more than ten tokens");

  // Twice the text is roughly twice the tokens — not exactly, because a repeated line
  // re-counts its own structure, but the estimate must not be off by an order of magnitude.
  const doubled = `${source}\n${source}`;
  const ratio = estimateTokens(doubled) / estimateTokens(source);
  assert.ok(ratio > 1.8 && ratio < 2.2, `doubling the text doubled the estimate (got ${ratio})`);
});

test("the estimate stays close to the bytes-per-token rule the docs publish", () => {
  // `docs/codebase-token-budget.md` tells readers to divide bytes by about 3.5. The estimate
  // is allowed to differ by the calibration stated in `tokenize.ts`; it must not be a
  // different answer to the same question.
  const source = `${"export const value = compute(input, other);\n".repeat(400)}`;
  const bytes = Buffer.byteLength(source, "utf8");
  const fromBytes = bytes / 3.5;
  const approximate = estimateTokens(source);
  const drift = Math.abs(approximate - fromBytes) / fromBytes;
  assert.ok(drift < 0.35, `estimate ${approximate} vs bytes/3.5 ${fromBytes.toFixed(0)}`);
});

test("a part records its tokens, and the header states them", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(
    path.join(dir, "src", "a.ts"),
    `${"export function fn(): number { return 1; }\n".repeat(200)}`
  );

  const config = resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" });
  const manifest = generateSnapshot(config);

  assert.ok(manifest.parts.length > 0);
  for (const part of manifest.parts) {
    assert.ok(part.estimatedTokens > 0, `${part.filename} carries an estimate`);
    const text = fs.readFileSync(path.join(dir, "snapshot", "parts", part.filename), "utf8");
    const header = /- Estimated Tokens: ~([\d,]+)/.exec(text);
    assert.ok(header, `${part.filename} states its estimate in the header`);
    assert.equal(
      Number(String(header[1]).replace(/,/g, "")),
      part.estimatedTokens,
      "the header and the manifest agree"
    );
  }

  const total = manifest.totals.estimatedTokens;
  assert.equal(
    total,
    manifest.parts.reduce((sum, part) => sum + part.estimatedTokens, 0),
    "the total is the sum of the parts"
  );
});

test("--max-part-tokens becomes a byte ceiling, and both are recorded", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, "src", "a.ts"), `${"export const a = 1;\n".repeat(50)}`);

  const tokens = 4000;
  const config = resolveConfig({
    cwd: dir,
    outDir: "snapshot",
    tmpDir: "snapshot.tmp",
    maxPartTokens: tokens,
  });

  assert.equal(config.maxPartTokens, tokens);
  assert.equal(config.maxPartBytes, bytesForTokens(tokens), "the byte budget is the conversion");

  const manifest = generateSnapshot(config);
  assert.equal(manifest.config.maxPartTokens, tokens, "the manifest states the user's unit");
  assert.equal(manifest.config.maxPartBytes, bytesForTokens(tokens));
  // And the ceiling is real: no part is over it.
  for (const part of manifest.parts) {
    assert.ok(part.byteSize <= config.maxPartBytes, `${part.filename} is ${part.byteSize} B`);
  }
});

test("a token budget never raises the byte budget", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  // 100,000 tokens is 400 KB, which is above the 120 KB byte budget named here.
  const config = resolveConfig({
    cwd: dir,
    outDir: "snapshot",
    tmpDir: "snapshot.tmp",
    maxPartBytes: "120k",
    maxPartTokens: 100_000,
  });
  assert.equal(config.maxPartBytes, 120 * 1024, "the smaller ceiling wins");
});
