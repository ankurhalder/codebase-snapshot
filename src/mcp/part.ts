/**
 * The MCP reader's view of a part: parsing lives in `partitioner/part-format.ts` so the auditor
 * can use the same parser, and this module adds the windowing the tools need.
 */
export { parsePartSections, findSection } from "../partitioner/part-format.js";
export type { PartSection } from "../partitioner/part-format.js";


export interface Window {
  text: string;
  fromLine: number;
  returnedLines: number;
  totalLines: number;
  truncated: boolean;
  nextFromLine: number | null;
  /**
   * True when `fromLine` is beyond the last line of the body.
   *
   * The start used to be clamped to the last line, so asking for line 9,000 of a 40-line file
   * returned line 40 with a header that read `Lines 40–40 of 40` — a wrong answer dressed as a
   * right one. The caller is told the request was out of range instead.
   */
  pastEnd: boolean;
}

/**
 * Cuts a line window out of a body.
 *
 * Windows are the whole point of this module: a part holds hundreds of kilobytes, and the only
 * safe default for a tool that returns content is "as little as answers the question". `next` is
 * an explicit pointer rather than an instruction to keep reading, so an agent decides.
 */
export function windowText(body: string, fromLine: number, lineCount: number): Window {
  const lines = body.split("\n");
  // `"".split("\n")` is `[""]`: an empty file is zero lines, not one empty line. Reporting one
  // made `snapshot_read` print `Lines 1–0 of 1`.
  const total = body.length === 0 ? 0 : lines.length;
  const requested = Math.max(1, Math.trunc(fromLine));
  const pastEnd = total > 0 && requested > total;
  const start = pastEnd ? requested : Math.min(requested, Math.max(1, total));
  const end = Math.min(total, start + Math.max(1, Math.trunc(lineCount)) - 1);
  const slice = pastEnd ? [] : lines.slice(start - 1, Math.max(start - 1, end));

  return {
    text: slice.join("\n"),
    fromLine: start,
    returnedLines: slice.length,
    totalLines: total,
    truncated: !pastEnd && end < total,
    nextFromLine: !pastEnd && end < total ? end + 1 : null,
    pastEnd,
  };
}
