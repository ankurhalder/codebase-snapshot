// C§20 (02 §20) — the audit's OWN rejected claims. They are not findings, so
// "fixed" is meaningless; the check is that the sound behaviour the audit
// documented has not regressed and the rejections stay rejected.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  collectFiles,
  generateSnapshot,
  loadConfigFileDetailed,
  resolveConfig,
  validateSnapshot,
} from "../../dist/index.js";
import {
  assert,
  assertEqual,
  assertNotIncludes,
  check,
  checkAsync,
  finish,
  readTree,
  selfTest,
  tmp,
  write,
} from "./v-lib.mjs";

selfTest();

check("C20.bytes-exact", "claim A (self-referential byteSize) stays false: recorded size == real size", () => {
  const dir = tmp("c20a");
  for (const size of [10, 1000, 9990, 99990, 999998]) {
    write(dir, `src/f${size}.txt`, "x".repeat(size));
  }
  const manifest = generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  const deltas = [];
  for (const part of manifest.parts) {
    const stat = fs.statSync(path.join(dir, "snapshot/parts", part.filename));
    deltas.push(stat.size - part.byteSize);
  }
  assertEqual(deltas.filter((delta) => delta !== 0).length, 0, `deltas: ${deltas.join(",")}`);
  return `${manifest.parts.length} parts, delta 0 at every digit boundary`;
});

check("C20.crlf-safe", "claim B (CRLF overshoot) stays safe: emitted parts are smaller, not larger", () => {
  const dir = tmp("c20b");
  const crlf = Array.from({ length: 2000 }, (_, i) => `export const l${i} = ${i};\r`).join("\n");
  write(dir, "src/crlf.ts", crlf);
  const manifest = generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  const part = Object.values(readTree(path.join(dir, "snapshot/parts"))).join("\n");
  assert(!part.includes("\r"), "CRLF survived into the emitted part");
  for (const metadata of manifest.parts) {
    const stat = fs.statSync(path.join(dir, "snapshot/parts", metadata.filename));
    assert(stat.size <= manifest.budgets.maxPartBytes, "part exceeded the budget");
  }
  return "no \\r in output, within budget";
});

check("C20.empty-repo", "claim R (empty repo) stays coherent: no NaN, no divide-by-zero, valid", () => {
  const dir = tmp("c20c");
  const config = resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" });
  const manifest = generateSnapshot(config);
  assertEqual(manifest.parts.length, 0, "parts");
  assertEqual(manifest.counts.partsCount, 0, "partsCount");
  assert(!JSON.stringify(manifest).includes("NaN"), "NaN in the manifest");
  assertEqual(manifest.validation.status, "passed", `status: ${manifest.validation.errors.join("; ")}`);
  const result = validateSnapshot(config);
  assertEqual(result.valid, true, `validate: ${result.errors.join("; ")}`);
  assertEqual(manifest.totals.totalContentBytes, 0, "totalContentBytes");
  return "0 parts, valid:true, no NaN";
});

await checkAsync("C20.file-url", "claim G (file://C: URLs) stays rejected: configs load via pathToFileURL", async () => {
  const dir = tmp("c20d");
  write(dir, "snapshot.config.mjs", `export default { maxPartBytes: 204800 };\n`);
  const loaded = await loadConfigFileDetailed(dir);
  assert(loaded.config, `not loaded: ${loaded.warnings.join("; ")}`);
  return `win32 path imported fine (${path.basename(loaded.file)})`;
});

check("C20.symlink-recursion", "claim J (infinite recursion) stays false: a self-referential junction terminates", () => {
  const dir = tmp("c20e");
  write(dir, "src/a.ts", "export const a = 1;\n");
  let junction = false;
  try {
    execFileSync("cmd", ["/c", "mklink", "/J", path.join(dir, "loop"), dir], { stdio: "ignore" });
    junction = true;
  } catch {
    junction = false;
  }
  if (!junction) {
    console.log("    SKIP C20.symlink-recursion: could not create a junction");
    return "not applicable";
  }
  try {
    const collected = collectFiles(dir, {});
    assert(collected.files.length < 50, `walk exploded: ${collected.files.length} files`);
    return `${collected.files.length} files, walk terminated`;
  } finally {
    try {
      fs.rmdirSync(path.join(dir, "loop"));
    } catch {
      /* ignore */
    }
  }
});

finish();

