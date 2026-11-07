import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { displayWidth, wrapLines } from "../dist/index.js";

/**
 * Two surfaces that have to work out what they were asked: the wizard's line wrapper, which has to
 * count *cells*, and the `npm create` shim, which has to parse its arguments rather than look for
 * substrings.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE = path.join(HERE, "..", "packages", "create", "index.mjs");

/** A UTF-16 string containing a high surrogate that is not followed by a low one, or vice versa. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("wrapping counts display cells, not UTF-16 code units", () => {
  // `room` was in cells and `rest.slice(0, room)` in code units. For CJK text — one code unit, two
  // cells — a row came out up to twice as wide as the frame believed, so the terminal wrapped it
  // behind the renderer's back and the menu gained a duplicate header on every keypress.
  const cjk = "日本語のテキストです。".repeat(4);
  const rows = wrapLines(cjk, 10);
  for (const row of rows) {
    assert.ok(displayWidth(row) <= 10, `"${row}" is ${displayWidth(row)} cells, limit 10`);
  }
  assert.equal(rows.join(""), cjk, "wrapping is lossless");

  // A surrogate pair is two code units and two cells. `wrapLines` never goes below eight columns,
  // so an odd limit is what makes the two counts disagree: nine cells hold four emoji and half of
  // the fifth, and the old slice took exactly that half.
  const emoji = "🙂".repeat(8);
  const emojiRows = wrapLines(emoji, 9);
  for (const row of emojiRows) {
    assert.ok(displayWidth(row) <= 9, `"${row}" is ${displayWidth(row)} cells, limit 9`);
    assert.doesNotMatch(row, LONE_SURROGATE, "no row holds half a character");
  }
  assert.equal(emojiRows.join(""), emoji, "and the emoji are still there");

  // Ordinary text still breaks at spaces rather than mid-word where it can.
  const words = wrapLines("the quick brown fox jumps over the lazy dog", 12);
  for (const row of words) assert.ok(displayWidth(row) <= 12);
  assert.equal(words.join(" ").replace(/\s+/g, " "), "the quick brown fox jumps over the lazy dog");
});

test("`npm create` reads --preset=name, and refuses what it cannot parse", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "create-shim-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const shim = (args) => {
    const result = spawnSync(process.execPath, [CREATE, ...args], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };

  // `--preset=nextjs` is the form `npm create x -- --preset=nextjs` produces. The old parser used
  // `argv.indexOf("--preset")`, found nothing, and auto-detected a preset instead.
  const equalsForm = shim(["--preset=nextjs", "--yes"]);
  assert.equal(equalsForm.code, 0, equalsForm.stderr);
  assert.match(equalsForm.stderr, /preset: nextjs/, "the named preset is the one that was used");

  // A named preset and a space take the same path.
  const spaceForm = shim(["--preset", "nextjs", "--yes", "--force"]);
  assert.equal(spaceForm.code, 0, spaceForm.stderr);
  assert.match(spaceForm.stderr, /preset: nextjs/);

  // No value at all is a usage error: `takeValue` returned undefined and auto-detection ran.
  const missingValue = shim(["--preset", "--yes"]);
  assert.equal(missingValue.code, 2, `a missing value is a usage error: ${missingValue.stderr}`);
  assert.match(missingValue.stderr, /preset/);

  // An empty value is not "no preset" either.
  const emptyValue = shim(["--preset=", "--yes"]);
  assert.equal(emptyValue.code, 2);
  assert.match(emptyValue.stderr, /empty string/);

  // An unknown flag is the command-line form of a silent fallback: `--forse` looked like it forced
  // the overwrite and forced nothing.
  const unknown = shim(["--forse", "--yes"]);
  assert.equal(unknown.code, 2, `an unknown flag is a usage error: ${unknown.stderr}`);
  assert.match(unknown.stderr, /forse/);

  // `--help` still works, and still writes to stderr so a pipe stays clean.
  const help = shim(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stderr, /--preset <name>/);
  assert.equal(help.stdout, "");
});
