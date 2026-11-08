import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { removeTree } from "../../scripts/test-run.mjs";

/**
 * Creates a temporary project for a test and removes it when the test finishes —
 * including when the test fails.
 *
 * A bare `fs.mkdtempSync` with no registered cleanup is how 616 directories and
 * about 600 MB accumulated in the host temp directory: one test made two fixtures
 * per run and removed neither. Pass the test's `t` so the removal belongs to the
 * test, not to its happy path.
 */
export function makeTempDir(t, prefix = "cbs-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => removeTree(dir));
  return dir;
}
