import assert from "node:assert/strict";
import test from "node:test";

import { addHeadingIds, headingSlug, renderMarkdown, renderPages } from "../scripts/build-site.mjs";
import { findAnchorProblems } from "../scripts/check-site-links.mjs";

/**
 * The docs site shipped with every table-of-contents link dead.
 *
 * `marked` renders a heading as a plain `<h2>text</h2>`, and the site builder published that
 * as-is, while the prose was written for GitHub, where every heading gets an anchor. All 49
 * in-page and cross-page `#fragment` links on the 15 pages therefore pointed at nothing, and the
 * link checker passed them because it only asked whether a target file existed. These tests pin
 * both halves of the fix: the ids match the ones GitHub mints, and every anchor in the real
 * documentation resolves against them.
 */

test("heading ids follow GitHub's heading-anchor rules", () => {
  const table = [
    ["## Commands", "commands"],
    ["## Project presets", "project-presets"],
    ["## A file is missing from the snapshot", "a-file-is-missing-from-the-snapshot"],
    ["### `validate` / `check`", "validate--check"],
    ["### `diff <before> <after>`", "diff-before-after"],
    ["### `skipped[]`", "skipped"],
    ["## Exit code 2 — the command itself was wrong", "exit-code-2--the-command-itself-was-wrong"],
    ["### `Refusing to replace outDir …`", "refusing-to-replace-outdir-"],
  ];
  for (const [markdown, id] of table) {
    assert.match(renderMarkdown(`${markdown}\n`), new RegExp(`<h[1-6][^>]* id="${id}">`), markdown);
  }
});

test("headingSlug keeps what GitHub keeps and strips the rest", () => {
  assert.equal(headingSlug("Version 1.2.3"), "version-123");
  assert.equal(headingSlug("snake_case"), "snake_case");
  assert.equal(headingSlug("--mode"), "--mode");
  assert.equal(headingSlug("Café"), "café");
});

test("repeated headings get the -1 and -2 suffixes GitHub uses", () => {
  const ids = [
    ...renderMarkdown("## Example\n\n## Example\n\n## Example\n").matchAll(/<h2 id="([^"]+)"/g),
  ].map((match) => match[1]);
  assert.deepEqual(ids, ["example", "example-1", "example-2"]);
});

test("an explicit id is preserved and generated ids avoid it", () => {
  const html = addHeadingIds('<h2 id="kept">Kept</h2>\n<h2>Kept</h2>\n');
  assert.match(html, /<h2 id="kept">Kept<\/h2>/);
  assert.match(html, /<h2 id="kept-1">Kept<\/h2>/);
});

test("a fragment no element declares is reported with its page and href", () => {
  const pages = new Map([
    ["a.html", '<h2 id="present">Present</h2><a href="#missing">x</a><a href="#present">y</a>'],
    ["b.html", '<p><a href="a.html#missing">z</a></p>'],
  ]);
  const { checked, problems } = findAnchorProblems(pages);
  assert.equal(checked, 3);
  assert.deepEqual(problems, [
    'a.html -> #missing (a.html has no element with id "missing")',
    'b.html -> a.html#missing (a.html has no element with id "missing")',
  ]);
});

test("a duplicate id is reported once", () => {
  const { problems } = findAnchorProblems(
    new Map([["dup.html", '<h2 id="x">One</h2><h2 id="x">Two</h2>']])
  );
  assert.deepEqual(problems, ['dup.html: duplicate id "x"']);
});

test("every anchor in the published documentation resolves", () => {
  const pages = new Map(renderPages().map((rendered) => [`${rendered.slug}.html`, rendered.html]));
  const { checked, problems } = findAnchorProblems(pages);
  assert.deepEqual(problems, []);
  assert.ok(checked > 40, `only ${checked} anchors were checked`);
});
