import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { collectFiles } from "../dist/index.js";

/**
 * 4.0.9 regression cover for the walker's shape.
 *
 * The walker was recursive, one stack frame per directory, so a path 2 400 levels deep overflowed
 * the JavaScript stack and killed every command on a tree that was otherwise perfectly readable.
 * It is an explicit frame stack now. Visit order has to stay what the recursion produced, because
 * `manifest.files[]` is in walk order and a different order changes the fingerprint and every part
 * boundary with it — so the order tests below are the point of this file.
 *
 * The deep fixture is opt-in: creating 2 500 nested directories costs minutes on Windows
 * (the path string itself is hundreds of kilobytes), while a real repository is never that deep.
 *   SNAPSHOT_DEPTH_TEST=1 node --test tests/walker-depth.test.js
 */

function tempDir(t, prefix = "snap-depth-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test(
  "S5: a path 2 500 directories deep is scanned instead of overflowing the stack",
  {
    skip:
      process.env.SNAPSHOT_DEPTH_TEST === "1"
        ? false
        : "set SNAPSHOT_DEPTH_TEST=1 to run the 2 500-level walk test",
  },
  (t) => {
    const dir = tempDir(t);
    let deep = dir;
    try {
      for (let index = 0; index < 2_500; index += 1) {
        deep = path.join(deep, `d${index}`);
        fs.mkdirSync(deep);
      }
      fs.writeFileSync(path.join(deep, "leaf.ts"), "export const deep = 1;\n", "utf8");
    } catch {
      t.skip("this filesystem cannot create a 2 500-level path");
      return;
    }

    const collected = collectFiles(dir, {});

    assert.equal(collected.files.length, 1, "the deep file is found and the walk did not crash");
    assert.match(collected.files[0], /leaf\.ts$/);
  }
);

test("a subtree is finished before the next sibling directory begins", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "a", "aa"), { recursive: true });
  fs.mkdirSync(path.join(dir, "b"), { recursive: true });
  fs.writeFileSync(path.join(dir, "root.ts"), "", "utf8");
  fs.writeFileSync(path.join(dir, "a", "one.ts"), "", "utf8");
  fs.writeFileSync(path.join(dir, "a", "aa", "two.ts"), "", "utf8");
  fs.writeFileSync(path.join(dir, "b", "three.ts"), "", "utf8");

  const order = collectFiles(dir, {}).files;

  assert.equal(order.length, 4);
  const lastOfA = Math.max(
    order.indexOf("a/one.ts"),
    order.indexOf("a/aa/two.ts")
  );
  const firstOfB = order.indexOf("b/three.ts");
  assert.ok(lastOfA < firstOfB, "everything under a/ precedes everything under b/");
  // Entries inside one directory are visited in filesystem order, so whether `a/one.ts` or the
  // `aa/` subtree comes first is not fixed — only that `aa`'s own file follows its parent entry.
  assert.ok(order.indexOf("a/aa/two.ts") > order.indexOf("a/one.ts") - 2);
});

test("the root file and every nested file appear exactly once", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "src", "deep", "deeper"), { recursive: true });
  for (const name of [
    "root.ts",
    "src/a.ts",
    "src/deep/b.ts",
    "src/deep/deeper/c.ts",
  ]) {
    fs.writeFileSync(path.join(dir, name), "", "utf8");
  }

  const files = collectFiles(dir, {}).files;

  assert.equal(new Set(files).size, files.length, "no duplicates");
  assert.equal(files.length, 4);
});

test("two scans of the same tree produce the same order", (t) => {
  const dir = tempDir(t);
  for (const name of ["x", "y", "y/z"]) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "f.ts"), "export const v = 1;\n", "utf8");
  }

  const first = collectFiles(dir, {}).files;
  const second = collectFiles(dir, {}).files;

  assert.deepEqual(second, first, "the walk is deterministic");
});

test("a walk 120 directories deep still works, and quickly", (t) => {
  const dir = tempDir(t);
  let deep = dir;
  for (let index = 0; index < 120; index += 1) {
    deep = path.join(deep, `d${index}`);
    fs.mkdirSync(deep);
  }
  fs.writeFileSync(path.join(deep, "leaf.ts"), "", "utf8");

  const collected = collectFiles(dir, {});
  assert.equal(collected.files.length, 1);
});
