import assert from "node:assert/strict";
import test from "node:test";

import { createLinkRewriter } from "../scripts/build-site.mjs";

/**
 * README.md deliberately writes absolute GitHub URLs so the same text works on
 * npmjs.com. The site builder only rewrote *relative* `docs/*.md` links, so a
 * visitor on the docs site who clicked a guide link on the homepage was handed
 * back to GitHub — the site existed but its own navigation pointed away from it.
 *
 * The rewrite is deliberately narrow: a link to a file the site does not publish
 * must keep working, and another repository's URLs are none of our business.
 */

const rewrite = createLinkRewriter({
  repositoryUrl: "https://github.com/ankurhalder/codebase-snapshot.git",
  publishedSlugs: ["index", "cli", "mcp", "agent"],
});

const href = (url, anchor = "") => `<a href="${url}${anchor}">guide</a>`;

test("an absolute in-repo docs link becomes the local page", () => {
  assert.equal(
    rewrite(href("https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/cli.md")),
    href("cli.html")
  );
});

test("a fragment on an absolute link is preserved", () => {
  assert.equal(
    rewrite(href("https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/mcp.md", "#tools")),
    href("mcp.html", "#tools")
  );
});

test("the README becomes the site index", () => {
  for (const prefix of ["blob", "tree"]) {
    assert.equal(
      rewrite(href(`https://github.com/ankurhalder/codebase-snapshot/${prefix}/main/README.md`)),
      href("index.html"),
      prefix
    );
  }
});

test("raw.githubusercontent links are rewritten too", () => {
  assert.equal(
    rewrite(href("https://raw.githubusercontent.com/ankurhalder/codebase-snapshot/main/docs/agent.md")),
    href("agent.html")
  );
});

test("a published file referenced by src is rewritten as well", () => {
  assert.equal(
    rewrite('<img src="https://github.com/ankurhalder/codebase-snapshot/blob/main/README.md">'),
    '<img src="index.html">'
  );
});

test("a file the site does not publish keeps its working link", () => {
  const url = "https://github.com/ankurhalder/codebase-snapshot/blob/main/CHANGELOG.md";
  assert.equal(rewrite(href(url)), href(url));
});

test("another repository is left alone", () => {
  const url = "https://github.com/someone-else/codebase-snapshot/blob/main/docs/cli.md";
  assert.equal(rewrite(href(url)), href(url));
});

test("a docs file with no page is left alone", () => {
  const url = "https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/not-a-page.md";
  assert.equal(rewrite(href(url)), href(url));
});

test("a bare URL in prose is not rewritten", () => {
  const text = "see https://github.com/ankurhalder/codebase-snapshot/blob/main/docs/cli.md for details";
  assert.equal(rewrite(text), text);
});

test("the owner and repository come from package.json, not from a constant", () => {
  const other = createLinkRewriter({
    repositoryUrl: "https://github.com/fork-owner/forked-snapshot",
    publishedSlugs: ["index"],
  });
  assert.equal(
    other(href("https://github.com/fork-owner/forked-snapshot/blob/main/README.md")),
    href("index.html"),
    "a fork rewrites its own links"
  );
  assert.equal(
    other(href("https://github.com/ankurhalder/codebase-snapshot/blob/main/README.md")),
    href("https://github.com/ankurhalder/codebase-snapshot/blob/main/README.md"),
    "and not the upstream's"
  );
});
