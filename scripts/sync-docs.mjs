/**
 * Keeps the version numbers inside the documentation in step with `package.json`.
 *
 * Docs that state a version rot the moment the version changes, and the failure is
 * silent: nothing goes red, the published README just starts lying. Hand-updating
 * them at each release is a step someone eventually skips.
 *
 * So the value lives in exactly one place and is injected into marked spans:
 *
 *     | <!--@majorMinor-->0.9<!--/@majorMinor-->.x | supported |
 *     npx codebase-snapshot@<!--@version-->0.9.0<!--/@version-->
 *
 * The markers are HTML comments, so GitHub renders the value and hides the syntax.
 * `--check` rewrites nothing and exits 1 when any span is stale, which is what CI
 * runs; without it the script fixes the files in place.
 *
 * Two shapes cannot hold a marker — a comment inside a fence renders as text — so
 * they are matched by shape instead: `Added devDependency: codebase-snapshot ^x.y.z`
 * and any `codebase-snapshot@x.y.z` install pin.
 *
 * Only the *current* version is synchronised. Changelog history stays a literal:
 * rewriting past entries would be falsifying a record, not maintaining it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const write = (...parts) => process.stdout.write(`${parts.join("")}\n`);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const parts = pkg.version.split(".");
const VALUES = {
  version: pkg.version,
  majorMinor: `${parts[0]}.${parts[1]}`,
  major: parts[0],
};

/** Every documentation file that may carry a synchronised value. */
function targets() {
  // CHANGELOG.md is deliberately absent: it records what happened at each version, and
  // rewriting a past entry would falsify that record instead of maintaining it.
  const list = ["README.md", "SECURITY.md", "AGENTS.md", "llms.txt", "CONTRIBUTING.md"];
  const docs = path.join(ROOT, "docs");
  if (fs.existsSync(docs)) {
    for (const name of fs.readdirSync(docs)) {
      if (name.endsWith(".md")) list.push(path.join("docs", name));
    }
  }
  return list.filter((relative) => fs.existsSync(path.join(ROOT, relative)));
}

const check = process.argv.includes("--check");
const stale = [];

for (const relative of targets()) {
  const absolute = path.join(ROOT, relative);
  const before = fs.readFileSync(absolute, "utf8");
  let after = before;

  for (const [key, value] of Object.entries(VALUES)) {
    const pattern = new RegExp(`(<!--@${key}-->)[\\s\\S]*?(<!--/@${key}-->)`, "g");
    after = after.replace(pattern, (_match, open, close) => `${open}${value}${close}`);
  }

  // Code-block examples cannot carry HTML-comment markers: inside a fence the
  // comment is literal text, so the syntax leaks into the rendered page. They are
  // matched by shape instead, which keeps the source readable.
  after = after.replace(
    /(Added devDependency: codebase-snapshot \^)\d+\.\d+\.\d+/g,
    `$1${VALUES.version}`
  );
  // An install pin has the same problem in a different costume: an MCP client config is JSON
  // inside a fence, and `"args": ["-y", "codebase-snapshot@0.9.6", …]` cannot carry a marker
  // either. A pinned example naming the previous release is worse than a stale sentence —
  // copying it installs the wrong version — so it is rewritten by shape too. `@latest` does not
  // match, which is what the guides that do not want a pin use.
  after = after.replace(/(codebase-snapshot@)\d+\.\d+\.\d+/g, `$1${VALUES.version}`);
  if (after !== before) {
    stale.push(relative);
    if (!check) fs.writeFileSync(absolute, after, "utf8");
  }
}

if (check) {
  if (stale.length > 0) {
    write(`sync-docs: ${stale.length} file(s) out of step with package.json ${pkg.version}:`);
    for (const file of stale) write(`  - ${file}`);
    write("sync-docs: run `npm run sync-docs` and commit the result");
    process.exit(1);
  }
  write(`sync-docs: every marked version agrees with package.json ${pkg.version}`);
} else {
  write(
    stale.length === 0
      ? `sync-docs: already current with package.json ${pkg.version}`
      : `sync-docs: updated ${stale.join(", ")} to ${pkg.version}`
  );
}
