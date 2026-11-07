/**
 * Signature compression: keep the shape of a file, drop the implementations.
 *
 * `docs/vs-repomix.md` is honest that a tree-sitter compression mode is better than this tool
 * for a repository too large to fit even after budgeting — it keeps structure and discards
 * bodies. This is the same idea built on the compiler that is already the one runtime
 * dependency: the file still says what it exports, what those things are called, and what they
 * take and return, but not how they work.
 *
 * The rewrite is **span-based**, not a re-print. `ts.createPrinter()` would normalise the whole
 * file — quotes, semicolons, comment positions, blank lines — and the point of this mode is to
 * make a file smaller, not to reformat someone's code. Each function-like body is replaced in
 * place and everything around it is copied byte for byte, so a diff between the real file and
 * its skeleton touches only the bodies that were removed.
 */
import ts from "typescript";

export interface SkeletonResult {
  text: string;
  /** How many bodies were replaced; zero means the file had none and was left alone. */
  collapsed: number;
}

/** True for a node whose body is a block of statements rather than a type or an expression. */
function hasCollapsibleBody(node: ts.Node): node is ts.Node & { body: ts.Block } {
  if (!("body" in node)) return false;
  const body = (node as { body?: ts.Node }).body;
  return body !== undefined && ts.isBlock(body);
}

/**
 * Replaces the body of every function-like node, innermost-first, by text span.
 *
 * Spans are collected and then applied from the end of the file backwards so that an earlier
 * replacement never invalidates a later span's offsets.
 */
/**
 * True when a filename is TypeScript-with-JSX, in any letter case.
 *
 * One function for one question, because two spellings of it is exactly how `.TSX` came to be
 * eligible for a skeleton and then parsed as plain TypeScript, where JSX is a syntax error.
 * Exported so the decision itself can be tested: collapsing a body is span-based and produces the
 * same text under either script kind for simple files, so an output comparison cannot prove which
 * parser ran.
 */
export function isTsxFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(".tsx");
}

export function skeletonizeTypeScript(source: string, fileName = "file.ts"): SkeletonResult {
  // Case-insensitive, through the same helper `isSkeletonizable` uses.
  const scriptKind = isTsxFileName(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );

  const spans: Array<{ start: number; end: number }> = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node)) &&
      hasCollapsibleBody(node)
    ) {
      const body = (node as { body: ts.Block }).body;
      // `getStart()` skips the leading trivia, so the span begins at `{` and the comments
      // above the function stay where they were.
      const start = body.getStart(sourceFile);
      const end = body.getEnd();
      if (end > start) spans.push({ start, end });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (spans.length === 0) return { text: source, collapsed: 0 };

  // Outermost spans contain the inner ones, so applying only the outermost is enough — and
  // applying both would corrupt the text, because the inner replacement lands inside a range
  // that has already been rewritten. Sorted by start then by end descending, the first span of
  // each group is the outermost.
  const outermost: Array<{ start: number; end: number }> = [];
  for (const span of spans.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = outermost[outermost.length - 1];
    if (last && span.start < last.end) continue;
    outermost.push(span);
  }

  let text = source;
  for (let index = outermost.length - 1; index >= 0; index -= 1) {
    const span = outermost[index] as { start: number; end: number };
    text = `${text.slice(0, span.start)}{ /* ... */ }${text.slice(span.end)}`;
  }

  return { text, collapsed: outermost.length };
}

/** True for a path this module can compress. */
export function isSkeletonizable(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".mts") || lower.endsWith(".cts")
  );
}
