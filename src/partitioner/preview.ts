export interface PreviewResult {
  content: string;
  isTruncated: boolean;
  originalLines: number;
  includedLines: number;
}

/**
 * Line count with one consistent convention: a trailing newline does not start
 * a new line, and an empty string has zero lines.
 *
 * Previously `index.ts` recorded 0 for an empty file while `preview.ts` recorded
 * 1, and every newline-terminated file was over-counted by one.
 */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
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
  const lines = content.split("\n");
  const total = countLines(content);

  if (total <= headLines + tailLines) {
    return {
      content,
      isTruncated: false,
      originalLines: total,
      includedLines: total,
    };
  }

  const head = lines.slice(0, headLines);
  const tail = tailLines > 0 ? lines.slice(lines.length - tailLines) : [];
  const omitted = total - headLines - tailLines;

  const result = [
    ...head,
    `... [${omitted} lines omitted: file exceeds large file size budget] ...`,
    ...tail,
  ].join("\n");

  return {
    content: result,
    isTruncated: true,
    originalLines: total,
    includedLines: headLines + tailLines + 1,
  };
}
