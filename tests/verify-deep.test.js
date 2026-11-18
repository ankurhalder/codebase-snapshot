/**
 * The deep gate itself: generate, audit against the source, validate, prove coverage and prove
 * reproducibility. This is the composition npm run verify:deep runs after the normal gate.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "verify-deep.mjs");

test("verify-deep passes on a clean repository", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-deep-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "import { a } from './a.js';\nexport const b = a;\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "snapshot/\nsnapshot.tmp/\n");
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (git(["init", "-q"]).status !== 0) {
    t.skip("git is not available");
    return;
  }
  git(["-c", "user.email=t@e.c", "-c", "user.name=T", "add", "-A"]);
  git(["-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "fixture"]);

  const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
  const out = (result.stdout ?? "") + (result.stderr ?? "");
  assert.equal(result.status, 0, out);
  assert.match(out, /verify-deep: health \d+\/100/);
  assert.match(out, /verify-deep: okay/);
});
