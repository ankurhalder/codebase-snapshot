import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { REPO_ROOT, runSuite } from "../scripts/test-run.mjs";
import { makeTempDir } from "./helpers/temp.js";

/**
 * The suite's own hygiene: a test may not create a scratch directory it never
 * removes, the command that runs the suite must confine the temp environment to a
 * root it deletes, and a leak that does happen must not survive the run.
 *
 * This exists because 616 leftover directories (about 600 MB) had accumulated in
 * the host temp directory. `agent-simulation.test.js` made two fixtures per run
 * and registered no cleanup, so every `npm test` left two more behind.
 */

const TESTS_DIR = path.join(REPO_ROOT, "tests");
const CLEANS_UP = /\b(?:rmSync|removeTree|makeTempDir)\s*\(/;

function javascriptFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...javascriptFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("no test creates a scratch directory it never removes", () => {
  const offenders = javascriptFiles(TESTS_DIR).filter((file) => {
    const text = fs.readFileSync(file, "utf8");
    return text.includes("mkdtempSync(") && !CLEANS_UP.test(text);
  });
  assert.deepEqual(
    offenders.map((file) => path.relative(REPO_ROOT, file)),
    [],
    "these files create a temp directory without removing it; use makeTempDir(t, prefix) from tests/helpers/temp.js"
  );
});

test("npm test runs the suite through the scratch-root wrapper", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /scripts\/test-run\.mjs/, "npm test must use the wrapper");
  assert.match(
    pkg.scripts["test:coverage"],
    /scripts\/test-run\.mjs/,
    "coverage runs must use the wrapper too"
  );
});

test("a scratch directory a child test leaves behind dies with the run", async (t) => {
  const project = makeTempDir(t, "cbs-hygiene-");
  const leaky = path.join(project, "leaky.test.js");
  fs.writeFileSync(
    leaky,
    [
      'import * as fs from "node:fs";',
      'import * as os from "node:os";',
      'import * as path from "node:path";',
      'import test from "node:test";',
      'test("leaves a scratch directory behind", () => {',
      '  fs.mkdtempSync(path.join(os.tmpdir(), "leaked-"));',
      "});",
      "",
    ].join("\n")
  );
  const result = await runSuite({ files: [leaky], cwd: project, stdio: "ignore" });
  assert.equal(result.code, 0, "the child suite passes");
  assert.ok(result.leftovers >= 1, "the child's directory landed inside the run's scratch root");
  assert.equal(result.removed, true, "the scratch root is removed");
  assert.equal(fs.existsSync(result.scratch), false, "nothing from the run remains");
});

test("the fixture-heavy generation suite leaves no scratch behind", async () => {
  // This file made one fixture per run with no cleanup: a single forgotten `repo()`
  // argument grew the host temp directory by a directory on every run. Run the file
  // in the wrapper and count what it leaves — the same count a leak would accumulate.
  const result = await runSuite({ files: ["tests/generation-truth.test.js"], stdio: "ignore" });
  assert.equal(result.code, 0, "the file passes on its own");
  assert.equal(
    result.leftovers,
    0,
    "every fixture that file created was removed; a leftover would grow on every run"
  );
  assert.equal(result.removed, true, "the scratch root is removed");
});
