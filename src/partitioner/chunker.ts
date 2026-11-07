import * as crypto from "node:crypto";
import { countLines, truncateToBytes } from "./preview.js";
import { escapeControls, UNTRUSTED_CONTENT_NOTICE } from "../terminal.js";
import { estimateTokens, formatTokens } from "../tokenize.js";
import type { FileEntry, PartFileEntry, PartMetadata } from "../types.js";

export interface PartitionedPart {
  filename: string;
  markdown: string;
  metadata: PartMetadata;
}

/**
 * Worst-case header overhead for a chunk: title, prev/next, counts, fingerprint,
 * the capped layer/kind summary lines and the untrusted-content notice.
 * Reserving it up front guarantees that a chunk holding a single pre-truncated
 * file always fits.
 */
const HEADER_RESERVE_BYTES = 2048 + Buffer.byteLength(UNTRUSTED_CONTENT_NOTICE, "utf8") + 8;
const MIN_SECTION_BUDGET_BYTES = 512;
const MAX_SPLIT_PASSES = 64;

/** Bytes reserved for the `[N lines omitted]` notice a budget-cut body must carry. */
const BUDGET_MARKER_RESERVE = 96;

/**
 * Inserts the token line under the file count.
 *
 * The estimate is taken on the part *without* this line and then states itself, so the
 * header and the manifest always carry the same number. Folding the line into its own
 * estimate made them disagree by one, because writing the digits changes the count that is
 * being written — a ~10-token difference either way, in a number that is labelled an
 * estimate, and an exact match between two places that claim the same thing is worth more
 * than the last digit.
 */
function insertTokenLine(markdown: string, tokens: number): string {
  return markdown.replace(
    /^(- Files: .*)$/m,
    `$1\n- Estimated Tokens: ~${formatTokens(tokens)}`
  );
}

/**
 * Rewrites the headline token estimate in place, or inserts it when the header has none.
 *
 * `insertTokenLine` only ever inserts, so calling it on a part that already carries the line
 * would emit two of them.
 */
function replaceTokenLine(markdown: string, tokens: number): string {
  const line = `- Estimated Tokens: ~${formatTokens(tokens)}`;
  if (/^- Estimated Tokens: .*$/m.test(markdown)) {
    return markdown.replace(/^- Estimated Tokens: .*$/m, line);
  }
  return insertTokenLine(markdown, tokens);
}

/** Recognises a marker already appended, so a second shrink does not cut it in half. */
const BUDGET_MARKER_SUFFIX = /\n\.\.\. \[\d+ lines omitted: part budget \d+ B\] \.\.\.$/;

/** The headline token estimate, rewritten in place after a part is clipped. */
const TOKEN_LINE = /^- Estimated Tokens: .*$/m;

/**
 * Room reserved for rewriting {@link TOKEN_LINE} after a part has been clipped to its budget.
 *
 * Clipping happens at `budget - marker`, and fixing the token count afterwards changes the
 * header: the new number is not always as wide as the old one (`~99` grows to `~100`), and when
 * the clip cut the header itself away, `replaceTokenLine` falls back to *inserting* the line —
 * about 28 bytes that were not in the clipped text. Reserving the room is what keeps the byte
 * bound a guarantee instead of an aspiration; both clip sites subtract it.
 */
const TOKEN_LINE_SLACK = 32;

interface PreparedSection {
  file: FileEntry;
  text: string;
  byteSize: number;
}

/**
 * Truncates to `maxBytes` and appends the omission notice the preview route has always carried.
 *
 * The marker is mandatory (item 8): a body cut by the part budget with no marker reads like a
 * complete file, and an agent counting lines has no way to see the cut. `budget` names the byte
 * budget that forced it, so a reader can tell `largeFileBytes` from `maxPartBytes`.
 *
 * `originalLines` is the file's real line count, not the count of what is being cut down
 * here. A large file arrives already reduced to a head/tail preview, and measuring the
 * omission against *that* string counted only the second cut — a 5,000-line file reduced
 * to 120 preview lines and then to 40 told the reader "80 lines omitted" when 4,960 were
 * missing. The number has to describe the file, because that is the question a reader
 * asks of it.
 */
function truncateWithBudgetMarker(
  content: string,
  maxBytes: number,
  budget: number,
  originalLines: number
): { content: string; isTruncated: boolean } {
  const base = content.replace(BUDGET_MARKER_SUFFIX, "");
  const truncated = truncateToBytes(base, Math.max(0, maxBytes));
  if (!truncated.isTruncated) return { content: base, isTruncated: false };
  const keptLines = countLines(truncated.content);
  const omitted = Math.max(1, Math.max(countLines(base), originalLines) - keptLines);
  return {
    content: `${truncated.content}\n... [${omitted} lines omitted: part budget ${budget} B] ...`,
    isTruncated: true,
  };
}

/**
 * Partitions rendered file sections into byte-bounded parts.
 *
 * The budget is a hard bound: a section that cannot fit into a part on its own
 * is byte-truncated (and marked `isPreviewTruncated`) rather than emitted whole.
 * The previous implementation skipped the flush check for an empty chunk, so one
 * large file produced a part 13.5x over the configured budget.
 */
export function partitionFiles(
  files: FileEntry[],
  maxPartBytes: number,
  contentFingerprint?: string
): PartitionedPart[] {
  if (files.length === 0) return [];

  const budget = Math.max(MIN_SECTION_BUDGET_BYTES + HEADER_RESERVE_BYTES, maxPartBytes);
  const sectionBudget = budget - HEADER_RESERVE_BYTES;

  const prepared = files.map((file) => prepareSection(file, sectionBudget));

  let groups = greedyGroups(prepared, budget);

  for (let pass = 0; pass < MAX_SPLIT_PASSES; pass++) {
    const rendered = renderGroups(groups, budget, contentFingerprint);
    const oversized = rendered.findIndex((part) => part.metadata.byteSize > budget);
    if (oversized === -1) return rendered;

    const group = groups[oversized];
    if (group.length > 1) {
      const moved = group.pop() as PreparedSection;
      groups.splice(oversized + 1, 0, [moved]);
      continue;
    }

    // A single section still exceeds the budget (its metadata alone is huge):
    // shrink the body until it fits.
    const [section] = group;
    const overflow = rendered[oversized].metadata.byteSize - budget;
    const currentContent = section.file.content ?? "";
    const shrinkTo = Math.max(
      0,
      Buffer.byteLength(currentContent, "utf8") - overflow - BUDGET_MARKER_RESERVE
    );
    const shrunk = truncateWithBudgetMarker(
      currentContent,
      shrinkTo,
      budget,
      section.file.originalLines
    );
    if (shrunk.isTruncated) {
      applyTruncatedContent(section.file, shrunk.content);
      section.text = renderFileSection(section.file);
      section.byteSize = Buffer.byteLength(section.text, "utf8");
      continue;
    }

    // Last resort: the single section still does not fit, so hard-truncate the
    // rendered part. The byte bound is a guarantee, not an aspiration — which includes the
    // token line {@link rehashPart} rewrites below, so the same room is held back here as in
    // `enforceBudget`. Without it a part clipped exactly to budget came out over it whenever the
    // rewoven estimate was a digit wider.
    const marker = TRUNCATION_MARKER;
    assertBudgetHoldsMarker(budget);
    const target = Math.max(
      0,
      budget - Buffer.byteLength(marker, "utf8") - TOKEN_LINE_SLACK
    );
    const clipped = truncateToBytes(rendered[oversized].markdown, target);
    rendered[oversized] = rehashPart(rendered[oversized], clipped.content + marker);
    return rendered;
  }

  // The split-pass budget is exhausted (or every remaining group is a single
  // section). Clip anything still over budget so the byte bound is a guarantee
  // rather than a best effort.
  return enforceBudget(renderGroups(groups, budget, contentFingerprint), budget);
}

/** Hard-clips any part that is still above `budget`, re-hashing what it wrote. */
/**
 * Hard-clips any part that is still above `budget`, re-hashing what it wrote.
 *
 * Exported so the clip path can be tested at all: the partitioner splits oversized sections
 * rather than clipping them, so no ordinary fixture reaches this branch, and the stale token
 * count it used to leave behind was therefore invisible to every end-to-end test.
 */
/** Appended to a part that had to be cut because it could not fit its budget. */
const TRUNCATION_MARKER = "\n... [part truncated: cannot fit budget] ...\n";

/**
 * Refuses a budget that cannot hold the notice a truncated part is required to carry.
 *
 * Below this ceiling the two obligations are contradictory: the part must fit, and a part that was
 * cut must say so. Keeping its own marker after the cut means the smallest honest part is the
 * marker itself, so a budget under its length cannot be honoured — and returning a part that is
 * bigger than the budget it was clipped to is the one thing a byte bound may not do. A configured
 * budget cannot request this (`--max-part-bytes` has a floor of 4096), so this is a guard for
 * direct callers of `partitionFiles` and `enforceBudget`.
 */
function assertBudgetHoldsMarker(budget: number): void {
  const minimum = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  if (budget < minimum) {
    throw new Error(
      `A part budget of ${budget} B cannot hold the truncation notice (${minimum} B), so a ` +
        "clipped part could not fit and still say it was clipped. Use a budget of at least " +
        `${minimum} B.`
    );
  }
}

/**
 * Hard-clips any part that is still above `budget`, re-hashing what it wrote.
 *
 * Exported so the clip path can be tested at all: the partitioner splits oversized sections
 * rather than clipping them, so no ordinary fixture reaches this branch, and the stale token
 * count it used to leave behind was therefore invisible to every end-to-end test.
 */
export function enforceBudget(parts: PartitionedPart[], budget: number): PartitionedPart[] {
  const target = Math.max(
    0,
    budget - Buffer.byteLength(TRUNCATION_MARKER, "utf8") - TOKEN_LINE_SLACK
  );

  return parts.map((part) => {
    if (part.metadata.byteSize <= budget) return part;
    assertBudgetHoldsMarker(budget);
    const clipped = truncateToBytes(part.markdown, target);
    return rehashPart(part, clipped.content + TRUNCATION_MARKER);
  });
}

/**
 * Re-numbers a set of parts as one sequence and rewrites their headers.
 *
 * Needed when parts are produced by more than one partition pass (per-layer
 * budgets): each pass numbers from `part-001`, so the merged set would otherwise
 * contain duplicate filenames and every `Previous:`/`Next:` link would lie.
 */
export function renumberParts(
  parts: PartitionedPart[],
  contentFingerprint?: string
): PartitionedPart[] {
  const total = parts.length;
  if (total === 0) return [];

  const zeroPad = (index: number): string =>
    String(index).padStart(Math.max(3, String(total).length), "0");
  const nameFor = (position: number): string => `part-${zeroPad(position)}.md`;
  const marker = "## Contents\n";

  const renumbered = parts.map((part, index) => {
    const markerIndex = part.markdown.indexOf(marker);
    const body = markerIndex === -1 ? "" : part.markdown.slice(markerIndex + marker.length);    const included = part.metadata.includedFiles;
    if (markerIndex === -1) {
      throw new Error(`${part.filename} has no "## Contents" section to re-number.`);
    }

    const layerCounts: Record<string, number> = {};
    const kindCounts: Record<string, number> = {};
    for (const file of included) {
      layerCounts[file.layer] = (layerCounts[file.layer] || 0) + 1;
      kindCounts[file.kind] = (kindCounts[file.kind] || 0) + 1;
    }

    const pathLines = included.map((file) => displayPath(file.relativePath));
    const listFence = fenceForText(pathLines.join("\n"), 3);

    const header = [
      `# Codebase Snapshot Part ${zeroPad(index + 1)} of ${zeroPad(total)}`,
      "",
      `- Previous: ${index === 0 ? "none" : nameFor(index)}`,
      `- Next: ${index === total - 1 ? "none" : nameFor(index + 2)}`,
      `- Files: ${included.length}`,
      `- Content Fingerprint: ${contentFingerprint || "none"}`,
      `- Layers: ${topEntries(layerCounts, 6) || "none"}`,
      `- Kinds: ${topEntries(kindCounts, 8) || "none"}`,
      "",
      UNTRUSTED_CONTENT_NOTICE,
      "",
      "## Files",
      "",
      `${listFence}text`,
      ...pathLines,
      listFence,
      "",
      "## Contents",
      "",
    ].join("\n");

    const assembled = (header + body).replace(/\r\n/g, "\n");
    const estimatedTokens = estimateTokens(assembled);
    const markdown = insertTokenLine(assembled, estimatedTokens);
    const metadata: PartMetadata = {
      ...part.metadata,
      index: index + 1,
      filename: nameFor(index + 1),
      byteSize: Buffer.byteLength(markdown, "utf8"),
      estimatedTokens,
      sha256: crypto.createHash("sha256").update(markdown).digest("hex"),
      lines: countLines(markdown),
      fileCount: included.length,
      layersCovered: Object.keys(layerCounts).sort(),
    };

    return { filename: metadata.filename, markdown, metadata };
  });

  // Renumbering rewrites the header ("of 3" becomes "of 12") and re-renders the file list,
  // so a part that fitted its budget when it was partitioned can come out over it. The byte
  // bound is a guarantee, so it is re-applied here — against the budget each part was built
  // for, which with per-layer budgets is not the same for every part.
  return renumbered.map(
    (part) => enforceBudget([part], part.metadata.budgetBytes)[0] ?? part
  );
}

/** Characters reserved for the omission notice appended to a hard-truncated section. */
const SECTION_TRUNCATION_NOTICE =  "\n... [section truncated: metadata alone exceeds the part budget] ...\n";
/** Cap on any single metadata value interpolated into a section or header. */
const METADATA_VALUE_MAX = 200;
/** Cap on a path shown in the `## Files` list and the `### FILE:` heading. */
const DISPLAY_PATH_MAX = 300;

/** Shortens a value from the middle so both ends stay recognisable. */
function capValue(value: string, max: number): string {
  if (value.length <= max) return value;
  const half = Math.floor((max - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(value.length - half)}`;
}

const capMetadata = (value: string): string => capValue(escapeControls(value), METADATA_VALUE_MAX);

/**
 * Paths reach the `## Files` list, the `### FILE:` heading and the navigation
 * index, so a control character in a name is rendered as `\uXXXX` instead of
 * being emitted raw: a bidi override visually reorders the line, a C1 CSI drives
 * the terminal, and a newline would break the line-oriented layout. Escaping
 * also keeps the `## Files` fence safe (see {@link fenceForText}). Paths are
 * legal UTF-8, so this is reachable with an ordinary `git mv`.
 */
/**
 * The form of a path that is written into a part.
 *
 * Exported because the reader has to compare against it: a section heading holds this
 * form, not the manifest's `relativePath`, and the two differ for any path with a
 * control character or one longer than {@link DISPLAY_PATH_MAX}.
 */
export const displayPath = (value: string): string =>
  capValue(escapeControls(value), DISPLAY_PATH_MAX);

/** Top-N `Layer (count)` / `Kind (count)` summary used in a part header. */
function topEntries(counts: Record<string, number>, limit: number): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([key, value]) => `${capMetadata(key)} (${value})`)
    .join(", ");
}

/**
 * Renders a section and guarantees it fits within `sectionBudget` bytes.
 *
 * Order matters: the body is truncated while keeping the summary, then the
 * summary is dropped if the section still does not fit, then the body is
 * truncated again with the reclaimed room, and only as a last resort is the
 * rendered section hard-truncated. Dropping the summary first and truncating
 * afterwards is what previously collapsed the body to zero bytes while most of
 * the budget was still free.
 */
function prepareSection(file: FileEntry, sectionBudget: number): PreparedSection {
  let text = renderFileSection(file);
  let byteSize = Buffer.byteLength(text, "utf8");
  if (byteSize <= sectionBudget) return { file, text, byteSize };

  const shrinkBody = (): void => {
    const content = file.content ?? "";
    const overhead = byteSize - Buffer.byteLength(content, "utf8");
    const allowed = sectionBudget - overhead - BUDGET_MARKER_RESERVE;
    if (allowed <= 0) return;
    const truncated = truncateWithBudgetMarker(
      content,
      allowed,
      sectionBudget,
      file.originalLines
    );
    if (!truncated.isTruncated) return;
    applyTruncatedContent(file, truncated.content);
    text = renderFileSection(file);
    byteSize = Buffer.byteLength(text, "utf8");
  };

  shrinkBody();

  if (byteSize > sectionBudget && file.summary) {
    file.summary = undefined;
    file.summaryOmitted = true;
    text = renderFileSection(file);
    byteSize = Buffer.byteLength(text, "utf8");
    // Reclaim the room the summary was occupying.
    shrinkBody();
  }

  if (byteSize > sectionBudget) {
    // Fixed metadata (a very long path or layer/kind name) still exceeds the
    // budget on its own; the hard bound wins over readability.
    const target = sectionBudget - Buffer.byteLength(SECTION_TRUNCATION_NOTICE, "utf8");
    const truncated = truncateToBytes(text, Math.max(0, target));
    text = truncated.content + SECTION_TRUNCATION_NOTICE;
    byteSize = Buffer.byteLength(text, "utf8");
  }

  return { file, text, byteSize };
}

function applyTruncatedContent(file: FileEntry, content: string): void {
  file.content = content;
  file.isPreviewTruncated = true;
  file.inclusionMode = "preview";
  file.includedBytes = Buffer.byteLength(content, "utf8");
  file.includedLines = countLines(content);
}

/** Rebuilds a part's recorded digest/size after its markdown was altered. */
function rehashPart(part: PartitionedPart, markdown: string): PartitionedPart {
  // The estimate describes the text it sits above, and clipping changed that text. Leaving the
  // pre-clip number made a part's own header, its metadata and the report that sums metadata
  // all disagree with the bytes underneath — and `metadata.estimatedTokens` is the field every
  // reader trusts.
  //
  // Estimated over the markdown **without** its token line, which is how `renderGroups` and
  // `renumberParts` estimate theirs. Estimating the text that still carried the *old* number
  // counted the old digits as content, so the rewritten line and the recorded total disagreed
  // by the width of the number being replaced.
  const estimatedTokens = estimateTokens(markdown.replace(TOKEN_LINE, ""));
  const redistributed = replaceTokenLine(markdown, estimatedTokens);
  return {
    filename: part.filename,
    markdown: redistributed,
    metadata: {
      ...part.metadata,
      byteSize: Buffer.byteLength(redistributed, "utf8"),
      sha256: crypto.createHash("sha256").update(redistributed).digest("hex"),
      lines: countLines(redistributed),
      estimatedTokens,
    },
  };
}

function greedyGroups(sections: PreparedSection[], budget: number): PreparedSection[][] {
  const groups: PreparedSection[][] = [];
  let current: PreparedSection[] = [];
  let bodyBytes = 0;
  let pathBytes = 0;

  for (const section of sections) {
    const sectionPathBytes = Buffer.byteLength(
      `${displayPath(section.file.relativePath)}\n`,
      "utf8"
    );
    const projected =
      bodyBytes + section.byteSize + pathBytes + sectionPathBytes + HEADER_RESERVE_BYTES;

    if (current.length > 0 && projected > budget) {
      groups.push(current);
      current = [];
      bodyBytes = 0;
      pathBytes = 0;
    }

    current.push(section);
    bodyBytes += section.byteSize;
    pathBytes += sectionPathBytes;
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

function renderGroups(
  groups: PreparedSection[][],
  budget: number,
  contentFingerprint?: string
): PartitionedPart[] {
  const total = groups.length;
  const zeroPad = (index: number): string =>
    String(index).padStart(Math.max(3, String(total).length), "0");

  return groups.map((group, index) => {
    const filename = `part-${zeroPad(index + 1)}.md`;
    const prev = index === 0 ? "none" : `part-${zeroPad(index)}.md`;
    const next = index === total - 1 ? "none" : `part-${zeroPad(index + 2)}.md`;

    for (const section of group) {
      section.file.part = filename;
    }

    const layersCovered = Array.from(new Set(group.map((s) => s.file.layer))).sort();
    const layerCounts: Record<string, number> = {};
    const kindCounts: Record<string, number> = {};
    for (const section of group) {
      layerCounts[section.file.layer] = (layerCounts[section.file.layer] || 0) + 1;
      kindCounts[section.file.kind] = (kindCounts[section.file.kind] || 0) + 1;
    }

    const pathLines = group.map((s) => displayPath(s.file.relativePath));
    // A filename can itself contain a backtick run, so the listing fence is
    // chosen from the listing rather than hardcoded to three backticks.
    const listFence = fenceForText(pathLines.join("\n"), 3);

    const header = [
      `# Codebase Snapshot Part ${zeroPad(index + 1)} of ${zeroPad(total)}`,
      "",
      `- Previous: ${prev}`,
      `- Next: ${next}`,
      `- Files: ${group.length}`,
      `- Content Fingerprint: ${contentFingerprint || "none"}`,
      `- Layers: ${topEntries(layerCounts, 6) || "none"}`,
      `- Kinds: ${topEntries(kindCounts, 8) || "none"}`,
      "",
      UNTRUSTED_CONTENT_NOTICE,
      "",
      "## Files",
      "",
      `${listFence}text`,
      ...pathLines,
      listFence,
      "",
      "## Contents",
      "",
    ].join("\n");

    const assembled = (header + group.map((s) => s.text).join("")).replace(/\r\n/g, "\n");
    const estimatedTokens = estimateTokens(assembled);
    const content = insertTokenLine(assembled, estimatedTokens);
    const byteSize = Buffer.byteLength(content, "utf8");
    const sha256 = crypto.createHash("sha256").update(content).digest("hex");

    const includedFiles: PartFileEntry[] = group.map(({ file }) => ({
      relativePath: file.relativePath,
      sourceBytes: file.sizeBytes,
      includedBytes: file.includedBytes,
      lines: file.includedLines,
      layer: file.layer,
      kind: file.kind,
    }));

    const metadata: PartMetadata = {
      index: index + 1,
      filename,
      byteSize,
      estimatedTokens,
      budgetBytes: budget,
      sha256,
      lines: countLines(content),
      fileCount: group.length,
      layersCovered,
      includedFiles,
    };

    return { filename, markdown: content, metadata };
  });
}

/**
 * The body exactly as it reaches the reader: CRLF normalised, closing newline dropped.
 *
 * The manifest's `includedBytes` and `includedLines` have to describe this string rather than the
 * content the generator read. Counting the raw content reported one byte too many for almost every
 * file (the newline the closing fence swallows) and one byte per line too many for a CRLF checkout
 * (the part is written with LF). A number an agent uses to budget context must be the number of
 * bytes it will actually read.
 */
export function emittedBody(content: string): string {
  const normalised = content.replace(/\r\n/g, "\n");
  return normalised.endsWith("\n") ? normalised.slice(0, -1) : normalised;
}

/**
 * One compact metadata line per file, instead of nine.
 *
 * This is the only per-file metadata a reader pays for, and the nine bullets it replaces were
 * `Layer`, `Kind`, `Language`, `Inclusion`, `Source Bytes`, `Source Lines`, `Included Lines`,
 * `SHA-256` and `Summary Quality` — about 32 tokens on every file in the snapshot, which is
 * roughly 160 000 tokens in a 5 000-file monorepo, spent before a line of code is read.
 *
 * Nothing was dropped that a reader can use:
 *
 * - `layer/kind` and `language` are unchanged, just joined.
 * - `inclusion` is a closed set (`full`, `preview`, `signatures`), which is what lets the
 *   reader in `mcp/part.ts` find it again in a line whose other fields are free-form.
 * - The line counts and the source byte count are unchanged; a body that holds fewer lines
 *   than its source says so (`40 of 300 lines`) instead of needing two labels to say it.
 * - `SHA-256` is **gone from the part** and stays authoritative in `manifest.json`. The part is
 *   the text a model reads; the manifest is the file-machine-reads. The digest was there for two
 *   internal lookups — one of which was a fallback for a path the heading cannot spell, now
 *   answered by {@link anchorForPath}'s own digest — and a 64-character hex string is pure
 *   context cost to the reader.
 */
function compactMetadata(file: FileEntry): string {
  const count = (value: number): string => `${value} line${value === 1 ? "" : "s"}`;
  const lines =
    file.includedLines === file.originalLines
      ? count(file.originalLines)
      : `${count(file.includedLines)} of ${count(file.originalLines)}`;
  return [
    `- Meta: ${capMetadata(file.layer)}/${capMetadata(file.kind)}`,
    capMetadata(file.language),
    file.inclusionMode,
    `${lines} (${file.sizeBytes} B)`,
  ].join(" | ");
}

function renderFileSection(file: FileEntry): string {
  const content = file.content ?? "";
  const body = emittedBody(content);
  // Settled before the metadata line is built, because it is rendered from
  // these values and both are read afterwards by `PartFileEntry` and by the manifest entry.
  file.includedBytes = Buffer.byteLength(body, "utf8");
  file.includedLines = countLines(body);
  const fence = fenceForContent(content);
  const anchor = anchorForPath(file.relativePath);

  return [
    `<a id="${anchor}"></a>`,
    `### FILE: ${displayPath(file.relativePath)}`,
    "",
    compactMetadata(file),
    ...(file.summaryQuality ? [`- Summary Quality: ${file.summaryQuality}`] : []),
    ...renderSummary(file.summary, file.inclusionMode),
    ...(file.summaryOmitted ? ["- Summary: (omitted: exceeds the part budget)"] : []),
    "",
    file.inclusionMode === "preview" ? "#### Bounded Preview" : "#### Content",
    "",
    `${fence}${capMetadata(file.language)}`,
    body,
    fence,
    "",
    "",
  ].join("\n");
}

/**
 * Chooses a fence longer than any backtick run in `content`, so a file that
 * contains a fenced block cannot break out of its own code block.
 */
export function fenceForContent(content: string): string {
  return fenceForText(content, 4);
}

/**
 * A fence longer than any backtick run in `content`, never shorter than
 * `minimum`.
 *
 * Every fenced block the generator writes goes through this, not just file
 * bodies: a *filename* may contain a backtick run (it is a legal name), and a
 * fixed three-backtick fence around the `## Files` list let such a name close
 * the block and turn the following filenames into live document text.
 */
export function fenceForText(content: string, minimum: number): string {
  const matches = content.match(/`+/g);
  const maxRun = matches?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  return "`".repeat(Math.max(minimum, maxRun + 1));
}

/**
 * The structural summary, when it says something the body does not.
 *
 * A `full` file is about to print every line of itself three lines below, so a pretty-printed
 * JSON summary above it lists every variable, import and export the reader is about to read
 * anyway — 30 duplicated lines for a 12-line file. The summary is still computed, still recorded
 * in `manifest.json`, and still what `snapshot_locate` and `snapshot_dependents` answer from; it
 * is only the *part* that stops repeating it. For `preview` and `signatures` the body is not the
 * file, so the summary is the only structural account the reader gets, and it stays.
 *
 * A one-line string summary is kept either way: it costs a dozen tokens and states the shape of
 * the file before the reader commits to reading it.
 */
function renderSummary(summary: FileEntry["summary"], inclusionMode: string): string[] {
  if (!summary) return [];
  if (typeof summary === "string") return [`- Summary: ${summary}`];
  if (inclusionMode === "full") return [];
  return ["- Summary:", "```json", JSON.stringify(summary, null, 2), "```"];
}

/**
 * Stable, injective anchor for a file path.
 *
 * The previous slug was not injective (`src/a-b.ts` and `src/a/b.ts` produced the
 * same anchor) and, more importantly, no part file ever emitted the anchors that
 * `reports/navigation.md` linked to — every file link was dead.
 */
export function anchorForPath(filePath: string): string {
  const slug = filePath
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const digest = crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 8);
  return `${slug || "file"}-${digest}`;
}
