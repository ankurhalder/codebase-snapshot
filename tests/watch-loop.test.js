import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WATCH_SETTLE_MS,
  beginWatchRun,
  decideWatchEvent,
  finishWatchRun,
  initialWatchState,
  isGeneratedWatchPath,
} from "../dist/cli.js";

const root = path.join(os.tmpdir(), "codebase-snapshot-watch-loop-test");
const paths = {
  cwd: root,
  outDir: path.join(root, "docs"),
  tmpDir: path.join(root, "snapshot.tmp"),
};
const source = path.join(root, "src", "app.ts");
const nestedSource = path.join(root, "src", "docs", "nested.ts");

function scheduled(pathname, now = 0) {
  const decision = decideWatchEvent(initialWatchState(), { path: pathname, now }, paths);
  assert.equal(decision.action, "schedule");
  return decision.state;
}

test("W3: a source directory sharing the outDir basename is watched, generated paths are not", () => {
  assert.equal(isGeneratedWatchPath(source, paths), false);
  assert.equal(isGeneratedWatchPath(nestedSource, paths), false);
  assert.equal(isGeneratedWatchPath(path.join(paths.outDir, "parts", "part-001.md"), paths), true);
  assert.equal(isGeneratedWatchPath(path.join(paths.outDir, "parts"), paths), true);
  assert.equal(isGeneratedWatchPath(paths.outDir, paths), true);
  assert.equal(isGeneratedWatchPath(path.join(paths.tmpDir, "run-1", "parts"), paths), true);

  // The generated paths are ignored even when an event arrives inside the run.
  const running = beginWatchRun(initialWatchState());
  const generated = decideWatchEvent(running, {
    path: path.join(paths.outDir, "manifest.json"),
    now: 10,
  }, paths);
  assert.equal(generated.action, "ignore");
  assert.equal(generated.state.pending, false);

  // The nested source directory is not output merely because its basename is `docs`.
  const nested = decideWatchEvent(running, { path: nestedSource, now: 10 }, paths);
  assert.equal(nested.action, "pending");
  assert.equal(nested.state.pending, true);
});

test("W1: an edit during a run sets exactly one pending follow-up run", () => {
  let state = beginWatchRun(initialWatchState());
  const during = decideWatchEvent(state, { path: source, now: 10 }, paths);
  assert.equal(during.action, "pending");
  state = during.state;
  assert.equal(state.pending, true);

  // More edits during the same run do not queue more than one follow-up.
  state = decideWatchEvent(state, { path: nestedSource, now: 20 }, paths).state;
  assert.equal(state.pending, true);

  const finished = finishWatchRun(state, 30);
  assert.equal(finished.schedule, true);
  assert.equal(finished.state.pending, false);
  assert.equal(finished.state.running, false);

  // The follow-up run itself is not a reason to schedule another one.
  const second = finishWatchRun(finished.state, 40);
  assert.equal(second.schedule, false);
  assert.equal(second.state.pending, false);
});

test("W2: an edit inside the settle window still schedules a run", () => {
  const finished = finishWatchRun(initialWatchState(), 1_000).state;
  const inside = decideWatchEvent(finished, {
    path: source,
    now: 1_000 + WATCH_SETTLE_MS - 1,
  }, paths);
  assert.equal(inside.action, "schedule");

  // Generated writes inside the same window remain silent.
  const generated = decideWatchEvent(finished, {
    path: path.join(paths.outDir, "parts", "part-001.md"),
    now: 1_000 + WATCH_SETTLE_MS - 1,
  }, paths);
  assert.equal(generated.action, "ignore");
});

test("generated output, staging and backup paths are ignored", () => {
  assert.equal(isGeneratedWatchPath(path.join(paths.outDir, "parts", "part-002.md"), paths), true);
  assert.equal(isGeneratedWatchPath(path.join(paths.tmpDir, "run-2", "parts"), paths), true);
  assert.equal(isGeneratedWatchPath(`${paths.outDir}.backup-123-456`, paths), true);
  assert.equal(isGeneratedWatchPath(path.join(paths.outDir, "parts", "..", "README.md"), paths), true);
  assert.equal(isGeneratedWatchPath(path.join(root, ".git", "index"), paths), true);
  assert.equal(isGeneratedWatchPath(path.join(root, "src", "docs", "nested.ts"), paths), false);
});

test("unattributed watcher events are ignored only while running or settling", () => {
  const running = decideWatchEvent(beginWatchRun(initialWatchState()), { path: null, now: 10 }, paths);
  assert.equal(running.action, "ignore");

  const finished = finishWatchRun(initialWatchState(), 1_000).state;
  const settling = decideWatchEvent(finished, { path: null, now: 1_000 + WATCH_SETTLE_MS - 1 }, paths);
  assert.equal(settling.action, "ignore");

  const settled = decideWatchEvent(finished, { path: null, now: 1_000 + WATCH_SETTLE_MS }, paths);
  assert.equal(settled.action, "schedule");
});

test("a debounced follow-up is scheduled once after a run finishes", () => {
  const pending = decideWatchEvent(
    beginWatchRun(initialWatchState()),
    { path: source, now: 10 },
    paths
  ).state;
  const finished = finishWatchRun(pending, 20);
  assert.equal(finished.schedule, true);
  assert.equal(finishWatchRun(finished.state, 30).schedule, false);
});
