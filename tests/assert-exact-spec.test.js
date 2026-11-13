import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as path from "node:path";
import test from "node:test";

import { readFileSync } from "node:fs";

/**
 * The deprecate/unpublish guard from the 0.9.16 audit (CI-02).
 *
 * `npm deprecate` and `npm unpublish` accept ranges, so the guard must accept only a release
 * version. A glob test is not a parse: `pkg@>=1.2.3` and `pkg@1.x.x` both have an `@` and two
 * dots.
 */

const name = JSON.parse(
  readFileSync(path.join(process.cwd(), "package.json"), "utf8")
).name;
const script = path.join(process.cwd(), "scripts", "assert-exact-spec.mjs");

const run = (spec) =>
  childProcess.spawnSync(process.execPath, [script, spec], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

test("exact versions, including a prerelease, are accepted", () => {
  for (const spec of [`${name}@1.2.3`, `${name}@1.2.3-rc.1`]) {
    const result = run(spec);
    assert.equal(result.status, 0, `${spec}: ${result.stderr}`);
  }
});

test("ranges, wildcards, tags and other packages are refused", () => {
  for (const spec of [
    `${name}@>=1.2.3`,
    `${name}@1.2.*`,
    `${name}@1.x.x`,
    `${name}@^1.2.3`,
    `${name}@~1.2.3`,
    `${name}@latest`,
    `${name}@1.2.3 || 2.0.0`,
    "other-package@1.2.3",
    `${name}`,
  ]) {
    const result = run(spec);
    assert.equal(result.status, 1, `${spec} must be refused`);
    assert.match(result.stderr, /::error::/, `${spec} must say why`);
  }
});
