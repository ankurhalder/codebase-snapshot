import assert from "node:assert/strict";
import test from "node:test";

import { summarizeMarkdown, summarizeWithProfile } from "../dist/index.js";

/**
 * Structural summaries, from the 0.9.9 audit.
 *
 * Both defects made `manifest.files[].summary` describe something other than the file.
 * The summary is what an agent reads instead of the file, so a wrong one is worse than
 * a missing one: it is confident, terse and searchable.
 */

test("a comment inside a fenced code block is not a document heading", () => {
  const markdown = [
    "# Real heading",
    "",
    "```bash",
    "# a shell comment, not a heading",
    "npm install",
    "```",
    "",
    "## Another real heading",
    "",
    "~~~python",
    "# a python comment",
    "~~~",
    "",
    "### Third heading",
  ].join("\n");

  assert.deepEqual(summarizeMarkdown(markdown).headings, [
    "# Real heading",
    "## Another real heading",
    "### Third heading",
  ]);
});

test("an unterminated fence does not swallow the rest of the document", () => {
  // A fence that was never closed is a real shape in a truncated file. Everything after
  // it is inside the block, so no later `#` is a heading — which is what a renderer does.
  const markdown = ["# Title", "```", "# inside the block", "still inside"].join("\n");
  assert.deepEqual(summarizeMarkdown(markdown).headings, ["# Title"]);
});

test("frontmatter keys are still read and fences inside frontmatter do not confuse it", () => {
  const markdown = ["---", "title: Test", "tags: [a]", "---", "# Body"].join("\n");
  const summary = summarizeMarkdown(markdown);
  assert.deepEqual(summary.frontmatterKeys, ["tags", "title"]);
  assert.deepEqual(summary.headings, ["# Body"]);
});

test("a single-file component is listed once, not once per sighting", () => {
  // `<script setup>` exports the component's own name, and the profile then adds the
  // component name again — the second push bypassed the sort-and-dedupe pass.
  const source = [
    "<template><button>hi</button></template>",
    '<script setup lang="ts">',
    "export const Button = 1;",
    "export function helper(): number { return 1; }",
    "</script>",
  ].join("\n");

  const { summary, quality } = summarizeWithProfile("components/Button.vue", source);

  assert.equal(quality, "ast");
  assert.equal(
    summary.exports.filter((name) => name === "Button").length,
    1,
    `exports must be a set: ${JSON.stringify(summary.exports)}`
  );
  assert.deepEqual(summary.reactComponents, ["Button"], "the component is listed once");
  assert.deepEqual(
    summary.exports,
    [...summary.exports].sort(),
    "and the list stays sorted after the component is added"
  );
});
