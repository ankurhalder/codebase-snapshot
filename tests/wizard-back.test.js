/**
 * Reversible questions in the wizard.
 *
 * The walk used to be one-way: no prompt accepted a back key, and answering "No" at the review
 * threw the same cancellation Ctrl+C does — so "that is not what I meant" ended the run instead of
 * letting you correct it. These tests drive real keypress events through the same fake TTY the rest
 * of the wizard suite uses, because the behaviour under test *is* the key handling.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runInit } from "../dist/index.js";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function makeProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wizard-back-"));
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

/** Runs the wizard, pressing one key per redrawn prompt, and returns what it wrote. */
async function drive(dir, keys) {
  const pending = [...keys];
  const written = [];

  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 120;
  output.on("data", (chunk) => {
    const text = chunk.toString();
    written.push(text);
    if (!text.includes("◆")) return;
    if (pending.length === 0) return;
    const name = pending.shift();
    queueMicrotask(() => input.emit("keypress", "", { name }));
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

  const result = await Promise.race([run, timeout]);
  assert.deepEqual(pending, [], "every programmed key was consumed");
  return { result, screen: written.join("").replace(ANSI, "") };
}

const configName = (dir) =>
  fs.readdirSync(dir).find((name) => /^snapshot\.config\.(ts|mjs|cjs|js|json)$/.test(name));

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

test("the walk advertises the back key", async (t) => {
  const dir = makeProject(t);
  // pace → walk, then answer the scope question so the size prompt is the one on screen.
  const run = await drive(dir, ["down", "return", "return", "return", "return", "return", "return"]);
  assert.match(run.screen, /← back/, "a reversible question says so in its footer");
  assert.equal(run.result.written, true);
});

test("back from the part size returns to the scope question and keeps the run alive", async (t) => {
  const dir = makeProject(t);
  const run = await drive(dir, [
    "down", // pace → "go through each setting"
    "return", // select walk
    "return", // scope: everything
    "left", // back out of the size question
    "return", // scope again
    "return", // size, default
    "return", // artifacts
    "return", // credentials
    "return", // review → yes
  ]);

  assert.equal(
    countOf(run.screen, "What should go into the snapshot?"),
    2,
    "the scope question is asked again after backing out of the size question"
  );
  assert.equal(run.result.written, true);
  assert.ok(configName(dir), "the config was written after the detour");
});

test("answering No at the review steps back instead of cancelling", async (t) => {
  const dir = makeProject(t);
  const run = await drive(dir, [
    "down",
    "return", // walk
    "return", // scope
    "return", // size
    "return", // artifacts
    "return", // credentials
    "n", // review → "No"
    "return", // confirm No
    "return", // credentials again
    "return", // review → yes
  ]);

  assert.equal(run.result.written, true, "the run survives the No");
  assert.equal(countOf(run.screen, "Include credential files"), 2, "it returns to the previous question");
  assert.ok(configName(dir));
});

test("back from the first walk question returns to the setup menu", async (t) => {
  const dir = makeProject(t);
  const run = await drive(dir, [
    "down", // pace → walk
    "return", // select walk
    "left", // back out of the first step
    "return", // take the recommended path instead
  ]);

  // Counting occurrences counts redraws: the frame is repainted on every keypress. What matters is
  // the order — the setup menu is asked again *after* the walk's first question.
  const lastPace = run.screen.lastIndexOf("How should I set this up?");
  const scopeAt = run.screen.indexOf("What should go into the snapshot?");
  assert.ok(
    scopeAt >= 0 && lastPace > scopeAt,
    "backing out of the first step returns to the setup menu"
  );
  assert.equal(countOf(run.screen, "Review"), 0, "the walk was abandoned, not restarted at its end");
  assert.equal(run.result.written, true);
  assert.equal(run.result.preset, "nextjs", "the recommended path still detects the project");
});
