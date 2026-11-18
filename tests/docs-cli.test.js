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
