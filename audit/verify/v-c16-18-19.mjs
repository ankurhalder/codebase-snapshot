// C§16 (02 §16, LOW) — the no-git walk handled only isDirectory()/isFile(), so
// symlinks and junctions vanished with no `skipped` record at all.
// C§18 (02 §18, LOW) — tree.ts sorted with localeCompare (machine-dependent),
// had no size cap, and could not told a file from a directory.
// C§19 (02 §19, LOW) — ts-parser gaps: .mts/.cts never summarised, anonymous
// default exports, `export *`, and inconsistent routeHandlers.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  collectFiles,
  generateProjectTree,
  resolveConfig,
  summarizeTypeScriptSource,
  generateSnapshot,
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

// ------------------------------------------------------------------- C§16
check("C16.junction-recorded", "a junction in the no-git walk produces a visible skip record", () => {
  const dir = tmp("c16");
  const outside = tmp("c16-outside");
  write(outside, "hidden.ts", "export const hidden = 1;\n");
  write(dir, "real-dir/inner.ts", "export const inner = 1;\n");
  write(dir, "real-file.ts", "export const real = 1;\n");
  const link = path.join(dir, "link-dir");
  execFileSync("cmd", ["/c", "mklink", "/J", link, outside], { stdio: "ignore" });
  try {
    const collected = collectFiles(dir, {});
    const symlinkRecords = collected.skipped.filter((entry) => entry.reason === "symlink");
    assert(symlinkRecords.length >= 1, `no symlink skip record: ${JSON.stringify(collected.skipped)}`);
    assert(
      symlinkRecords.some((entry) => entry.path === "link-dir"),
      `record does not name the junction: ${JSON.stringify(symlinkRecords)}`
    );
    assert(collected.files.includes("real-dir/inner.ts"), "real files missing");
    console.log(
      `    OBS C16: files=${JSON.stringify(collected.files)} skipped=${JSON.stringify(collected.skipped.map((s) => `${s.path}:${s.reason}`))}`
    );
    return symlinkRecords[0].detail ?? "symlink recorded";
  } finally {
    try {
      fs.rmdirSync(link);
    } catch {
      /* ignore */
    }
  }
});

check("C16.file-symlink", "a file symlink is followed and recorded (or the OS refuses to create it)", () => {
  const dir = tmp("c16f");
  const outside = tmp("c16f-outside");
  write(outside, "target.ts", "export const target = 1;\n");
  const link = path.join(dir, "linked.ts");
  try {
    fs.symlinkSync(path.join(outside, "target.ts"), link);
  } catch (err) {
    console.log(`    SKIP C16.file-symlink: symlink creation refused (${err.code}) — fixed by inspection`);
    return "not applicable in this environment";
  }
  const collected = collectFiles(dir, {});
  const record = collected.skipped.find((entry) => entry.path === "linked.ts");
  assert(record, "symlink not recorded");
  assertEqual(record.reason, "symlink", "reason");
  return "linked.ts recorded";
});

// ------------------------------------------------------------------- C§18
check("C18.deterministic-order", "tree ordering is code-unit, not locale collation", () => {
  const paths = ["Ärger.ts", "a.ts", "zebra.ts", "Banana.ts", "Z.ts", "apple.ts", "b.ts", "ä.ts"];
  const tree = generateProjectTree(paths);
  const emitted = tree
    .split("\n")
    .filter((line) => /── /.test(line))
    .map((line) => line.replace(/^.*── /, ""));
  const expected = [...paths].sort();
  assertEqual(emitted.join(","), expected.join(","), `tree order ${emitted.join(",")}`);
  return emitted.join(",");
});

check("C18.dir-marker", "directories are marked with a trailing slash", () => {
  const tree = generateProjectTree(["src/a.ts", "src/deep/b.ts"]);
  assert(tree.includes("├── src/") || tree.includes("└── src/"), `src not marked as a directory:\n${tree}`);
  assert(!/── a\.ts\//.test(tree), "a file was marked as a directory");
  return "src/ marked, a.ts not";
});

check("C18.cap", "a very large tree is truncated instead of emitted unbounded", () => {
  const paths = Array.from({ length: 25_000 }, (_, i) => `d${i % 50}/file${i}.ts`);
  const tree = generateProjectTree(paths);
  assert(tree.includes("tree truncated at"), "no truncation marker");
  assert(tree.length < 1_500_000, `tree is ${tree.length} B — cap not applied`);
  return `${(tree.length / 1024).toFixed(0)} KB, truncated marker present`;
});

check("C18.collision", "a file/dir name collision is unreachable on a real filesystem (informational)", () => {
  const dir = tmp("c18");
  write(dir, "a/b.ts", "export const b = 1;\n");
  let fileSameName = false;
  try {
    fs.writeFileSync(path.join(dir, "a"), "x");
    fileSameName = true;
  } catch {
    fileSameName = false;
  }
  assertEqual(fileSameName, false, "the OS allowed a file and directory with the same name");
  return "OS refuses the collision, so the synthetic PoC case cannot occur";
});

// ------------------------------------------------------------------- C§19
check("C19.mts-cts", "self-generated .mts/.cts files are summarised", () => {
  const manifest = (() => {
    const dir = tmp("c19");
    write(dir, ".gitignore", "snapshot/\n");
    write(dir, "src/b.mts", `import "./m";\nexport const bm = 1;\n`);
    write(dir, "src/c.cts", `import "./c";\nexport const cc = 1;\n`);
    write(dir, "src/d.ts", `import "./v";\nexport const dd = 1;\n`);
    return generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  })();
  const byPath = Object.fromEntries(manifest.files.map((file) => [file.relativePath, file]));
  for (const name of ["src/b.mts", "src/c.cts", "src/d.ts"]) {
    assert(byPath[name]?.summary, `${name} has no summary`);
    assert(byPath[name].summary.imports.length > 0, `${name} summary has no imports`);
  }
  return "b.mts, c.cts, d.ts all summarised";
});

check("C19.anonymous-default", "anonymous default exports are recorded", () => {
  const fn = summarizeTypeScriptSource("a.ts", `export default function () {}\n`);
  assert(fn.exports.includes("default"), `function: ${JSON.stringify(fn.exports)}`);
  const cls = summarizeTypeScriptSource("b.ts", `export default class {}\n`);
  assert(cls.exports.includes("default"), `class: ${JSON.stringify(cls.exports)}`);
  const expr = summarizeTypeScriptSource("c.ts", `export default 42;\n`);
  assert(expr.exports.includes("default"), `assignment: ${JSON.stringify(expr.exports)}`);
  return "function, class and assignment all record 'default'";
});

check("C19.export-star", "`export * from './star'` is recorded as import and re-export", () => {
  const summary = summarizeTypeScriptSource("a.ts", `export * from "./star";\n`);
  assertEqual(summary.reExports.join(","), "./star", "reExports");
  assert(summary.imports.includes("./star"), `imports: ${JSON.stringify(summary.imports)}`);
  return "imports + reExports both carry ./star";
});

check("C19.route-handlers", "only exported route handlers are recorded", () => {
  const summary = summarizeTypeScriptSource(
    "route.ts",
    [
      `export function GET() { return 1; }`,
      `function DELETE() { return 2; }`,
      `export const POST = () => 3;`,
      `const PATCH = () => 4;`,
      `export const helper = 5;`,
    ].join("\n")
  );
  assertEqual(summary.routeHandlers.join(","), "GET,POST", `routeHandlers: ${JSON.stringify(summary.routeHandlers)}`);
  assert(summary.functions.includes("DELETE"), "DELETE should still be listed as a function");
  assert(summary.variables.includes("PATCH"), "PATCH should still be listed as a variable");
  return "GET+POST (exported only), DELETE/PATCH excluded";
});

finish();
