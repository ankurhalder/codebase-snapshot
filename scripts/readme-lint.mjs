#!/usr/bin/env node
/**
 * Checks the README the way a reader meets it: a hero, a way in, and nothing that lies.
 *
 * The README is the page every visitor sees before they decide, and the one surface GitHub,
 * npm and the docs site all render from the same bytes. It had no hero image, no navigation,
 * four badges and 2,000 words — a wall of prose whose first fold named a command and nothing
 * else. These checks keep the next edit from quietly removing the parts that made it readable.
 *
 * Deliberately structural, not editorial: it cannot tell whether the writing is any good.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

const problems = [];
const note = (message) => problems.push(`README.md: ${message}`);
const lines = readme.split("\n");

/**
 * The document with fenced blocks removed.
 *
 * A shell comment inside a fence starts with `#`, and the heading checks counted five of them
 * as top-level headings — the README has one.
 */
const prose = readme.replace(/^```[\s\S]*?^```/gm, "");
const proseLines = prose.split("\n");

/** At least one H1, in either Markdown or the HTML the hero block uses. */
const h1s =
  proseLines.filter((line) => /^#\s+\S/.test(line)).length + [...prose.matchAll(/<h1[\s>]/g)].length;
if (h1s !== 1) note(`${h1s} top-level headings, expected exactly 1`);

/** A hero: an image in the first 15 lines tells a visitor what this is before they read. */
const heroWindow = lines.slice(0, 15).join("\n");
if (!/<img\b/.test(heroWindow) && !/!\[/.test(heroWindow)) note("no image in the first 15 lines");

const badges = [...readme.matchAll(/img\.shields\.io/g)].length;
if (badges < 5) note(`${badges} badges, expected at least 5`);

/** Navigation: at least four in-page anchors, so a long page is skimmable. */
const anchors = [...readme.matchAll(/\]\(#[a-z0-9-]+\)|href="#[a-z0-9-]+"/g)].length;
if (anchors < 4) note(`${anchors} in-page links, expected at least 4`);

/** Every Markdown image needs alt text, and it has to say something. */
for (const [, alt, target] of readme.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)) {
  if (alt.trim().length < 10) note(`image ${target} has thin alt text: "${alt}"`);
}

/** Every relative link has to resolve to a file in the repository. */
for (const [, target] of readme.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) {
  const clean = target.split("#")[0];
  if (!clean) continue;
  if (!fs.existsSync(path.join(ROOT, clean))) {
    note(`relative link does not resolve: ${target}`);
  }
}

/** Insecure links are a mixed-content bug waiting to happen in the npm and GitHub renderers. */
for (const [, target] of readme.matchAll(/\]\((http:\/\/[^)\s]+)\)/g)) {
  note(`insecure link: ${target}`);
}

const firstCommand = lines.findIndex((line) => /^```(bash|sh)$/.test(line));
if (firstCommand === -1 || firstCommand > 40) {
  note("no shell example in the first 40 lines");
}

const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
if (longest > 400) note(`a line is ${longest} characters — tables and prose should wrap`);

const words = readme.split(/\s+/).filter(Boolean).length;
// A ceiling, not a target: the README is still longer than it should be (the CLI reference
// belongs on the site), and this catches growth rather than pretending the trim is done.
if (words > 2600) note(`${words} words — the CLI reference belongs on the site`);

console.log(
  `readme-lint: ${words} words, ${badges} badges, ${anchors} in-page links, ` +
    `${[...readme.matchAll(/!\[/g)].length} images`
);
if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  process.exit(1);
}
console.log("readme-lint: no problems");
