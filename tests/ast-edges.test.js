import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  enforceBudget,
  estimateTokens,
  isTsxFileName,
  skeletonizeTypeScript,
  summarizeMarkdown,
  summarizeTypeScriptSource,
} from "../dist/index.js";

/**
 * AST and structural-summary edge cases from the 0.9.10 audit.
 *
 * Each of these is a case where the summary described a document that is not the one on disk —
 * the failure mode the whole tool exists to avoid.
 */

test("a .TSX file is treated as TypeScript-with-JSX, exactly like a .tsx one", () => {
  // Collapsing a body is span-based, so the two script kinds happen to produce the same text for
  // a simple component — an output comparison cannot prove which parser ran. The decision is
  // therefore tested directly, and `skeletonizeTypeScript` uses the same helper.
  assert.equal(isTsxFileName("src/Card.tsx"), true);
  assert.equal(isTsxFileName("src/Card.TSX"), true, "the case that used to fall through");
  assert.equal(isTsxFileName("src/card.ts"), false);

  const source = "export function Card() {\n  return <div className=\"c\" />;\n}\n";
  const lower = skeletonizeTypeScript(source, "src/Card.tsx");
  const upper = skeletonizeTypeScript(source, "src/Card.TSX");

  assert.ok(lower.collapsed > 0, "the lowercase fixture collapses");
  assert.equal(upper.text, lower.text, "and the uppercase spelling behaves identically");
});

test("an unclosed `---` is a horizontal rule, not frontmatter", () => {
  const summary = summarizeMarkdown("---\n\n# First\n\n## Second\n");

  assert.deepEqual(
    summary.headings,
    ["# First", "## Second"],
    "a rule at line 0 used to swallow every heading in the file"
  );
});

test("a closed frontmatter block still parses", () => {
  const summary = summarizeMarkdown("---\ntitle: Guide\n---\n\n# First\n");

  assert.deepEqual(summary.frontmatterKeys, ["title"]);
  assert.deepEqual(summary.headings, ["# First"]);
});

test("a shorter fence inside a longer one is content, not a close", () => {
  // One inner fence line, so the toggling cannot cancel itself out: with the fence stored as a
  // bare character, the three-backtick line closed the four-backtick block and `# b` was read as
  // a real heading.
  const summary = summarizeMarkdown(["````", "# a", "```", "# b", "````", "# Real heading", ""].join("\n"));

  assert.deepEqual(
    summary.headings,
    ["# Real heading"],
    "everything between the four-backtick fences is a code example"
  );
});

test("a closing fence with an info string does not close the block", () => {
  const summary = summarizeMarkdown(["```", "text", "```bash", "# still inside", "```", "# Outside", ""].join("\n"));

  assert.deepEqual(summary.headings, ["# Outside"]);
});

test("a tilde fence and a backtick fence do not pair with each other", () => {
  const summary = summarizeMarkdown(["~~~", "```", "# inside", "~~~", "# Outside", ""].join("\n"));

  assert.deepEqual(summary.headings, ["# Outside"]);
});

test("destructured exports are reported as exports", () => {
  const summary = summarizeTypeScriptSource(
    "src/destructured.ts",
    [
      "const source = { a: 1, b: 2 };",
      "export const { a, b } = source;",
      "export const [first, ...rest] = [1, 2, 3];",
      "export const { a: renamed } = source;",
      "",
    ].join("\n")
  );

  for (const name of ["a", "b", "first", "rest", "renamed"]) {
    assert.ok(
      summary.exports.includes(name),
      `\`${name}\` is bound by a destructuring export, so it is part of the module's surface: ${JSON.stringify(summary.exports)}`
    );
  }
});

test("an omitted array element does not become a symbol", () => {
  const summary = summarizeTypeScriptSource(
    "src/sparse.ts",
    "export const [, second] = [1, 2];\n"
  );

  assert.deepEqual(summary.exports, ["second"]);
});

test("a clipped part reports the token count of the text it actually holds", () => {
  // `rehashPart` runs only when `enforceBudget` cuts a part, and it used to update byteSize,
  // sha256 and lines while leaving `estimatedTokens` at its pre-clip value — so the part's own
  // header, its metadata and any report summing metadata all described text that had been cut.
  // The partitioner splits oversized sections rather than clipping them, so no end-to-end
  // fixture reaches this branch; the guard is exercised directly.
  const body = Array.from({ length: 400 }, (_, index) => `- line ${index}: ${"x".repeat(40)}`).join(
    "\n"
  );
  const markdown = `# Part 001\n\n- Files: 1\n- Estimated Tokens: ~100000\n\n## src/big.ts\n\n${body}\n`;
  const part = {
    filename: "part-001.md",
    markdown,
    metadata: {
      index: 1,
      filename: "part-001.md",
      byteSize: Buffer.byteLength(markdown, "utf8"),
      estimatedTokens: 100_000,
      budgetBytes: 4096,
      sha256: "placeholder",
      lines: 500,
      fileCount: 1,
      layersCovered: [],
      includedFiles: [],
    },
  };

  const [clipped] = enforceBudget([part], 4096);

  assert.ok(clipped.markdown.includes("cannot fit budget"), "the part really was clipped");
  assert.ok(clipped.metadata.byteSize <= 4096, "and it fits the budget it was clipped to");
  assert.notEqual(clipped.metadata.estimatedTokens, 100_000, "the pre-clip number is gone");
  assert.equal(
    clipped.metadata.estimatedTokens,
    estimateTokens(clipped.markdown),
    "the recorded count describes the text that was actually written"
  );
});
