export interface PreviewResult {
  content: string;
  isTruncated: boolean;
  originalLines: number;
  includedLines: number;
}

/**
 * `\r\n` and a bare `\r` are both line breaks.
 *
 * The generator emitted one normal form (LF) everywhere else, so a CR-only file — a classic Mac
 * file, a fixture, anything written by an old tool — was handled inconsistently in three places
 * at once. Here it was counted as **one line**: `largeFileBytes` never fired, so a 5 MB CR file
 * went into a part whole, and `manifest.json` reported `lines: 1` for a 40 000-line file.
 */
const LINE_ENDINGS = /\r\n|\r/g;

export const normaliseLineEndings = (content: string): string => content.replace(LINE_ENDINGS, "\n");

/**
 * Line count with one consistent convention: a trailing newline does not start
 * a new line, and an empty string has zero lines.
 *
 * Previously `index.ts` recorded 0 for an empty file while `preview.ts` recorded
 * 1, and every newline-terminated file was over-counted by one.
 *
 * Counted by scanning rather than by `split`: this runs on every file body and on every part, and
 * normalising first would allocate a second copy of a multi-megabyte string to answer a question
 * about its terminator count.
 */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  let breaks = 0;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code === 10) {
      breaks += 1;
      continue;
    }
    // `\r` starts a break; `\r\n` is one break, not two.
    if (code === 13 && content.charCodeAt(index + 1) !== 10) breaks += 1;
  }
  const last = content.charCodeAt(content.length - 1);
  // A trailing terminator ends the last line rather than opening an empty one.
  return last === 10 || last === 13 ? breaks : breaks + 1;
}

/**
 * Truncates to a UTF-8 byte budget without splitting a multi-byte character.
 */
export function truncateToBytes(
  content: string,
  maxBytes: number
): { content: string; isTruncated: boolean } {
  if (maxBytes <= 0) return { content: "", isTruncated: content.length > 0 };
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= maxBytes) return { content, isTruncated: false };

  let slice = buffer.subarray(0, maxBytes).toString("utf8");
  // A cut in the middle of a multi-byte sequence yields U+FFFD; drop it.
  while (slice.endsWith("\uFFFD")) slice = slice.slice(0, -1);
  return { content: slice, isTruncated: true };
}

export function truncatePreview(
  content: string,
  headLines: number,
  tailLines: number
): PreviewResult {
  // Normalise first: a CR-only file is all one "line" to `split("\n")`, so the preview returned the
  // whole file with `isTruncated: false` — the large-file budget silently did not apply — and the
  // CRs went into the part, where every other line ending had already been normalised.
  const normalised = normaliseLineEndings(content);
  const lines = normalised.split("\n");
  const total = countLines(normalised);

  if (total <= headLines + tailLines) {
    return {
      content: normalised,
      isTruncated: false,
      originalLines: total,
      includedLines: total,
    };
  }

  // A newline-terminated source splits with a trailing "" that is not a line of its
  // own. Keeping it in the window spent one tail slot on nothing and made the
  // omission notice claim one line fewer than it hid.
  const window = normalised.endsWith("\n") ? lines.slice(0, -1) : lines;
  const head = window.slice(0, headLines);
  const tail = tailLines > 0 ? window.slice(window.length - tailLines) : [];
  const omitted = total - head.length - tail.length;

  const result = [
    ...head,
    `... [${omitted} lines omitted: file exceeds large file size budget] ...`,
    ...tail,
  ].join("\n");

  return {
    content: result,
    isTruncated: true,
    originalLines: total,
    // Head + notice + tail is exactly what is emitted; counting the slice is
    // wrong when the source ended with a newline (the trailing "" issue above).
    includedLines: head.length + tail.length + 1,
  };
}
