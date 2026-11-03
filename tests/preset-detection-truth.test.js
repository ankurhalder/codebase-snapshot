import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { detectPreset } from "../dist/index.js";

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
