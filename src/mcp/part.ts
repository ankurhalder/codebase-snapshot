/**
 * Reads one file's section back out of a rendered part.
 *
 * `snapshot_read` must not open the working tree. The snapshot is the contract: sensitive files
 * are excluded from it, secret-shaped strings inside ordinary files are redacted on the way in,
 * and a large file is emitted as a bounded preview. Reading the source directly would hand the
 * model the `.env` the snapshot deliberately skipped and the credential it masked — so the read
 * goes through the artifact instead.
 *
 * The format it parses is written by `renderFileSection`, and the parser is deliberately tied to
 * that shape rather than to a regex over the whole document: a file's *content* may legitimately
 * contain a line that looks like `### FILE: something`, and only fence tracking tells the two
 * apart. Content fences are four or more backticks (`fenceForContent` never emits three), which
 * is what makes "the next line equal to this exact fence" an unambiguous terminator.
 */

import { displayPath } from "../partitioner/chunker.js";

export interface PartSection {
  /** The path as rendered in the `### FILE:` heading. */
  path: string;
  /** The file body, without its fence. Redacted and possibly a bounded preview. */
  body: string;
  /** `full` or `preview`. */
  inclusion: string | null;
  sha256: string | null;
  includedLines: number | null;
}

const FILE_HEADING = "### FILE: ";
const CONTENT_MARKERS = new Set(["#### Content", "#### Bounded Preview"]);

/** Splits a part into one section per emitted file. */
export function parsePartSections(partText: string): PartSection[] {
  const lines = partText.split("\n");
  const sections: PartSection[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].startsWith(FILE_HEADING)) {
      index += 1;
      continue;
    }

    const heading = lines[index].slice(FILE_HEADING.length);
    let cursor = index + 1;
    let inclusion: string | null = null;
    let sha256: string | null = null;
    let includedLines: number | null = null;

    while (cursor < lines.length && !CONTENT_MARKERS.has(lines[cursor])) {
      const line = lines[cursor];
      // A new heading before a content marker means this section was malformed; stop scanning it
      // rather than adopting the next file's metadata.
      if (line.startsWith(FILE_HEADING)) break;
      if (line.startsWith("- Inclusion: ")) inclusion = line.slice("- Inclusion: ".length).trim();
      else if (line.startsWith("- SHA-256: ")) sha256 = line.slice("- SHA-256: ".length).trim();
      else if (line.startsWith("- Included Lines: ")) {
        const value = Number(line.slice("- Included Lines: ".length).trim());
        includedLines = Number.isFinite(value) ? value : null;
      }
      cursor += 1;
    }

    if (cursor >= lines.length || !CONTENT_MARKERS.has(lines[cursor])) {
      index = cursor + 1;
      continue;
    }

    let fenceLine = cursor + 1;
    while (fenceLine < lines.length && lines[fenceLine].trim().length === 0) fenceLine += 1;

    const fenceMatch = /^(`{4,})/.exec(lines[fenceLine] ?? "");
    if (!fenceMatch) {
      index = cursor + 1;
      continue;
    }
    const fence = fenceMatch[1];

    const body: string[] = [];
    let bodyLine = fenceLine + 1;
    while (bodyLine < lines.length && lines[bodyLine] !== fence) {
      body.push(lines[bodyLine]);
      bodyLine += 1;
    }

    sections.push({ path: heading, body: body.join("\n"), inclusion, sha256, includedLines });
    index = bodyLine + 1;
  }

  return sections;
}

/**
 * Finds the section for one file.
 *
 * The heading is matched first, because it is exact for every ordinary path. Two forms
 * have to be compared: the manifest's `relativePath` and the *rendered* path the heading
 * actually holds, which differs whenever the name carries a control character (escaped
 * as `\uXXXX`) or is long enough to be capped. Comparing only the raw form left such a
 * file unreadable through `snapshot_read` in a snapshot where another file had the same
 * content — the hash fallback could not disambiguate, and the path comparison always
 * failed.
 *
 * The SHA-256 is the fallback that matters for a path the heading cannot reproduce. When
 * several files share content and therefore a hash, an ambiguous hash match is refused
 * rather than guessed, and the path comparison decides.
 */
export function findSection(
  sections: readonly PartSection[],
  relativePath: string,
  sha256: string | null
): PartSection | null {
  const rendered = displayPath(relativePath);
  const samePath = (section: PartSection): boolean =>
    section.path === relativePath || section.path === rendered;
  const samePathFolded = (section: PartSection): boolean => {
    const path = section.path.toLowerCase();
    return path === relativePath.toLowerCase() || path === rendered.toLowerCase();
  };

  const exact = sections.find(samePath);
  if (exact) return exact;

  if (sha256) {
    const byHash = sections.filter((section) => section.sha256 === sha256);
    if (byHash.length === 1) return byHash[0];
    if (byHash.length > 1) {
      const byPath = byHash.find(samePathFolded);
      if (byPath) return byPath;
    }
  }

  const folded = sections.filter(samePathFolded);
  return folded.length === 1 ? folded[0] : null;
}

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
