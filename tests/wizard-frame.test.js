/**
 * The prompt frame in a narrow terminal.
 *
 * The wizard repaints a prompt in place by moving the cursor up by the height of the frame it
 * last drew. That height was counted in *logical lines*, while the terminal lays out *screen
 * rows* — and it wraps anything wider than itself without telling anyone. Every other test in
 * this suite pins `columns` to 120, where nothing wraps and the two numbers agree.
 *
 * At 70-ish columns they do not: the setup menu's recommended answer carries a hint 83 cells
 * long, the terminal silently turned it into two rows, and one row too few was erased on every
 * keypress. The result was a column of identical `◆ How should I set this up?` lines with the
 * live menu at the bottom. These tests are that terminal.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { displayWidth, PromptCancelled, runInit, wrapLines } from "../dist/index.js";

const ERASE = /\u001b\[(\d+)A\u001b\[0J/g;

/** How many screen rows a payload occupies once the terminal has had its way with it. */
function visualRows(payload, columns) {
  return payload
    .replace(/\n$/, "") // the write's own terminator is not a row of its own
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(displayWidth(line) / columns)), 0);
}

function makeProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wizard-frame-"));
  const write = (relative, content) => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write("package.json", '{"name":"app","version":"1.0.0"}\n');
  write("next.config.ts", "export default {};\n");
  write("src/a.ts", "export const a = 1;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Runs the wizard at a given width, pressing one key per redrawn prompt.
 *
 * The last key is Ctrl+C, so the run stops on the setup menu instead of walking to the end —
 * that keeps every byte after the first prompt a frame payload and nothing else.
 */
async function driveNarrow(dir, columns, keys) {
  const pending = [...keys];
  const chunks = [];

  const output = new PassThrough();
  output.isTTY = true;
  output.columns = columns;
  output.on("data", (chunk) => {
    const text = chunk.toString();
    chunks.push(text);
    if (!text.includes("◆") || pending.length === 0) return;
    const key = pending.shift();
    queueMicrotask(() => input.emit("keypress", "", key));
  });

  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = () => {};

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`the wizard stalled with ${pending.length} key(s) left`)), 5000)
  );
  const run = runInit({ cwd: dir, io: { input, output } });
  run.catch(() => {});
  let error = null;
  try {
    await Promise.race([run, timeout]);
  } catch (caught) {
    error = caught;
  }
  return { error, raw: chunks.join("") };
}

test("displayWidth counts cells, not code units", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("◆ setup"), 7, "the marker glyph is one cell, like the font draws it");
  assert.equal(displayWidth("日本語"), 6, "CJK takes two cells per character");
  assert.equal(displayWidth("\u001b[31mred\u001b[0m"), 3, "escape sequences take none");
});

test("wrapLines leaves a block that already fits alone", () => {
  assert.deepEqual(wrapLines("one\ntwo\n\nthree", 40), ["one", "two", "", "three"]);
});

test("wrapLines keeps every row inside the limit", () => {
  const hint = "  ❯ Use the recommended setup  node-lib · config · npm scripts · install · generate";
  const rows = wrapLines(hint, 60);
  assert.ok(rows.length > 1, "an over-long line is broken");
  for (const row of rows) {
    assert.ok(displayWidth(row) <= 60, `"${row}" is ${displayWidth(row)} cells`);
  }
  assert.match(rows[1], /^ {4}\S/, "the continuation keeps the indent and adds two spaces");
  assert.equal(rows.join(" ").replace(/\s+/g, " "), hint.replace(/\s+/g, " "), "nothing is lost");
});

test("wrapLines breaks a single token that is longer than the width", () => {
  const long = `  ${"C".repeat(120)}`;
  const rows = wrapLines(long, 40);
  for (const row of rows) assert.ok(displayWidth(row) <= 40);
  assert.equal(rows.join("").replace(/\s+/g, ""), "C".repeat(120), "a hard break keeps every character");
});

test("every frame is erased by exactly the number of rows it drew", async (t) => {
  const dir = makeProject(t);
  // 48 columns is narrow enough that the recommended answer wraps, and narrow enough that it used
  // to wrap *differently* once the cursor left it — which made the menu change height as you moved.
  const columns = 48;
  const keys = [
    { name: "down" },
    { name: "down" },
    { name: "up" },
    { name: "down" },
    { name: "c", ctrl: true },
  ];
  const { error, raw } = await driveNarrow(dir, columns, keys);
  assert.ok(error instanceof PromptCancelled, "the run ended on Ctrl+C at the menu");

  // Everything from the first prompt on is frame payloads separated by erases.
  const start = raw.indexOf("◆");
  assert.ok(start >= 0, "the setup menu was drawn");
  const tail = raw.slice(start);

  const checks = [];
  let cursor = 0;
  for (const match of tail.matchAll(ERASE)) {
    const payload = tail.slice(cursor, match.index);
    checks.push({ announced: Number(match[1]), rows: visualRows(payload, columns), payload });
    cursor = match.index + match[0].length;
  }
  assert.ok(checks.length >= 4, `the menu was repainted ${checks.length} time(s)`);

  for (const check of checks) {
    for (const line of check.payload.split("\n")) {
      assert.ok(
        displayWidth(line) <= columns,
        `nothing may reach the edge, or the terminal wraps behind the frame's back: "${line}"`
      );
    }
    assert.equal(
      check.announced,
      check.rows,
      `the erase moved up ${check.announced} row(s) over a frame ${check.rows} row(s) tall:\n` +
        check.payload
    );
  }
  // It is the same menu every time, so it must be the same height every time. A wrapped hint that
  // re-wraps when the marker moves makes the whole menu jump one row as the cursor passes it.
  assert.equal(
    new Set(checks.map((check) => check.announced)).size,
    1,
    `the menu kept one height as the cursor moved: ${checks.map((check) => check.announced).join(", ")}`
  );
});

/**
 * A terminal, roughly: a grid of rows, `ESC[nA` moves up n, `ESC[0J` clears to the end of the
 * screen, and every write wraps at `columns` whether the writer wanted it to or not. That last
 * part is the whole bug — the reporter's screen was the terminal doing this, not the wizard.
 */
function simulate(raw, columns) {
  const cells = [];
  let row = 0;
  let col = 0;

  const put = (character) => {
    if (col >= columns) {
      row += 1;
      col = 0;
    }
    cells[row] ??= [];
    cells[row][col] = character;
    col += 1;
  };

  let index = 0;
  while (index < raw.length) {
    const match = /^\u001b\[(\d+)A/.exec(raw.slice(index));
    if (match) {
      row = Math.max(0, row - Number(match[1]));
      col = 0;
      index += match[0].length;
      continue;
    }
    if (raw.startsWith("\u001b[0J", index)) {
      cells[row]?.splice(col);
      for (let below = row + 1; below < cells.length; below += 1) cells[below] = [];
      index += 4;
      continue;
    }
    const character = raw[index];
    index += 1;
    if (character === "\n") {
      row += 1;
      col = 0;
      continue;
    }
    if (character === "\r") {
      col = 0;
      continue;
    }
    put(character);
  }

  return cells.map((line) => line.join("").replace(/\s+$/, ""));
}

test("the screen shows one question, not one per keypress", async (t) => {
  const dir = makeProject(t);
  const columns = 70;
  const keys = [
    { name: "down" },
    { name: "down" },
    { name: "up" },
    { name: "down" },
    { name: "down" },
    { name: "c", ctrl: true },
  ];
  const { error, raw } = await driveNarrow(dir, columns, keys);
  assert.ok(error instanceof PromptCancelled, "the run ended on Ctrl+C at the menu");

  const screen = simulate(raw, columns);
  const text = screen.join("\n");
  const countOf = (needle) => text.split(needle).length - 1;

  // The run ends on Ctrl+C, which erases the frame it was showing on purpose — so the last screen
  // has no prompt on it at all. The one the user was looking at is the one before that erase.
  const beforeLastErase = raw.slice(0, raw.lastIndexOf("\u001b["));
  const live = simulate(beforeLastErase, columns).join("\n");
  const countLive = (needle) => live.split(needle).length - 1;

  assert.equal(
    countLive("◆ How should I set this up?"),
    1,
    `one question line on screen, not one per keypress:\n${live}`
  );
  assert.equal(countLive("Go through each setting"), 1, `one copy of each answer:\n${live}`);
  assert.equal(countLive("Use the recommended setup"), 1, `one copy of each answer:\n${live}`);
  assert.match(live, /↑↓ move · enter select/, "the footer survives the last repaint");
  assert.equal(countOf("◆ How should I set this up?"), 0, `nothing is left behind:\n${text}`);
});

test("a narrow terminal still finishes the walk", async (t) => {
  const dir = makeProject(t);
  const columns = 50;
  const keys = [
    { name: "down" }, // walk
    { name: "return" },
    { name: "return" }, // scope
    { name: "return" }, // size
    { name: "return" }, // artifacts
    { name: "return" }, // credentials
    { name: "return" }, // review
  ];

  const pending = [...keys];
  const chunks = [];
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = columns;
  output.on("data", (chunk) => {
    const text = chunk.toString();
    chunks.push(text);
    if (!text.includes("◆") || pending.length === 0) return;
    const key = pending.shift();
    queueMicrotask(() => input.emit("keypress", "", key));
  });
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = () => {};

  const result = await runInit({ cwd: dir, io: { input, output } });
  assert.equal(result.written, true, "a 50-column terminal is still usable");

  // Only the frame payloads have to fit: the header and the review summary are written once and
  // never erased, so a long line there is the terminal's to wrap and nobody's problem. Everything
  // from the first prompt to the review block is a repainted frame, and those must fit.
  const screen = chunks.join("");
  const start = screen.indexOf("◆");
  const review = screen.indexOf("\n  Review\n");
  assert.ok(start >= 0 && review > start, "the walk reached the review step");
  for (const line of screen.slice(start, review).split("\n")) {
    assert.ok(displayWidth(line) <= columns, `"${line}" is too wide for the terminal`);
  }
});
