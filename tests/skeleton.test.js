import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, resolveConfig, skeletonizeTypeScript } from "../dist/index.js";

/**
 * Signature compression, from the 0.9.9 audit.
 *
 * `docs/vs-repomix.md` concedes that a tree-sitter compression mode beats byte budgeting for a
 * repository too large to fit at all: it keeps the shape of the code and drops the
 * implementations. This is that mode, built on the compiler that is already the one runtime
 * dependency.
 *
 * The rewrite must be *span-based*. Re-printing a file with `ts.createPrinter()` would
 * normalise quotes, semicolons, blank lines and comment positions, so a skeleton of a file
 * would differ from it everywhere rather than only where bodies were removed — which makes the
 * mode useless for reading and destroys the "diff it against the source" workflow.
 */

test("bodies are replaced in place and everything around them is untouched", () => {
  const source = [
    'import { readFile } from "node:fs";',
    "",
    "/** Says hello. */",
    "export function greet(name: string): string {",
    "  const trimmed = name.trim();",
    "  return `hello ${trimmed}`;",
    "}",
    "",
    "export const LIMIT = 10;",
    "",
    "export interface Options {",
    "  verbose: boolean;",
    "}",
    "",
    "export class Store {",
    "  private items: string[] = [];",
    "",
    "  add(item: string): void {",
    "    this.items.push(item);",
    "  }",
    "}",
  ].join("\n");

  const { text, collapsed } = skeletonizeTypeScript(source, "sample.ts");

  assert.equal(collapsed, 2, "the function and the method are the two bodies");
  assert.ok(text.includes("/** Says hello. */"), "the doc comment stays");
  assert.ok(text.includes("export function greet(name: string): string { /* ... */ }"));
  assert.ok(text.includes("add(item: string): void { /* ... */ }"));
  assert.ok(text.includes("export interface Options {"), "type declarations are not bodies");
  assert.ok(!text.includes("const trimmed = name.trim();"), "the implementation is gone");
  assert.ok(!text.includes("this.items.push(item);"));
  assert.ok(text.length < source.length, "the point is that it is smaller");
  // Formatting outside the collapsed bodies is byte-identical.
  assert.ok(text.includes('import { readFile } from "node:fs";'));
  assert.ok(text.includes("  private items: string[] = [];"));
});

test("a file with no bodies is returned unchanged", () => {
  const source = "export type A = string;\nexport const B = 1;\n";
  const { text, collapsed } = skeletonizeTypeScript(source, "types.ts");
  assert.equal(collapsed, 0);
  assert.equal(text, source, "nothing to do means no edit at all");
});

test("nested arrows inside a function collapse with their parent, not twice", () => {
  const source = [
    "export function outer(): number[] {",
    "  const inner = (n: number) => {",
    "    return n * 2;",
    "  };",
    "  return [1, 2, 3].map(inner);",
    "}",
  ].join("\n");

  const { text, collapsed } = skeletonizeTypeScript(source, "nested.ts");

  assert.equal(collapsed, 1, "one outermost body, replaced once");
  assert.equal(text, "export function outer(): number[] { /* ... */ }");
});

test("a .tsx file keeps its JSX outside the collapsed bodies", () => {
  const source = [
    "export function Page() {",
    "  return <main>hello</main>;",
    "}",
  ].join("\n");
  const { text, collapsed } = skeletonizeTypeScript(source, "Page.tsx");
  assert.equal(collapsed, 1);
  assert.equal(text, "export function Page() { /* ... */ }");
});

test("generate --skeleton emits signatures and says so per file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeleton-"));
  const write = (relative, content) => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
  write("package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write(
    "src/math.ts",
    [
      "export function add(a: number, b: number): number {",
      "  const total = a + b;",
      "  return total;",
      "}",
      "export const VERSION = 1;",
    ].join("\n")
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const config = resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", skeleton: true });
  const manifest = generateSnapshot(config);

  const entry = manifest.files.find((file) => file.relativePath === "src/math.ts");
  assert.equal(entry.inclusionMode, "signatures", "the mode is recorded per file");
  assert.ok(entry.includedBytes < entry.sizeBytes, "and the file really is smaller");

  const part = fs.readFileSync(
    path.join(dir, "snapshot", "parts", manifest.parts[0].filename),
    "utf8"
  );
  assert.ok(part.includes("export function add(a: number, b: number): number { /* ... */ }"));
  assert.ok(!part.includes("const total = a + b;"), "the body is not in the snapshot");
  // The summary still describes the real file.
  assert.deepEqual(entry.summary.exports, ["VERSION", "add"]);
  assert.equal(manifest.config.skeleton, true);
});

test("without the flag the same file is emitted whole", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skeleton-off-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(
    path.join(dir, "src", "math.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n"
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const manifest = generateSnapshot(
    resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" })
  );
  const entry = manifest.files.find((file) => file.relativePath === "src/math.ts");
  assert.equal(entry.inclusionMode, "full");
  assert.equal(manifest.config.skeleton, undefined);
});
