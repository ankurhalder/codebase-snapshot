import assert from "node:assert/strict";
import test from "node:test";

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

test("every image on a rendered page resolves to a file the site build copies", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const assets = new Set(
    fs.readdirSync(path.join(here, "..", "docs", "assets")).filter((name) => /\.(svg|png|ico)$/.test(name))
  );

  const broken = [];
  for (const page of renderPages()) {
    for (const match of page.html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|data:|#)/.test(target)) continue;
      if (!/^assets\//.test(target)) continue;
      const name = target.replace(/^assets\//, "");
      if (!assets.has(name)) broken.push(`${page.slug}: ${target}`);
    }
  }
  assert.deepEqual(broken, [], "an image path the build does not copy is a 404 on the live site");
});

test("no page references a repository asset path the site does not serve", () => {
  // The two dead assets on the published site were both `src` attributes pointing at
  // `docs/assets/…`: the builder stripped the raw-URL prefix but never rewrote the directory to
  // `assets/`, and the link gate read only `href`. Both halves are pinned here.
  for (const page of renderPages()) {
    assert.doesNotMatch(
      page.html,
      /(?:src|href)="docs\/assets\//,
      `${page.slug} points at a path the site does not serve`
    );
  }
});
