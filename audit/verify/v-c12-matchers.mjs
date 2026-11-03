// C§12 (02 §12, MEDIUM) — `"src/app/**"` compiled to `startsWith("src/app")`
// (so it also matched src/apple/), and `excludePatterns` was a raw substring
// test (so "test" silently dropped contest/ and attest/). Check the documented
// README forms both unit-level and end-to-end.
import * as path from "node:path";
import {
  generateSnapshot,
  globToRegExp,
  matchRule,
  matchesExclude,
  resolveConfig,
} from "../../dist/index.js";
import {
  assert,
  assertEqual,
  check,
  finish,
  selfTest,
  tmp,
  write,
} from "./v-lib.mjs";

selfTest();

check("C12.layer-glob", "'src/app/**' matches src/app and below, not src/apple/application", () => {
  const cases = [
    ["src/app", true],
    ["src/app/route.ts", true],
    ["src/app/deep/nested/x.ts", true],
    ["src/apple/pie.ts", false],
    ["src/application/server.ts", false],
    ["src/app2/x.ts", false],
    ["other/src/app/x.ts", false],
  ];
  const wrong = cases.filter(([file, expected]) => matchRule(file, "src/app/**") !== expected);
  assertEqual(wrong.length, 0, `misclassified: ${wrong.map(([f]) => f).join(", ")}`);
  return `7/7 path classifications`;
});

check("C12.substring-rule", "a plain string rule keeps documented substring semantics", () => {
  assertEqual(matchRule("src/apple/pie.ts", "app"), true, "substring rule");
  assertEqual(matchRule("src/other/pie.ts", "app"), false, "substring rule (non-match)");
  return "substring semantics for non-glob rules";
});

check("C12.exclude-segments", "'test' excludes test/ paths but not contest/ or attest/", () => {
  const cases = [
    ["test/a.ts", true],
    ["src/test/b.ts", true],
    ["contest/entry.ts", false],
    ["attest/words.ts", false],
    ["src/attestation/x.ts", false],
  ];
  const wrong = cases.filter(([file, expected]) => matchesExclude(file, "test") !== expected);
  assertEqual(wrong.length, 0, `wrong excludes: ${wrong.map(([f]) => f).join(", ")}`);
  return "5/5 exclude classifications";
});

check("C12.exclude-globs", "real glob excludes: *.lock, **/fixtures/**, src/app/**", () => {
  assertEqual(matchesExclude("foo.lock", "*.lock"), true, "*.lock top level");
  assertEqual(matchesExclude("sub/bar.lock", "*.lock"), true, "*.lock nested (gitignore semantics)");
  assertEqual(matchesExclude("src/fixtures/a.ts", "**/fixtures/**"), true, "fixtures at any depth");
  assertEqual(matchesExclude("a/b/fixtures/c.ts", "**/fixtures/**"), true, "fixtures deep");
  assertEqual(matchesExclude("src/fixturesx/a.ts", "**/fixtures/**"), false, "fixturesx must not match");
  assertEqual(matchesExclude("src/app/x.ts", "src/app/**"), true, "src/app/**");
  assertEqual(matchesExclude("src/apple/x.ts", "src/app/**"), false, "src/apple/** must not match");
  assertEqual(globToRegExp("*.lock").test("a.lock"), true, "globToRegExp *.lock");
  assertEqual(globToRegExp("*.lock").test("a.lockx"), false, "globToRegExp *.lock (negative)");
  return "9/9 glob assertions";
});

check("C12.end-to-end-excludes", "excludePatterns:['test'] keeps attest/ and contest/ in the snapshot", () => {
  const dir = tmp("c12");
  write(dir, ".gitignore", "snapshot/\n");
  write(dir, "test/a.ts", "export const a = 1;\n");
  write(dir, "attest/words.ts", "export const words = 1;\n");
  write(dir, "contest/entry.ts", "export const entry = 1;\n");
  write(dir, "src/keep.ts", "export const keep = 1;\n");
  const manifest = generateSnapshot(
    resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", excludePatterns: ["test"] })
  );
  const paths = manifest.files.map((file) => file.relativePath).sort();
  assert(!paths.includes("test/a.ts"), "test/a.ts was not excluded");
  assert(paths.includes("attest/words.ts"), "attest/words.ts was wrongly excluded");
  assert(paths.includes("contest/entry.ts"), "contest/entry.ts was wrongly excluded");
  assert(paths.includes("src/keep.ts"), "src/keep.ts missing");
  return paths.join(", ");
});

check("C12.end-to-end-layers", "layers with 'src/app/**' do not leak into src/apple/", () => {
  const dir = tmp("c12b");
  write(dir, ".gitignore", "snapshot/\n");
  write(dir, "src/app/route.ts", "export const r = 1;\n");
  write(dir, "src/apple/pie.ts", "export const p = 1;\n");
  write(dir, "src/application/server.ts", "export const s = 1;\n");
  const manifest = generateSnapshot(
    resolveConfig({
      cwd: dir,
      outDir: "snapshot",
      tmpDir: "snapshot.tmp",
      layers: [{ name: "app", match: "src/app/**" }],
    })
  );
  const layerOf = Object.fromEntries(manifest.files.map((file) => [file.relativePath, file.layer]));
  assertEqual(layerOf["src/app/route.ts"], "app", "src/app/route.ts layer");
  assertEqual(layerOf["src/apple/pie.ts"], "other", "src/apple/pie.ts layer");
  assertEqual(layerOf["src/application/server.ts"], "other", "src/application/server.ts layer");
  assertEqual(manifest.layers.app, 1, `layers histogram: ${JSON.stringify(manifest.layers)}`);
  return JSON.stringify(layerOf);
});

check("C12.end-to-end-glob-exclude", "excludePatterns:['*.lock'] drops only lock files", () => {
  const dir = tmp("c12c");
  write(dir, ".gitignore", "snapshot/\n");
  write(dir, "foo.lock", "lock\n");
  write(dir, "src/bar.lock", "lock\n");
  write(dir, "src/keep.ts", "export const keep = 1;\n");
  const manifest = generateSnapshot(
    resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", excludePatterns: ["*.lock"] })
  );
  const paths = manifest.files.map((file) => file.relativePath);
  assertEqual(paths.sort().join(","), ".gitignore,src/keep.ts", `files: ${paths.join(",")}`);
  return "only src/keep.ts remained";
});

finish();

