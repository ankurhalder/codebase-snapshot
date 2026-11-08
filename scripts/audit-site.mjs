#!/usr/bin/env node
/**
 * Audits the built site for the defects that are invisible until someone shares a link.
 *
 * Every check here exists because the site shipped without it: twelve pages declared
 * `twitter:card=summary_large_image` with no `og:image` at all, so every share rendered as a
 * blank card; there was no favicon; and titles spent their first 40 characters on a brand
 * nobody was searching for. None of that breaks a build, which is exactly why it survived.
 * The first build also carried 49 `#anchor` links pointing at headings that had no ids at all,
 * so every table of contents was a list of links to nowhere; that rule lives in
 * check-site-links.mjs, and this audit applies it here so `npm run verify` sees it too.
 *
 * Runs against `site/`, so run `npm run site` first. Exits 1 on any violation — this is wired
 * into `npm run verify`, not offered as advice.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { findAnchorProblems } from "./check-site-links.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "site");

/** Title and description windows: too short wastes the slot, too long is truncated. */
const TITLE_MIN = 25;
const TITLE_MAX = 65;
const DESC_MIN = 90;
const DESC_MAX = 165;

const problems = [];
const notes = [];
const fail = (page, message) => problems.push(`${page}: ${message}`);

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function match(html, pattern) {
  return pattern.exec(html)?.[1] ?? null;
}

/** Presence only. Separated from `match` because a pattern with no capture group has no group 1
 * to return, and reading that as "absent" made this audit fail pages that were correct. */
function has(html, pattern) {
  return pattern.test(html);
}

if (!fs.existsSync(path.join(OUT, "index.html"))) {
  console.error("audit-site: site/ is missing — run `npm run site` first.");
  process.exit(1);
}

// The canonical base is taken from the sitemap rather than repeated here, so a change of
// domain cannot make the audit pass while the pages point somewhere else.
const sitemap = read(path.join(OUT, "sitemap.xml"));
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const siteRoot = locs.find((loc) => loc.endsWith("/"));
if (!siteRoot) {
  console.error("audit-site: sitemap.xml has no site root entry.");
  process.exit(1);
}
const SITE = siteRoot.replace(/\/$/, "");

const pages = fs.readdirSync(OUT).filter((name) => name.endsWith(".html"));
const seenCanonicals = new Set();
/** Every page's HTML, kept so the anchor rule can resolve cross-page fragments. */
const pageHtml = new Map();

for (const file of pages.sort()) {
  const slug = path.basename(file, ".html");
  const html = read(path.join(OUT, file));
  pageHtml.set(file, html);
  const expected = slug === "index" ? siteRoot : `${SITE}/${slug}.html`;

  const title = match(html, /<title>([^<]*)<\/title>/);
  if (!title) fail(file, "no <title>");
  else {
    if (title.length < TITLE_MIN) fail(file, `title is ${title.length} chars, under ${TITLE_MIN}`);
    if (title.length > TITLE_MAX) fail(file, `title is ${title.length} chars, over ${TITLE_MAX}`);
  }

  const description = match(html, /<meta name="description" content="([^"]*)"/);
  if (!description) fail(file, "no meta description");
  else {
    if (description.length < DESC_MIN) {
      fail(file, `description is ${description.length} chars, under ${DESC_MIN}`);
    }
    if (description.length > DESC_MAX) {
      fail(file, `description is ${description.length} chars, over ${DESC_MAX}`);
    }
  }

  const canonical = match(html, /<link rel="canonical" href="([^"]*)"/);
  if (!canonical) fail(file, "no canonical");
  else {
    if (canonical !== expected) fail(file, `canonical is ${canonical}, expected ${expected}`);
    if (seenCanonicals.has(canonical)) fail(file, "two pages share a canonical");
    seenCanonicals.add(canonical);
  }

  const ogImage = match(html, /<meta property="og:image" content="([^"]*)"/);
  if (!ogImage) {
    fail(file, "no og:image — every share renders as a blank card");
  } else {
    if (!ogImage.startsWith(SITE)) fail(file, `og:image is not on this origin: ${ogImage}`);
    const local = path.join(OUT, ogImage.slice(SITE.length).replace(/^\//, ""));
    if (!fs.existsSync(local)) fail(file, `og:image does not exist: ${ogImage}`);
    const width = match(html, /<meta property="og:image:width" content="([^"]*)"/);
    const height = match(html, /<meta property="og:image:height" content="([^"]*)"/);
    if (width !== "1200" || height !== "630") {
      fail(file, `og:image dimensions declared ${width ?? "?"}x${height ?? "?"}, expected 1200x630`);
    }
    if (!has(html, /<meta property="og:image:alt" content="[^"]+"/)) {
      fail(file, "og:image has no alt text");
    }
  }

  if (match(html, /<meta name="twitter:card" content="([^"]*)"/) !== "summary_large_image") {
    fail(file, "twitter:card is not summary_large_image");
  }
  if (!has(html, /<meta name="twitter:image" content="[^"]+"/)) {
    fail(file, "no twitter:image — the large card is empty");
  }

  const h1s = [...html.matchAll(/<h1[\s>]/g)].length;
  if (h1s !== 1) fail(file, `${h1s} <h1> elements, expected exactly 1`);

  for (const [, tag] of html.matchAll(/(<img\b[^>]*>)/g)) {
    if (!/\balt=/.test(tag)) fail(file, `<img> without alt: ${tag.slice(0, 60)}`);
  }

  const icon = match(html, /<link rel="icon" href="([^"]*)"/);
  if (!icon) fail(file, "no favicon link");
  else if (!fs.existsSync(path.join(OUT, icon.replace(/^\//, "")))) {
    fail(file, `favicon does not exist: ${icon}`);
  }

  const ld = match(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!ld) fail(file, "no JSON-LD");
  else {
    try {
      const parsed = JSON.parse(ld);
      const kinds = parsed["@graph"] ?? [parsed];
      if (!Array.isArray(kinds) || kinds.length === 0) fail(file, "JSON-LD has no @type");
      else if (!kinds.every((node) => typeof node["@type"] === "string")) {
        fail(file, "a JSON-LD node has no @type");
      }
      if (!JSON.stringify(parsed).includes("BreadcrumbList")) {
        fail(file, "JSON-LD has no BreadcrumbList");
      }
    } catch (err) {
      fail(file, `JSON-LD does not parse: ${err.message}`);
    }
  }

  if (!has(html, /<html lang="[a-z-]+"/)) fail(file, "no lang on <html>");
  if (/<meta name="robots"[^>]*noindex/.test(html)) fail(file, "page is noindex");
  if (/\bundefined\b|\[object Object\]/.test(html)) fail(file, "renderer leaked undefined or [object Object]");
  if (!locs.includes(expected)) fail(file, "page is missing from sitemap.xml");
}

// The anchor rule lives in check-site-links.mjs, which the deploy workflow runs directly;
// applying it here as well means `npm run verify` catches a dead table-of-contents link on the
// pull request. The problem text names the page, the href and the missing id, because "a heading
// id is missing" is not actionable without knowing which link broke.
const anchors = findAnchorProblems(pageHtml);
for (const problem of anchors.problems) problems.push(`anchors: ${problem}`);

for (const loc of locs) {
  if (!seenCanonicals.has(loc)) fail("sitemap.xml", `lists ${loc}, which no page claims`);
}

for (const required of ["llms.txt", "llms-full.txt", "robots.txt", "sitemap.xml", ".nojekyll"]) {
  if (!fs.existsSync(path.join(OUT, required))) fail("-", `missing ${required}`);
}

const ogCount = pages.filter((file) =>
  /<meta property="og:image" content="[^"]+"/.test(read(path.join(OUT, file)))
).length;
notes.push(
  `${pages.length} pages, ${ogCount} with a social card, ${locs.length} sitemap urls, ` +
    `${anchors.checked} anchors`
);
notes.push(`canonical base ${SITE}`);

for (const note of notes) console.log(`audit-site: ${note}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  process.exit(1);
}
console.log("audit-site: no problems");
