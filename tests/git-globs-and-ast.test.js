import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  generateSnapshot,
  getGitInfo,
  matchRule,
  resolveConfig,
  summarizeTypeScriptSource,
} from "../dist/index.js";

/**
 * Git enumeration, gitignore matching, layer rules and route summaries, from the 0.9.12 audit.
 *
 * What these have in common is that each one answered a question about the repository with a
 * *different* rule than the one the rest of the tool uses: git was read one way here and another
 * way there, `.gitignore` was honoured in `git` mode and quietly ignored in `walk` mode, and a
 * layer rule fell back to a substring search when it contained a brace.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-globs-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const walkConfig = (root) =>
  resolveConfig(
    { cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", discovery: "walk" },
    {},
    root
  );

test("gitignore character classes apply in walk mode", (t) => {
  // `matchGitignorePattern` escaped `[` and `]` as literals, so a rule written with a class —
  // which is how `*.[oa]`, `[Tt]humbs.db` and `log[0-9].txt` are spelled — matched nothing at all
  // in `--discovery walk` while the identical rule worked in `git` mode.
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    ".gitignore": "*.[oa]\n[Tt]humbs.db\nlog[0-9].txt\n",
    "object.o": "ignored\n",
    "Thumbs.db": "ignored\n",
    "log5.txt": "ignored\n",
    "logx.txt": "kept\n",
    "kept.ts": "export const kept = 1;\n",
  });
  const manifest = generateSnapshot(walkConfig(root));
  const paths = manifest.files.map((file) => file.relativePath).sort();

  assert.equal(paths.includes("object.o"), false, "*.[oa] must ignore object.o");
  assert.equal(paths.includes("Thumbs.db"), false, "[Tt]humbs.db must ignore Thumbs.db");
  assert.equal(paths.includes("log5.txt"), false, "log[0-9].txt must ignore log5.txt");
  assert.equal(paths.includes("logx.txt"), true, "and must not ignore a non-matching name");
  assert.equal(paths.includes("kept.ts"), true, "an unlisted file is still scanned");
});

test("a layer or kind rule understands braces, classes and path segments", () => {
  // Braces and classes were translated to a glob only when the pattern contained `*` or `?`;
  // anything else fell through to `filePath.includes(pattern)`, which is a substring search.
  assert.equal(matchRule("src/api/index.ts", "src/{api,web}/index.ts"), true, "brace alternative");
  assert.equal(matchRule("src/web/index.ts", "src/{api,web}/index.ts"), true, "second alternative");
  assert.equal(matchRule("src/db/index.ts", "src/{api,web}/index.ts"), false, "not an alternative");
  assert.equal(matchRule("src/api/x.ts", "src/[ai]*/x.ts"), true, "character class");
  assert.equal(matchRule("src/db/x.ts", "src/[ai]*/x.ts"), false, "class excludes");

  // A plain pattern means a whole path segment, which is what `matchesExclude` already did.
  assert.equal(matchRule("src/contest/a.ts", "test"), false, "`test` must not match `contest`");
  assert.equal(matchRule("src/test/a.ts", "test"), true, "a real segment matches");
  assert.equal(matchRule("test/a.ts", "test"), true, "including the first segment");
  assert.equal(matchRule("src/app/deep/a.ts", "src/app/**"), true, "and the literal prefix form");
  assert.equal(matchRule("src/apple/a.ts", "src/app/**"), false, "with path boundaries");
});

test("layer rules that use a brace actually classify files", (t) => {
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/api/index.ts": "export const api = 1;\n",
    "src/web/index.ts": "export const web = 1;\n",
    "src/db/index.ts": "export const db = 1;\n",
  });
  const manifest = generateSnapshot(
    resolveConfig(
      {
        cwd: root,
        outDir: "snapshot",
        tmpDir: "snapshot.tmp",
        discovery: "walk",
        layers: [{ name: "http", match: "src/{api,web}/index.ts" }],
      },
      {},
      root
    )
  );
  const layerOf = (file) => manifest.files.find((entry) => entry.relativePath === file).layer;
  assert.equal(layerOf("src/api/index.ts"), "http");
  assert.equal(layerOf("src/web/index.ts"), "http");
  assert.notEqual(layerOf("src/db/index.ts"), "http", "a file outside the brace group is not in it");
});

test("getGitInfo reports the tree it is looking at", { skip: !gitAvailable }, (t) => {
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "a.ts": "export const a = 1;\n",
  });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "one"], { cwd: root });

  const clean = getGitInfo(root);
  assert.equal(clean.isDirty, false, "a committed tree is clean");
  assert.match(clean.commit, /^[0-9a-f]{40}$/, "and the commit is recorded");

  fs.writeFileSync(path.join(root, "a.ts"), "export const a = 2;\n");
  assert.equal(getGitInfo(root).isDirty, true, "an edited tree is dirty");

  // A directory that is not a repository still answers, because that is a normal state.
  const outside = makeRepo(t, { "package.json": "{}\n" });
  assert.equal(getGitInfo(outside).isDirty, false);
});

test("no git listing runs through a shell, and none of them trusts a 1 MB buffer", () => {
  // The defect was an *omission* — `getGitInfo` did not pass `maxBuffer`, so the 1 MB default
  // applied to output that grows with the number of changed files. Reproducing it needs a
  // repository with tens of thousands of dirty entries, which is not a unit test; the invariant is
  // cheap to hold instead, and it is the thing that was wrong.
  const source = fs.readFileSync(path.join(HERE, "..", "src", "scanner", "files.ts"), "utf8");
  assert.equal(
    /childProcess\.execSync\(/.test(source),
    false,
    "a git invocation must not go through a shell"
  );
  const invocations = source.match(/childProcess\.execFileSync\(/g) ?? [];
  const budgets = source.match(/maxBuffer: GIT_OUTPUT_LIMIT/g) ?? [];
  assert.ok(invocations.length >= 3, `every git call is found: ${invocations.length}`);
  assert.equal(
    budgets.length,
    invocations.length,
    "every git call passes the shared output ceiling"
  );
});

test("re-aliased route handlers are recorded as route methods", () => {
  // `export { handler as GET }` and `export { GET } from "./handlers"` are the App Router's way of
  // declaring a route, and the summary listed the export while leaving `routeHandlers` empty — so
  // those routes had no methods at all in `manifest.indexes.routes`.
  const aliased = summarizeTypeScriptSource(
    "route.ts",
    "async function handler() {}\nexport { handler as GET, handler as POST };\n"
  );
  assert.deepEqual(aliased.routeHandlers, ["GET", "POST"]);
  assert.ok(aliased.exports.includes("GET"), "the export is still recorded");

  const reexported = summarizeTypeScriptSource("route.ts", 'export { GET, PUT } from "./handlers";');
  assert.deepEqual(reexported.routeHandlers, ["GET", "PUT"]);

  // A plain named export that happens to be route-shaped is a route; anything else is not.
  assert.deepEqual(
    summarizeTypeScriptSource("lib.ts", "const cache = 1;\nexport { cache as loader };").routeHandlers,
    []
  );
});

test("an anonymous default component is recorded as a component", () => {
  // The named forms were all covered; `export default () => <div />` was the one React component
  // shape missing from `reactComponents`, so a Next.js page directory summarised as having none.
  const arrow = summarizeTypeScriptSource("page.tsx", "export default () => <div />;\n");
  assert.deepEqual(arrow.reactComponents, ["default"]);

  const notJsx = summarizeTypeScriptSource("config.ts", "export default { a: 1 };\n");
  assert.deepEqual(notJsx.reactComponents, [], "a plain object is not a component");
});
