/**
 * Fails when a rendered page links to something the site does not contain.
 *
 * A broken internal link is invisible until a reader clicks it, and by then the
 * page is published. This check runs between rendering and deploying so the
 * deploy cannot ship one.
 *
 * Existence is the whole test: it does not attempt to validate anchors, because
 * a false failure on a heading slug would train everyone to ignore the check.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const write = (...parts) => process.stdout.write(`${parts.join("")}\n`);

if (!fs.existsSync(SITE)) {
  write("check-site-links: site/ does not exist — run `npm run site` first");
  process.exit(1);
}

const files = new Set(fs.readdirSync(SITE));
const problems = [];
let checked = 0;

for (const name of files) {
  if (!name.endsWith(".html")) continue;
  const html = fs.readFileSync(path.join(SITE, name), "utf8");
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

write(`check-site-links: ${files.size} files, ${checked} internal links, 0 problems`);
