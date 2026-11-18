/**
 * The CLI page is titled "Every command and option", so it has to be one.
 *
 * Ten flags were missing from it — the six transport flags, `--all-members`, `--strict`, `--mode` and
 * `--no-update-check` — while the page promised completeness. This compares the page with the
 * contract the binary prints, in both directions: a flag the contract publishes but the page omits,
 * and a flag the page shows that no longer exists.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const PAGE = fs.readFileSync(path.join(ROOT, "docs", "cli.md"), "utf8");

function contractFlags() {
  const stdout = execFileSync(process.execPath, ["dist/bin.js", "describe", "--format", "json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(stdout).options.map((option) => option.flag);
}

/** Flags the page documents as table rows: `| \`--flag …\` | …`. */
function documentedFlags() {
  return [...PAGE.matchAll(/^\| `(--[a-z0-9-]+)[^`]*`/gm)].map((match) => match[1]);
}

test("every option the contract publishes is documented", () => {
  const documented = new Set(documentedFlags());
  const missing = contractFlags().filter((flag) => !documented.has(flag));
  assert.deepEqual(missing, [], "undocumented: " + missing.join(", "));
});

test("the page documents no flag the contract does not publish", () => {
  const contract = new Set(contractFlags());
  const unknown = documentedFlags().filter((flag) => !contract.has(flag));
  assert.deepEqual([...new Set(unknown)], [], "unknown: " + unknown.join(", "));
});

/** Command sections on the page: `### `generate`` or `### `validate` / `check``. */
function documentedCommands() {
  return [...PAGE.matchAll(/^### `([a-z]+)/gm)].map((match) => match[1]);
}

function contractCommands() {
  const stdout = execFileSync(process.execPath, ["dist/bin.js", "describe", "--format", "json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(stdout).commands.map((command) => command.name);
}

test("every command the contract publishes has a section on the page", () => {
  const documented = new Set(documentedCommands());
  const missing = contractCommands().filter((name) => !documented.has(name));
  assert.deepEqual(missing, [], "undocumented commands: " + missing.join(", "));
});

test("the page has no command section for a command that does not exist", () => {
  const contract = new Set(contractCommands());
  const unknown = documentedCommands().filter((name) => !contract.has(name));
  assert.deepEqual([...new Set(unknown)], [], "unknown commands: " + unknown.join(", "));
});

/** Install pins in the docs: `npx -y codebase-snapshot@x.y.z`. */
function documentedPins() {
  const files = [
    path.join(ROOT, "README.md"),
    ...fs.readdirSync(path.join(ROOT, "docs")).filter((name) => name.endsWith(".md")).map((name) => path.join(ROOT, "docs", name)),
  ];
  const pins = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/codebase-snapshot@(\d+\.\d+\.\d+)/g)) {
      pins.push({ file: path.relative(ROOT, file), version: match[1] });
    }
  }
  return pins;
}

test("every install pin names a published milestone, not an unpublished patch", () => {
  const published = fs.readFileSync(path.join(ROOT, "PUBLISHED"), "utf8").trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(published, /^\d+\.\d+\.0$/, "PUBLISHED records an x.y.0 milestone");
  assert.ok(
    published.localeCompare(pkg.version, undefined, { numeric: true }) <= 0,
    "PUBLISHED (" + published + ") cannot be newer than the package (" + pkg.version + ")"
  );
  const stale = documentedPins().filter((pin) => pin.version !== published);
  assert.deepEqual(stale, [], "pins must match PUBLISHED " + published + ": " + JSON.stringify(stale));
  assert.ok(documentedPins().length > 0, "the docs do pin a version");
});

test("the MCP page documents every resource URI the server publishes", async () => {
  const { STATIC_RESOURCE_URIS, REPORT_RESOURCE_URIS, RESOURCE_TEMPLATE_URIS } = await import("../dist/mcp.js");
  const page = fs.readFileSync(path.join(ROOT, "docs", "mcp.md"), "utf8");
  const missing = [...STATIC_RESOURCE_URIS, ...REPORT_RESOURCE_URIS, ...RESOURCE_TEMPLATE_URIS].filter(
    (uri) => !page.includes("`" + uri + "`")
  );
  assert.deepEqual(missing, [], "undocumented resource URIs: " + missing.join(", "));
});

test("the CLI page states the real prompt count", async () => {
  const { buildPrompts } = await import("../dist/mcp.js");
  const page = fs.readFileSync(path.join(ROOT, "docs", "cli.md"), "utf8");
  const counts = [...page.matchAll(/(\w+) prompts/g)].map((match) => match[1]);
  const words = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const wrong = counts.filter((word) => words[word.toLowerCase()] !== undefined && words[word.toLowerCase()] !== buildPrompts().length);
  assert.deepEqual(wrong, [], "the page says " + wrong.join(", ") + " prompts; the server serves " + buildPrompts().length);
});
