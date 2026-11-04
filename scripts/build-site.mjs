/**
 * Builds the documentation site from the Markdown that already exists.
 *
 * There is exactly one source of truth for the docs: `README.md` and `docs/*.md`.
 * This script renders them into static HTML under `site/`; it does not hold a
 * second copy of the prose, and it is not allowed to — a docs site that drifts
 * from the docs it documents is worse than no site.
 *
 * Why a site at all: GitHub's robots.txt blocks directory-tree and raw-file
 * paths, and there is no repository sitemap, so `docs/` has no crawlable entry
 * point. A static site gives each page a real URL, a title, a canonical and a
 * sitemap, and lets the origin serve its own `robots.txt` and `llms.txt` — none
 * of which a repository tree can do. That is the entire reason this exists.
 *
 * Output:
 *   index.html + docs/*.html       rendered pages, with canonical, JSON-LD and
 *                                 a `text/markdown` twin link per llms.txt v2
 *   *.md                           the raw Markdown twin for each page
 *   sitemap.xml, robots.txt        crawl instructions
 *   llms.txt                       the agent-facing index at the site root
 *   CNAME, .nojekyll               custom domain, and stop Jekyll reprocessing
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
const OUT = path.join(ROOT, "site");
// The canonical base. This must be a host that resolves TODAY: a canonical, a
// sitemap and an llms.txt that all point at a domain with no DNS record tell
// every crawler to index nothing. When the custom domain is wired up, GitHub
// Pages 301s the github.io URL to it, so this constant can move then without
// stranding anything.
const SITE = "https://ankurhalder.github.io/codebase-snapshot";
const REPO = "https://github.com/ankurhalder/codebase-snapshot";

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const write = (...parts) => process.stdout.write(`${parts.join("")}\n`);

/** Page titles. A docs page gets its first heading, which is already good. */
const TITLES = {
  index: "codebase-snapshot — turn any codebase into LLM-ready Markdown",
  "getting-started": "Getting started",
};

const ORDER = [
  "index",
  "install",
  "cli",
  "configuration",
  "output",
  "agent",
  "troubleshooting",
  "how-to-feed-a-repo-to-claude",
  "how-to-context-budget",
  "vs-repomix",
  "vs-gitingest",
  "vs-code2prompt",
];

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Turns links between Markdown files into links between the pages they become.
 * Done on the rendered HTML rather than the Markdown so code samples that
 * happen to contain `](docs/x.md)` are left exactly as written.
 */
function rewriteLinks(html) {
  return html
    .replace(/href="\.\.\/README\.md(#[\w-]*)?"/g, 'href="index.html$1"')
    // Anything else one level up is a repository file with no page here — point
    // at the repository rather than at a path above the site root, which 404s.
    .replace(/href="\.\.\/([A-Za-z0-9_.\-]+?)(#[\w-]*)?"/g, `href="${REPO}/blob/main/$1$2"`)
    .replace(/href="docs\/([a-z0-9-]+)\.md(#[\w-]*)?"/g, 'href="$1.html$2"')
    .replace(/href="([a-z0-9-]+)\.md(#[\w-]*)?"/g, 'href="$1.html$2"');
}

/** First real paragraph, for the meta description. */
function summarise(markdown) {
  const blocks = markdown.split(/\n\s*\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("```") || trimmed.startsWith("|") || trimmed.startsWith("---")) continue;
    const text = trimmed
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*`_>#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 40) return text.slice(0, 158);
  }
  return pkg.description;
}

function nav(slug) {
  const labels = {
    index: "Overview",
    install: "Installation",
    cli: "CLI",
    configuration: "Configuration",
    output: "Output",
    agent: "AI agents",
    troubleshooting: "Troubleshooting",
    "how-to-feed-a-repo-to-claude": "Feeding a repo to an LLM",
    "how-to-context-budget": "Context budgeting",
    "vs-repomix": "vs repomix",
    "vs-gitingest": "vs gitingest",
    "vs-code2prompt": "vs code2prompt",
  };
  return ORDER.filter((name) => name !== "index")
    .map((name) => `<a${name === slug ? ' class="here"' : ""} href="${name}.html">${labels[name]}</a>`)
    .join("\n        ");
}

function page({ slug, title, description, body }) {
  const canonical = slug === "index" ? `${SITE}/` : `${SITE}/${slug}.html`;
  const twin = `${slug}.md`;
  const structured =
    slug === "index"
      ? {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "SoftwareApplication",
              name: pkg.name,
              applicationCategory: "DeveloperApplication",
              operatingSystem: "Windows, macOS, Linux",
              description: pkg.description,
              url: `${SITE}/`,
              license: "https://opensource.org/licenses/MIT",
              codeRepository: REPO,
              programmingLanguage: "TypeScript",
              offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
              keywords: pkg.keywords.join(", "),
            },
            {
              "@type": "SoftwareSourceCode",
              name: pkg.name,
              codeRepository: REPO,
              programmingLanguage: "TypeScript",
              runtimePlatform: `Node.js >= ${pkg.engines.node.replace(">=", "")}`,
              version: pkg.version,
            },
          ],
        }
      : {
          "@context": "https://schema.org",
          "@type": "TechArticle",
          headline: title,
          description,
          url: canonical,
          isPartOf: { "@type": "WebSite", name: pkg.name, url: `${SITE}/` },
        };

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <link rel="canonical" href="${canonical}">
    <link rel="alternate" type="text/markdown" href="${twin}" title="Markdown version">
    <link rel="describedby" href="/llms.txt">
    <meta property="og:type" content="website">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${canonical}">
    <meta name="twitter:card" content="summary_large_image">
    <script type="application/ld+json">${JSON.stringify(structured)}</script>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { margin: 0; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
      header { border-bottom: 1px solid #8883; padding: 14px 20px; display: flex; flex-wrap: wrap; gap: 16px; align-items: baseline; }
      header a { text-decoration: none; }
      header .brand { font-weight: 650; margin-right: auto; }
      nav { display: flex; flex-wrap: wrap; gap: 14px; font-size: 14px; }
      nav a.here { font-weight: 650; text-decoration: underline; }
      main { max-width: 60rem; margin: 0 auto; padding: 28px 20px 80px; }
      pre { background: #8881; padding: 12px 14px; overflow-x: auto; border-radius: 6px; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
      table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
      th, td { border: 1px solid #8884; padding: 6px 10px; text-align: left; vertical-align: top; }
      blockquote { margin: 0; padding-left: 16px; border-left: 3px solid #8886; opacity: 0.9; }
      footer { border-top: 1px solid #8883; padding: 18px 20px; font-size: 13px; opacity: 0.8; }
    </style>
  </head>
  <body>
    <header>
      <a class="brand" href="index.html">${escapeHtml(pkg.name)}</a>
      <nav>
        ${nav(slug)}
        <a href="${REPO}">GitHub</a>
      </nav>
    </header>
    <main>
${body}
    </main>
    <footer>
      MIT © Ankur Halder · <a href="${REPO}">source</a> · <a href="${REPO}/issues">issues</a> · <a href="llms.txt">llms.txt</a>
    </footer>
  </body>
</html>
`;
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const sources = [{ slug: "index", file: path.join(ROOT, "README.md"), markdown: fs.readFileSync(path.join(ROOT, "README.md"), "utf8") }];
for (const entry of fs.readdirSync(DOCS).filter((name) => name.endsWith(".md")).sort()) {
  const slug = path.basename(entry, ".md");
  sources.push({ slug, file: path.join(DOCS, entry), markdown: fs.readFileSync(path.join(DOCS, entry), "utf8") });
}

const urls = [];
for (const source of sources) {
  const html = rewriteLinks(marked.parse(source.markdown));
  const heading = source.markdown.match(/^#\s+(.+)$/m)?.[1] ?? pkg.name;
  const title = TITLES[source.slug] ?? (source.slug === "index" ? heading : `${heading} — ${pkg.name}`);
  const description = summarise(source.markdown);
  fs.writeFileSync(
    path.join(OUT, `${source.slug}.html`),
    page({ slug: source.slug, title, description, body: html }),
    "utf8"
  );
  // The Markdown twin: what llms.txt v2 asks for, and what an agent would rather read.
  // The Markdown twin is for an agent to read, so the sync markers are stripped:
  // they are web-page plumbing, and the rendered value beside them already stands alone.
  const twin = source.markdown.replace(/<!--\/?@[A-Za-z]+-->/g, "");
  fs.writeFileSync(path.join(OUT, `${source.slug}.md`), twin, "utf8");
  urls.push(source.slug === "index" ? `${SITE}/` : `${SITE}/${source.slug}.html`);
}

const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(
  path.join(OUT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${url}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>
`,
  "utf8"
);

/**
 * robots.txt with the AI crawlers named explicitly. GitHub's own robots.txt
 * already grants them access with a crawl delay, so anything we publish should
 * be at least as open — being hard to read is not a security posture.
 */
fs.writeFileSync(
  path.join(OUT, "robots.txt"),
  `# Everything here is documentation meant to be read, quoted and indexed.
User-agent: *
Allow: /

User-agent: GPTBot
User-agent: OAI-SearchBot
User-agent: ChatGPT-User
User-agent: ClaudeBot
User-agent: anthropic-ai
User-agent: Claude-Web
User-agent: PerplexityBot
User-agent: Google-Extended
User-agent: Applebot-Extended
User-agent: CCBot
Allow: /

Sitemap: ${SITE}/sitemap.xml
`,
  "utf8"
);

// The repository's llms.txt, rewired to site URLs — it should point at pages
// that resolve, not at the repository that the site was generated from.
const llms = fs
  .readFileSync(path.join(ROOT, "llms.txt"), "utf8")
  .replace(new RegExp(`${REPO}/blob/main/docs/([a-z0-9-]+)\\.md`, "g"), `${SITE}/$1.html`)
  .replace(new RegExp(`${REPO}/blob/main/llms\\.txt`, "g"), `${SITE}/llms.txt`);
fs.writeFileSync(path.join(OUT, "llms.txt"), llms, "utf8");

// No CNAME file until the DNS record exists. Under an Actions deploy the custom
// domain is set on the Pages configuration, not by a file in the artifact, and
// shipping a CNAME for a host that does not resolve only invites confusion.
fs.writeFileSync(path.join(OUT, ".nojekyll"), "", "utf8");

write(`site: ${sources.length} pages, ${urls.length} urls`);
write(`site: sitemap.xml, robots.txt, llms.txt for ${SITE}`);
