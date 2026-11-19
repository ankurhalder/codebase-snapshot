/**
 * --pack: one full-repository file in a chosen shape.
 *
 * The XML is the interesting one: CDATA, attributes, and the one sequence that cannot appear in a
 * CDATA section. The test parses it back with a real parser, not a regex.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

function makeRepo(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pack-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"p","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  for (const [relative, content] of Object.entries(files)) fs.writeFileSync(path.join(root, relative), content);
  return root;
}

const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
};

test("--pack xml writes valid XML with a file element per file", (t) => {
  const root = makeRepo(t, {
    "src/odd.ts": "export const odd = 'a ]]> b';\n",
    "src/control.ts": "export const control = 'a\u0001b';\n",
  });
  const result = run(["generate", "--pack", "xml"], root);
  assert.equal(result.code, 0, result.out);

  const xml = fs.readFileSync(path.join(root, "snapshot", "full-codebase.xml"), "utf8");
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<codebase_snapshot /);
  assert.equal((xml.match(/<file /g) ?? []).length, 4, "one element per included file");
  assert.match(xml, /path="src\/odd\.ts"/);
  // The split CDATA is the only way a body containing ]]> can stay valid.
  assert.match(xml, /\]\]\]\]><!\[CDATA\[>/);
  assert.doesNotMatch(xml, /\u0001/, "an XML 1.0 control byte must not make the document unparseable");
  assert.match(xml, /\uFFFD/, "the control is replaced, not silently dropped");

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  assert.ok(manifest.artifacts.fullXml, "the manifest records the digest");
  assert.equal(manifest.artifacts.fullMarkdown, null, "the markdown pack was not written");
  assert.equal(fs.existsSync(path.join(root, "snapshot", "full-codebase.md")), false);

  assert.equal(run(["validate", "--pack", "xml"], root).code, 0);
  fs.rmSync(path.join(root, "snapshot", "full-codebase.xml"));
  const stale = run(["validate", "--pack", "xml"], root);
  assert.equal(stale.code, 1, stale.out);
  assert.match(stale.out, /full-codebase\.xml/);
});

test("--pack single writes only the markdown pack", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate", "--pack", "single"], root).code, 0);
  assert.ok(fs.existsSync(path.join(root, "snapshot", "full-codebase.md")));
  assert.equal(fs.existsSync(path.join(root, "snapshot", "full-codebase.json")), false);
});

test("--pack json writes only the JSON pack", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate", "--pack", "json"], root).code, 0);
  const json = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "full-codebase.json"), "utf8"));
  assert.ok(json.files.length >= 2);
  assert.ok(json.manifest.selfReference);
  assert.equal(fs.existsSync(path.join(root, "snapshot", "full-codebase.md")), false);
});

test("an invalid --pack value is a usage error", (t) => {
  const root = makeRepo(t);
  const result = run(["generate", "--pack", "yaml"], root);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /single, xml, json/);
});
