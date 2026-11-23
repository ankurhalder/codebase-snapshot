/**
 * The rendered-part format: what a section looks like, and how to read one back.
 *
 * Lives outside `src/mcp/` because two readers need it and only one of them is the MCP server:
 * the auditor verifies each file's recorded byte and line counts against the body in the part.
 * The parser is deliberately tied to the writer's shape — fence tracking rather than a regex over
 * the whole document, because a file's content may legitimately contain a line that looks like a
 * heading.
 */
import { anchorForPath, displayPath } from "../partitioner/chunker.js";

export interface PartSection {
  /** The path as rendered in the `### FILE:` heading. */
  path: string;
  /** The `<a id="…">` anchor from the line above the heading, when present. */
  anchor: string | null;
  /** The file body, without its fence. Redacted and possibly a bounded preview. */
  body: string;
  /** `full`, `preview` or `signatures`. */
  inclusion: string | null;
  includedLines: number | null;
}

const FILE_HEADING = "### FILE: ";
const CONTENT_MARKERS = new Set(["#### Content", "#### Bounded Preview"]);
const ANCHOR_LINE = /^<a id="([^"]+)"><\/a>$/;
const META_PREFIX = "- Meta: ";
const LEGACY_INCLUSION_PREFIX = "- Inclusion: ";
const LEGACY_INCLUDED_LINES_PREFIX = "- Included Lines: ";
/**
 * The inclusion modes a part can declare.
 *
 * The metadata line is `layer/kind | language | inclusion | N lines[ of M lines] (B B)`, and the
 * first three fields are free-form names a config can set — so the inclusion is found by *value*
 * rather than by position. A layer called `api|v2` must not shift the field the reader is looking
 * for. The counts are found the other way round, by position ({@link readIncludedLines}), because
 * they are the only field with a fixed shape.
 */
const INCLUSION_MODES = new Set(["full", "preview", "signatures", "comments-stripped"]);

/**
 * The included-line count from the last field of a compact `- Meta:` line.
 *
 * The writer emits `<N lines>[ of <M lines>] (<B> B)` in the final field, with English plurals —
 * `1 line (20 B)`, `1 line of 3 lines (48 B)` — so both numbers are optional plurals and a body
 * that holds one line is a count, not a missing value. The FIRST number is the emitted count the
 * manifest records as `includedLines`; the second is the file's original size. Reading the counts
 * from the final field rather than scanning the whole line is what keeps the free-form fields from
 * being mistaken for counts: a layer called `api|v2` or a kind that reads like a number used to
 * win the match, and a 1-of-3 skeleton reported 3 — the source size — as the emitted count.
 */
const COMPACT_COUNTS = /^(\d+)\s+lines?(?:\s+of\s+\d+\s+lines?)?/;

function readIncludedLines(fields: readonly string[]): number | null {
  const last = fields[fields.length - 1];
  if (last === undefined) return null;
  const counts = COMPACT_COUNTS.exec(last.trim());
  return counts === null ? null : Number(counts[1]);
}

/**
 * First line after the part's own `## Contents` header, or 0 for a pre-header part.
 *
 * Filenames are emitted verbatim inside the `## Files` fence. Scanning from line 0 therefore
 * found a real file named `### FILE: a.ts` in the listing before the section it named, then
 * jumped over the real section. The listing fence is chosen to be longer than any backtick run
 * in the paths, so skipping it is deterministic; `## Contents` is the writer's own header.
 */
function contentsStart(lines: readonly string[]): number {
  const filesHeader = lines.indexOf("## Files");
  if (filesHeader === -1) return 0;
  let open = filesHeader + 1;
  while (open < lines.length && lines[open].trim() === "") open += 1;
  const fenceMatch = /^(`{3,})/.exec(lines[open] ?? "");
  if (fenceMatch === null) return 0;
  const fence = fenceMatch[1];
  let close = open + 1;
  while (close < lines.length && lines[close] !== fence) close += 1;
  if (close >= lines.length) return 0;
  let contents = close + 1;
  while (contents < lines.length && lines[contents].trim() === "") contents += 1;
  return lines[contents] === "## Contents" ? contents + 1 : 0;
}

/** Splits a part into one section per emitted file. */
export function parsePartSections(partText: string): PartSection[] {
  const lines = partText.split("\n");
  const sections: PartSection[] = [];
  let index = contentsStart(lines);

  while (index < lines.length) {
    if (!lines[index].startsWith(FILE_HEADING)) {
      index += 1;
      continue;
    }

    const heading = lines[index].slice(FILE_HEADING.length);
    // The anchor sits on the line immediately above the heading. It is the only exact
    // identifier a section has: the heading is the *display* form, capped and escaped, so two
    // long paths can share it, while the anchor hashes the real path.
    const anchorMatch = index > 0 ? ANCHOR_LINE.exec(lines[index - 1]) : null;
    let cursor = index + 1;
    let inclusion: string | null = null;
    let includedLines: number | null = null;

    while (cursor < lines.length && !CONTENT_MARKERS.has(lines[cursor])) {
      const line = lines[cursor];
      // A new heading before a content marker means this section was malformed; stop scanning it
      // rather than adopting the next file's metadata.
      if (line.startsWith(FILE_HEADING)) break;
      if (line.startsWith(META_PREFIX)) {
        const fields = line.slice(META_PREFIX.length).split("|");
        for (const field of fields) {
          const value = field.trim();
          if (INCLUSION_MODES.has(value)) inclusion = value;
        }
        includedLines = readIncludedLines(fields);
      } else if (line.startsWith(LEGACY_INCLUSION_PREFIX)) {
        // Snapshots written before 0.9.12 carry a bullet per field; the reader still reads them
        // so an existing snapshot directory does not have to be regenerated to be readable.
        inclusion = line.slice(LEGACY_INCLUSION_PREFIX.length).trim();
      } else if (line.startsWith(LEGACY_INCLUDED_LINES_PREFIX)) {
        const value = Number(line.slice(LEGACY_INCLUDED_LINES_PREFIX.length).trim());
        includedLines = Number.isFinite(value) ? value : null;
      }
      cursor += 1;
    }

    if (cursor >= lines.length || !CONTENT_MARKERS.has(lines[cursor])) {
      // If the metadata scan stopped on the next heading, resume at it rather than skipping it.
      index = cursor < lines.length && lines[cursor].startsWith(FILE_HEADING) ? cursor : cursor + 1;
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

    sections.push({ path: heading, anchor: anchorMatch?.[1] ?? null, body: body.join("\n"), inclusion, includedLines });
    index = bodyLine + 1;
  }

  return sections;
}

/**
 * Finds the section for one file.
 *
 * The **anchor** is the identifier, not the heading. `anchorForPath` hashes the real
 * `relativePath`, so it is exact and injective; the heading is the display form, and for a path
 * with a control character (escaped as `\uXXXX`) or one longer than 300 characters (capped from
 * the middle) it is not the path at all. The old fallback for those cases was the content
 * SHA-256, which the part no longer carries — and which could never disambiguate two files with
 * the same content, the exact case that needs it.
 *
 * The heading comparison is kept as a second chance, for a snapshot written before the anchor
 * was read, or a part whose anchor line was edited by hand.
 */
export function findSection(
  sections: readonly PartSection[],
  relativePath: string
): PartSection | null {
  const anchor = anchorForPath(relativePath);
  const byAnchor = sections.find((section) => section.anchor === anchor);
  if (byAnchor) return byAnchor;

  const rendered = displayPath(relativePath);
  const samePath = (section: PartSection): boolean =>
    section.path === relativePath || section.path === rendered;

  const exact = sections.find(samePath);
  if (exact) return exact;

  const foldedPath = rendered.toLowerCase();
  const folded = sections.filter((section) => {
    const path = section.path.toLowerCase();
    return path === relativePath.toLowerCase() || path === foldedPath;
  });
  return folded.length === 1 ? folded[0] : null;
}
