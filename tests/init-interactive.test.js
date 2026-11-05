/**
 * The guided first run, driven without a real terminal.
 *
 * `runInit` takes its streams from `PromptIO`, and the prompt layer only needs two things
 * from them: `isTTY` and `keypress` events. A `PassThrough` with `isTTY` set therefore drives
 * the whole wizard, which is how the most important interaction of 0.9.2 — pressing enter on
 * the recommended setup — gets a test instead of a manual checklist.
 *
 * One key is released per prompt, on the prompt's own repaint (the `◆` header). Releasing keys
 * on any write would fire during the previous prompt's erase, land in a reader that is about
 * to close, and hang the run.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runInit } from "../dist/index.js";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function makeProject(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wizard-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs the wizard with `keys` pressed, one per prompt, and returns what it wrote. */
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

test("the recommended setup is one keystroke, and it says what it detected", async (t) => {
  const dir = makeProject(t, {
    "package.json": '{"name":"app","version":"1.0.0"}\n',
    "next.config.ts": "export default {};\n",
    "src/a.ts": "export const a = 1;\n",
  });

  const run = await drive(dir, ["return"]);

  assert.match(run.screen, /Detected\s+nextjs/);
  assert.match(run.screen, /Because\s+next\.config\.ts/);
  assert.equal(run.result.written, true);
  assert.equal(run.result.preset, "nextjs");
  assert.equal(run.result.reason, "next.config.ts");
  assert.equal(run.result.fallback, false);
  assert.ok(configName(dir), "a config was written");

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.snapshot, "npx codebase-snapshot generate");
  assert.match(String(pkg.devDependencies["codebase-snapshot"]), /^\^\d+\.\d+\.\d+$/);
});

test("a project it cannot recognise is asked about, not guessed at", async (t) => {
  const dir = makeProject(t, { "notes.md": "# notes\n" });

  // The default on the preset list is `generic`, so this is "I cannot tell, use the fallback".
  const run = await drive(dir, ["return", "return"]);

  assert.match(run.screen, /Could not tell what kind of project this is/);
  assert.match(run.screen, /No package\.json, go\.mod/);
  assert.equal(run.result.written, true);
  assert.equal(run.result.preset, "generic");
});

test("walking through every setting accepts a default at each step", async (t) => {
  const dir = makeProject(t, {
    "package.json": '{"name":"app","version":"1.0.0"}\n',
    "src/a.ts": "export const a = 1;\n",
  });

  // pace ↓⏎ · scope ⏎ · size ⏎ · artifacts ⏎ · credentials ⏎ · review ⏎
  const run = await drive(dir, ["down", "return", "return", "return", "return", "return", "return"]);

  assert.match(run.screen, /What should go into the snapshot/);
  assert.match(run.screen, /How large should each part be/);
  assert.match(run.screen, /Which artifacts should be generated/);
  assert.match(run.screen, /Include credential files/);
  assert.match(run.screen, /Review/);
  assert.equal(run.result.written, true);
  assert.equal(run.result.preset, "node-lib");
  assert.equal(run.result.reason, "package.json");
});

test("the part-size question starts on the preset's recommended budget", async (t) => {
  const dir = makeProject(t, {
    "package.json": '{"name":"app","version":"1.0.0"}\n',
    "next.config.ts": "export default {};\n",
    "src/a.ts": "export const a = 1;\n",
  });

  // Walk through and accept everything: Next.js recommends 300 KB, so that is what gets written.
  const run = await drive(dir, ["down", "return", "return", "return", "return", "return", "return"]);

  assert.equal(run.result.written, true);
  assert.equal(run.result.preset, "nextjs");
  const config = fs.readFileSync(path.join(dir, configName(dir)), "utf8");
  assert.match(config, /300\s*\*\s*1024|307200|"300k"/, "the detected budget survived the wizard");
});
