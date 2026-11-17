import ts from "typescript";

/**
 * Comment stripping for JavaScript and TypeScript.
 *
 * The TypeScript parser decides what is a comment, not a regular expression: a comment marker inside
 * a string, a template literal, a regex literal or a JSX attribute is not a comment, and a naive
 * stripper corrupts the code it claims only to trim. Comment text is removed but its newlines are
 * kept, so every line number in the manifest still points at the same line.
 *
 * The ranges come from the parser trivia API (`getLeadingCommentRanges` / `getTrailingCommentRanges`)
 * over every node, which is how the TypeScript formatter finds comments: a scanner alone cannot
 * tell a division from the start of a regex literal, and that ambiguity is what made a trailing
 * comment survive after a regex on the same line.
 */

const STRIPPABLE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;

export function isCommentStrippable(relativePath: string): boolean {
  return STRIPPABLE.test(relativePath);
}

export interface StripResult {
  text: string;
  /** Comment characters removed, before newline preservation. */
  removed: number;
}

function scriptKind(relativePath: string): ts.ScriptKind {
  if (/\.tsx$/i.test(relativePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(relativePath)) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/i.test(relativePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function stripComments(text: string, relativePath: string): StripResult {
  let source: ts.SourceFile;
  try {
    source = ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, scriptKind(relativePath));
  } catch {
    return { text, removed: 0 };
  }

  const ranges: Array<[number, number]> = [];
  const collect = (ranges_: readonly ts.CommentRange[] | undefined): void => {
    if (ranges_ === undefined) return;
    for (const range of ranges_) ranges.push([range.pos, range.end]);
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(source);
  // Comments after the last token are trailing trivia of the end-of-file token.
  collect(ts.getLeadingCommentRanges(text, source.endOfFileToken.getFullStart()));

  if (ranges.length === 0) return { text, removed: 0 };
  ranges.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }

  const pieces: string[] = [];
  let copied = 0;
  let removed = 0;
  for (const [start, end] of merged) {
    pieces.push(text.slice(copied, start));
    // Keep the newlines so line numbers do not move.
    pieces.push(text.slice(start, end).replace(/[^\n]/g, ""));
    removed += end - start;
    copied = end;
  }
  pieces.push(text.slice(copied));
  return { text: pieces.join(""), removed };
}
