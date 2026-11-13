/**
 * Fails when a rendered page links to something the site does not contain.
 *
 * Two things are checked: that the target file exists, and that a link's `#fragment` names an
 * element on the page it targets. The second check is the one this file shipped without, and the
 * reason every table-of-contents link on the published site was dead: the pages had heading text
 * but no heading ids, and an existence-only check cannot see the difference between a heading and
 * a paragraph. A fragment is checked against the id set of the page it lands on, so it covers both
 * an in-page `href="#commands"` and a cross-page `href="configuration.html#project-presets"`.
 *
 * Runs against the built site, so run `npm run site` first. `npm run verify` runs this script
 * after the build and before the audit, so a pull request catches a dead link; the deploy
 * workflow runs it directly before uploading the artifact.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const write = (...parts) => process.stdout.write(`${parts.join("")}\n`);

/** Decodes a fragment's percent-escapes, leaving malformed input exactly as written. */
function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * Every `#fragment` must resolve against the ids of the page it targets.
 *
 * `pages` maps a page name (`cli.html`) to its HTML, so one rule covers a same-page anchor and
 * a cross-page one. A duplicate id is reported too: only the first can be linked to reliably.
 *
 * Exported so a test can run the check over rendered pages without a built `site/`.
 */
export function findAnchorProblems(pages) {
  const idsByPage = new Map();
  const problems = [];

  for (const [name, html] of pages) {
    const ids = new Set();
    for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
      if (ids.has(match[1])) problems.push(`${name}: duplicate id "${match[1]}"`);
      ids.add(match[1]);
    }
    idsByPage.set(name, ids);
  }

  let checked = 0;
  for (const [name, html] of pages) {
    for (const match of html.matchAll(/href="([^"]*)"/g)) {
      const href = match[1];
      if (/^(?:https?:|mailto:)/.test(href)) continue;
      const hash = href.indexOf("#");
      if (hash < 0) continue;
      const fragment = decodeFragment(href.slice(hash + 1));
      if (!fragment) continue;
      const beforeHash = href.slice(0, hash);
      const target = beforeHash === "" ? name : beforeHash.replace(/^\//, "") || "index.html";
      const targetIds = idsByPage.get(target);
      // A missing target file, or a non-HTML one, is the existence check's job.
      if (targetIds === undefined) continue;
      checked += 1;
      if (!targetIds.has(fragment)) {
        problems.push(`${name} -> ${href} (${target} has no element with id "${fragment}")`);
      }
    }
  }

  return { checked, problems };
}

function checkSite() {
  if (!fs.existsSync(SITE)) {
    write("check-site-links: site/ does not exist — run `npm run site` first");
    process.exit(1);
  }

  const files = new Set(fs.readdirSync(SITE));
  const pages = new Map();
  const problems = [];
  let checked = 0;

  for (const name of files) {
    if (name.endsWith(".html")) pages.set(name, fs.readFileSync(path.join(SITE, name), "utf8"));
  }

  for (const [name, html] of pages) {
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const href = match[1];
      if (/^(?:https?:|mailto:|#)/.test(href)) continue;
      checked += 1;
      // Origin-absolute paths (`/llms.txt`) are served from the site root once
      // deployed, so they resolve against the same directory as relative ones.
      const target = href.split("#")[0].replace(/^\//, "");
      if (!target) continue;
      // Resolve against the site root rather than the top-level listing: `assets/favicon.svg`
      // is a real file one directory down, and a flat `files.has()` reported every icon on every
      // page as broken the moment the site gained an assets directory.
      const resolved = path.resolve(SITE, target);
      // The separator matters: without it a sibling directory whose name merely begins with the
      // site's (`../site-other`) satisfied `startsWith`, so a link escaping the site root was read
      // as inside it.
      if (resolved !== SITE && !resolved.startsWith(SITE + path.sep)) {
        problems.push(`${name} -> ${href} (escapes the site root)`);
        continue;
      }
      if (!fs.existsSync(resolved)) problems.push(`${name} -> ${href}`);
    }
  }

  const anchors = findAnchorProblems(pages);
  problems.push(...anchors.problems);

  // Every sitemap URL must be a page this build actually produced, or the sitemap
  // advertises a 404 to the one crawler we are trying to satisfy.
  //
  // The base path is taken from the canonical on index.html rather than hardcoded,
  // so this also asserts that the sitemap and the canonical agree about where the
  // site lives — a subpath and an origin root are both valid, a mismatch is not.
  const indexHtml = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  const canonical = indexHtml.match(/rel="canonical" href="([^"]+)"/)?.[1] ?? "";
  const base = canonical.replace(/\/$/, "");
  if (!base) {
    write("check-site-links: index.html has no canonical, so the sitemap base is unknown");
    process.exit(1);
  }

  const sitemap = fs.readFileSync(path.join(SITE, "sitemap.xml"), "utf8");
  for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const loc = new URL(match[1]);
    const pathname = loc.pathname.replace(/\/$/, "");
    if (!`${loc.origin}${pathname}`.startsWith(base)) {
      problems.push(`sitemap -> ${match[1]} (outside the canonical base ${base})`);
      continue;
    }
    const relativePath = pathname.slice(new URL(base).pathname.replace(/\/$/, "").length).replace(/^\//, "");
    const target = relativePath === "" ? "index.html" : relativePath;
    if (!files.has(target)) problems.push(`sitemap -> ${match[1]} (no ${target})`);
  }

  if (problems.length > 0) {
    for (const problem of problems) write(`FAIL: ${problem}`);
    write(`check-site-links: ${problems.length} problem(s) in ${files.size} file(s)`);
    process.exit(1);
  }

  write(
    `check-site-links: ${files.size} files, ${checked} internal links, ${anchors.checked} anchors, 0 problems`
  );
}

function isInvokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isInvokedDirectly()) checkSite();
