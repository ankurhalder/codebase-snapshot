// C§1 (02 §1 / C1, CRITICAL) — generateSnapshot deleted the destination before
// it could write the replacement: `outDir: "."` erased the whole repository, a
// nested tmpDir erased its own parent, and a failed EXDEV rename lost the
// previous snapshot. Checked with real fixtures plus a real junction onto D:
// (EXDEV) and a real locked output directory.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateSnapshot, resolveConfig, resolveSafeOutputDirs } from "../../dist/index.js";
import {
  assert,
  assertEqual,
  check,
  finish,
  gitInit,
  readTree,
  selfTest,
  sha256,
  tmp,
  write,
} from "./v-lib.mjs";

selfTest();

function makeRepo(name) {
  const dir = tmp(name);
  write(dir, "README.md", "# fixture\n");
  write(dir, "package.json", `{"name":"fixture"}\n`);
  write(dir, "src/a.ts", "export const a = 1;\n");
  write(dir, "src/nested/b.ts", "export const b = 2;\n");
  const git = gitInit(dir);
  git.add(".");
  git.commit();
  return dir;
}

/** Fingerprint of everything except .git, to prove nothing was lost. */
function fingerprint(dir) {
  const tree = readTree(dir, { encoding: "buffer" });
  const entries = Object.entries(tree)
    .filter(([name]) => !name.startsWith(".git/"))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, buf]) => `${name}:${sha256(buf)}`);
  return sha256(entries.join("\n"));
}

/** Fingerprint of the fixture's *sources* only (the snapshot is expected to change). */
function sourceFingerprint(dir) {
  const tree = readTree(dir, { encoding: "buffer" });
  const entries = Object.entries(tree)
    .filter(([name]) => /^(src|README\.md|package\.json|\.git)/.test(name))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, buf]) => `${name}:${sha256(buf)}`);
  return sha256(entries.join("\n"));
}

const GUARDS = [
  ["outDir '.'", { outDir: ".", tmpDir: "snapshot.tmp" }, /working directory or one of its ancestors/],
  ["outDir './'", { outDir: "./", tmpDir: "snapshot.tmp" }, /working directory or one of its ancestors/],
  ["outDir '..'", { outDir: "..", tmpDir: "snapshot.tmp" }, /working directory or one of its ancestors/],
  ["outDir '' (branded config)", { outDir: "", tmpDir: "snapshot.tmp" }, /working directory or one of its ancestors/],
  ["outDir = tmpDir", { outDir: "out", tmpDir: "out" }, /same directory/],
  ["tmpDir inside outDir", { outDir: "out", tmpDir: "out/.tmp" }, /tmpDir is inside outDir/],
  ["tmpDir is cwd", { outDir: "out", tmpDir: "." }, /working directory or one of its ancestors/],
];

for (const [label, config, expected] of GUARDS) {
  check(`C1.guard:${label}`, "refused before any write, and the tree is untouched", () => {
    const dir = makeRepo("c1");
    const before = fingerprint(dir);
    let error = null;
    try {
      // Re-brand after the spread so the hand-built values are actually used
      // (a bare spread is re-resolved and would silently restore the defaults).
      generateSnapshot({ ...resolveConfig({ cwd: dir }), ...config, [Symbol.for("@ankurhalder/codebase-snapshot/resolved-config")]: true });
    } catch (err) {
      error = err;
    }
    assert(error, "generateSnapshot did NOT throw — the guard is missing");
    assert(expected.test(error.message), `unexpected error: ${error.message}`);
    assertEqual(fingerprint(dir), before, "fixture contents changed");
    assert(fs.existsSync(path.join(dir, "src/a.ts")), "src/a.ts was deleted");
    assert(fs.existsSync(path.join(dir, ".git")), ".git was deleted");
    return error.message.split(".")[0].slice(0, 72);
  });
}

check("C1.previous-snapshot", "a rejected config leaves the previous snapshot intact", () => {
  const dir = makeRepo("c1p");
  generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  const before = fingerprint(dir);
  let threw = false;
  try {
    generateSnapshot({ ...resolveConfig({ cwd: dir }), outDir: ".", tmpDir: "snapshot.tmp" });
  } catch {
    threw = true;
  }
  assert(threw, "did not throw");
  assert(fs.existsSync(path.join(dir, "snapshot/manifest.json")), "previous manifest disappeared");
  assertEqual(fingerprint(dir), before, "fixture changed");
  return "snapshot/manifest.json survived";
});

check("C1.atomic-swap", "regeneration replaces the snapshot and leaves no backup/tmp litter", () => {
  const dir = makeRepo("c1s");
  const first = generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  write(dir, "src/a.ts", "export const a = 2;\n");
  const second = generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  assert(first.fingerprint !== second.fingerprint, "fingerprint did not change after an edit");
  const entries = fs.readdirSync(dir);
  const litter = entries.filter((name) => name.includes(".backup-"));
  assertEqual(litter.length, 0, `backup dirs left behind: ${litter.join(", ")}`);
  assert(!fs.existsSync(path.join(dir, "snapshot.tmp")), "tmpDir left behind");
  assert(fs.existsSync(path.join(dir, "snapshot/parts/part-001.md")), "part missing after swap");
  return `fingerprints differ, no litter, ${entries.length} entries`;
});

check(
  "C1.busy-outdir",
  "a swap that cannot even move the old snapshot away leaves it intact (data safety)",
  () => {
    const dir = makeRepo("c1b");
    generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
    const manifestBefore = fs.readFileSync(path.join(dir, "snapshot/manifest.json"), "utf8");

    // A live process whose CWD is outDir makes the rename fail on Windows.
    const child = spawn(
      process.execPath,
      ["-e", "process.chdir(process.argv[1]); setTimeout(() => {}, 20000)", path.join(dir, "snapshot")],
      { stdio: "ignore" }
    );
    const started = Date.now();
    while (Date.now() - started < 400) {
      /* let the child take the lock */
    }

    write(dir, "src/a.ts", "export const a = 3;\n");
    const sources = sourceFingerprint(dir);
    let error = null;
    try {
      generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
    } catch (err) {
      error = err;
    }
    child.kill();
    const manifestAfter = fs.readFileSync(path.join(dir, "snapshot/manifest.json"), "utf8");
    console.log(
      `    OBS C1.busy-outdir: rename blocked=${Boolean(error)} code=${error?.code ?? "-"} oldManifestIntact=${manifestAfter === manifestBefore}`
    );
    assertEqual(sourceFingerprint(dir), sources, "source files changed");
    assertEqual(manifestAfter, manifestBefore, "the previous snapshot manifest was replaced/lost");
    return error ? `blocked with ${error.code ?? "error"}, old snapshot intact` : "regeneration succeeded, snapshot intact";
  }
);

// --------------------------------------------------------------- EXDEV (D:)
const hasD = (() => {
  try {
    fs.accessSync("D:\\");
    return true;
  } catch {
    return false;
  }
})();

if (!hasD) {
  console.log("SKIP C1.exdev :: no second volume available in this environment");
} else {
  const target = fs.mkdtempSync("D:\\csv-exdev-");
  const dir = makeRepo("c1x");
  const link = path.join(dir, "mnt");
  execFileSync("cmd", ["/c", "mklink", "/J", link, target], { stdio: "ignore" });

  check("C1.exdev-first", "EXDEV on the swap-in falls back to a recursive copy", () => {
    const manifest = generateSnapshot(
      resolveConfig({ cwd: dir, outDir: "mnt/snapshot", tmpDir: "snapshot.tmp" })
    );
    assert(manifest.counts.totalFiles > 0, "nothing generated");
    assert(fs.existsSync(path.join(target, "snapshot", "manifest.json")), "snapshot not copied to D:");
    assert(fs.existsSync(path.join(target, "snapshot", "parts", "part-001.md")), "parts not copied to D:");
    assert(!fs.existsSync(path.join(dir, "snapshot.tmp")), "tmpDir stranded on C:");
    return "written across the volume boundary, tmp cleaned";
  });

  check("C1.exdev-regenerate", "regenerating across the boundary replaces the snapshot cleanly", () => {
    fs.writeFileSync(path.join(target, "snapshot", "STALE.txt"), "stale content\n");
    const manifest = generateSnapshot(
      resolveConfig({ cwd: dir, outDir: "mnt/snapshot", tmpDir: "snapshot.tmp" })
    );
    assert(manifest.counts.totalFiles > 0, "nothing generated");
    assert(!fs.existsSync(path.join(target, "snapshot", "STALE.txt")), "stale file survived the swap");
    assert(fs.existsSync(path.join(target, "snapshot", "manifest.json")), "manifest missing after swap");
    const dEntries = fs.readdirSync(target);
    const cEntries = fs.readdirSync(dir);
    assertEqual(dEntries.filter((n) => n.includes(".backup-")).length, 0, "backup litter on D:");
    assertEqual(cEntries.filter((n) => n.includes(".backup-")).length, 0, "backup litter on C:");
    assert(!fs.existsSync(path.join(dir, "snapshot.tmp")), "tmp leftover on C:");
    return "old snapshot replaced, no litter on either volume";
  });

  try {
    fs.rmdirSync(link);
  } catch {
    /* ignore */
  }
  fs.rmSync(target, { recursive: true, force: true });
}

check("C1.resolveSafe-output", "resolveSafeOutputDirs rejects every C1 shape and allows the default", () => {
  const dir = makeRepo("c1r");
  const reject = (outDir, tmpDir) => {
    try {
      resolveSafeOutputDirs({ cwd: dir, outDir, tmpDir });
      return false;
    } catch {
      return true;
    }
  };
  assert(reject(".", "snapshot.tmp"), "'.' accepted");
  assert(reject("..", "snapshot.tmp"), "'..' accepted");
  assert(reject("out", "out/.tmp"), "nested tmp accepted");
  assert(reject("out", "out"), "same dir accepted");
  assert(!reject("snapshot", "snapshot.tmp"), "the default layout was rejected");
  return "5 rejections, default layout allowed";
});

finish();
