import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, resolveConfig, validateSnapshot } from "../dist/index.js";

/**
 * Part budgets and the omission notice, from the 0.9.9 audit.
 *
 * Two defects in the same area: a body cut twice reported only the second cut's line
 * count, so a 1,000-line file that kept ten lines said "1 line omitted"; and with
 * per-layer budgets every part was verified against the *largest* budget in the run,
 * so a part twice over its own layer budget was reported as fine.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "part-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

/** Every `part-NNN.md` under `dir`, with its bytes and recorded metadata. */
function readParts(dir, manifest) {
  return manifest.parts.map((part) => {
    const file = path.join(dir, "snapshot", "parts", part.filename);
    return { ...part, diskBytes: fs.statSync(file).size, markdown: fs.readFileSync(file, "utf8") };
  });
}

test("a body cut by the part budget reports the file's real omission count", async (t) => {
  const dir = tempDir(t);
  // 1,000 lines of 400 characters: far past `largeFileBytes`, so the body arrives as a
  // head/tail preview and is then cut again to fit the part budget.
  const line = "x".repeat(400);
  write(dir, "big.ts", `${Array.from({ length: 1000 }, (_, i) => `${line} // ${i}`).join("\n")}\n`);

  const config = resolveConfig({
    cwd: dir,
    outDir: "snapshot",
    tmpDir: "snapshot.tmp",
    largeFileBytes: "1k",
    previewHeadLines: 5,
    previewTailLines: 5,
    maxPartBytes: "4k",
  });
  const manifest = generateSnapshot(config);

  const marker = /\[(\d+) lines omitted: part budget (\d+) B\]/;
  const withMarker = manifest.parts
    .map((part) => fs.readFileSync(path.join(dir, "snapshot", "parts", part.filename), "utf8"))
    .map((text) => marker.exec(text))
    .filter(Boolean);

  assert.ok(withMarker.length > 0, "the body must be cut by the budget, or this proves nothing");
  const omitted = Number(withMarker[0][1]);
  assert.ok(
    omitted > 500,
    `the notice must describe the file, not the second cut: reported ${omitted} of 1,000 lines`
  );
});

test("per-layer budgets are recorded per part and honoured on disk", async (t) => {
  const dir = tempDir(t);
  for (const name of ["a", "b", "c", "d"]) {
    write(dir, `src/${name}.ts`, `${`export const ${name} = 1;\n`.repeat(400)}`);
  }
  write(dir, "README.md", "# fixture\n");

  const config = resolveConfig({
    cwd: dir,
    outDir: "snapshot",
    tmpDir: "snapshot.tmp",
    maxPartBytes: "16k",
    budgets: { default: "16k", byLayer: { src: "4k" } },
  });
  const manifest = generateSnapshot(config);
  const parts = readParts(dir, manifest);

  assert.ok(
    parts.some((part) => part.budgetBytes === 4096),
    `the src layer must use its own budget: ${parts.map((part) => part.budgetBytes).join(", ")}`
  );
  for (const part of parts) {
    assert.ok(
      part.budgetBytes <= 4096 || part.budgetBytes === 16384,
      `every part carries the budget it was built for, got ${part.budgetBytes}`
    );
    assert.ok(
      part.diskBytes <= part.budgetBytes,
      `${part.filename} is ${part.diskBytes} B against a ${part.budgetBytes} B budget`
    );
  }
  // The snapshot the generator just wrote must pass its own validator.
  const validation = validateSnapshot(config);
  assert.deepEqual(validation.drift.partIssues, [], "no part may be over its budget");
  assert.equal(validation.valid, true, JSON.stringify(validation.drift));
});
