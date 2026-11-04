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
  const list = ["README.md", "SECURITY.md", "CHANGELOG.md", "AGENTS.md", "llms.txt", "CONTRIBUTING.md"];
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
