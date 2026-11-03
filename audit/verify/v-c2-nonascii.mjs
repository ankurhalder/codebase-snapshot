// C§2 (02 §2 / H2) — `git ls-files` without `-z` C-quotes paths, so every
// non-ASCII filename was mangled ("src/café.ts" -> "src/caf/303/251.ts") and
// silently dropped as a read-error. Check: every one of those files must be
// collected, hashed, emitted into a part, and absent from `skipped`.
import * as fs from "node:fs";
import * as path from "node:path";
import { collectFiles, generateSnapshot, resolveConfig, validateSnapshot } from "../../dist/index.js";
import {
  assert,
  assertEqual,
  assertIncludes,
  check,
  finish,
  gitInit,
  readTree,
  selfTest,
  tmp,
  write,
} from "./v-lib.mjs";

selfTest();

const NAMES = [
  "src/ascii.ts",
  "src/café.ts",
  "src/ümlaut-ok.ts",
  "src/日本語.ts",
  "src/with space.ts",
  "src/hash#tag.ts",
  "src/percent%41.ts",
  "src/emoji-🚀.ts",
  "docs/résumé.md",
];

const dir = tmp("c2");
for (const name of NAMES) write(dir, name, `export const value = 1; // ${path.basename(name)}\n`);
const git = gitInit(dir);
git.add(".");
git.commit();

check("C2.collect-git", "git ls-files -z returns every non-ASCII path verbatim", () => {
  const collected = collectFiles(dir, {});
  const missing = NAMES.filter((name) => !collected.files.includes(name));
  assertEqual(missing.length, 0, `not collected: ${missing.join(", ")}`);
  const badSkip = collected.skipped.filter((entry) => entry.reason === "read-error" || entry.path.includes("\\"));
  assertEqual(badSkip.length, 0, `spurious read-errors: ${JSON.stringify(badSkip)}`);
  return `${collected.files.length}/${NAMES.length} collected, 0 read-errors`;
});

check("C2.manifest", "all paths appear in the manifest with a real hash", () => {
  const manifest = generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  const included = new Map(manifest.files.map((file) => [file.relativePath, file]));
  const missing = NAMES.filter((name) => !included.has(name));
  assertEqual(missing.length, 0, `missing from manifest: ${missing.join(", ")}`);
  for (const name of NAMES) {
    const entry = included.get(name);
    assert(/^[0-9a-f]{64}$/.test(entry.hashSha256), `${name} has no hash`);
    assert(entry.part, `${name} was not assigned to a part`);
  }
  assert(
    manifest.skipped.every((entry) => entry.reason !== "read-error"),
    `skipped still records read-errors: ${JSON.stringify(manifest.skipped)}`
  );
  return `${manifest.files.length} files, all hashed and parted`;
});

check("C2.parts", "the emitted parts contain the real filenames", () => {
  const parts = readTree(path.join(dir, "snapshot", "parts"));
  const body = Object.values(parts).join("\n");
  for (const name of NAMES) assertIncludes(body, `### FILE: ${name}`, "part content");
  return `${NAMES.length}/${NAMES.length} headings present`;
});

check("C2.walk-fallback", "the non-git walk also preserves non-ASCII names", () => {
  const dir2 = tmp("c2w");
  for (const name of NAMES) write(dir2, name, "export const value = 1;\n");
  const collected = collectFiles(dir2, {});
  const missing = NAMES.filter((name) => !collected.files.includes(name));
  assertEqual(missing.length, 0, `walk missed: ${missing.join(", ")}`);
  return `${collected.files.length}/${NAMES.length} collected without git`;
});

check("C2.roundtrip", "generate -> validate on a unicode repo reports no drift", () => {
  const result = validateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  assert(result.valid, `drift: ${JSON.stringify(result.drift)} ${result.errors.join("; ")}`);
  assert(fs.existsSync(path.join(dir, "src/日本語.ts")), "fixture lost");
  return "valid:true";
});

finish();

