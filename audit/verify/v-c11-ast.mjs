// C§11 (02 §11, MEDIUM) — one deeply-nested JS/TS file aborted the whole run
// with an uncaught RangeError: the AST walk was recursive and there was no
// per-file isolation. Check: both the parser-throws case and our-walk-throws
// case must be contained, the file must stay in the snapshot, and the warning
// must name it.
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { generateSnapshot, resolveConfig, summarizeTypeScriptSource } from "../../dist/index.js";
import {
  BIN,
  assert,
  assertEqual,
  check,
  finish,
  readTree,
  selfTest,
  tmp,
  write,
} from "./v-lib.mjs";

selfTest();

check("C11.deep-and-chain", "20k '&&' operands (parser OK, visitor used to recurse) no longer throw", () => {
  const source = `export const big = ${Array.from({ length: 20_000 }, (_, i) => `v${i}`).join(" && ")};\n`;
  let summary = null;
  let error = null;
  try {
    summary = summarizeTypeScriptSource("big.js", source);
  } catch (err) {
    error = err;
  }
  assert(!error, `summarizeTypeScriptSource threw: ${error?.message}`);
  assert(summary && Array.isArray(summary.variables), "no summary returned");
  return `summary built with ${summary.variables.length} variables`;
});

check("C11.nested-parens", "5000 nested parentheses are contained by the per-file try/catch", () => {
  const source = `export const x = ${"(".repeat(5000)}1${")".repeat(5000)};\n`;
  let parserThrew = false;
  try {
    summarizeTypeScriptSource("deep.js", source);
  } catch {
    parserThrew = true;
  }
  const dir = tmp("c11a");
  write(dir, ".gitignore", "snapshot/\n");
  write(dir, "src/deep.js", source);
  write(dir, "src/ok.ts", "export const ok = 1;\n");
  let manifest = null;
  let error = null;
  try {
    manifest = generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  } catch (err) {
    error = err;
  }
  assert(!error, `generateSnapshot still threw: ${error?.message}`);
  assert(manifest, "no manifest returned");
  const included = manifest.files.some((file) => file.relativePath === "src/deep.js");
  assert(included, "the pathological file was dropped instead of isolated");
  assertEqual(manifest.validation.status, "passed", `status: ${manifest.validation.errors.join("; ")}`);
  console.log(`    OBS C11: parser threw directly=${parserThrew} warning=${JSON.stringify(manifest.warnings.filter((w) => w.includes("deep.js")))}`);
  return `run completed, deep.js included, ${manifest.warnings.length} warning(s)`;
});

check("C11.warning-names-file", "the isolation warning identifies the offending file", () => {
  const dir = tmp("c11b");
  write(dir, ".gitignore", "snapshot/\n");
  write(dir, "src/deep.js", `export const x = ${"(".repeat(20000)}1${")".repeat(20000)};\n`);
  write(dir, "src/ok.ts", "export const ok = 1;\n");
  const manifest = generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  const related = manifest.warnings.filter((warning) => warning.includes("deep.js"));
  assert(related.length >= 1, `no warning names deep.js: ${JSON.stringify(manifest.warnings)}`);
  assert(/Summary skipped/.test(related[0]), `unexpected warning text: ${related[0]}`);
  return related[0].slice(0, 80);
});

check("C11.cli", "the CLI does not crash on a pathological file", () => {
  const dir = tmp("c11c");
  write(dir, ".gitignore", "snapshot/\n");
  write(dir, "src/deep.js", `export const x = ${"(".repeat(20000)}1${")".repeat(20000)};\n`);
  const run = spawnSync(process.execPath, [BIN, "generate", "--cwd", dir], { encoding: "utf8", timeout: 120_000 });
  assertEqual(run.status, 0, `exit ${run.status}: ${run.stderr.slice(0, 300)}`);
  assert(!/RangeError/.test(`${run.stdout}${run.stderr}`), "a stack trace/RangeError leaked to the CLI");
  return "exit 0, no RangeError";
});

check("C11.parts-intact", "the pathological file's content is still emitted", () => {
  const dir = tmp("c11d");
  write(dir, ".gitignore", "snapshot/\n");
  write(dir, "src/deep.js", "export const deepMarker = 12345;\n");
  const manifest = generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  const parts = readTree(path.join(dir, "snapshot", "parts"));
  assert(Object.values(parts).join("\n").includes("deepMarker"), "content missing from parts");
  assertEqual(manifest.files.length, 2, "file count (.gitignore + deep.js)");
  return "content present";
});

finish();

