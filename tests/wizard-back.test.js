/**
 * Reversible questions in the wizard.
 *
 * The walk used to be one-way: no prompt accepted a back key, and answering "No" at the review
 * threw the same cancellation Ctrl+C does — so "that is not what I meant" ended the run instead of
 * letting you correct it. These tests drive real keypress events through the same fake TTY the rest
 * of the wizard suite uses, because the behaviour under test *is* the key handling.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createWizardProject, driveWizard, findConfigName } from "./helpers/wizard-harness.js";

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

test("the walk advertises the back key", async (t) => {
  const dir = createWizardProject(t, { prefix: "wizard-back-" });
  // pace → walk, then answer the scope question so the size prompt is the one on screen.
  const run = await driveWizard(dir, ["down", "return", "return", "return", "return", "return", "return"]);
  assert.match(run.screen, /← back/, "a reversible question says so in its footer");
  assert.equal(run.result.written, true);
});

test("back from the part size returns to the scope question and keeps the run alive", async (t) => {
  const dir = createWizardProject(t, { prefix: "wizard-back-" });
  const run = await driveWizard(dir, [
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
  assert.ok(findConfigName(dir), "the config was written after the detour");
});

test("answering No at the review steps back instead of cancelling", async (t) => {
  const dir = createWizardProject(t, { prefix: "wizard-back-" });
  const run = await driveWizard(dir, [
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
  assert.ok(findConfigName(dir));
});

test("back from the first walk question returns to the setup menu", async (t) => {
  const dir = createWizardProject(t, { prefix: "wizard-back-" });
  const run = await driveWizard(dir, [
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
