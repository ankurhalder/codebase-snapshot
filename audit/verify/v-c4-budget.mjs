// C§4 (02 §4 / H4, HIGH) — `maxPartBytes` was not a bound: the flush check was
// skipped for an empty chunk, so a single 4.16 MB one-line file produced a part
// 13.54x over a 307 KB budget.
//
// Check: every emitted part file must be <= maxPartBytes for a matrix of shapes
// (one huge line, budget floor, exact boundary, many tiny files, 4-byte UTF-8,
// long path, summary-heavy file).
import * as fs from "node:fs";
import * as path from "node:path";
import { generateSnapshot, partitionFiles, resolveConfig } from "../../dist/index.js";
import {
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

function makeEntry(relativePath) {
  return {
    relativePath,
    sizeBytes: 20,
    lines: 1,
    hashSha256: "0".repeat(64),
    part: "",
    layer: "src",
    kind: "source",
    language: "typescript",
    inclusionMode: "full",
    isLarge: false,
    isPreviewTruncated: false,
    originalLines: 1,
    includedLines: 1,
    includedBytes: 20,
    content: "export const a = 1;\n",
  };
}
function partsOf(dir) {
  const tree = readTree(path.join(dir, "snapshot", "parts"), { encoding: "buffer" });
  return Object.entries(tree).map(([name, buffer]) => ({ name, bytes: buffer.length, buffer }));
}

function generateAndMeasure(dir, overrides) {
  const manifest = generateSnapshot(
    resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", ...overrides })
  );
  const parts = partsOf(dir);
  return { manifest, parts, budget: manifest.budgets.maxPartBytes };
}

check("C4.huge-line", "a 4.16 MB single-line file now fits the 307 KB budget", () => {
  const dir = tmp("c4a");
  write(dir, "src/vendor.min.js", `var a=${"1".repeat(4_160_000)};`);
  write(dir, "src/control.ts", "export const a = 1;\n");
  const { manifest, parts, budget } = generateAndMeasure(dir, {});
  const worst = Math.max(...parts.map((part) => part.bytes));
  const over = parts.filter((part) => part.bytes > budget);
  assertEqual(over.length, 0, `${over.length} part(s) over budget (worst ${worst} B vs ${budget} B)`);
  assert(manifest.counts.truncatedPreviewCount >= 1, "the oversized section was not marked truncated");
  return `worst part ${worst} B vs budget ${budget} B (old: 4,160,812 B = 13.54x)`;
});

check("C4.huge-line-content", "the truncated part keeps head content and does not split UTF-8", () => {
  const dir = tmp("c4b");
  const emoji = "🚀".repeat(150_000); // 600 KB of 4-byte characters
  write(dir, "src/emoji.txt", `${emoji}\n`);
  const { parts, budget } = generateAndMeasure(dir, {});
  for (const part of parts) assert(part.bytes <= budget, `${part.name} is ${part.bytes} > ${budget}`);
  const body = parts.map((part) => part.buffer.toString("utf8")).join("");
  assert(!body.includes("\uFFFD"), "a multi-byte character was split (U+FFFD emitted)");
  assert(body.includes("🚀"), "the content disappeared entirely");
  return `${parts.length} part(s), all <= ${budget} B, no U+FFFD`;
});

check("C4.boundary", "content sized to land exactly on the budget boundary stays inside it", () => {
  const budget = 4096;
  // Grow the body until the rendered part is just under the budget.
  let best = null;
  for (const size of [2000, 2400, 2600, 2800, 3000, 3200, 3400, 3600]) {
    const dir = tmp("c4c");
    write(dir, "src/a.txt", "x".repeat(size));
    const { parts } = generateAndMeasure(dir, { maxPartBytes: budget, largeFileBytes: 10_000_000 });
    const worst = Math.max(...parts.map((part) => part.bytes));
    best = { size, worst };
    assert(worst <= budget, `body ${size} produced a ${worst} B part (budget ${budget})`);
  }
  return `bodies 2000-3600 B all fit 4096 B (closest ${best.worst} B)`;
});

check("C4.floor-4096", "the CLI minimum budget (4096) is respected for a multi-file repo", () => {
  const dir = tmp("c4d");
  for (let index = 0; index < 40; index += 1) {
    write(dir, `src/f${String(index).padStart(2, "0")}.ts`, `export const value${index} = ${index};\n`.repeat(20));
  }
  const { parts, budget, manifest } = generateAndMeasure(dir, { maxPartBytes: 4096 });
  assertEqual(budget, 4096, "budget");
  const over = parts.filter((part) => part.bytes > budget);
  assertEqual(over.length, 0, `${over.length} parts over 4096: ${over.map((p) => `${p.name}=${p.bytes}`).join(" ")}`);
  assertEqual(manifest.validation.status, "passed", `validation errors: ${manifest.validation.errors.join("; ")}`);
  return `${parts.length} parts, worst ${Math.max(...parts.map((p) => p.bytes))} B <= 4096 B`;
});

check("C4.many-tiny", "many tiny files fill the budget instead of wasting it", () => {
  const dir = tmp("c4e");
  for (let index = 0; index < 400; index += 1) {
    write(dir, `src/t${String(index).padStart(3, "0")}.ts`, `export const v${index} = ${index};\n`);
  }
  const { parts, budget } = generateAndMeasure(dir, { maxPartBytes: 102_400 });
  for (const part of parts) assert(part.bytes <= budget, `${part.name} ${part.bytes} > ${budget}`);
  const fill = parts.slice(0, -1).map((part) => part.bytes / budget);
  const worstFill = Math.min(...fill, 1);
  assert(parts.length > 1, "expected multiple parts");
  assert(worstFill > 0.85, `non-final parts only ${(worstFill * 100).toFixed(0)}% full (old reserve wasted 45%)`);
  return `${parts.length} parts, min fill ${(worstFill * 100).toFixed(0)}% (old: 55%)`;
});

check("C4.long-path", "a near-maximum-length path still produces a within-budget part", () => {
  const dir = tmp("c4f");
  const deep = Array.from({ length: 8 }, (_, i) => `directory${i}`).join("/");
  const name = `${deep}/${"n".repeat(120)}.ts`;
  write(dir, `src/${name}`, `export const a = "${"z".repeat(20_000)}";\n`);
  const { parts, budget } = generateAndMeasure(dir, { maxPartBytes: 4096 });
  assertEqual(parts.length >= 1, true, "no parts");
  for (const part of parts) assert(part.bytes <= budget, `${part.name} ${part.bytes} > ${budget}`);
  return `path ${path.posix.basename(name).length} B, parts <= ${budget} B`;
});

check("C4.byteSize-exact", "recorded part byteSize equals the file size on disk (claim A)", () => {
  const dir = tmp("c4g");
  for (let index = 0; index < 12; index += 1) write(dir, `src/f${index}.ts`, `export const v${index} = ${index};\n`.repeat(400));
  const { manifest } = generateAndMeasure(dir, { maxPartBytes: 8192 });
  const mismatched = [];
  for (const part of manifest.parts) {
    const stat = fs.statSync(path.join(dir, "snapshot/parts", part.filename));
    if (stat.size !== part.byteSize) mismatched.push(`${part.filename}: ${part.byteSize} != ${stat.size}`);
  }
  assertEqual(mismatched.length, 0, mismatched.join(", "));
  return `${manifest.parts.length} parts, byteSize exact`;
});

check("C4.summary-metadata", "a file whose SUMMARY alone exceeds the budget is still bounded", () => {
  const dir = tmp("c4h");
  // One markdown heading of 400 KB: the body is truncated, but the summary is
  // rendered from the untruncated heading and is emitted into the part.
  write(dir, "docs/huge.md", `# ${"A".repeat(400_000)}\n`);
  const { manifest, parts, budget } = generateAndMeasure(dir, { maxPartBytes: 307_200 });
  const worst = Math.max(...parts.map((part) => part.bytes));
  const huge = manifest.files.find((file) => file.relativePath === "docs/huge.md");
  console.log(
    `    OBS C4.summary-metadata: worst part=${worst} B budget=${budget} ratio=${(worst / budget).toFixed(2)}x status=${manifest.validation.status} summaryOmitted=${huge?.summaryOmitted}`
  );
  const over = parts.filter((part) => part.bytes > budget);
  assertEqual(over.length, 0, `summary metadata pushed ${over.length} part(s) over budget (${over.map((p) => `${p.name}=${p.bytes}`).join(", ")})`);
  assertEqual(huge?.summaryOmitted, true, "the summary was not marked omitted");
  const body = parts.map((part) => part.buffer.toString("utf8")).join("");
  assertIncludes(body, "Summary: (omitted", "the omission is not visible in the part");
  // The body now legitimately keeps most of the 400 KB heading; what must not
  // happen is the heading AND the summary both landing in one part.
  assert(body.includes("A".repeat(5000)), "the body was over-truncated again");
  assert(!body.includes("A".repeat(398_000)), "the full 400 KB heading was emitted");
  return `worst ${worst} B <= ${budget} B, summary dropped, body retained`;
});

check("C4.summary-adversarial", "small summary + huge path + 4096 B budget stays bounded", () => {
  const dir = tmp("c4h2");
  const deep = Array.from({ length: 9 }, (_, i) => `dir${i}`).join("/");
  write(dir, `src/${deep}/${"n".repeat(100)}.md`, `# short\n\n${"body ".repeat(4000)}\n`);
  const { parts, budget } = generateAndMeasure(dir, { maxPartBytes: 4096 });
  for (const part of parts) assert(part.bytes <= budget, `${part.name}=${part.bytes} > ${budget}`);
  return `${parts.length} part(s) <= 4096 B with a ${100 + deep.length} char path`;
});

check("C4.fixed-metadata", "FIXED — a 6,000-char layer name no longer breaks a 4096 B budget", () => {
  // The section header renders `- Layer: <name>`; the value is now capped at 200
  // chars and the section is hard-truncated as a last resort.
  const dir = tmp("c4h3");
  write(dir, "src/a.ts", "export const a = 1;\n");
  const { manifest, parts, budget } = generateAndMeasure(dir, {
    maxPartBytes: 4096,
    layers: [{ name: "L".repeat(6000), match: () => true }],
  });
  const worst = Math.max(...parts.map((part) => part.bytes));
  console.log(
    `    OBS C4.fixed-metadata: worst part=${worst} B budget=${budget} status=${manifest.validation.status} errors=${manifest.validation.errors.length}`
  );
  const over = parts.filter((part) => part.bytes > budget);
  assertEqual(over.length, 0, `fixed metadata pushed ${over.length} part(s) over budget (${over.map((p) => `${p.name}=${p.bytes}`).join(", ")})`);
  assertEqual(manifest.validation.status, "passed", `validation: ${manifest.validation.errors.join("; ")}`);
  assert(!parts.some((part) => part.buffer.toString("utf8").includes("L".repeat(1000))), "the 6 KB layer name is still emitted whole");
  return `worst ${worst} B <= ${budget} B, status passed (was 12,588 B / failed)`;
});

check("C4.fixed-metadata-kind", "a 10,000-char kind name is bounded at a 4096 B budget", () => {
  const dir = tmp("c4h5");
  write(dir, "src/a.ts", "export const a = 1;\n");
  const { manifest, parts, budget } = generateAndMeasure(dir, {
    maxPartBytes: 4096,
    kinds: [{ kind: "K".repeat(10_000), match: () => true }],
  });
  const worst = Math.max(...parts.map((part) => part.bytes));
  console.log(`    OBS C4.fixed-metadata-kind: worst=${worst} B budget=${budget} status=${manifest.validation.status}`);
  for (const part of parts) assert(part.bytes <= budget, `${part.name}=${part.bytes} > ${budget}`);
  return `worst ${worst} B <= ${budget} B`;
});

check("C4.fixed-metadata-path", "a 10,000-char path is bounded and kept whole in includedFiles", () => {
  // Windows cannot create a 10 KB path, so this drives the partitioner directly.
  const longPath = `src/${"p".repeat(10_000)}.ts`;
  const entry = makeEntry(longPath);
  const budget = 4096;
  const parts = partitionFiles([entry], budget, "fp");
  const worst = Math.max(...parts.map((part) => Buffer.byteLength(part.markdown, "utf8")));
  const markdown = parts.map((part) => part.markdown).join("");
  const recorded = parts[0].metadata.includedFiles[0].relativePath;
  const anchorLine = markdown.split("\n").find((line) => line.startsWith("<a id=")) ?? "";
  console.log(
    `    OBS C4.fixed-metadata-path: worst=${worst} B budget=${budget} recordedPathLen=${recorded.length} anchorLen=${anchorLine.length} sectionTruncated=${markdown.includes("section truncated")}`
  );
  assert(worst <= budget, `part is ${worst} B for a ${budget} B budget`);
  assertEqual(recorded, longPath, "includedFiles[].relativePath must keep the full path");
  // Recorded, not scored (unreachable on Windows): `anchorForPath` slugs the FULL
  // path, so a 10 KB path spends the budget on the anchor and the section is
  // hard-truncated before the elided heading is rendered. The bound still holds.
  assert(markdown.includes("section truncated"), "expected the fixed-metadata truncation notice");
  return `worst ${worst} B, full path kept, anchor ${anchorLine.length} chars, section truncated`;
});

check("C4.fixed-metadata-path-elision", "a path above the display cap renders middle-elided", () => {
  const longPath = `src/${"q".repeat(400)}.ts`; // 407 chars, above the 300-char cap
  const parts = partitionFiles([makeEntry(longPath)], 4096, "fp");
  const markdown = parts[0].markdown;
  const fileLine = markdown.split("\n").find((line) => line.startsWith("### FILE:")) ?? "";
  const listEntry = markdown.split("\n").find((line) => line.startsWith("src/")) ?? "";
  console.log(
    `    OBS C4.fixed-metadata-path-elision: fileLineLen=${fileLine.length} elided=${fileLine.includes("…")} listEntryLen=${listEntry.length} part=${Buffer.byteLength(markdown, "utf8")} B`
  );
  assert(fileLine.includes("…"), `the heading was not elided (${fileLine.length} chars)`);
  assert(fileLine.length <= 320, `heading is ${fileLine.length} chars`);
  assert(listEntry.length <= 310, `file list entry is ${listEntry.length} chars`);
  assertEqual(parts[0].metadata.includedFiles[0].relativePath, longPath, "full path in metadata");
  return `heading ${fileLine.length} chars with …, list entry ${listEntry.length} chars`;
});

check("C4.fixed-metadata-many", "every file carrying a huge layer name still fits the cumulative header", () => {
  const dir = tmp("c4h6");
  for (let index = 0; index < 30; index += 1) {
    write(dir, `src/f${String(index).padStart(2, "0")}.ts`, `export const v${index} = ${index};\n`);
  }
  const { manifest, parts, budget } = generateAndMeasure(dir, {
    maxPartBytes: 4096,
    layers: [{ name: `L${"x".repeat(6000)}`, match: () => true }],
  });
  const worst = Math.max(...parts.map((part) => part.bytes));
  console.log(
    `    OBS C4.fixed-metadata-many: parts=${parts.length} worst=${worst} B budget=${budget} status=${manifest.validation.status}`
  );
  for (const part of parts) assert(part.bytes <= budget, `${part.name}=${part.bytes} > ${budget}`);
  assert(parts.length > 1, "the 30 files were packed into a single part");
  return `${parts.length} parts, worst ${worst} B <= ${budget} B`;
});

check("C4.counters", "counts.truncatedPreviewCount equals totals.previewFiles across configs", () => {
  const cases = [
    ["default", {}],
    ["largeFileBytes huge + small budget", { largeFileBytes: 100_000_000, maxPartBytes: 4096 }],
    ["largeFileBytes tiny", { largeFileBytes: 10, maxPartBytes: 307_200 }],
    ["both", { largeFileBytes: 200, maxPartBytes: 5120 }],
  ];
  const rows = [];
  for (const [label, overrides] of cases) {
    const dir = tmp("c4k");
    write(dir, "src/big.min.js", `var a=${"7".repeat(600_000)};`);
    write(dir, "src/lines.ts", Array.from({ length: 400 }, (_, i) => `export const l${i} = ${i};`).join("\n"));
    write(dir, "src/small.ts", "export const s = 1;\n");
    const { manifest, parts, budget } = generateAndMeasure(dir, overrides);
    assertEqual(
      manifest.counts.truncatedPreviewCount,
      manifest.totals.previewFiles,
      `${label}: truncatedPreviewCount != previewFiles`
    );
    for (const part of parts) assert(part.bytes <= budget, `${label}: ${part.name} ${part.bytes} > ${budget}`);
    rows.push(`${label}=${manifest.counts.truncatedPreviewCount}`);
  }
  return rows.join(", ");
});

check("C4.floor-rejected", "a sub-floor budget is rejected loudly (intended API floor)", () => {
  let message = "";
  try {
    resolveConfig({ cwd: tmp("c4l"), maxPartBytes: 100 });
  } catch (err) {
    message = err.message;
  }
  assertIncludes(message, "maxPartBytes must be at least 4096 bytes", "error text");
  return message;
});

check("C4.summary-drop-body", "FIXED — dropping the summary reclaims the room for the body", () => {
  // Previously the body was truncated while the summary still counted as
  // overhead, then the summary was dropped without re-fitting: 0 B emitted.
  const dir = tmp("c4h4");
  write(dir, "docs/huge.md", `# ${"A".repeat(400_000)}\n`);
  write(dir, "docs/plain.txt", "B".repeat(400_000));
  const { manifest, parts } = generateAndMeasure(dir, { maxPartBytes: 307_200 });
  const huge = manifest.files.find((file) => file.relativePath === "docs/huge.md");
  const plain = manifest.files.find((file) => file.relativePath === "docs/plain.txt");
  console.log(
    `    OBS C4.summary-drop-body: summary file emitted ${huge.includedBytes} B of ${huge.sizeBytes} B; control .txt emitted ${plain.includedBytes} B; budget ${manifest.budgets.maxPartBytes}`
  );
  assert(
    huge.includedBytes > 0.5 * (manifest.budgets.maxPartBytes - 2048),
    `body was truncated to ${huge.includedBytes} B although ~${manifest.budgets.maxPartBytes - 2048} B was available`
  );
  assertEqual(parts.length, 2, "part count");
  const body = parts.map((part) => part.buffer.toString("utf8")).join("");
  assert(body.includes("A".repeat(10_000)), "the reclaimed body text is missing from the part");
  return `${huge.includedBytes} B emitted (was 0 B)`;
});

check("C4.summary-drop-tail", "the emitted body still reaches the END of a summary-heavy file", () => {
  // The huge headings sit in the MIDDLE (so the line-based preview keeps short
  // head/tail lines), the summary of those headings exceeds the budget, and the
  // body must therefore fit — with its tail — after the summary is dropped.
  const dir = tmp("c4h7");
  const placeholder = "PLACEHOLDER"; // inserted below
  const lines = [];
  for (let index = 0; index < 60; index += 1) lines.push(`short head line ${index}`);
  for (let index = 0; index < 40; index += 1) lines.push(`## ${"H".repeat(7990)} ${index}`);
  for (let index = 0; index < 60; index += 1) lines.push(`short tail line ${index}`);
  lines.push("TAILMARKER_UNIQUE_XYZ");
  write(dir, "docs/huge-tail.md", `${lines.join("\n")}\n`);
  const { manifest, parts, budget } = generateAndMeasure(dir, { maxPartBytes: 307_200 });
  const file = manifest.files.find((entry) => entry.relativePath === "docs/huge-tail.md");
  const body = parts.map((part) => part.buffer.toString("utf8")).join("");
  console.log(
    `    OBS C4.summary-drop-tail: size=${file.sizeBytes} includedBytes=${file.includedBytes} omittoed=${file.summaryOmitted} truncated=${file.isPreviewTruncated} tailPresent=${body.includes("TAILMARKER_UNIQUE_XYZ")} budget=${budget}`
  );
  void placeholder;
  assertEqual(file.summaryOmitted, true, "the summary was not dropped for this fixture");
  assert(body.includes("TAILMARKER_UNIQUE_XYZ"), "the end of the file was lost");
  assert(body.includes("short head line 0"), "the head of the file was lost");
  return `head + tail present, body ${file.includedBytes} B`;
});

check("C4.summary-drop-many", "a file with 20,000 exported symbols (huge summary) keeps its body", () => {
  const dir = tmp("c4h8");
  // largeFileBytes is raised so the line-based preview does not pre-shrink the
  // body; the summary alone must be what forces the drop.
  write(dir, "src/many.ts", Array.from({ length: 20_000 }, (_, i) => `export const v${i} = ${i};`).join("\n"));
  const { manifest, parts } = generateAndMeasure(dir, {
    maxPartBytes: 307_200,
    largeFileBytes: 10_000_000,
  });
  const file = manifest.files.find((entry) => entry.relativePath === "src/many.ts");
  const body = parts.map((part) => part.buffer.toString("utf8")).join("");
  console.log(
    `    OBS C4.summary-drop-many: size=${file.sizeBytes} includedBytes=${file.includedBytes} summaryOmitted=${file.summaryOmitted} status=${manifest.validation.status} parts=${parts.length}`
  );
  assert(file.includedBytes > 100_000, `only ${file.includedBytes} B of body emitted`);
  assert(body.includes("export const v0 = 0;"), "head missing");
  // Byte truncation is front-anchored, so the tail is only expected when the body
  // fits; here it does not, which is the correct trade-off.
  return `${file.includedBytes} B of body emitted, head present, front-anchored truncation`;
});

finish();


