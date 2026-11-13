#!/usr/bin/env node
/**
 * Fails when a GitHub Actions `uses:` is not pinned to a full commit SHA.
 *
 * A tag is a movable pointer: whoever controls the action's repository can change what
 * `actions/checkout@v4` runs without touching this repository. Four workflows pinned every
 * action and two — the two holding `pages: write`/`id-token: write` and `contents: write` — did
 * not, which is precisely backwards: the workflows with deploy and push permissions were the ones
 * trusting a mutable tag.
 *
 * Exempt: `docker://` images (content-addressed by digest when pinned, but not a git ref), and
 * local actions (`./path`), which are this repository's own code.
 *
 * Usage: node scripts/check-workflows.mjs [root]
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const WORKFLOW_DIR = path.join(ROOT, ".github", "workflows");
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;

function workflowFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

const failures = [];
let checked = 0;

for (const file of workflowFiles(WORKFLOW_DIR)) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    const match = /^\s*(?:-\s+)?uses:\s*(\S+)\s*(?:#.*)?$/.exec(line);
    if (!match) return;
    const reference = match[1];
    if (reference.startsWith("./") || reference.startsWith("docker://")) return;
    checked += 1;
    if (!PINNED.test(reference)) {
      failures.push({
        file: path.relative(ROOT, file).replace(/\\/g, "/"),
        line: index + 1,
        reference,
      });
    }
  });
}

if (failures.length === 0) {
  console.log(`workflows: ${checked} action reference(s) pinned to a full commit SHA`);
  process.exit(0);
}

for (const failure of failures) {
  console.error(
    `${failure.file}:${failure.line}  action "${failure.reference}" is not pinned to a 40-character commit SHA`
  );
}
console.error(
  `\n${failures.length} movable action reference(s). Pin each as owner/repo@<40 hex> # vX.Y.Z.`
);
process.exit(1);
