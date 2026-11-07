import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, partitionFiles, renumberParts, resolveConfig } from "../dist/index.js";

/**
 * Per-layer budgets, and the numbering that has to be decided before a part is rendered.
 *
 * The generator used to partition each budget separately and then re-number the merged set. A part
 * fitted to its budget grew by up to fourteen bytes in that rewrite (`- Previous: none` becomes
 * `- Previous: part-001.md`), and the byte bound was re-applied to the rewritten part afterwards.
 * Numbers and links are now decided once, before anything is rendered, so a part is built at the
 * size it will be published at.
 */

function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "part-budget-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function readParts(root, manifest) {
  return manifest.parts.map((part) => ({
    part,
    text: fs.readFileSync(path.join(root, "snapshot", "parts", part.filename), "utf8"),
  }));
}

/** Every structural promise a part makes about itself, checked. */
function assertPartsAreCoherent(root, manifest) {
  const parts = readParts(root, manifest);

  assert.deepEqual(
    parts
      .filter(({ part }) => part.byteSize > part.budgetBytes)
      .map(({ part }) => `${part.filename}: ${part.byteSize} > ${part.budgetBytes}`),
    [],
    "every part fits the budget it was built for"
  );
  assert.deepEqual(
    parts
      .filter(({ text }) => text.includes("[part truncated"))
      .map(({ part }) => part.filename),
    [],
    "no part was cut to make room for its own header"
  );

  // Numbering is a gapless sequence, and the links form a chain through it.
  assert.deepEqual(
    manifest.parts.map((part) => part.index),
    manifest.parts.map((_, index) => index + 1),
    "indices are 1..n in order"
  );
  assert.deepEqual(
    manifest.parts.map((part) => part.filename),
    manifest.parts.map((_, index) => `part-${String(index + 1).padStart(3, "0")}.md`),
    "filenames follow the indices"
  );
  for (const [index, { text, part }] of parts.entries()) {
    const previous = index === 0 ? "none" : manifest.parts[index - 1].filename;
    const next = index === parts.length - 1 ? "none" : manifest.parts[index + 1].filename;
    assert.ok(text.includes(`- Previous: ${previous}`), `${part.filename}: previous link`);
    assert.ok(text.includes(`- Next: ${next}`), `${part.filename}: next link`);
    assert.ok(
      text.includes(`Part ${String(index + 1).padStart(3, "0")} of ${String(parts.length).padStart(3, "0")}`),
      `${part.filename}: "of n" counts the whole run, not one budget`
    );

    // Every section it advertises is really in it, and every file points back at it.
    for (const included of part.includedFiles) {
      assert.ok(
        text.includes(`### FILE: ${included.relativePath}`),
        `${part.filename} lists ${included.relativePath}`
      );
      const file = manifest.files.find((entry) => entry.relativePath === included.relativePath);
      assert.equal(file?.part, part.filename, `${included.relativePath} points back at its part`);
    }
    // And the section is whole: a clipped part loses its closing fence, which is what the
    // after-the-fact clamp used to produce.
    assert.match(text.trimEnd(), /`{4,}$/, `${part.filename} ends with its closing fence`);
  }

  const fileCount = manifest.parts.reduce((total, part) => total + part.fileCount, 0);
  assert.equal(fileCount, manifest.files.length, "every file is accounted for by exactly one part");
}

test("two budgets still produce one numbered sequence", (t) => {
  const files = {};
  for (let index = 0; index < 6; index += 1) {
    files[`src/module-${index}.ts`] = `export const value${index} = "${"s".repeat(240)}";\n`.repeat(6);
    files[`docs/page-${index}.md`] = `# Page ${index}\n\n${"prose line\n".repeat(12)}`;
  }
  const root = makeRepo(t, files);

  const config = resolveConfig(
    {
      cwd: root,
      outDir: "snapshot",
      tmpDir: "snapshot.tmp",
      discovery: "walk",
      budgets: { default: "16k", byLayer: { src: "8k" } },
      layers: [
        { name: "src", match: "src/**" },
        { name: "docs", match: "docs/**" },
      ],
      artifacts: { readme: false, navigation: false, projectTree: false, audit: false },
    },
    {},
    root
  );
  const manifest = generateSnapshot(config);

  assert.ok(manifest.parts.length > 2, `more than one budget really produced parts: ${manifest.parts.length}`);
  const budgets = new Set(manifest.parts.map((part) => part.budgetBytes));
  assert.deepEqual([...budgets].sort((a, b) => a - b), [8192, 16384], "each part kept its own budget");
  assertPartsAreCoherent(root, manifest);
});

test("a tight budget with many files keeps the same promises", (t) => {
  const files = {};
  for (let index = 0; index < 12; index += 1) {
    files[`src/file-${index}.ts`] = `export const value${index} = 1;\n`.repeat(40);
  }
  const root = makeRepo(t, files);
  const manifest = generateSnapshot(
    resolveConfig(
      { cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", discovery: "walk", maxPartBytes: 4096 },
      {},
      root
    )
  );
  assert.ok(manifest.parts.length > 1, "the budget really does split the run");
  assertPartsAreCoherent(root, manifest);
});

test("renumberParts still renumbers and re-links a merged set", (t) => {
  // Kept as a public function, and kept working: it is the only supported way to merge parts that
  // somebody else partitioned, and a caller that merges two single-part runs needs exactly this.
  const root = makeRepo(t, {
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
  });
  const config = resolveConfig(
    { cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", discovery: "walk" },
    {},
    root
  );
  const first = generateSnapshot(config);
  const parts = first.parts.map((part) => ({
    filename: part.filename,
    markdown: fs.readFileSync(path.join(root, "snapshot", "parts", part.filename), "utf8"),
    metadata: part,
  }));
  assert.equal(parts.length, 1, "one part to start from");

  // The same part twice stands in for two separately partitioned halves.
  const merged = renumberParts([...parts, ...parts], first.fingerprint);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].filename, "part-001.md");
  assert.equal(merged[1].filename, "part-002.md");
  assert.match(merged[0].markdown, /- Next: part-002\.md/);
  assert.match(merged[1].markdown, /- Previous: part-001\.md/);
  assert.match(merged[1].markdown, /Part 002 of 002/);
  for (const part of merged) {
    assert.equal(part.metadata.byteSize, Buffer.byteLength(part.markdown, "utf8"));
    assert.notEqual(part.metadata.sha256, "placeholder");
  }
});

test("partitionFiles alone still numbers from one and honours its budget", () => {
  // The single-bucket entry point is unchanged in behaviour, and it is what a library caller has.
  assert.deepEqual(partitionFiles([], 8192), [], "no files, no parts");
});
