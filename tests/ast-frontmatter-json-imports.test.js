import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  generateSnapshot,
  isSkeletonizable,
  resolveConfig,
  skeletonizeTypeScript,
  stripJsonComments,
  summarizeJson,
  summarizeMarkdown,
  summarizeTypeScriptSource,
} from "../dist/index.js";

/**
 * The AST layer: what a Markdown document's front matter is, what JSONC tolerates, which module
 * edges a file declares, and which files signature compression applies to.
 *
 * Every one of these answers "what is in this file?" for the manifest index that agents query
 * before reading anything. An index that silently omits half a document's headings, a file's
 * imports, or a whole language is worse than no index: it reads as complete.
 */

function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ast-shapes-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a leading horizontal rule is not YAML front matter", () => {
  // The check scanned to the end of the file for any `---` line and called the result front matter,
  // so a document that opens with a horizontal rule and uses another one as a section divider had
  // every heading between them removed from its summary — the index claimed a document with no
  // sections.
  const ruleDoc = ["---", "# Title", "", "Intro paragraph.", "---", "## Section", "text"].join("\n");
  const summary = summarizeMarkdown(ruleDoc);
  assert.deepEqual(summary.headings, ["# Title", "## Section"]);
  assert.deepEqual(summary.frontmatterKeys, [], "a rule is not front matter");

  // A fenced block between the two rules settles it too.
  const fenced = ["---", "```js", "const a = 1;", "```", "---", "# Heading"].join("\n");
  assert.deepEqual(summarizeMarkdown(fenced).headings, ["# Heading"]);
  assert.deepEqual(summarizeMarkdown(fenced).frontmatterKeys, []);

  // A `---` and a later `---` with prose between them is two rules, not front matter.
  const prose = ["---", "Some prose.", "---", "## Later"].join("\n");
  assert.deepEqual(summarizeMarkdown(prose).frontmatterKeys, []);
  assert.deepEqual(summarizeMarkdown(prose).headings, ["## Later"]);
});

test("real front matter is still front matter", () => {
  const yaml = ["---", "title: Foo", "tags: [a, b]", "---", "# Heading"].join("\n");
  const summary = summarizeMarkdown(yaml);
  assert.deepEqual(summary.frontmatterKeys, ["tags", "title"]);
  assert.deepEqual(summary.headings, ["# Heading"]);

  // A `...` document terminator closes a YAML block just as `---` does.
  const dotted = ["---", "title: Foo", "...", "# Heading"].join("\n");
  assert.deepEqual(summarizeMarkdown(dotted).frontmatterKeys, ["title"]);
  assert.deepEqual(summarizeMarkdown(dotted).headings, ["# Heading"]);

  // Indented continuations and a blank line inside the block are still YAML.
  const multi = [
    "---",
    "description: >",
    "  a folded value",
    "",
    "title: Foo",
    "---",
    "# Heading",
  ].join("\n");
  const multiSummary = summarizeMarkdown(multi);
  assert.deepEqual(multiSummary.frontmatterKeys, ["description", "title"]);
  assert.deepEqual(multiSummary.headings, ["# Heading"]);
});

test("JSONC: trailing commas, CR-only lines, and block comments that keep their lines", () => {
  // `src/ast/structured.ts` had its own `stripJsonComments` that only ended a `//` comment on `\n`
  // and never removed a trailing comma — so a `.jsonc` or `tsconfig.json` written the way editors
  // write them summarised as `invalid-json` with no keys at all.
  const trailing = summarizeJson('{\n  "compilerOptions": {},\n  "files": [],\n}\n');
  assert.equal(trailing.shape, "object");
  assert.deepEqual(trailing.keys, ["compilerOptions", "files"]);

  // A `\r`-only line comment ends at the carriage return, not at the end of the file.
  const crOnly = summarizeJson('{\r// a comment\r"a": 1,\r}');
  assert.equal(crOnly.shape, "object", "a CR-delimited line comment ends at the carriage return");
  assert.deepEqual(crOnly.keys, ["a"]);

  // A block comment keeps the terminators it spans: dropping them renumbered every line after it,
  // and the summary's line references are read against the real file.
  const withBlock = '{\n/* one\n   two */\n"a": 1\n}\n';
  assert.equal(
    stripJsonComments(withBlock).split("\n").length,
    withBlock.split("\n").length,
    "the comment's line breaks survive"
  );

  // A `//` inside a string is still not a comment.
  assert.equal(summarizeJson('{"url": "https://example.com/a"}').shape, "object");
});

test("require, import() and import-equals are module edges too", () => {
  // `summarizeTypeScriptSource` only looked at `ts.isImportDeclaration` and
  // `ts.isExportDeclaration`, so a CommonJS project, and any code using `await import()`, recorded
  // no import edges at all — which is what `manifest.indexes.imports`, `snapshot_dependents` and
  // `--with-dependents` are built from.
  const source = [
    'const legacy = require("./cjs-target");',
    'async function load() { return import("./dynamic-target"); }',
    'import fs = require("node:fs");',
    'import { named } from "./static-target";',
    'export { thing } from "./named-re-export";',
    'export * from "./star-re-export";',
  ].join("\n");

  const summary = summarizeTypeScriptSource("mixed.ts", source);
  for (const specifier of [
    "./cjs-target",
    "./dynamic-target",
    "node:fs",
    "./static-target",
    "./named-re-export",
    "./star-re-export",
  ]) {
    assert.ok(summary.imports.includes(specifier), `${specifier} is recorded: ${summary.imports}`);
  }
  assert.ok(summary.reExports.includes("./named-re-export"), "a named re-export is a re-export");
  assert.ok(summary.reExports.includes("./star-re-export"));

  // A non-literal specifier is an expression, and guessing at it would be worse than saying
  // nothing: no edge is recorded rather than a wrong one.
  const computed = summarizeTypeScriptSource(
    "c.ts",
    'const name = "./x";\nconst a = require(name);\nconst b = import(`./tpl/${name}.js`);\n'
  );
  assert.deepEqual(computed.imports, []);
});

test("signature compression covers JavaScript and JSX, not just TypeScript", (t) => {
  // `skeletonizeTypeScript` parses `.js`/`.jsx`/`.mjs`/`.cjs` natively when it is told which
  // ScriptKind to use, and `--skeleton` was limiting itself to the four TypeScript spellings — so
  // the files most repositories are made of were the ones it could not compress. It also parsed
  // `.d.ts` files, which have no bodies to collapse.
  for (const extension of [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]) {
    assert.equal(isSkeletonizable(`src/app${extension}`), true, `${extension} is compressible`);
  }
  for (const extension of [".d.ts", ".d.mts", ".d.cts"]) {
    assert.equal(isSkeletonizable(`src/types${extension}`), false, `${extension} has no bodies`);
  }

  // The script kind has to follow the extension or JSX is a syntax error.
  const jsx = "export function App() {\n  return <div>{name}</div>;\n}\n";
  const collapsed = skeletonizeTypeScript(jsx, "App.jsx");
  assert.equal(collapsed.collapsed, 1);
  assert.equal(collapsed.text.includes("{ /* ... */ }"), true);
  assert.equal(collapsed.text.includes("<div>"), false, "the body is gone, the signature is not");

  // End to end: a `.js` file really is compressed by `generate --skeleton` now.
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/app.js": 'export function compute() {\n  return 6 * 7;\n}\n',
    "src/app.ts": 'export function computeTs() {\n  return 6 * 7;\n}\n',
  });
  const config = resolveConfig(
    { cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", discovery: "walk", skeleton: true },
    {},
    root
  );
  const manifest = generateSnapshot(config);
  for (const file of ["src/app.js", "src/app.ts"]) {
    const entry = manifest.files.find((candidate) => candidate.relativePath === file);
    assert.equal(entry?.inclusionMode, "signatures", `${file} was compressed`);
  }
  const partText = fs.readFileSync(path.join(root, "snapshot", "parts", manifest.parts[0].filename), "utf8");
  assert.equal(partText.includes("6 * 7"), false, "and no body reached the part");
});
