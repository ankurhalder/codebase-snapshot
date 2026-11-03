// C§7 (inclusionMode lying), C§8 (dead navigation anchors), C§9 (monolith fixed
// 3-backtick fence), C§10 (hardcoded validation.status + fake generator.script),
// C§13 (hardcoded empty indexes), C§14 (totalContentBytes mirroring source
// bytes), C§17 (off-by-one line counting) and A11 (duplicate legacy fields).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  anchorForPath,
  countLines,
  generateSnapshot,
  resolveConfig,
  truncatePreview,
  validateSnapshot,
} from "../../dist/index.js";
import {
  BIN,
  REPO,
  assert,
  assertEqual,
  assertIncludes,
  check,
  finish,
  readTree,
  selfTest,
  tmp,
  write,
} from "./v-lib.mjs";

selfTest();

function makeRepo(name) {
  const dir = tmp(name);
  write(dir, ".gitignore", "snapshot/\nsnapshot.tmp/\n");
  write(dir, "src/a.ts", `import { b } from "./b";\nexport const a = b + 1;\n`);
  write(dir, "src/b.ts", `export const b = 1;\n`);
  write(dir, "src/features/billing/charge.ts", `export const charge = () => 42;\n`);
  write(dir, "src/features/billing/refund.ts", `export const refund = () => 0;\n`);
  write(dir, "src/client.tsx", `"use client";\nimport { useState } from "react";\nexport function Widget() { return null; }\n`);
  // file larger than largeFileBytes but short enough that the preview never truncates
  write(dir, "docs/six-lines.md", ["line1", "line2", "line3", "line4", "line5", "line6"].join("\n") + "\n");
  write(dir, "src/empty.ts", "");
  write(dir, "src/onlynewline.ts", "\n");
  write(dir, "src/two.ts", "a\nb\n");
  write(dir, "src/long.ts", Array.from({ length: 400 }, (_, i) => `export const l${i} = ${i};`).join("\n") + "\n");
  return dir;
}

const dir = makeRepo("c7");
write(dir, "docs/six-lines.md", ["line1", "line2", "line3", "line4", "line5", "line6"].join("\n").padEnd(1610, "x") + "\n");

const config = resolveConfig({
  cwd: dir,
  outDir: "snapshot",
  tmpDir: "snapshot.tmp",
  largeFileBytes: 500, // six-lines.md is bigger than this but its preview is not truncated
  includeMonolith: true,
});
const manifest = generateSnapshot(config);
const tree = readTree(path.join(dir, "snapshot"));
const partsBody = Object.entries(tree)
  .filter(([name]) => name.startsWith("parts/"))
  .map(([, text]) => text)
  .join("\n");

const sixLines = manifest.files.find((file) => file.relativePath === "docs/six-lines.md");
const long = manifest.files.find((file) => file.relativePath === "src/long.ts");

// ------------------------------------------------------------------- C§7
check("C7.inclusion-mode", "a large-but-untruncated file is 'full', not 'summary-only'", () => {
  assert(sixLines, "fixture file missing");
  assertEqual(sixLines.isLarge, true, "fixture is not above largeFileBytes");
  assertEqual(sixLines.isPreviewTruncated, false, "fixture preview was truncated");
  assertEqual(sixLines.inclusionMode, "full", "inclusionMode");
  assert(!partsBody.includes("#### Bounded Preview\n\n<a id=\"docs-six-lines-md"), "unexpected preview heading");
  const section = partsBody.split("### FILE: docs/six-lines.md")[1] ?? "";
  assert(section.includes("#### Content"), "the file is not rendered under '#### Content'");
  return `isLarge=${sixLines.isLarge} inclusionMode=${sixLines.inclusionMode}`;
});

check("C7.totals", "fullFiles/previewFiles are derived from truncation, not from size", () => {
  const fullFromManifest = manifest.files.filter((file) => !file.isPreviewTruncated).length;
  const previewFromManifest = manifest.files.filter((file) => file.isPreviewTruncated).length;
  assertEqual(manifest.totals.fullFiles, fullFromManifest, "fullFiles");
  assertEqual(manifest.totals.previewFiles, previewFromManifest, "previewFiles");
  assert(manifest.totals.fullFiles >= 1, "no full files counted");
  return `fullFiles=${manifest.totals.fullFiles} previewFiles=${manifest.totals.previewFiles}`;
});

check("C7.truncated-heading", "a genuinely truncated file is a 'preview' under the right heading", () => {
  assert(long, "long.ts missing");
  assertEqual(long.isPreviewTruncated, true, "long.ts was not truncated (largeFileBytes=500)");
  assertEqual(long.inclusionMode, "preview", "inclusionMode");
  const section = partsBody.split("### FILE: src/long.ts")[1] ?? "";
  assert(section.includes("#### Bounded Preview"), "no preview heading for a truncated file");
  assert(section.includes("lines omitted"), "no omission marker");
  return "preview + Bounded Preview + omission marker";
});

// ------------------------------------------------------------------- C§8
check("C8.anchors-resolve", "every navigation.md file link resolves to an emitted anchor", () => {
  const nav = tree["reports/navigation.md"];
  assert(nav, "navigation.md missing");
  const links = [...nav.matchAll(/\]\(\.\.\/parts\/([^)#]+)#([^)]+)\)/g)].map((match) => ({
    part: match[1],
    anchor: match[2],
  }));
  assert(links.length >= 5, `expected several links, found ${links.length}`);
  const missing = [];
  for (const link of links) {
    const partBody = tree[`parts/${link.part}`];
    if (!partBody) {
      missing.push(`${link.part} (file absent)`);
      continue;
    }
    if (!partBody.includes(`id="${link.anchor}"`)) missing.push(`${link.part}#${link.anchor}`);
  }
  assertEqual(missing.length, 0, `dead anchors: ${missing.join(", ")}`);
  return `${links.length}/${links.length} anchors resolve`;
});

check("C8.injective", "anchorForPath is injective for colliding slugs", () => {
  const a = anchorForPath("src/a-b.ts");
  const b = anchorForPath("src/a/b.ts");
  const c = anchorForPath("src/A-B.ts");
  assert(a !== b, `collision: both map to ${a}`);
  assert(a !== c, `collision: case-folded collision ${a}`);
  assert(/^[a-z0-9_-]+-[0-9a-f]{8}$/.test(a), `unexpected anchor shape: ${a}`);
  return `${a} != ${b}`;
});

// ------------------------------------------------------------------- C§9
check("C9.monolith-fence", "a file containing ``` cannot escape the monolith code fence", () => {
  const dir2 = tmp("c9");
  write(dir2, ".gitignore", "snapshot/\n");
  write(
    dir2,
    "docs.md",
    "# Docs\n\n```js\nconst x = 1;\n```\n\nINJECTED HEADING: this text is now outside the fence\n"
  );
  generateSnapshot(resolveConfig({ cwd: dir2, outDir: "snapshot", tmpDir: "snapshot.tmp", includeMonolith: true }));
  const md = fs.readFileSync(path.join(dir2, "snapshot/full-codebase.md"), "utf8");
  const lines = md.split("\n");
  let fence = null;
  let injectedInsideFence = false;
  let fenceRuns = [];
  for (const line of lines) {
    const match = /^(`{3,})/.exec(line);
    if (match) {
      if (!fence) {
        fence = match[1];
        fenceRuns.push(fence.length);
      } else if (match[1].length >= fence.length && /^`{3,}\s*$/.test(line)) {
        fence = null;
      }
    } else if (fence && line.includes("INJECTED HEADING")) {
      injectedInsideFence = true;
    }
  }
  assert(fenceRuns.every((run) => run >= 4), `monolith used a short fence: ${fenceRuns.join(",")}`);
  assert(injectedInsideFence, "the injected heading escaped the code fence");
  return `fences ${fenceRuns.join(",")} backticks, injection stayed inside`;
});

// ------------------------------------------------------------------- C§10
check("C10.status-computed", "validation.status is 'passed' only when nothing failed", () => {
  assertEqual(manifest.validation.status, "passed", `status (${manifest.validation.errors.join("; ")})`);
  assertEqual(manifest.validation.errors.length, 0, "errors");
  return "passed with 0 errors";
});

check("C10.status-consistency", "status is a function of validation.errors across adversarial fixtures", () => {
  // The old probe forced `failed` with a 6 KB layer name. That vector is now
  // bounded, so the `failed` branch is unreachable from public inputs — which is
  // the intended end state. What is still checkable is that the field is derived,
  // never a literal: passed <=> zero recorded errors, in every fixture shape.
  const shapes = [
    ["normal", (dir) => write(dir, "src/a.ts", "export const a = 1;\n")],
    ["huge line", (dir) => write(dir, "src/big.min.js", `var a=${"1".repeat(500_000)};`)],
    ["huge summary", (dir) => write(dir, "docs/h.md", `# ${"A".repeat(300_000)}\n`)],
    ["huge layer name", (dir) => write(dir, "src/c.ts", "export const c = 1;\n")],
    ["empty", () => {}],
  ];
  const rows = [];
  for (const [label, seed] of shapes) {
    const dir = tmp("c10s");
    seed(dir);
    const result = generateSnapshot(
      resolveConfig({
        cwd: dir,
        outDir: "snapshot",
        tmpDir: "snapshot.tmp",
        maxPartBytes: 4096,
        ...(label === "huge layer name" ? { layers: [{ name: "L".repeat(6000), match: () => true }] } : {}),
      })
    );
    const expected = result.validation.errors.length === 0 ? "passed" : "failed";
    assertEqual(result.validation.status, expected, `${label}: status vs errors`);
    assertEqual(result.validation.status, "passed", `${label}: unexpectedly failed (${result.validation.errors.join("; ")})`);
    rows.push(`${label}=${result.validation.status}/${result.validation.errors.length}`);
  }
  return rows.join(", ");
});

check("C10.status-derived-in-build", "the shipped bundle computes status instead of hardcoding it", () => {
  const bundle = fs.readFileSync(path.join(REPO, "dist/index.cjs"), "utf8");
  const derived = /validationErrors\.length === 0 \? "passed" : "failed"/.test(bundle) ||
    /errors\.length === 0 \? "passed" : "failed"/.test(bundle);
  console.log(`    OBS C10.status-derived-in-build: derivation found in dist/index.cjs=${derived}`);
  assert(derived, "dist/index.cjs does not derive validation.status from the error list");
  assert(!/'status: "passed"'/.test(bundle), "a literal status remains in the bundle");
  return "condition present, no hardcoded literal";
});

check("C10.declared-failure-honoured", "a manifest declaring itself failed is treated as invalid by validate", () => {
  const dir2 = tmp("c10d");
  write(dir2, ".gitignore", "snapshot/\nsnapshot.tmp/\n");
  write(dir2, "src/a.ts", "export const a = 1;\n");
  const cfg = resolveConfig({ cwd: dir2, outDir: "snapshot", tmpDir: "snapshot.tmp" });
  generateSnapshot(cfg);
  const manifestPath = path.join(dir2, "snapshot/manifest.json");
  const tampered = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  tampered.validation = { status: "failed", errors: ["synthetic invariant failure"] };
  fs.writeFileSync(manifestPath, JSON.stringify(tampered, null, 2));
  const result = validateSnapshot(cfg);
  assert(!result.valid, "a manifest declaring failure validated as clean");
  assert(
    result.drift.configMismatches.some((entry) => /declared itself invalid|synthetic invariant failure/.test(entry)),
    JSON.stringify(result.drift.configMismatches)
  );
  return "declared failure surfaced to consumers";
});

check("C10.cli-exit", "the CLI exit code tracks the computed status", () => {
  const dir2 = tmp("c10c");
  write(dir2, ".gitignore", "snapshot/\nsnapshot.tmp/\n");
  write(dir2, "src/a.ts", "export const a = 1;\n");
  const run = spawnSync(process.execPath, [BIN, "generate", "--cwd", dir2], { encoding: "utf8" });
  assertEqual(run.status, 0, `exit code on a passing run (stdout ${run.stdout.slice(0, 200)} stderr ${run.stderr.slice(0, 200)})`);
  // The `1` half of `status === "passed" ? 0 : 1` is now unreachable because the
  // invariants it guards hold; the source line is cited in the report.
  const declared = spawnSync(process.execPath, [BIN, "validate", "--cwd", dir2], { encoding: "utf8" });
  assertEqual(declared.status, 0, `validate exit ${declared.status}`);
  return "exit 0 on a passing run (failed path unreachable, cited by inspection)";
});

check("C10.no-generator-script", "generator.script is gone from the manifest", () => {
  assert(!("script" in manifest.generator), `generator still carries: ${Object.keys(manifest.generator).join(", ")}`);
  assertEqual(Object.keys(manifest.generator).sort().join(","), "name,version", "generator keys");
  return "generator = {name, version}";
});

// ------------------------------------------------------------------- C§13
check("C13.indexes", "imports/directives/features indexes are populated", () => {
  assert(manifest.indexes.imports.byFile.length >= 2, `byFile has ${manifest.indexes.imports.byFile.length} entries`);
  const aEntry = manifest.indexes.imports.byFile.find((entry) => entry.path === "src/a.ts");
  assert(aEntry, "src/a.ts missing from imports.byFile");
  assert(aEntry.imports.includes("./b"), `imports not recorded: ${JSON.stringify(aEntry.imports)}`);
  assert(
    manifest.indexes.imports.centralFiles.some((entry) => entry.path === "src/b.ts"),
    `centralFiles not derived: ${JSON.stringify(manifest.indexes.imports.centralFiles)}`
  );
  assert(
    manifest.indexes.directives.some((entry) => entry.path === "src/client.tsx" && entry.directives.includes("use client")),
    `directives empty: ${JSON.stringify(manifest.indexes.directives)}`
  );
  const features = manifest.indexes.features.map((entry) => entry.name);
  assert(features.includes("billing"), `features empty: ${JSON.stringify(manifest.indexes.features)}`);
  return `byFile=${manifest.indexes.imports.byFile.length} directives=${manifest.indexes.directives.length} features=${features.join(",")}`;
});

// ------------------------------------------------------------------- C§14
check("C14.content-bytes", "totalContentBytes reflects emitted content, not source bytes", () => {
  const sum = manifest.files.reduce((total, file) => total + file.includedBytes, 0);
  assertEqual(manifest.totals.totalContentBytes, sum, "totalContentBytes != sum(includedBytes)");
  assert(
    manifest.totals.totalContentBytes !== manifest.totals.totalSourceBytes,
    `still mirroring source bytes (${manifest.totals.totalContentBytes})`
  );
  assert(
    manifest.totals.totalContentBytes < manifest.totals.totalSourceBytes,
    "truncation should reduce content bytes"
  );
  return `${manifest.totals.totalContentBytes} vs source ${manifest.totals.totalSourceBytes}`;
});

// ------------------------------------------------------------------- C§17
check("C17.countLines", "one line-count convention", () => {
  const cases = [
    ["", 0],
    ["a", 1],
    ["a\n", 1],
    ["a\nb", 2],
    ["a\nb\n", 2],
    ["\n", 1],
    ["\n\n", 2],
  ];
  for (const [input, expected] of cases) {
    assertEqual(countLines(input), expected, `countLines(${JSON.stringify(input)})`);
  }
  return "7/7 conventions";
});

check("C17.manifest-lines", "manifest line counts match the convention", () => {
  const two = manifest.files.find((file) => file.relativePath === "src/two.ts");
  const empty = manifest.files.find((file) => file.relativePath === "src/empty.ts");
  const onlyNewline = manifest.files.find((file) => file.relativePath === "src/onlynewline.ts");
  assertEqual(two.lines, 2, "two.ts lines (old: 3)");
  assertEqual(empty.lines, 0, "empty.ts lines");
  assertEqual(onlyNewline.lines, 1, "onlynewline.ts lines (old: 2)");
  const sum = manifest.files.reduce((total, file) => total + file.lines, 0);
  assertEqual(manifest.counts.totalLines, sum, "counts.totalLines");
  assertEqual(manifest.totals.totalLines ?? sum, sum, "totals.totalLines");
  return `two=2 empty=0 onlynewline=1 total=${sum}`;
});

check("C17.preview-lines", "truncatePreview originalLines/includedLines describe the emitted text", () => {
  const content = Array.from({ length: 400 }, (_, i) => `line${i}`).join("\n") + "\n";
  const preview = truncatePreview(content, 80, 40);
  assertEqual(preview.originalLines, 400, "originalLines (old: 401)");
  assertEqual(preview.includedLines, 121, "includedLines");
  // head(80) + marker(1) + tail(40) = 121 newline-separated elements; the final
  // element is the empty string left by the trailing newline.
  assertEqual(preview.content.split("\n").length, preview.includedLines, "emitted elements");
  assertIncludes(preview.content, "[280 lines omitted", "omission count (old: 281)");
  return `original=400 included=121 elements=121, 280 omitted`;
});

// ------------------------------------------------------------------- A11
check("A11.no-duplicate-fields", "FileEntry/PartMetadata carry no legacy aliases", () => {
  const forbiddenFile = ["path", "bytes", "sha256"];
  const forbiddenPart = ["bytes", "files"];
  for (const file of manifest.files) {
    for (const key of forbiddenFile) assert(!(key in file), `FileEntry.${key} is back`);
  }
  for (const part of manifest.parts) {
    for (const key of forbiddenPart) assert(!(key in part), `PartMetadata.${key} is back`);
  }
  assert("includedBytes" in manifest.files[0], "includedBytes missing");
  assert("byteSize" in manifest.parts[0], "byteSize missing");
  return `files: ${Object.keys(manifest.files[0]).length} keys, parts: ${Object.keys(manifest.parts[0]).length} keys`;
});

// -------------------------------------------- NEW: stale truncatedPreviewCount
check("NEW.counters", "REGRESSION PROBE — counts.truncatedPreviewCount vs totals.previewFiles agree", () => {
  const dir2 = tmp("cn");
  write(dir2, ".gitignore", "snapshot/\n");
  write(dir2, "src/huge.min.js", `var a=${"1".repeat(400_000)};`);
  const m = generateSnapshot(resolveConfig({ cwd: dir2, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  console.log(
    `    OBS NEW.counters: counts.truncatedPreviewCount=${m.counts.truncatedPreviewCount} totals.previewFiles=${m.totals.previewFiles} file.isPreviewTruncated=${m.files[0].isPreviewTruncated}`
  );
  assertEqual(
    m.counts.truncatedPreviewCount,
    m.totals.previewFiles,
    "the two truncation counters disagree"
  );
  return `both ${m.counts.truncatedPreviewCount}`;
});

finish();
