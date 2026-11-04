import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateProjectTree, generateSnapshot, resolveConfig, truncatePreview } from "../dist/index.js";

/**
 * Regression cover for the approved Track-2 items:
 * 17/8 preview window + mandatory budget marker, 18 navigation link labels, 19 iterative tree,
 * 7 audit truncation reporting, 39 escaped branch names.
 */

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-fixes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(base, relativePath, content) {
  const target = path.join(base, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function fencedBody(markdown, filePath) {
  for (const chunk of markdown.split("\n### FILE: ").slice(1)) {
    const lines = chunk.split("\n");
    if (lines[0].trim() !== filePath) continue;
    const banner = lines.findIndex(
      (line) => line === "#### Content" || line === "#### Bounded Preview"
    );
    if (banner === -1) return undefined;
    const fence = (lines[banner + 2].match(/^`+/) ?? [""])[0];
    let closing = banner + 3;
    while (closing < lines.length && lines[closing] !== fence) closing += 1;
    return lines.slice(banner + 3, closing).join("\n");
  }
  return undefined;
}

test("preview: a newline-terminated source keeps its tail lines and the real omission count", (t) => {
  const source = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";

  const preview = truncatePreview(source, 2, 2);
  assert.deepEqual(preview.content.split("\n"), [
    "line 1",
    "line 2",
    "... [6 lines omitted: file exceeds large file size budget] ...",
    "line 9",
    "line 10",
  ]);
  assert.equal(preview.includedLines, 5);

  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"preview-fix"}\n');
  write(dir, "ten.ts", source);

  const manifest = generateSnapshot(
    resolveConfig({
      cwd: dir,
      outDir: "snapshot",
      tmpDir: "snapshot.tmp",
      largeFileBytes: 50,
      previewHeadLines: 2,
      previewTailLines: 2,
    })
  );
  const entry = manifest.files.find((file) => file.relativePath === "ten.ts");
  const block = fencedBody(
    fs.readFileSync(path.join(dir, "snapshot", "parts", "part-001.md"), "utf8"),
    "ten.ts"
  );
  assert.ok(block, "the preview block is present");
  assert.ok(block.includes("line 9"), "the last-but-one line is emitted");
  assert.ok(block.includes("line 10"), "the last line is emitted");
  assert.ok(block.includes("[6 lines omitted"), "the marker counts the six hidden lines");
  assert.equal(entry.includedLines, block.split("\n").length);
});

test("part-budget clipping emits a marker naming the budget", (t) => {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"budget-marker"}\n');
  write(dir, "big.ts", "export const v = 1;\n".repeat(20_000));

  const manifest = generateSnapshot(
    resolveConfig({
      cwd: dir,
      outDir: "snapshot",
      tmpDir: "snapshot.tmp",
      maxPartBytes: 4096,
      largeFileBytes: 10_000_000,
    })
  );
  const entry = manifest.files.find((file) => file.relativePath === "big.ts");

  assert.equal(entry.isLarge, false, "the size threshold did not fire");
  assert.equal(entry.isPreviewTruncated, true, "the part budget clipped the body");
  assert.equal(entry.inclusionMode, "preview");

  const block = fencedBody(
    fs.readFileSync(path.join(dir, "snapshot", "parts", "part-001.md"), "utf8"),
    "big.ts"
  );
  assert.ok(block, "the clipped block is present");
  assert.match(
    block,
    /\[[1-9]\d* lines omitted: part budget \d+ B\]/,
    "the block says how many lines were cut and which budget did it"
  );
  assert.equal(entry.includedLines, block.split("\n").length);
});

test("a bracketed filename cannot inject a live link into navigation.md", (t) => {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"nav-fix"}\n');
  write(dir, "src/b](b).ts", "export const bb = 1;\n");
  write(dir, "src/x](/evil).ts", "export const xe = 1;\n");

  generateSnapshot({ cwd: dir });
  const navigation = fs.readFileSync(
    path.join(dir, "snapshot", "reports", "navigation.md"),
    "utf8"
  );

  assert.ok(!navigation.includes("[src/b](b).ts]("), "no live link is produced");
  assert.ok(!navigation.includes("[src/x](/evil).ts]("), "no root-relative link is produced");
  assert.ok(
    navigation.includes("[src/b\\]\\(b\\).ts](../parts/"),
    "the brackets are backslash-escaped in the label"
  );
  assert.ok(
    navigation.includes("[src/x\\]\\(/evil\\).ts](../parts/"),
    "the root-relative path is backslash-escaped too"
  );
});

test("a 3000-level directory tree completes and reports the depth cap", () => {
  const deepPath = `${"d/".repeat(3000)}leaf.ts`;
  const tree = generateProjectTree([deepPath]);

  assert.ok(tree.startsWith("# Project Tree\n"), "the tree report still renders");
  assert.ok(
    tree.includes("... [tree truncated at 512 levels] ..."),
    "deeper levels are reported as truncated instead of overflowing the stack"
  );
});

test("the audit report shows part-budget truncation with bytes and lines", (t) => {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"audit-fix"}\n');
  write(dir, "big.ts", "export const v = 1;\n".repeat(20_000));

  generateSnapshot(
    resolveConfig({
      cwd: dir,
      outDir: "snapshot",
      tmpDir: "snapshot.tmp",
      maxPartBytes: 4096,
      largeFileBytes: 10_000_000,
    })
  );
  const audit = fs.readFileSync(path.join(dir, "snapshot", "reports", "audit.md"), "utf8");

  assert.ok(!audit.includes("✅ No files exceeded the large file budget"), "the lie is gone");
  assert.ok(audit.includes("| Included Bytes |"), "bytes are printed next to lines");
  assert.match(audit, /\| Truncated \| maxPartBytes \|/, "the cause is labelled maxPartBytes");
  assert.ok(audit.includes("lines omitted"), "the reader is pointed at the in-block marker");
});

test("git branch names with a backtick or bidi character are rendered inert", (t) => {
  const dir = tempDir(t);
  write(dir, "package.json", '{"name":"branch-fix"}\n');
  write(dir, "a.ts", "export const a = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"],
    { cwd: dir, stdio: "ignore" }
  );
  const branch = "a`b" + "\u202E";
  execFileSync("git", ["checkout", "-qb", branch], { cwd: dir, stdio: "ignore" });

  generateSnapshot({ cwd: dir });
  const readme = fs.readFileSync(path.join(dir, "snapshot", "README.md"), "utf8");
  const audit = fs.readFileSync(path.join(dir, "snapshot", "reports", "audit.md"), "utf8");

  assert.match(readme, /\*\*Branch:\*\* ``a`b\\u202E``/, "README renders the branch as inline code");
  assert.match(audit, /\*\*Git Branch:\*\* ``a`b\\u202E``/, "audit renders the branch as inline code");
  assert.equal(readme.includes("\u202E"), false, "no raw bidi in README");
  assert.equal(audit.includes("\u202E"), false, "no raw bidi in audit");
});
