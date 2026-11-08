import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildTools } from "../dist/mcp.js";

/**
 * What the published package promises, from the 0.9.12 audit.
 *
 * Two promises were broken. Every tool but one ignored a custom output directory, so a snapshot
 * written where the agent asked for it was invisible to every tool that could inspect it. And every
 * shipped file ended with a `sourceMappingURL` comment pointing at a `.map` that `package.json#files`
 * deliberately does not ship.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIST = path.join(ROOT, "dist");
const readRepoFile = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const tools = new Map(buildTools().map((tool) => [tool.name, tool]));

const contextFor = (root) => ({ cwd: root, roots: [root], log: () => {} });

function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "surface-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("every tool that reads a snapshot accepts the directory it was generated into", () => {
  const readers = [
    "snapshot_status",
    "snapshot_plan",
    "snapshot_generate",
    "snapshot_validate",
    "snapshot_locate",
    "snapshot_dependents",
    "snapshot_read",
    "snapshot_explain",
  ];
  for (const name of readers) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} exists`);
    assert.ok(
      tool.inputSchema.properties?.outDir,
      `${name} must accept outDir, or a snapshot in a custom directory is unreadable`
    );
  }
});

test("a snapshot generated into a custom directory is readable by every tool", async (t) => {
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/app.ts": "export function alpha(): number { return 1; }\n",
  });
  const context = contextFor(root);

  const generated = await tools.get("snapshot_generate").handler({ outDir: "custom-snap" }, context);
  assert.notEqual(generated.isError, true, generated.text);
  assert.ok(fs.existsSync(path.join(root, "custom-snap", "manifest.json")));

  const status = await tools.get("snapshot_status").handler({ outDir: "custom-snap" }, context);
  assert.equal(status.structured?.present, true, `status must see it: ${status.text}`);

  const read = await tools.get("snapshot_read").handler(
    { path: "src/app.ts", outDir: "custom-snap" },
    context
  );
  assert.notEqual(read.isError, true, `read must find it: ${read.text}`);
  assert.match(read.text, /export function alpha/);

  const located = await tools.get("snapshot_locate").handler(
    { query: "alpha", outDir: "custom-snap" },
    context
  );
  assert.ok(located.structured?.total > 0, `locate must search it: ${located.text}`);

  const validated = await tools.get("snapshot_validate").handler({ outDir: "custom-snap" }, context);
  assert.notEqual(validated.isError, true, `validate must check it: ${validated.text}`);
});

test("no shipped file points at a source map that is not shipped", () => {
  const offenders = [];
  for (const name of fs.readdirSync(DIST)) {
    if (!/\.(?:js|cjs|d\.ts|d\.cts)$/.test(name)) continue;
    const text = fs.readFileSync(path.join(DIST, name), "utf8");
    if (text.includes("sourceMappingURL")) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    "a debugger resolves that comment, finds nothing, and reports a missing map for a file it " +
      "just loaded — so the comment must not be emitted when the maps are not published"
  );
  assert.equal(
    fs.readdirSync(DIST).some((name) => name.endsWith(".map")),
    false,
    "and no map files are left behind either"
  );
});

/**
 * Release-process promises, from the launch audit.
 *
 * The Node 18/20/22 matrix ran only at release time, so a compatibility break first surfaced during
 * a publish instead of on the branch; the scaffolder declared MIT without shipping a licence; and
 * the publish job could not tell a stale manifest from the tag being released. Each test below
 * fails against the repository as it was before those fixes — that is what makes it a regression
 * test rather than a description of the current files.
 */

/** The `uses:` values in a workflow, without the trailing version comment. */
function workflowActions(workflow) {
  return [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((match) => match[1]);
}

/** Every third-party action in a workflow is pinned to a full commit SHA. */
function assertActionsPinned(workflow, label) {
  const actions = workflowActions(workflow);
  assert.ok(actions.length > 0, `${label} must use at least one action`);
  for (const action of actions) {
    assert.match(
      action,
      /@[0-9a-f]{40}$/,
      `${label} must pin ${action} to a full commit SHA; a moved tag can change what runs`
    );
  }
}

test("a pull request runs the same verify gate a release does", () => {
  const workflow = readRepoFile(".github/workflows/pr.yml");
  assert.match(
    workflow,
    /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]$/m,
    "the gate must run on pull requests and on pushes to main"
  );
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /node: \[18, 20, 22\]/, "the same supported Node versions as the release");
  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm run verify/, "the gate must be the repository's real gate");
  assert.doesNotMatch(workflow, /npm publish/, "the publish job belongs to publish.yml alone");
  assertActionsPinned(workflow, "pr.yml");
});

test("a release tag that disagrees with the manifest version fails the publish", () => {
  const workflow = readRepoFile(".github/workflows/publish.yml");
  assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(workflow, /TAG_VERSION="\$\{RELEASE_TAG#v\}"/);
  assert.match(
    workflow,
    /if \[ "\$TAG_VERSION" != "\$VERSION" \]/,
    "the comparison is what turns a stale manifest into a failed publish instead of a wrong one"
  );
  assert.match(
    workflow,
    /^ {8}if: github\.event_name == 'release'$/m,
    "the check only applies to a release event, which is the only event that carries a tag"
  );
  assert.doesNotMatch(
    workflow,
    /The only workflow in the repository/,
    "pr.yml now runs the gate too, so that claim is stale"
  );
});

test("workflows that hold the npm token pin their actions", () => {
  for (const name of ["deprecate.yml", "unpublish.yml"]) {
    assertActionsPinned(readRepoFile(`.github/workflows/${name}`), name);
  }
});

test("create-codebase-snapshot ships the licence it declares", () => {
  const create = JSON.parse(readRepoFile("packages/create/package.json"));
  assert.equal(create.license, "MIT");
  assert.ok(
    (create.files ?? []).includes("LICENSE"),
    "packages/create#files must list LICENSE, or the tarball ships no licence text"
  );
  assert.equal(
    fs.readFileSync(path.join(ROOT, "packages", "create", "LICENSE"), "utf8"),
    readRepoFile("LICENSE"),
    "the scaffolder's licence must not drift from the repository's"
  );
});
