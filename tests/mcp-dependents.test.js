import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { buildTools } from "../dist/mcp.js";

/**
 * `snapshot_dependents`, from the 0.9.9 audit.
 *
 * `manifest.indexes.imports` already held the graph — `byFile` recorded every file's import
 * specifiers and `centralFiles` ranked the most-imported ones — but nothing an agent could
 * ask. "What breaks if I change this?" was answered by reading parts until the picture
 * appeared, which is the cost the snapshot exists to remove.
 */

const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
const contextFor = (root) => ({ cwd: root, roots: [root], log: () => {} });

async function call(name, args, context) {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} exists`);
  return tool.handler(args, context);
}

function makeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dependents-"));
  const write = (relative, content) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
  write("package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write("src/b.ts", "export const b = 1;\n");
  write("src/a.ts", 'import { b } from "./b.js";\nimport fs from "node:fs";\nexport const a = b + 1;\n');
  write("src/c.ts", 'import { a } from "./a.js";\nexport const c = a + 1;\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("it answers in both directions", async (t) => {
  const root = makeProject(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const middle = await call("snapshot_dependents", { path: "src/a.ts" }, context);
  assert.ok(!middle.isError, middle.text);

  assert.deepEqual(
    middle.structured.importedBy.map((entry) => entry.path),
    ["src/c.ts"],
    "src/c.ts is the only importer"
  );
  assert.deepEqual(
    middle.structured.imports.map((entry) => entry.path),
    ["src/b.ts"],
    "the relative specifier resolved to the file in the snapshot"
  );
  // A bare package specifier cannot resolve to a snapshot file, and saying so is more useful
  // than pretending the edge does not exist.
  assert.deepEqual(middle.structured.unresolved, ["node:fs"]);
  assert.match(middle.text, /1 importer\(s\), 1 import\(s\), 1 outside the snapshot/);

  const leaf = await call("snapshot_dependents", { path: "src/b.ts" }, context);
  assert.deepEqual(leaf.structured.imports, [], "the leaf imports nothing");
  assert.deepEqual(leaf.structured.importedBy.map((entry) => entry.path), ["src/a.ts"]);
});

test("direction narrows the answer", async (t) => {
  const root = makeProject(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const forward = await call("snapshot_dependents", { path: "src/a.ts", direction: "imports" }, context);
  assert.equal(forward.structured.importedBy.length, 0, "not asked for importers");

  const backward = await call(
    "snapshot_dependents",
    { path: "src/a.ts", direction: "imported-by" },
    context
  );
  assert.equal(backward.structured.imports.length, 0, "not asked for imports");
  assert.equal(backward.structured.importedBy.length, 1);
});

test("a path outside the snapshot is refused with the next step", async (t) => {
  const root = makeProject(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const missing = await call("snapshot_dependents", { path: "src/nope.ts" }, context);
  assert.ok(missing.isError, "an unknown path is a tool error, not an empty answer");
  assert.match(missing.text, /snapshot_locate/);
});

test("the resolver agrees with the generator's own graph", async (t) => {
  const root = makeProject(t);
  const context = contextFor(root);
  await call("snapshot_generate", {}, context);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8")
  );
  // `centralFiles` is built by the generator from the same edges this tool walks.
  const central = manifest.indexes.imports.centralFiles.find((entry) => entry.path === "src/b.ts");
  assert.ok(central, "src/b.ts is in the generator's centrality ranking");
  assert.equal(central.importedByCount, 1);

  const answer = await call("snapshot_dependents", { path: "src/b.ts", direction: "imported-by" }, context);
  assert.equal(
    answer.structured.importedBy.length,
    central.importedByCount,
    "the tool and the manifest count the same edges"
  );
});

test("a previewed importer is still an importer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-dependents-preview-"));
  const write = (relative, content) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
  write("package.json", '{"name":"fixture","version":"1.0.0"}\n');
  // A preview threshold low enough that the importer is emitted as a head/tail excerpt — and a
  // previewed file has no structural summary, which is exactly the case that used to vanish from
  // the import index.
  write("snapshot.config.json", '{ "outDir": "snapshot", "largeFileBytes": 1024 }\n');
  write("src/changed.ts", "export const changed = 1;\n");
  write(
    "src/big-consumer.ts",
    'import { changed } from "./changed.js";\n' +
      // Long enough that the head/tail window (80 + 40 lines) cannot hold it: a file that fits
      // those windows is emitted whole even above the threshold.
      Array.from({ length: 200 }, (_, index) => `export const value${index} = changed + ${index};`).join("\n") +
      "\n"
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const context = contextFor(root);
  const generated = await call("snapshot_generate", {}, context);
  assert.ok(!generated.isError, generated.text);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  const consumer = manifest.files.find((file) => file.relativePath === "src/big-consumer.ts");
  assert.equal(consumer.inclusionMode, "preview", "the importer really is previewed");
  assert.equal(consumer.summary, undefined, "and has no structural summary");

  const entry = manifest.indexes.imports.byFile.find((file) => file.path === "src/big-consumer.ts");
  assert.ok(entry, "the previewed importer is in indexes.imports.byFile");
  assert.deepEqual(entry.imports, ["./changed.js"]);
  assert.equal(entry.exportsOmitted, true, "its export list says it was not read");

  const central = manifest.indexes.imports.centralFiles.find((file) => file.path === "src/changed.ts");
  assert.ok(central, "the imported file is ranked in centralFiles");
  assert.equal(central.importedByCount, 1);

  // The tool reads `byFile`; before the index included previewed files, this answered
  // "0 importer(s)" for a file that has one — while the file was in the snapshot *because* it
  // imports that file.
  const answer = await call(
    "snapshot_dependents",
    { path: "src/changed.ts", direction: "imported-by" },
    context
  );
  assert.ok(!answer.isError, answer.text);
  assert.deepEqual(
    answer.structured.importedBy.map((item) => item.path),
    ["src/big-consumer.ts"]
  );
});
