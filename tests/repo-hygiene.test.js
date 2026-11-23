import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPrompts, buildTools } from "../dist/mcp.js";

/**
 * Repository hygiene, from the 0.9.10 audit.
 *
 * Three separate ways the repository described itself wrongly: a control byte had eaten a letter
 * out of a sentence (`\v` in "Validate", `\r` in "reports/", `\a` in "audit.md" — the escapes were
 * interpreted when the text was written), four documents claimed the MCP server serves seven
 * tools when it serves eight, and one npm script could not run.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

/** Control characters that have no business being in a text file. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".txt",
  ".sh",
]);

function trackedTextFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return output
    .split("\0")
    .filter(Boolean)
    .filter((relative) => fs.existsSync(path.join(ROOT, relative)))
    .filter((relative) => TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase()));
}

test("no tracked text file contains a control byte", () => {
  const offenders = [];
  for (const relative of trackedTextFiles()) {
    const text = fs.readFileSync(path.join(ROOT, relative), "utf8");
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (CONTROL.test(line)) {
        offenders.push(`${relative}:${index + 1}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "an interpreted escape (\\v, \\r, \\a, \\e) writes a control byte and silently deletes a letter"
  );
});

test("the words those escapes ate are back", () => {
  assert.match(read("src/explain.ts"), /out of explain\./);
  assert.match(read("src/index.ts"), /Written beside audit\.md/);
  assert.match(read("src/types.ts"), /`reports\/audit\.sarif`/);
  assert.match(read("src/mcp/workspace.ts"), /`resolveConfig` was called with/);
  assert.match(read("docs/stale-context-is-your-bug.md"), /^Validate only helps if it runs\./m);
});

test("every document that states the MCP tool count states the real one", () => {
  const count = buildTools().length;
  // Both spellings and both separators, including a number split across a line by wrapping:
  // "serves the repository as 25\ntools" slipped past the previous word-only regex, which also
  // stopped at ten and so could never fail for a bigger server.
  const units = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  const teens = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty"];
  const words = new Map();
  units.forEach((word, index) => words.set(word, index));
  teens.forEach((word, index) => words.set(word, 10 + index));
  for (let ten = 2; ten < tens.length; ten += 1) {
    words.set(tens[ten], ten * 10);
    for (let unit = 1; unit < 10; unit += 1) words.set(tens[ten] + "-" + units[unit], ten * 10 + unit);
  }

  const documents = ["AGENTS.md", "README.md", "docs/agent.md", "scripts/build-site.mjs"];
  const wrong = [];
  for (const document of documents) {
    const text = read(document);
    for (const match of text.matchAll(/([A-Za-z0-9-]+)[\s-]+tools\b/gi)) {
      const token = match[1].toLowerCase();
      const value = /^\d+$/.test(token) ? Number(token) : words.get(token);
      if (value === undefined) continue;
      if (value !== count) wrong.push(`${document}: says ${match[1]}, the server serves ${count}`);
    }
  }

  assert.deepEqual(wrong, []);
});

test("publish:create names a path npm cannot mistake for a repository", () => {
  const script = JSON.parse(read("package.json")).scripts["publish:create"];

  // `npm publish packages/create` is read by npm as the GitHub shorthand
  // `ssh://git@github.com/packages/create.git` and fails with exit 128.
  assert.match(script, /npm publish \.\/packages\/create\b/, `received: ${script}`);
  assert.doesNotMatch(script, /npm publish packages\/create\b/);
});

test("the site link checker cannot accept a sibling directory", () => {
  const source = read("scripts/check-site-links.mjs");

  assert.match(
    source,
    /resolved\.startsWith\(SITE \+ path\.sep\)/,
    "`startsWith(SITE)` is true for `../site-other`, which is not inside the site"
  );
});

test("the verify gate checks that every site link resolves, not only the anchors", () => {
  const verify = JSON.parse(read("package.json")).scripts.verify;

  // `npm run site` builds the pages; `audit-site` only verifies fragments. A docs link to a page
  // that does not exist therefore passed `npm run verify` and failed the deploy.
  assert.match(verify, /npm run site/);
  assert.match(
    verify,
    /node scripts\/check-site-links\.mjs/,
    "a link to a page the site does not contain must fail the local gate too"
  );
  assert.ok(
    verify.indexOf("npm run site") < verify.indexOf("node scripts/check-site-links.mjs"),
    "the link check needs the built site"
  );
});

test("the release notes and the version agree", () => {
  const version = JSON.parse(read("package.json")).version;
  const changelog = read("CHANGELOG.md");

  assert.match(
    changelog,
    new RegExp(`^## ${version.replace(/\./g, "\\.")}\\b`, "m"),
    `CHANGELOG.md has no section for ${version}`
  );
});

test("comparison-harness output is not tracked", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const stray = tracked.filter((file) => /^(repomix-output\.xml|full-codebase\.(json|md|xml))$/.test(file));
  assert.deepEqual(stray, [], "generated tool output must not be committed: " + stray.join(", "));
});

test("every document that states the prompt count states the real one", () => {
  const count = buildPrompts().length;
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const documents = ["AGENTS.md", "README.md", "docs/agent.md", "docs/mcp.md", "scripts/build-site.mjs"];
  const wrong = [];
  for (const document of documents) {
    for (const match of fs.readFileSync(path.join(ROOT, document), "utf8").matchAll(/([A-Za-z0-9-]+)[\s-]+prompts\b/gi)) {
      const token = match[1].toLowerCase();
      const value = /^\d+$/.test(token) ? Number(token) : words[token];
      if (value === undefined) continue;
      if (value !== count) wrong.push(`${document}: says ${match[1]} prompts, the server serves ${count}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("the README lists every tool the server builds, in order", () => {
  const readme = read("README.md");
  const sentence = /The MCP server exposes [0-9]+ tools — ([^.]*?) — plus/s.exec(readme.replace(/\n/g, " "));
  assert.ok(sentence, "the README still introduces the tool list with an em dash");
  const listed = sentence[1]
    .replace(/, and /g, ", ")
    .replace(/ and /g, ", ")
    .split(/,\s*/)
    .map((name) => name.trim())
    .filter(Boolean);
  const built = buildTools().map((tool) => tool.name.replace(/^snapshot_/, ""));
  assert.deepEqual(listed, built, "the README list must match buildTools() exactly");
});

test("every release tag has a changelog section", () => {
  const tags = execFileSync("git", ["tag", "--list", "v0.*"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((tag) => tag.slice(1));
  assert.ok(tags.length > 100, "the tag list was read: " + tags.length);
  const changelog = read("CHANGELOG.md");
  const missing = tags.filter((version) => !changelog.includes("\n## " + version + "\n"));
  assert.deepEqual(missing, [], "tagged versions with no changelog section: " + missing.join(", "));
});
