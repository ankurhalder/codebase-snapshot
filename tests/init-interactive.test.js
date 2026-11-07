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
import * as path from "node:path";
import test from "node:test";

import { createWizardProject, driveWizard, findConfigName } from "./helpers/wizard-harness.js";

test("the recommended setup is one keystroke, and it says what it detected", async (t) => {
  const dir = createWizardProject(t, {
    files: {
      "package.json": '{"name":"app","version":"1.0.0"}\n',
      "next.config.ts": "export default {};\n",
      "src/a.ts": "export const a = 1;\n",
    },
  });

  const run = await driveWizard(dir, ["return"]);

  assert.match(run.screen, /Detected\s+nextjs/);
  assert.match(run.screen, /Because\s+next\.config\.ts/);
  assert.equal(run.result.written, true);
  assert.equal(run.result.preset, "nextjs");
  assert.equal(run.result.reason, "next.config.ts");
  assert.equal(run.result.fallback, false);
  assert.ok(findConfigName(dir), "a config was written");

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  assert.equal(pkg.scripts.snapshot, "npx codebase-snapshot generate");
  assert.match(String(pkg.devDependencies["codebase-snapshot"]), /^\^\d+\.\d+\.\d+$/);
});

test("a project it cannot recognise is asked about, not guessed at", async (t) => {
  const dir = createWizardProject(t, { files: { "notes.md": "# notes\n" } });

  // The default on the preset list is `generic`, so this is "I cannot tell, use the fallback".
  const run = await driveWizard(dir, ["return", "return"]);

  assert.match(run.screen, /Could not tell what kind of project this is/);
  assert.match(run.screen, /No package\.json, go\.mod/);
  assert.equal(run.result.written, true);
  assert.equal(run.result.preset, "generic");
});

test("walking through every setting accepts a default at each step", async (t) => {
  const dir = createWizardProject(t, {
    files: {
      "package.json": '{"name":"app","version":"1.0.0"}\n',
      "src/a.ts": "export const a = 1;\n",
    },
  });

  // pace ↓⏎ · scope ⏎ · size ⏎ · artifacts ⏎ · credentials ⏎ · review ⏎
  const run = await driveWizard(dir, ["down", "return", "return", "return", "return", "return", "return"]);

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
  const dir = createWizardProject(t, {
    files: {
      "package.json": '{"name":"app","version":"1.0.0"}\n',
      "next.config.ts": "export default {};\n",
      "src/a.ts": "export const a = 1;\n",
    },
  });

  // Walk through and accept everything: Next.js recommends 300 KB, so that is what gets written.
  const run = await driveWizard(dir, ["down", "return", "return", "return", "return", "return", "return"]);

  assert.equal(run.result.written, true);
  assert.equal(run.result.preset, "nextjs");
  const config = fs.readFileSync(path.join(dir, findConfigName(dir)), "utf8");
  assert.match(config, /300\s*\*\s*1024|307200|"300k"/, "the detected budget survived the wizard");
});
