#!/usr/bin/env node
/**
 * Fail when the published documentation surfaces drift apart.
 *
 * The repository docs are the source for the website and the wiki. The site is generated from
 * them, but the wiki is a separate git repository, so nothing stops a release from updating one
 * and forgetting the other. This check treats the live surfaces as part of the release contract:
 * the wiki Home/sidebar/footer must name the version in PUBLISHED, every wiki page linked from
 * the sidebar must exist, every copyable pin must use that version, and the MCP pages on both the
 * wiki and the site must still state the modern transport rules.
 *
 * It is deliberately a separate command instead of part of `npm run verify`: verify is offline
 * and must keep working on a laptop with no network. The Docs sync workflow runs this after the
 * Pages deployment and on a schedule, and fails loudly instead of letting a stale surface stand.
 *
 * Usage: node scripts/check-docs-sync.mjs
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const published = fs.readFileSync(path.join(ROOT, "PUBLISHED"), "utf8").trim();
const repoUrl = String(pkg.repository.url).replace(/\.git$/, "").replace(/\/+$/, "");
const [owner, repo] = new URL(repoUrl).pathname.split("/").filter(Boolean);
const site = String(pkg.homepage).replace(/\/+$/, "");
const wikiRepo = "https://github.com/" + owner + "/" + repo + ".wiki.git";
const wikiDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbs-docs-sync-"));
const failures = [];

/** The version must appear in the surface's own version label. */
function expectVersion(label, text, pattern) {
  const match = pattern.exec(text);
  if (match === null) {
    failures.push(label + ": no version label found");
    return;
  }
  if (match[1] !== published) {
    failures.push(label + ": says " + match[1] + ", PUBLISHED is " + published);
  }
}

/** Every copyable npx pin on a surface must name the last published version. */
function expectPins(label, text) {
  for (const match of text.matchAll(/codebase-snapshot@(\d+\.\d+\.\d+)/g)) {
    if (match[1] !== published) {
      failures.push(label + ": pin codebase-snapshot@" + match[1] + ", expected @" + published);
    }
  }
}

function expectPhrases(label, text, phrases) {
  for (const phrase of phrases) {
    if (!text.includes(phrase)) failures.push(label + ': missing "' + phrase + '"');
  }
}

async function getText(url, attempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "cache-control": "no-cache", "user-agent": "codebase-snapshot-docs-sync" },
      });
      if (response.ok) return await response.text();
      lastError = new Error("HTTP " + response.status);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(url + ": " + (lastError instanceof Error ? lastError.message : String(lastError)));
}

/** Read one page from the freshly cloned wiki; raw.githubusercontent caches too long. */
function readWiki(name) {
  return fs.readFileSync(path.join(wikiDir, name + ".md"), "utf8");
}

function linksIn(text) {
  const links = [];
  for (const match of text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    const target = match[2].trim();
    if (/^(https?:|mailto:|#)/.test(target) || target.startsWith("<")) continue;
    const page = decodeURIComponent(target.split("#")[0].replace(/\.md$/, ""));
    if (page.length > 0) links.push(page);
  }
  return links;
}

let wikiPages = new Map();
try {
  execFileSync("git", ["clone", "--quiet", "--depth", "1", wikiRepo, wikiDir], { stdio: "pipe" });
  const home = readWiki("Home");
  expectVersion("wiki Home", home, /^# codebase-snapshot (\d+\.\d+\.\d+)/m);
  expectPins("wiki Home", home);

  const sidebar = readWiki("_Sidebar");
  expectVersion("wiki sidebar", sidebar, /\*\*codebase-snapshot (\d+\.\d+\.\d+)\*\*/);
  const footer = readWiki("_Footer");
  expectVersion("wiki footer", footer, /codebase-snapshot (\d+\.\d+\.\d+)/);
  expectPins("wiki footer", footer);

  const sidebarPages = [...new Set(linksIn(sidebar).filter((page) => !page.startsWith("_") && page !== "Home"))];
  if (sidebarPages.length < 20) failures.push("wiki sidebar: only " + sidebarPages.length + " pages linked");
  wikiPages = new Map([["Home", home], ["_Sidebar", sidebar], ["_Footer", footer]]);
  for (const page of sidebarPages) {
    try {
      wikiPages.set(page, readWiki(page));
    } catch (error) {
      failures.push("wiki sidebar: " + page + " is linked but not readable (" + error.message + ")");
    }
  }

  for (const [page, text] of wikiPages) {
    expectPins("wiki " + page, text);
    for (const target of linksIn(text)) {
      if (!wikiPages.has(target) && target !== "Home" && !target.startsWith("_")) {
        failures.push("wiki " + page + ": links to missing page " + target);
      }
    }
  }

  expectPhrases("wiki Home", home, ["2026-07-28"]);
  expectPhrases("wiki MCP-Server", wikiPages.get("MCP-Server") ?? "", [
    "MCP-Protocol-Version",
    "Mcp-Method",
    "Mcp-Name",
    "cacheScope",
    "-32602",
  ]);
  expectPhrases("wiki Upgrading", wikiPages.get("Upgrading") ?? "", ["2026-07-28"]);

  const siteMcp = await getText(site + "/mcp.md");
  expectPins("site mcp.md", siteMcp);
  expectPhrases("site mcp.md", siteMcp, [
    "MCP-Protocol-Version",
    "Mcp-Method",
    "Mcp-Name",
    "cacheScope",
    "-32602",
  ]);
  await getText(site + "/llms.txt");
  await getText(site + "/index.html");
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  fs.rmSync(wikiDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("docs-sync: " + failures.length + " problem(s); published version is " + published);
  for (const failure of failures) console.error("  - " + failure);
  console.error("docs-sync: update the wiki/site and run this check again");
  process.exit(1);
}

console.log(
  "docs-sync: " + published + " is current on the wiki and the site; " + wikiPages.size + " wiki page(s) checked"
);
