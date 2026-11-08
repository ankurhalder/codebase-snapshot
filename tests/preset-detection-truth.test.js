import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { detectPreset, generateSnapshot } from "../dist/index.js";

/**
 * F1 / F2: preset detection must honour two documented promises in
 * `docs/configuration.md#project-presets`:
 *
 *   - "a Next.js app inside a pnpm workspace is still `nextjs`, not `monorepo`"
 *   - the `docs` preset's "≥ 3 markdown files and no `package.json`"
 *
 * Detection stays bounded: a workspace root looks one level into its packages,
 * and the markdown count walks at most two directories down. These tests build
 * small fixtures on disk and call `detectPreset` directly — no generation.
 */

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preset-truth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, relativePath, content = "") {
  const target = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

const detect = (dir) => detectPreset(dir);

test("F1: a Next.js app one workspace level down detects as nextjs, not monorepo", (t) => {
  const dir = makeRepo(t);
  write(dir, "package.json", JSON.stringify({ name: "root", private: true, packageManager: "pnpm@9.0.0" }));
  write(dir, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
  write(dir, "apps/web/package.json", JSON.stringify({ name: "web", dependencies: { next: "14.0.0", react: "18.0.0" } }));
  write(dir, "apps/web/next.config.js", "module.exports = {};\n");
  write(dir, "apps/web/app/page.tsx", "export default function Page() { return null; }\n");

  const detected = detect(dir);
  assert.equal(detected.presetName, "nextjs");
  assert.equal(detected.recommendedBudget, "300k", "the nextjs budget is the preset's, not monorepo's 200k");
});

test("F1: a workspace package with a Nuxt dependency detects as nuxt", (t) => {
  const dir = makeRepo(t);
  write(dir, "package.json", JSON.stringify({ name: "root", private: true }));
  write(dir, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
  write(dir, "apps/site/package.json", JSON.stringify({ name: "site", dependencies: { nuxt: "3.12.0" } }));

  assert.equal(detect(dir).presetName, "nuxt");
});

test("F1 control: a pnpm workspace without a framework app stays monorepo", (t) => {
  const dir = makeRepo(t);
  write(dir, "package.json", JSON.stringify({ name: "root", private: true }));
  write(dir, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
  write(dir, "apps/web/package.json", JSON.stringify({ name: "web" }));

  const detected = detect(dir);
  assert.equal(detected.presetName, "monorepo");
  assert.equal(detected.recommendedBudget, "200k");
});

test("F1 control: a root next.config.js still detects nextjs", (t) => {
  const dir = makeRepo(t);
  write(dir, "package.json", JSON.stringify({ name: "app", dependencies: { next: "14.0.0" } }));
  write(dir, "next.config.js", "module.exports = {};\n");

  assert.equal(detect(dir).presetName, "nextjs");
});

test("F2: markdown under docs/ counts towards the docs preset", (t) => {
  const dir = makeRepo(t);
  write(dir, "README.md", "# Project\n");
  write(dir, "docs/a.md", "# A\n");
  write(dir, "docs/b.md", "# B\n");
  write(dir, "docs/guide/c.md", "# C\n");

  const detected = detect(dir);
  assert.equal(detected.presetName, "docs");
  assert.equal(detected.recommendedBudget, "100k");
});

test("F2 control: fewer than three markdown files stays generic", (t) => {
  const dir = makeRepo(t);
  write(dir, "README.md", "# Project\n");
  write(dir, "docs/a.md", "# A\n");

  assert.equal(detect(dir).presetName, "generic");
});

test("F2 control: nested markdown with a package.json is not docs", (t) => {
  const dir = makeRepo(t);
  write(dir, "package.json", JSON.stringify({ name: "site", version: "1.0.0" }));
  write(dir, "README.md", "# Project\n");
  write(dir, "docs/a.md", "# A\n");
  write(dir, "docs/b.md", "# B\n");

  assert.equal(detect(dir).presetName, "node-lib");
});

test("F2 control: markdown inside node_modules or dist is not documentation", (t) => {
  const dir = makeRepo(t);
  write(dir, "README.md", "# Project\n");
  write(dir, "node_modules/pkg/README.md", "# dependency\n");
  write(dir, "dist/generated.md", "# build output\n");

  assert.equal(detect(dir).presetName, "generic");
});

// F2 regression: the tool's own output must never be counted as documentation.
// The markdown walk used to skip only the literal directory names `snapshot` and
// `snapshot.tmp`, so a custom `outDir` fed the previous run's README, parts and reports
// back into the docs preset's "three or more markdown files, no package.json" rule. A
// repository that detected as `generic` on run 1 detected as `docs` on run 2, which
// changed layers/kinds and even dropped a source `site/` directory.

test("F2 control: markdown in a tool-owned output directory is not documentation, whatever it is called", (t) => {
  const dir = makeRepo(t);
  write(dir, "main.c", "int main(void) { return 0; }\n");
  write(dir, "README.md", "# Project\n");
  // A previous run's output under a custom name: one real README plus parts and reports.
  for (const rel of [
    "README.md",
    "parts/part-001.md",
    "reports/audit.md",
    "reports/navigation.md",
    "reports/project-tree.md",
  ]) {
    write(dir, "context/" + rel, "# generated\n");
  }
  write(dir, "context/.codebase-snapshot", "{}");

  assert.equal(detect(dir).presetName, "generic");
});

test("F2 control: a tool-owned output directory two levels down is skipped too", (t) => {
  const dir = makeRepo(t);
  write(dir, "main.c", "int main(void) { return 0; }\n");
  write(dir, "README.md", "# Project\n");
  for (const rel of ["a.md", "b.md", "c.md"]) write(dir, "tools/context/" + rel, "# generated\n");
  write(dir, "tools/context/.codebase-snapshot", "{}");

  assert.equal(detect(dir).presetName, "generic");
});

test("F2 control: markdown in a plain directory is still documentation", (t) => {
  const dir = makeRepo(t);
  write(dir, "README.md", "# Project\n");
  for (const rel of ["a.md", "b.md", "c.md"]) write(dir, "generated/" + rel, "# notes\n");

  assert.equal(detect(dir).presetName, "docs", "the skip must require ownership evidence, not a name");
});

test("F2: a custom outDir does not change the preset or the parts on the second run", (t) => {
  const dir = makeRepo(t);
  write(dir, "main.c", "int main(void) { return 0; }\n");
  write(dir, "README.md", "# Project\n");
  write(dir, "site/page.md", "# A source page that is not the snapshot\n");

  const first = generateSnapshot({ cwd: dir, outDir: "context" });
  assert.equal(first.config.preset, "generic", "the first run has no output to mistake for docs");
  assert.ok(
    first.files.some((file) => file.relativePath === "site/page.md"),
    "the source page is in the first snapshot"
  );
  const partsFirst = fs
    .readdirSync(path.join(dir, "context", "parts"))
    .sort()
    .map((name) => fs.readFileSync(path.join(dir, "context", "parts", name)));

  const second = generateSnapshot({ cwd: dir, outDir: "context" });
  assert.equal(second.config.preset, "generic", "the tool's own output must not trigger the docs preset");
  assert.ok(
    second.files.some((file) => file.relativePath === "site/page.md"),
    "the docs preset's site/ exclusion must not fire on the second run"
  );
  assert.equal(second.fingerprint, first.fingerprint, "unchanged input keeps the fingerprint");
  const partsSecond = fs
    .readdirSync(path.join(dir, "context", "parts"))
    .sort()
    .map((name) => fs.readFileSync(path.join(dir, "context", "parts", name)));
  assert.deepEqual(partsSecond, partsFirst, "parts are byte-identical across runs");
});

test("F2: an absolute outDir inside the repository is excluded by the same evidence", (t) => {
  const dir = makeRepo(t);
  write(dir, "main.c", "int main(void) { return 0; }\n");
  write(dir, "README.md", "# Project\n");
  const outDir = path.join(dir, "llm-context");

  const first = generateSnapshot({ cwd: dir, outDir });
  assert.equal(first.config.preset, "generic");
  const second = generateSnapshot({ cwd: dir, outDir });
  assert.equal(second.config.preset, "generic", "an absolute outDir must be skipped like a relative one");
  assert.equal(second.fingerprint, first.fingerprint);
});
