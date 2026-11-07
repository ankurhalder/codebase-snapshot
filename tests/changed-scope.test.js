import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, resolveChangedScope, resolveConfig } from "../dist/index.js";
import { explainPath, validateSnapshot } from "../dist/index.js";

/**
 * Diff-scoped snapshots, from the 0.9.9 audit.
 *
 * Reviewing a pull request with a model is the case this exists for: the diff is small, the
 * repository is not, and packing all of it costs a context window to answer a question about
 * four files. The failure mode that matters is the quiet one — a ref typo that produces an
 * empty snapshot reads as "this change touched nothing", so every error here is loud.
 */

function git(dir, args) {
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], {
    cwd: dir,
    stdio: "ignore",
  });
}

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changed-scope-"));
  const write = (relative, content) => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  };
  write("package.json", '{"name":"fixture","version":"1.0.0"}\n');
  write("src/used.ts", "export const used = 1;\n");
  write("src/importer.ts", 'import { used } from "./used.js";\nexport const i = used;\n');
  write("src/untouched.ts", "export const untouched = 1;\n");

  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "first"]);

  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, write };
}

const configFor = (dir, extra) =>
  resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", ...extra });

test("only changed files, and untracked ones, are included", (t) => {
  const { dir, write } = makeRepo(t);
  write("src/used.ts", "export const used = 2;\n");
  write("src/brand-new.ts", "export const fresh = 3;\n");

  const manifest = generateSnapshot(configFor(dir, { changedSince: "HEAD" }));
  const included = manifest.files.map((file) => file.relativePath).sort();

  assert.deepEqual(included, ["src/brand-new.ts", "src/used.ts"]);
  const unchanged = manifest.skipped.filter((entry) => entry.reason === "unchanged");
  assert.deepEqual(
    unchanged.map((entry) => entry.path).sort(),
    ["package.json", "src/importer.ts", "src/untouched.ts"],
    "the files that did not move are accounted for, with their own reason"
  );
  assert.ok(unchanged.every((entry) => /changed since HEAD/.test(String(entry.detail))));
});

test("--staged takes the index, not the working tree", (t) => {
  const { dir, write } = makeRepo(t);
  write("src/used.ts", "export const used = 2;\n");
  git(dir, ["add", "src/used.ts"]);
  write("src/untouched.ts", "export const untouched = 99;\n"); // unstaged

  const manifest = generateSnapshot(configFor(dir, { staged: true }));

  assert.deepEqual(manifest.files.map((file) => file.relativePath), ["src/used.ts"]);
});

test("--with-dependents adds the files that import a changed one", (t) => {
  const { dir, write } = makeRepo(t);
  write("src/used.ts", "export const used = 2;\n");

  const plain = generateSnapshot(configFor(dir, { changedSince: "HEAD" }));
  assert.deepEqual(plain.files.map((file) => file.relativePath), ["src/used.ts"]);

  const widened = generateSnapshot(
    configFor(dir, { changedSince: "HEAD", withDependents: true })
  );
  assert.deepEqual(
    widened.files.map((file) => file.relativePath).sort(),
    ["src/importer.ts", "src/used.ts"],
    "the importer is what makes the change safe to review"
  );
  // A file that imports nothing has no dependents to add.
  assert.ok(
    widened.skipped.some((entry) => entry.path === "src/untouched.ts" && entry.reason === "unchanged")
  );
});

test("resolveChangedScope reports what it compared", (t) => {
  const { dir, write } = makeRepo(t);
  write("src/used.ts", "export const used = 2;\n");

  const scope = resolveChangedScope(dir, { changedSince: "HEAD" });
  assert.deepEqual([...scope.paths], ["src/used.ts"]);
  assert.equal(scope.detail, "changed since HEAD");
});

test("a ref that does not exist is an error naming the ref", (t) => {
  const { dir } = makeRepo(t);

  assert.throws(
    () => generateSnapshot(configFor(dir, { changedSince: "no-such-ref" })),
    /no-such-ref[\s\S]*without --changed-since/
  );
});

test("a directory that is not a git repository is an error, not an empty snapshot", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changed-nogit-"));
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.throws(() => generateSnapshot(configFor(dir, { changedSince: "HEAD" })), /git/);
});

test("--with-dependents without a scope is a configuration error", () => {
  assert.throws(
    () => resolveConfig({ cwd: process.cwd(), withDependents: true }),
    /needs `changedSince` or `staged`/
  );
});

test("an empty scope warns instead of looking like a success", (t) => {
  const { dir } = makeRepo(t);

  const manifest = generateSnapshot(configFor(dir, { changedSince: "HEAD" }));

  assert.equal(manifest.files.length, 0, "nothing changed, so nothing is included");
  assert.ok(
    manifest.warnings.some((warning) => /No file is changed since HEAD/.test(warning)),
    `the empty snapshot must explain itself: ${JSON.stringify(manifest.warnings)}`
  );
});

// ---------------------------------------------------------------------------
// 0.9.11 — the changed-files scope, after the audit that found it was applied
// one layer too late.
// ---------------------------------------------------------------------------

const scopedOptions = (dir, extra = {}) => ({
  cwd: dir,
  outDir: "snapshot",
  tmpDir: "snapshot.tmp",
  changedSince: "HEAD",
  ...extra,
});

test("validate accepts a snapshot generated with a changed-files scope", (t) => {
  const { dir, write } = makeRepo(t);
  write("src/used.ts", "export const used = 2;\n");

  generateSnapshot(scopedOptions(dir));
  const result = validateSnapshot(scopedOptions(dir));

  // Every unchanged file is valid text, so the old verdict — "the snapshot does not contain this
  // file and it would be included now" — was reached for every file in the repository, and
  // `validate` exited 1 on every snapshot built with --changed-since.
  assert.deepEqual(
    result.drift.missingInSnapshot,
    [],
    "a file the scope excluded is not a file the snapshot forgot"
  );
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("validate still reports a file that changed after the snapshot was taken", (t) => {
  const { dir, write } = makeRepo(t);
  write("src/used.ts", "export const used = 2;\n");
  generateSnapshot(scopedOptions(dir));

  // Now it is inside the recorded scope and the snapshot predates it: real drift.
  write("src/untouched.ts", "export const untouched = 2;\n");
  const result = validateSnapshot(scopedOptions(dir));

  assert.deepEqual(result.drift.missingInSnapshot, ["src/untouched.ts"]);
  assert.equal(result.valid, false);
});

test("explain does not call a file outside the changed scope included", (t) => {
  const { dir, write } = makeRepo(t);
  write("src/used.ts", "export const used = 2;\n");
  const config = resolveConfig(scopedOptions(dir));

  const outside = explainPath(config, "src/untouched.ts");
  assert.equal(outside.included, false, "generate would not emit this file");
  assert.equal(outside.reason, "unchanged");
  assert.match(String(outside.detail), /changed since HEAD/);

  const inside = explainPath(config, "src/used.ts");
  assert.equal(inside.included, true);
});

test("a scoped snapshot's counts describe the snapshot, not the repository", (t) => {
  const { dir, write } = makeRepo(t);
  // Everything below is committed and then left alone, so the run must never look at it.
  write("src/leaky.ts", 'const API_KEY = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
  write("docs/huge.md", "# big\n" + "x".repeat(4096) + "\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "background"]);
  write("src/used.ts", "export const used = 2;\n");

  const manifest = generateSnapshot(scopedOptions(dir, { largeFileBytes: 512 }));

  assert.deepEqual(manifest.files.map((file) => file.relativePath), ["src/used.ts"]);
  const layerTotal = Object.values(manifest.layers).reduce((total, count) => total + count, 0);
  const kindTotal = Object.values(manifest.kinds).reduce((total, count) => total + count, 0);
  assert.equal(layerTotal, manifest.files.length, "layers must count what is in the snapshot");
  assert.equal(kindTotal, manifest.files.length, "kinds must count what is in the snapshot");
  assert.equal(
    manifest.counts.largeFileCount,
    0,
    "the 4 KB file is outside the scope, so it is not a large file in this snapshot"
  );
  assert.equal(
    manifest.totals.redactedLines,
    0,
    "a secret in a file that is not in the snapshot is not a finding of this run"
  );
});

test("files outside the scope are never read", (t) => {
  const { dir, write } = makeRepo(t);
  // Latin-1 bytes produce a per-file encoding note — but only for a file that is opened.
  write("src/latin1.ts", Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0xe9, 0x3b, 0x0a]));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "latin1"]);
  write("src/used.ts", "export const used = 2;\n");

  const unscoped = generateSnapshot(configFor(dir));
  assert.ok(
    unscoped.warnings.some((warning) => warning.includes("src/latin1.ts")),
    "the fixture is only useful if a full scan really does notice it"
  );

  const scoped = generateSnapshot(scopedOptions(dir));
  assert.ok(
    !scoped.warnings.some((warning) => warning.includes("src/latin1.ts")),
    `a file the scope removed must never be decoded: ${JSON.stringify(scoped.warnings)}`
  );
});

test("--with-dependents is one hop, not a transitive walk", (t) => {
  const { dir, write } = makeRepo(t);
  // a <- m <- z, in alphabetical order, which is the order that made the old code walk the
  // graph: `m` joined the keep-set, so `z` then matched *that* and joined too.
  write("src/a.ts", "export const a = 1;\n");
  write("src/m.ts", 'import { a } from "./a.js";\nexport const m = a;\n');
  write("src/z.ts", 'import { m } from "./m.js";\nexport const z = m;\n');
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "chain"]);
  write("src/a.ts", "export const a = 2;\n");

  const manifest = generateSnapshot(scopedOptions(dir, { withDependents: true }));

  assert.deepEqual(
    manifest.files.map((file) => file.relativePath).sort(),
    ["src/a.ts", "src/m.ts"],
    "src/z.ts is two hops away and must not be pulled in"
  );
});

test("a ref that git would read as an option is refused", (t) => {
  const { dir } = makeRepo(t);

  // The ref is the one caller-controlled argument in git's command line, and a committed config
  // can supply it: `--output=…` reached git as a flag.
  assert.throws(
    () => resolveChangedScope(dir, { changedSince: "--output=/tmp/side-effect" }),
    /must be a git ref, not an option/
  );
});

test("--skeleton keeps the whole body in the monolith", (t) => {
  const { dir, write } = makeRepo(t);
  write("src/calc.ts", "export function compute(): number {\n  return 41 + 1;\n}\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "calc"]);
  write("src/calc.ts", "export function compute(): number {\n  return 42;\n}\n");

  const manifest = generateSnapshot(
    scopedOptions(dir, { skeleton: true, includeMonolith: true })
  );

  const partEntry = manifest.files.find((file) => file.relativePath === "src/calc.ts");
  assert.equal(partEntry.inclusionMode, "signatures", "the parts carry the skeleton");

  const monolith = JSON.parse(
    fs.readFileSync(path.join(dir, "snapshot", "full-codebase.json"), "utf8")
  );
  const entry = monolith.files.find((file) => file.relativePath === "src/calc.ts");
  assert.equal(entry.inclusionMode, "full");
  assert.match(
    entry.content,
    /return 42/,
    "the monolith is documented as the whole codebase, so it cannot hold the stripped body"
  );
});
