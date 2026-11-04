/**
 * Scanner/init fixes from the real-repository audit (track 5).
 *
 * Item 13 — `.gitignore` escapes were ignored in `walk` mode. The parser took the
 * first character of the line as meaningful, so `\#hashfile.ts` and `\!bangfile.ts`
 * were treated as a comment and a negation, and the matcher normalised every
 * backslash to a path separator, so `spaced\ .ts` became `spaced/ .ts`. Git
 * ignored all three; a `walk` scan included all three.
 *
 * Item 14 — `init` wrote `branch: "main"` unconditionally. It now records the
 * repository's actual branch, with "main" kept only as the fallback the
 * generator already uses when git cannot report one.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { generateSnapshot, resolveConfig, runInit } from "../dist/index.js";

function makeRepo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-init-"));
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  write("package.json", '{"name":"scanner-init","private":true}\n');
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** No `.git` in the fixture, so `discovery: "auto"` resolves to the plain walk. */
function walkSnapshot(dir) {
  const config = resolveConfig({
    cwd: dir,
    outDir: "snapshot",
    tmpDir: "snapshot.tmp",
    discovery: "walk",
  });
  const manifest = generateSnapshot(config);
  const partText = fs
    .readdirSync(path.join(dir, "snapshot", "parts"))
    .map((name) => fs.readFileSync(path.join(dir, "snapshot", "parts", name), "utf8"))
    .join("\n");
  return { manifest, partText };
}

const included = (manifest) => manifest.files.map((file) => file.relativePath);
const skippedReason = (manifest, target) =>
  manifest.skipped.find((entry) => entry.path === target)?.reason;

// ---------------------------------------------------------------- item 13

test("SI-01: an escaped leading # is a literal, not a comment", (t) => {
  const dir = makeRepo(t, {
    ".gitignore": "\\#hashfile.ts\n",
    "#hashfile.ts": "export const hash = 1;\n",
  });
  const { manifest, partText } = walkSnapshot(dir);

  assert.equal(skippedReason(manifest, "#hashfile.ts"), "gitignore");
  assert.ok(!included(manifest).includes("#hashfile.ts"), "must not be tracked");
  assert.ok(
    !partText.includes("export const hash = 1;"),
    "an ignored file's content must not reach the parts"
  );
});

test("SI-02: an escaped leading ! is a literal, not a negation", (t) => {
  const dir = makeRepo(t, {
    ".gitignore": "\\!bangfile.ts\n",
    "!bangfile.ts": "export const bang = 1;\n",
  });
  const { manifest, partText } = walkSnapshot(dir);

  assert.equal(skippedReason(manifest, "!bangfile.ts"), "gitignore");
  assert.ok(!partText.includes("export const bang = 1;"));
});

test("SI-03: an escaped space is significant and is not a separator", (t) => {
  const dir = makeRepo(t, {
    ".gitignore": "spaced\\ .ts\n",
    "spaced .ts": "export const spaced = 1;\n",
  });
  const { manifest, partText } = walkSnapshot(dir);

  assert.equal(
    skippedReason(manifest, "spaced .ts"),
    "gitignore",
    "the backslash escapes the space, it does not become a path separator"
  );
  assert.ok(!partText.includes("export const spaced = 1;"));
});

test("SI-04: plain ! negation still re-includes a file", (t) => {
  const dir = makeRepo(t, {
    ".gitignore": "*.log\n!keep.log\n",
    "keep.log": "kept\n",
    "drop.log": "dropped\n",
  });
  const { manifest } = walkSnapshot(dir);

  assert.ok(included(manifest).includes("keep.log"), "!keep.log must re-include the file");
  assert.equal(skippedReason(manifest, "drop.log"), "gitignore");
});

test("SI-05: an unescaped trailing space is insignificant", (t) => {
  const dir = makeRepo(t, {
    ".gitignore": "plain.ts   \n",
    "plain.ts": "export const plain = 1;\n",
  });
  const { manifest } = walkSnapshot(dir);

  assert.ok(
    !included(manifest).includes("plain.ts"),
    "git strips trailing spaces, so the rule still matches"
  );
});

test("SI-06: a trailing escaped space must match the literal space", (t) => {
  const dir = makeRepo(t, {
    ".gitignore": "trailing\\ \n",
    "trailing ": "x\n",
  });
  const { manifest } = walkSnapshot(dir);

  assert.equal(
    skippedReason(manifest, "trailing "),
    "gitignore",
    "an escaped trailing space is part of the pattern"
  );
});

// ---------------------------------------------------------------- item 14
// `init` used to emit a hardcoded `branch: "main"`, so every later `validate`
// warned about a branch mismatch the user never caused. It must write the
// repository's actual branch and keep "main" only as the fallback.

function initRepo(t, { gitBranch } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-branch-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"init-branch","private":true}\n');
  fs.writeFileSync(path.join(dir, "index.js"), "module.exports = 1;\n");
  if (gitBranch) {
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q", "-b", gitBranch);
    git("add", "-A");
    execFileSync(
      "git",
      ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"],
      { cwd: dir, stdio: "ignore" }
    );
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function initAndReadConfig(dir) {
  const result = await runInit({ cwd: dir, yes: true });
  return result.configText ?? fs.readFileSync(result.configPath, "utf8");
}

test("SI-07: init on a repository checked out on master writes branch: \"master\"", async (t) => {
  const dir = initRepo(t, { gitBranch: "master" });
  const configText = await initAndReadConfig(dir);

  assert.match(
    configText,
    /^\s*branch: "master",$/m,
    "the generated config must record the repository's actual branch"
  );
  assert.doesNotMatch(
    configText,
    /^\s*branch: "main",$/m,
    "the hardcoded default must not survive on a master checkout"
  );
});

test("SI-08: init in a non-git directory falls back to branch: \"main\"", async (t) => {
  const dir = initRepo(t);
  const configText = await initAndReadConfig(dir);

  assert.match(
    configText,
    /^\s*branch: "main",$/m,
    "without git there is no branch to report, so the documented fallback applies"
  );
});
