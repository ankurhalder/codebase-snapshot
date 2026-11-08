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
 * Head metadata is not decoration either. A page with `twitter:card` set to
 * `summary_large_image` and no `og:image` renders as a blank card every time
 * someone shares it, which is how this site shipped until 0.9.3: eleven pages,
 * zero social cards. Titles are written query-first here rather than derived
 * from the first heading, and every page declares an author, a breadcrumb and a
 * typed JSON-LD node so an answer engine can attribute the page to a person.
 *
 * Output:
 *   index.html + docs/*.html       rendered pages, with canonical, JSON-LD,
 *                                 GitHub-compatible heading ids and a
 *                                 `text/markdown` twin link per llms.txt v2
 *   *.md                           the raw Markdown twin for each page
 *   assets/*                       the images the pages and social cards use
 *   sitemap.xml, robots.txt        crawl instructions
 *   llms.txt, llms-full.txt        the agent-facing index, and everything at once
 *   favicon.svg, apple-touch-icon  tab and home-screen icons
 *   .nojekyll                      stop Jekyll reprocessing the artifact
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
/** The author's own site: the entity this project hangs off. */
const AUTHOR_URL = "https://ankurhalder.com";
const AUTHOR_NAME = "Ankur Halder";
const OG_IMAGE = `${SITE}/assets/social-card.png`;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const write = (...parts) => process.stdout.write(`${parts.join("\n")}\n`);

/**
 * The repository this site documents, derived rather than repeated.
 *
 * The owner and repository name were written twice — once here and once in the
 * links the site builder recognises — which is how a fork ends up linking its
 * readers back to a repository it does not own. `package.json` already names the
 * repository, so that is the one source.
 */
export const REPO = String(pkg.repository.url).replace(/\.git$/, "").replace(/\/+$/, "");
const REPO_SEGMENTS = new URL(REPO).pathname.split("/").filter(Boolean);
export const REPO_OWNER = REPO_SEGMENTS[0];
export const REPO_NAME = REPO_SEGMENTS[1];

/**
 * Page titles, written query-first.
 *
 * The previous form was `<heading> — codebase-snapshot`, which spends the part
 * of a search result a reader actually scans on a brand nobody is searching for
 * yet. These lead with the words someone would type; the brand is carried by
 * `og:site_name` and the JSON-LD publisher instead.
 */
const TITLES = {
  index: "codebase-snapshot — LLM-ready snapshots you can verify",
  install: "Install codebase-snapshot with npm, yarn, pnpm or bun",
  cli: "CLI reference: every command and option",
  configuration: "Configuration, byte budgets and the 25 project presets",
  output: "Snapshot output: parts, manifest and reports",
  agent: "Using codebase-snapshot with an AI agent",
  mcp: "MCP server: serve a codebase to any AI client",
  troubleshooting: "Troubleshooting: every message and its one-line fix",
  "how-to-feed-a-repo-to-claude": "How to feed a whole codebase to ChatGPT, Claude or Cursor",
  "how-to-context-budget": "How to size an LLM context budget for a codebase",
  "stale-context-is-your-bug": "Stale LLM context is a bug: detect drift in a snapshot",
  "codebase-token-budget": "How many tokens is a codebase? The arithmetic",
  "vs-repomix": "codebase-snapshot vs repomix: two ways to pack a repo",
  "vs-gitingest": "codebase-snapshot vs gitingest: CLI artifact or URL trick",
  "vs-code2prompt": "codebase-snapshot vs code2prompt: what actually differs",
};

/**
 * Meta descriptions, 100–160 characters.
 *
 * Derived from the first paragraph, these used to be whatever sentence happened
 * to come first, cut mid-word at 158. Written by hand, each one now states the
 * problem, the artefact and the differentiator — which is what the snippet has
 * to do in the two lines a result gets.
 */
const DESCRIPTIONS = {
  index:
    "Turn a repository into LLM-ready parts under a hard byte budget, with a manifest that " +
    "indexes every file and every skip, and a validate command that fails on drift.",
  install:
    "Install with npm, yarn, pnpm or bun, or run it with npx. Node 18+. A global install gives " +
    "you the short `snapshot` command.",
  cli:
    "Every command and option: generate, validate, report, setup, init, explain, diff, describe " +
    "and skill, with their defaults and exit codes.",
  configuration:
    "Every setting and its default: byte budgets, the 25 auto-detected presets, artifacts, " +
    "hooks, ignore rules and secret handling.",
  output:
    "What a run writes: budgeted parts, the manifest that indexes every file and skip, the " +
    "project tree, navigation and the audit report.",
  agent:
    "A machine-readable contract and an installable skill, so an agent with no prior knowledge " +
    "can drive the tool and never guess a flag.",
  troubleshooting:
    "Every message the tool prints and the one-line fix: refusals, config errors, drift, " +
    "sensitive-file skips and non-interactive first runs.",
  mcp:
    "Serve a repository to Claude, Cursor or any MCP client: eight tools and snapshot:// " +
    "resources, so an agent reads the one part it needs instead of all of them.",
  "how-to-feed-a-repo-to-claude":
    "Hand a whole codebase to ChatGPT, Claude or Cursor: generate a snapshot locally, pick a " +
    "budget that fits the window, and tell the model what it is reading.",
  "how-to-context-budget":
    "Choose maxPartBytes and largeFileBytes from the model's context window instead of from " +
    "taste, with the arithmetic spelled out.",
  "stale-context-is-your-bug":
    "A snapshot goes stale the moment the code moves, and a model cannot tell. Detect drift " +
    "with validate, gate it in CI, and know when to regenerate.",
  "codebase-token-budget":
    "How many tokens is a repository? The arithmetic of source lines, tokens and context " +
    "windows, with a table for choosing a part budget.",
  "vs-repomix":
    "Both pack a repository for a model. Repomix optimises for formats and reach; this one " +
    "optimises for a bounded, indexed, checkable artefact.",
  "vs-gitingest":
    "gitingest turns a GitHub URL into text in a browser. This is a CLI that writes an artefact " +
    "you can validate, diff and gate a pipeline on.",
  "vs-code2prompt":
    "code2prompt renders a prompt from a repository. This writes parts plus an index, and can " +
    "tell you when the index no longer matches the code.",
};

const ORDER = [
  "index",
  "install",
  "cli",
  "configuration",
  "output",
  "agent",
  "mcp",
  "troubleshooting",
  "how-to-feed-a-repo-to-claude",
  "how-to-context-budget",
  "stale-context-is-your-bug",
  "codebase-token-budget",
  "vs-repomix",
  "vs-gitingest",
  "vs-code2prompt",
];

const LABELS = {
  index: "Overview",
  install: "Installation",
  cli: "CLI",
  configuration: "Configuration",
  output: "Output",
  agent: "AI agents",
  mcp: "MCP server",
  troubleshooting: "Troubleshooting",
  "how-to-feed-a-repo-to-claude": "Feeding a repo to an LLM",
  "how-to-context-budget": "Context budgeting",
  "stale-context-is-your-bug": "Stale context",
  "codebase-token-budget": "Token arithmetic",
  "vs-repomix": "vs repomix",
  "vs-gitingest": "vs gitingest",
  "vs-code2prompt": "vs code2prompt",
};

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * GitHub's heading-anchor rules, as a function.
 *
 * The same Markdown is read on GitHub and npm as well as here, and both derive a heading's id
 * from its text: lowercase it, keep letters, numbers, marks, connector punctuation, spaces and
 * hyphens, remove everything else, then turn spaces into hyphens. The site has to mint the same
 * ids or a link that works in the repository is dead on the published page — which is exactly
 * how this site shipped: every table-of-contents link pointed at a heading carrying no id.
 *
 * No trimming after the spaces become hyphens: GitHub does not trim either, so a heading ending
 * in an ellipsis keeps the trailing hyphen its readers have been linking to.
 */
const SLUG_STRIP = /[^\p{L}\p{N}\p{M}\p{Pc} -]/gu;

export function headingSlug(text) {
  return String(text).toLowerCase().replace(SLUG_STRIP, "").replace(/ /g, "-");
}

/** The named entities a heading can contain; numeric ones are decoded in `headingText`. */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

/** The text a reader sees, which is what GitHub slugs and what `textContent` returns. */
function headingText(html) {
  return html.replace(/<[^>]*>/g, "").replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body.startsWith("#")) {
      const code =
        body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const name = body.toLowerCase();
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : whole;
  });
}

/**
 * Puts a stable, GitHub-compatible id on every heading.
 *
 * Done on the rendered HTML, not in a Markdown token hook, because the slug has to come from the
 * *rendered* text: the heading whose text is `validate / check` slugifies to `validate--check`,
 * because the slash is stripped and both neighbouring spaces become hyphens. An explicit `id`
 * written as raw HTML is kept as-is, and generated ids are de-duplicated with the `-1`, `-2`
 * suffixes GitHub uses.
 */
export function addHeadingIds(html) {
  const used = new Set();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) used.add(match[1]);
  return html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (whole, depth, attributes, inner) => {
    if (/\bid="/.test(attributes)) return whole;
    const base = headingSlug(headingText(inner)) || "section";
    let id = base;
    for (let suffix = 1; used.has(id); suffix += 1) id = `${base}-${suffix}`;
    used.add(id);
    return `<h${depth}${attributes} id="${id}">${inner}</h${depth}>`;
  });
}

/** One page body: Markdown rendered to HTML, with GitHub-compatible ids on its headings. */
export function renderMarkdown(markdown) {
  return addHeadingIds(marked.parse(markdown));
}

/**
 * Rewrites a link that points at a published Markdown file into the page that
 * file becomes.
 *
 * Two spellings of the same link reach this site. The docs use relative links
 * (`docs/foo.md`, `../README.md`), and `README.md` deliberately uses absolute
 * GitHub URLs so the same text works on npmjs.com. On the site both must resolve
 * to the local page: a visitor who clicks a guide link on the homepage should
 * stay on the homepage's site, not be handed back to GitHub.
 *
 * Only links that point at *this* repository and at a file the site actually
 * publishes are rewritten. Everything else — another repository, a file with no
 * page here such as `LICENSE`, a directory (`tree/…`) — keeps working exactly as
 * written, because rewriting those would turn a working link into a 404.
 *
 * Exported so `tests/site-link-rewriting.test.js` can exercise the rule as a
 * table instead of grepping the generated HTML.
 */
export function createLinkRewriter({ repositoryUrl, publishedSlugs }) {
  const repository = String(repositoryUrl).replace(/\.git$/, "").replace(/\/+$/, "");
  const segments = new URL(repository).pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const name = segments[1];
  const published = new Set(publishedSlugs);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** The page for a repository path, or `null` when the site does not publish one. */
  const pageFor = (repositoryPath) => {
    if (repositoryPath === "README.md") return "index.html";
    const match = /^docs\/([a-z0-9-]+)\.md$/.exec(repositoryPath);
    if (match && published.has(match[1])) return `${match[1]}.html`;
    return null;
  };

  const bases = [
    `https://github\\.com/${escape(owner)}/${escape(name)}/(?:blob|tree)/(?:main|master)/`,
    `https://raw\\.githubusercontent\\.com/${escape(owner)}/${escape(name)}/(?:main|master)/`,
  ];
  const pattern = new RegExp(`(href|src)="(?:${bases.join("|")})([^"#?]*?)(#[^"]*)?"`, "g");

  return (html) =>
    html.replace(pattern, (whole, attribute, repositoryPath, anchor) => {
      const page = pageFor(repositoryPath);
      return page ? `${attribute}="${page}${anchor ?? ""}"` : whole;
    });
}

/** Slugs the site publishes: the README as the index, then every `docs/*.md`. */
const PUBLISHED_SLUGS = [
  "index",
  ...fs
    .readdirSync(DOCS)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => path.basename(entry, ".md")),
];

const rewriteAbsoluteLinks = createLinkRewriter({
  repositoryUrl: pkg.repository.url,
  publishedSlugs: PUBLISHED_SLUGS,
});

/**
 * Turns links between Markdown files into links between the pages they become.
 * Done on the rendered HTML rather than the Markdown so code samples that
 * happen to contain `](docs/x.md)` are left exactly as written.
 */
function rewriteLinks(html) {
  return rewriteAbsoluteLinks(html)
    .replace(/href="\.\.\/README\.md(#[\w-]*)?"/g, 'href="index.html$1"')
    // Anything else one level up is a repository file with no page here — point
    // at the repository rather than at a path above the site root, which 404s.
    .replace(/href="\.\.\/([A-Za-z0-9_.\-]+?)(#[\w-]*)?"/g, `href="${REPO}/blob/main/$1$2"`)
    .replace(/href="docs\/([a-z0-9-]+)\.md(#[\w-]*)?"/g, 'href="$1.html$2"')
    .replace(/href="([a-z0-9-]+)\.md(#[\w-]*)?"/g, 'href="$1.html$2"');
}

/**
 * README images point at raw.githubusercontent so they render on GitHub and on
 * npm; on this site they have a local copy, so rewrite them instead of making
 * every visitor fetch from a second origin.
 */
const RAW = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/`;

/** The Markdown sources in publish order: README.md as the index, then every `docs/*.md`. */
function readSources() {
  const sources = [
    { slug: "index", markdown: fs.readFileSync(path.join(ROOT, "README.md"), "utf8") },
  ];
  for (const entry of fs.readdirSync(DOCS).filter((name) => name.endsWith(".md")).sort()) {
    sources.push({
      slug: path.basename(entry, ".md"),
      markdown: fs.readFileSync(path.join(DOCS, entry), "utf8"),
    });
  }
  return sources;
}

/**
 * Every page rendered from the Markdown, in publish order.
 *
 * Exported for `tests/site-anchors.test.js`, which checks that every in-page and
 * cross-page `#fragment` resolves against the ids this renderer produced. Rendering in
 * memory means the test needs no built `site/`, and it exercises the same pipeline the
 * site build uses instead of a second copy of it.
 */
export function renderPages() {
  return readSources().map((source) => {
    const localised = source.markdown.split(RAW).join("");
    return {
      slug: source.slug,
      markdown: source.markdown,
      html: rewriteLinks(renderMarkdown(localised)),
    };
  });
}

/** First real paragraph, for a fallback description when none is written. */
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
  return ORDER.filter((name) => name !== "index")
    .map(
      (name) =>
        `<a${name === slug ? ' class="here"' : ""} href="${name}.html">${LABELS[name]}</a>`
    )
    .join("\n        ");
}

/** The author's entity, referenced from every page rather than repeated. */
const PERSON = {
  "@type": "Person",
  name: AUTHOR_NAME,
  url: AUTHOR_URL,
};

/**
 * Structured data per page.
 *
 * The index describes the software; every other page describes an article that
 * belongs to it, and every page carries a breadcrumb so a result can show the
 * path instead of a bare URL. `author` is set on both because attribution is
 * the one signal a project page can offer that a generated docs dump cannot.
 */
function structuredData(slug, title, description, canonical) {
  const breadcrumb = {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: pkg.name, item: `${SITE}/` },
      ...(slug === "index"
        ? []
        : [{ "@type": "ListItem", position: 2, name: LABELS[slug] ?? title, item: canonical }]),
    ],
  };

  if (slug === "index") {
    return {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "SoftwareApplication",
          name: pkg.name,
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Windows, macOS, Linux",
          description,
          url: `${SITE}/`,
          image: OG_IMAGE,
          license: "https://opensource.org/licenses/MIT",
          codeRepository: REPO,
          programmingLanguage: "TypeScript",
          author: PERSON,
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          keywords: pkg.keywords.join(", "),
          sameAs: [
            REPO,
            "https://www.npmjs.com/package/codebase-snapshot",
            AUTHOR_URL,
          ],
        },
        {
          "@type": "SoftwareSourceCode",
          name: pkg.name,
          codeRepository: REPO,
          programmingLanguage: "TypeScript",
          runtimePlatform: `Node.js >= ${pkg.engines.node.replace(">=", "")}`,
          version: pkg.version,
          author: PERSON,
        },
        breadcrumb,
      ],
    };
  }

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: title,
        description,
        url: canonical,
        image: OG_IMAGE,
        author: PERSON,
        inLanguage: "en",
        isPartOf: { "@type": "WebSite", name: pkg.name, url: `${SITE}/` },
      },
      breadcrumb,
    ],
  };
}

function page({ slug, title, description, body, markdown }) {
  const canonical = slug === "index" ? `${SITE}/` : `${SITE}/${slug}.html`;
  const twin = `${slug}.md`;
  const structured = structuredData(slug, title, description, canonical);
  const readingTime = Math.max(1, Math.round(markdown.split(/\s+/).length / 220));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    <meta name="author" content="${AUTHOR_NAME}">
    <meta name="theme-color" content="#0d1117">
    <link rel="canonical" href="${canonical}">
    <link rel="author" href="${AUTHOR_URL}">
    <link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="assets/apple-touch-icon.png">
    <link rel="alternate" type="text/markdown" href="${twin}" title="Markdown version">
    <link rel="describedby" href="/llms.txt">
    <meta property="og:type" content="${slug === "index" ? "website" : "article"}">
    <meta property="og:site_name" content="${pkg.name}">
    <meta property="og:locale" content="en">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:url" content="${canonical}">
    <meta property="og:image" content="${OG_IMAGE}">
    <meta property="og:image:type" content="image/png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="codebase-snapshot — a snapshot you can prove is current">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${OG_IMAGE}">
    <meta name="twitter:image:alt" content="codebase-snapshot — a snapshot you can prove is current">
    <script type="application/ld+json">${JSON.stringify(structured)}</script>
    <style>
      :root { color-scheme: light dark; --ink: #1f2328; --muted: #59636e; --rule: #d1d9e0; --accent: #1a7f37; }
      @media (prefers-color-scheme: dark) { :root { --ink: #e6edf3; --muted: #9198a1; --rule: #30363d; --accent: #3fb950; } }
      * { box-sizing: border-box; }
      body { margin: 0; color: var(--ink); font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
      a { color: inherit; }
      header { border-bottom: 1px solid var(--rule); padding: 14px 20px; display: flex; flex-wrap: wrap; gap: 16px; align-items: baseline; }
      header a { text-decoration: none; }
      header .brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 650; margin-right: auto; }
      header .brand img { width: 20px; height: 20px; }
      nav { display: flex; flex-wrap: wrap; gap: 14px; font-size: 14px; }
      nav a { color: var(--muted); }
      nav a.here { color: var(--ink); font-weight: 650; text-decoration: underline; text-underline-offset: 3px; }
      main { max-width: 50rem; margin: 0 auto; padding: 32px 20px 96px; }
      h1 { font-size: 2rem; line-height: 1.2; letter-spacing: -0.01em; margin: 0 0 0.3em; }
      h2 { margin-top: 2.2em; padding-top: 0.6em; border-top: 1px solid var(--rule); font-size: 1.3rem; }
      .meta { color: var(--muted); font-size: 0.85rem; margin: 0 0 2em; }
      img { max-width: 100%; height: auto; }
      pre { background: #8881; padding: 12px 14px; overflow-x: auto; border-radius: 6px; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
      table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; font-size: 0.94rem; }
      th, td { border: 1px solid var(--rule); padding: 6px 10px; text-align: left; vertical-align: top; }
      th { background: #8881; }
      blockquote { margin: 1.2em 0; padding-left: 16px; border-left: 3px solid var(--accent); color: var(--muted); }
      footer { border-top: 1px solid var(--rule); padding: 22px 20px; font-size: 13px; color: var(--muted); }
      footer a { color: var(--ink); }
    </style>
  </head>
  <body>
    <header>
      <a class="brand" href="index.html"><img src="assets/favicon.svg" alt="" width="20" height="20">${escapeHtml(pkg.name)}</a>
      <nav>
        ${nav(slug)}
        <a href="${REPO}">GitHub</a>
      </nav>
    </header>
    <main>
      <p class="meta">${readingTime} min read · by <a href="${AUTHOR_URL}" rel="author">${AUTHOR_NAME}</a></p>
${body}
    </main>
    <footer>
      MIT © <a href="${AUTHOR_URL}" rel="author">${AUTHOR_NAME}</a> · <a href="${REPO}">source</a> ·
      <a href="${REPO}/issues">issues</a> · <a href="llms.txt">llms.txt</a> ·
      <a href="llms-full.txt">llms-full.txt</a>
    </footer>
  </body>
</html>
`;
}

/**
 * True when this file is the script node was asked to run, rather than a module
 * a test imported for its helpers.
 */
export function isInvokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

/**
 * Builds site/ from the Markdown.
 *
 * This runs only when the file is executed, not when it is imported: the link
 * rewriter and the page renderer above are exported so tests can exercise them
 * directly, and a test that silently rebuilt the site would be a side effect
 * nobody asked for.
 */
function buildSite() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // The images a page or a social card references have to exist under the site
  // root; a README that points at raw.githubusercontent is fine on GitHub and
  // useless as an `og:image`, which must be fetched from this origin.
  const ASSETS = path.join(DOCS, "assets");
  fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
  for (const entry of fs.readdirSync(ASSETS).filter((name) => /\.(svg|png|ico)$/.test(name))) {
    fs.copyFileSync(path.join(ASSETS, entry), path.join(OUT, "assets", entry));
  }

  const rendered = renderPages();

  const urls = [];
  const fullText = [];
  for (const source of rendered) {
    const heading = source.markdown.match(/^#\s+(.+)$/m)?.[1] ?? pkg.name;
    const title = TITLES[source.slug] ?? (source.slug === "index" ? heading : `${heading} — ${pkg.name}`);
    const description = DESCRIPTIONS[source.slug] ?? summarise(source.markdown);
    fs.writeFileSync(
      path.join(OUT, `${source.slug}.html`),
      page({ slug: source.slug, title, description, body: source.html, markdown: source.markdown }),
      "utf8"
    );
    // The Markdown twin: what llms.txt v2 asks for, and what an agent would rather read.
    // The sync markers are stripped: they are web-page plumbing, and the rendered
    // value beside them already stands alone.
    const twin = source.markdown.replace(/<!--\/?@[A-Za-z]+-->/g, "");
    fs.writeFileSync(path.join(OUT, `${source.slug}.md`), twin, "utf8");
    urls.push(source.slug === "index" ? `${SITE}/` : `${SITE}/${source.slug}.html`);
    fullText.push(`<!-- ${source.slug} -->\n\n${twin}`);
  }

  /**
   * `llms-full.txt`: every page in one file.
   *
   * `llms.txt` is an index of links, which a crawler has to follow one at a time.
   * The full corpus in a single response costs one fetch and is what several
   * answer engines now prefer when they can get it.
   */
  fs.writeFileSync(
    path.join(OUT, "llms-full.txt"),
    `# ${pkg.name} ${pkg.version} — complete documentation\n\n` +
      `> ${pkg.description}\n\n` +
      `Source: ${REPO}\nCanonical site: ${SITE}/\n\n---\n\n` +
      `${fullText.join("\n\n---\n\n")}\n`,
    "utf8"
  );

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

  write(`site: ${rendered.length} pages, ${urls.length} urls`);
  write(`site: sitemap.xml, robots.txt, llms.txt, llms-full.txt for ${SITE}`);
}

if (isInvokedDirectly()) buildSite();
