import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isGeneratedWatchPath } from "../dist/cli.js";
import {
  collectFiles,
  findSecretInPath,
  globToRegExp,
  matchesExclude,
  resolveConfig,
} from "../dist/index.js";

/**
 * Discovery parity, tool-owned leftovers, and the two caches the scanner was missing.
 *
 * The failure mode behind most of this file is the same one: `git` mode and `walk` mode answer the
 * same question with different rules, so one repository produces two different snapshots depending
 * on which enumeration ran. A snapshot tool whose output depends on an unrelated flag is not
 * reproducible, which is the one property the whole design is built on.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-parity-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** True when this machine lets the test process create symlinks (Windows needs a privilege). */
function canSymlink(root) {
  const probe = path.join(root, ".symlink-probe");
  try {
    fs.symlinkSync(path.join(root, "package.json"), probe, "file");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

const gitConfig = (root) =>
  resolveConfig({ cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", discovery: "git" }, {}, root);
const walkConfig = (root) =>
  resolveConfig({ cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", discovery: "walk" }, {}, root);

/** The `files`/`skipped` pair for one discovery mode, in a comparable form. */
function collect(root, discovery) {
  const result = collectFiles(root, { discovery, toolOwnedPaths: ["snapshot", "snapshot.tmp"] });
  const reasons = new Map(result.skipped.map((record) => [record.path, record.reason]));
  return { files: [...result.files].sort(), reasons };
}

test(
  "git and walk agree about file symlinks and broken symlinks",
  { skip: !gitAvailable },
  (t) => {
    // `dropLinkedDirectories` tested `depth <= parts.length`, so a *file* symlink was reported as a
    // `symlink` skip in `git` mode while `walkDirectory` followed it and emitted the file. And
    // because `targetReal` was initialised to the link's own path, a broken link that pointed
    // outside the root was inside the root by that comparison, so it was filed as `symlink`
    // instead of `read-error`/`outside-root`.
    const root = makeRepo(t, {
      "package.json": '{"name":"fixture","version":"1.0.0"}\n',
      "src/real.ts": "export const real = 1;\n",
    });
    if (!canSymlink(root)) {
      t.skip("this machine cannot create symlinks");
      return;
    }
    fs.symlinkSync(path.join(root, "src", "real.ts"), path.join(root, "src", "link.ts"), "file");
    fs.symlinkSync(
      path.join(root, "..", "gone", "nothing.ts"),
      path.join(root, "src", "broken.ts"),
      "file"
    );

    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "core.symlinks", "true"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });

    const viaGit = collect(root, "git");
    const viaWalk = collect(root, "walk");

    assert.deepEqual(
      viaGit.files,
      viaWalk.files,
      "the same repository must enumerate the same files either way"
    );
    assert.equal(
      viaGit.reasons.get("src/link.ts") ?? null,
      viaWalk.reasons.get("src/link.ts") ?? null,
      "an in-root file symlink is either a file or a skip in both modes, never one of each"
    );
    assert.equal(
      viaGit.reasons.get("src/broken.ts") ?? null,
      viaWalk.reasons.get("src/broken.ts") ?? null,
      "a broken symlink is reported with one reason, not two"
    );
    // A link that resolves outside the root is the security-relevant answer, and both modes
    // must give it rather than one of them inventing `symlink`.
    assert.equal(viaWalk.reasons.get("src/broken.ts"), "outside-root");
  }
);

test("leftovers of a custom outDir are never scanned back in", (t) => {
  // `defaultIgnoreReason` and the walker both hardcoded `snapshot.backup-`, and
  // `isGeneratedWatchPath` knew only `.backup-`. With `outDir: ".context"` a crashed swap left
  // `.context.backup-<pid>-<ts>` — which is a copy of the previous snapshot, not the user's source
  // — to be picked up by the next run. In `--watch` the `EXDEV` `.partial-` copy also fed the
  // watcher, which saw its own output as an edit and regenerated forever.
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/app.ts": "export const app = 1;\n",
    ".context.backup-4242-1700000000000/parts/part-001.md": "# old snapshot\n",
    ".context.partial-4242-1700000000001/parts/part-001.md": "# half-swapped\n",
    "snapshot.backup-1-2/parts/part-001.md": "# default name\n",
  });

  const config = resolveConfig(
    { cwd: root, outDir: ".context", tmpDir: ".context.tmp", discovery: "walk" },
    {},
    root
  );
  const result = collectFiles(root, {
    discovery: "walk",
    toolOwnedPaths: [".context", ".context.tmp"],
  });

  const leftovers = result.files.filter((file) => file.includes(".backup-") || file.includes(".partial-"));
  assert.deepEqual(leftovers, [], `no leftover directory may be scanned: ${leftovers.join(", ")}`);
  assert.ok(result.files.includes("src/app.ts"), "real source is unaffected");
  assert.ok(
    result.skipped.some((record) => record.path.startsWith(".context.backup-")),
    "a leftover is recorded as skipped rather than vanishing without a trace"
  );
  assert.equal(config.outDir, ".context");

  // The watcher has to ignore exactly the directories the swapper creates, or `--watch` feeds on
  // its own writes.
  const paths = { cwd: root, outDir: ".context", tmpDir: ".context.tmp" };
  assert.equal(isGeneratedWatchPath(".context.backup-9-9/parts/part-001.md", paths), true);
  assert.equal(isGeneratedWatchPath(".context.partial-9-9/parts/part-001.md", paths), true);
  assert.equal(isGeneratedWatchPath("src/app.ts", paths), false);
});

test("secrets.disableDefaultPatterns applies to paths, not just to content", (t) => {
  // `pathScanRules` returned `[...DEFAULT_SECRET_PATTERNS, ...extraRules]`, but `config.secretRules`
  // *already* starts with those patterns — so every path and every AST-summary string ran all 30
  // built-in rules twice, and the "defaults are off" switch had no effect on them at all.
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "aws_AKIAIOSFODNN7EXAMPLE.ts": "export const x = 1;\n",
  });

  const withDefaults = resolveConfig(
    { cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", discovery: "walk" },
    {},
    root
  );
  const skippedWithDefaults = collectFiles(root, {
    discovery: "walk",
    secretRules: withDefaults.secretRules,
  });
  assert.equal(
    skippedWithDefaults.files.includes("aws_AKIAIOSFODNN7EXAMPLE.ts"),
    false,
    "a credential-shaped filename is skipped by default"
  );

  const withoutDefaults = resolveConfig(
    {
      cwd: root,
      outDir: "snapshot",
      tmpDir: "snapshot.tmp",
      discovery: "walk",
      secrets: { disableDefaultPatterns: true },
    },
    {},
    root
  );
  assert.equal(withoutDefaults.secretRules.length, 0, "the switch really leaves no rules");
  const skippedWithout = collectFiles(root, {
    discovery: "walk",
    secretRules: withoutDefaults.secretRules,
  });
  assert.equal(
    skippedWithout.files.includes("aws_AKIAIOSFODNN7EXAMPLE.ts"),
    true,
    "with the defaults off, the default rules must not fire on a path either"
  );
});

test("a malformed character range in configuration is a named error", () => {
  // `new RegExp("[z-a]")` throws, and `matchesExclude` compiled with no guard — so one out-of-order
  // range in an exclude pattern, a layer rule or a preset killed the scan with a raw SyntaxError
  // that named neither the pattern nor the file. A glob that cannot work is a configuration
  // mistake, so it is reported as one (rule 1) instead of quietly matching nothing.
  assert.throws(() => matchesExclude("a.ts", "[z-a].ts"), /"\[z-a\]\.ts" is not a valid glob/);
  assert.throws(() => globToRegExp("[z-a]"), /not a valid glob/);
  // A well-formed class still behaves.
  assert.equal(matchesExclude("a.ts", "[a-c].ts"), true);
});

test("a malformed class in .gitignore does not stop the walk", (t) => {
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    ".gitignore": "[z-a].txt\n",
    "kept.ts": "export const kept = 1;\n",
  });
  const result = collectFiles(root, { discovery: "walk" });
  assert.ok(result.files.includes("kept.ts"), "the walk still returns the files it can read");
});

test("glob patterns compile once, not once per file", () => {
  // `globToRegExp` built a fresh RegExp on every call, and `matchesExclude` calls it for every
  // (file, pattern) pair — over a million compilations on a 20 000-file repository with 40
  // patterns. Compiling is pure, so the result is cached and the same object comes back.
  assert.equal(globToRegExp("**/*.ts"), globToRegExp("**/*.ts"), "the same glob is one RegExp");
  assert.notEqual(globToRegExp("**/*.ts"), globToRegExp("**/*.tsx"), "different globs differ");
});

test("the path scan rules are not rebuilt on every call", () => {
  // The observable half of the duplication is covered above (`disableDefaultPatterns`); the cost
  // half has no behavioural signal at all — the work is the same work, done twice — so the
  // invariant is asserted against the source. `pathScanRules` must not mention the built-in list.
  const source = fs.readFileSync(path.join(HERE, "..", "src", "scanner", "files.ts"), "utf8");
  const body = source.slice(
    source.indexOf("function pathScanRules"),
    source.indexOf("export function findSecretInPath")
  );
  assert.ok(body.length > 0, "the helper is still there");
  assert.equal(
    body.includes("DEFAULT_SECRET_PATTERNS"),
    false,
    "pathScanRules must not prepend the built-in rules to a list that already contains them"
  );

  // And the rules actually used are exactly the caller's, so a custom rule still applies.
  const custom = [{ rule: "custom", pattern: /hunter2/ }];
  const hit = findSecretInPath("hunter2.txt", custom);
  assert.deepEqual(hit?.rules, ["custom"]);
  assert.ok(hit?.masked.startsWith("[REDACTED"), `masked to a marker: ${hit?.masked}`);
  assert.ok(hit?.masked.endsWith(".txt"), "and the surrounding name survives");
});
