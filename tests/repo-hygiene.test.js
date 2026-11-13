import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildTools } from "../dist/mcp.js";

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
  const words = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
  ];
  const expected = words[count] ?? String(count);

  const documents = ["AGENTS.md", "README.md", "docs/agent.md", "scripts/build-site.mjs"];
  const wrong = [];
  for (const document of documents) {
    const text = read(document);
    for (const match of text.matchAll(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b[\s-]+tools\b/gi)) {
      if (match[1].toLowerCase() !== expected) {
        wrong.push(`${document}: says ${match[1]}, the server serves ${count}`);
      }
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
