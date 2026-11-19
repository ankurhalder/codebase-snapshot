/**
 * The files that break naive scanners, and the tools that must still answer.
 *
 * Every case here was probed against the built binary before it became a test: an empty file, a
 * CRLF file, a file that is nothing but comments under `--strip-comments`, a non-ASCII name, spaces
 * and brackets in a name, and a path deep enough to make a Windows path long. None of them may crash,
 * disappear, or change its recorded shape between generate and validate.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { makeTempDir } from "./helpers/temp.js";
import { buildTools } from "../dist/mcp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "dist", "bin.js");

const run = (args, cwd) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
};

function edgeRepo(t) {
  const root = makeTempDir(t, "edge-");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "edge", version: "1.0.0" }) + "\n");
  fs.writeFileSync(path.join(root, "src", "empty.ts"), "");
  fs.writeFileSync(path.join(root, "src", "crlf.ts"), "export const a = 1;\r\nexport const b = 2;\r\n");
  fs.writeFileSync(path.join(root, "src", "comments-only.ts"), "// one\n// two\n/* three */\n");
  fs.writeFileSync(path.join(root, "src", "unicode-Ω.ts"), "export const omega = 1;\n");
  fs.writeFileSync(path.join(root, "src", "odd [name] (v2).ts"), "export const odd = 1;\n");
  const deep = path.join(root, "src", "d".repeat(60), "e".repeat(60));
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "long.ts"), "export const deep = 1;\n");
  const tall = [];
  for (let index = 1; index <= 60; index += 1) tall.push("export const v" + index + " = " + index + ";");
  fs.writeFileSync(path.join(root, "src", "tall.ts"), tall.join("\n") + "\n");
  return root;
}

test("unusual files generate, validate and audit cleanly", (t) => {
  const root = edgeRepo(t);
  const generated = run(["generate", "--strip-comments"], root);
  assert.equal(generated.code, 0, generated.out);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "manifest.json"), "utf8"));
  const byPath = new Map(manifest.files.map((file) => [file.relativePath, file]));
  for (const relative of [
    "src/empty.ts",
    "src/crlf.ts",
    "src/comments-only.ts",
    "src/unicode-Ω.ts",
    "src/odd [name] (v2).ts",
    "src/" + "d".repeat(60) + "/" + "e".repeat(60) + "/long.ts",
    "src/tall.ts",
  ]) {
    assert.ok(byPath.has(relative), relative + " is in the snapshot");
  }
  assert.equal(byPath.get("src/empty.ts").originalLines, 0);
  assert.equal(byPath.get("src/crlf.ts").lines, 2, "CRLF yields two lines, not one");
  assert.equal(byPath.get("src/comments-only.ts").inclusionMode, "comments-stripped");
  assert.equal(byPath.get("src/tall.ts").lines, 60);

  const validated = run(["validate", "--strip-comments"], root);
  assert.equal(validated.code, 0, validated.out);
  const audited = run(["health"], root);
  assert.equal(audited.code, 0, audited.out);
  assert.match(audited.out, /0 failed/);
});

test("the tools read a path with spaces and brackets", async (t) => {
  const root = edgeRepo(t);
  assert.equal(run(["generate"], root).code, 0);
  const context = { cwd: root, roots: [root], log: () => {} };
  const tools = new Map(buildTools().map((tool) => [tool.name, tool]));

  const read = await tools.get("snapshot_read").handler({ path: "src/odd [name] (v2).ts" }, context);
  assert.equal(read.isError, undefined, read.text);
  assert.match(read.text, /export const odd = 1;/);

  const located = await tools.get("snapshot_locate").handler({ query: "odd [name] (v2)", by: "path" }, context);
  assert.equal(located.isError, undefined, located.text);
  assert.match(located.text, /odd \[name\] \(v2\)\.ts/);
});
