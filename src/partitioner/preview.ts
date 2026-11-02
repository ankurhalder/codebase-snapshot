export interface PreviewResult {
  content: string;
  isTruncated: boolean;
  originalLines: number;
  includedLines: number;
}

export function truncatePreview(
  content: string,
  headLines: number,
  tailLines: number
): PreviewResult {
  const lines = content.split("\n");
  const total = lines.length;

  if (total <= headLines + tailLines) {
    return {
      content,
      isTruncated: false,
      originalLines: total,
      includedLines: total,
    };
  }

  const head = lines.slice(0, headLines);
  const tail = lines.slice(total - tailLines);
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

