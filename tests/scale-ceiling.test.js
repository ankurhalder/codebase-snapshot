import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { collectFiles } from "../dist/index.js";

/**
 * 4.0.9 regression cover for the ~125 000-file ceiling.
 *
 * The directory walker merged each child listing with `results.files.push(...nested.files)`, which
 * passes every element as a function argument. V8 gives up somewhere around 125 000 arguments with
 * "Maximum call stack size exceeded", so a repository whose single directory held that many files
 * could not be scanned at all: `generate` and `explain` crashed in about a second, and `validate`
 * and `report` then answered "run generate first" because no manifest had ever been written.
 *
 * This test is opt-in because it has to create the files it is about. Run it with:
 *
 *   SNAPSHOT_SCALE_TEST=1 node --test tests/scale-ceiling.test.js
 *
 * It takes roughly a minute on an SSD and is the only test in the suite that is expected to be
 * skipped by default.
 */

const CREATE_COUNT = 130_000;
const enabled = process.env.SNAPSHOT_SCALE_TEST === "1";

test(
  "a directory holding more files than V8's argument limit is scanned, not crashed",
  { skip: enabled ? false : "set SNAPSHOT_SCALE_TEST=1 to run the 130 000-file scale test" },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-scale-"));
    try {
      const nested = path.join(dir, "big");
      fs.mkdirSync(nested, { recursive: true });
      for (let index = 0; index < CREATE_COUNT; index += 1) {
        fs.writeFileSync(path.join(nested, `f${index}.txt`), "");
      }

      const collected = collectFiles(dir, {});

      assert.equal(
        collected.files.length,
        CREATE_COUNT,
        "every file is offered as a candidate, not lost to a stack overflow"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
