import type { JsonSummary, MarkdownSummary } from "../types.js";

/**
 * Strips `//` and block comments the way JSONC does, without touching anything
 * inside a string literal. `JSON.parse` alone made every `.jsonc` file report
 * `invalid-json`, losing its key shape entirely.
 */
export function stripJsonComments(content: string): string {
  const text = content.replace(/^\uFEFF/, "");
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        // Keep escape pairs intact so `\"` cannot end the string early.
        if (next !== undefined) {
          out += next;
          i += 1;
        }
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += char;
  }

  return out;
}

export function summarizeJson(content: string): JsonSummary {
  try {
    const parsed = JSON.parse(stripJsonComments(content));
    if (Array.isArray(parsed)) {
      const sample = parsed[0];
      const sampleKeys =
        sample && typeof sample === "object" && !Array.isArray(sample)
          ? Object.keys(sample).slice(0, 10).sort()
          : [];
      return {
        shape: "array",
        itemCount: parsed.length,
        keys: [],
        sampleKeys,
      };
    }
    if (parsed && typeof parsed === "object") {
      const keys = Object.keys(parsed).sort();
      return {
        shape: "object",
        itemCount: keys.length,
        keys: keys.slice(0, 30),
        sampleKeys: [],
      };
    }
    return {
      shape: typeof parsed,
      itemCount: null,
      keys: [],
      sampleKeys: [],
    };
  } catch {
    return {
      shape: "invalid-json",
      itemCount: null,
      keys: [],
      sampleKeys: [],
    };
  }
}

export function summarizeMarkdown(content: string): MarkdownSummary {
  const headings: string[] = [];
  const frontmatterKeys: string[] = [];
  const lines = content.replace(/^\uFEFF/, "").split("\n");

  let inFrontmatter = false;
  /**
   * The fence character of the code block we are inside, or `null`.
   *
   * A `#` at the start of a line inside a fenced block is a comment in shell, Python,
   * YAML and Dockerfile examples — not a heading. Without tracking the fence, every one
   * of those became a document heading in the summary: this repository's own
   * `docs/agent.md` reported "# 1. Read the contract…" and `docs/cli.md` reported
   * "# The common path", both of which are shell comments in examples. A model reading
   * the index was told the document had sections it does not have.
   */
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;

    if (index === 0 && line.trim() === "---") {
      inFrontmatter = true;
      continue;
    }

    if (inFrontmatter) {
      if (line.trim() === "---") {
        inFrontmatter = false;
        continue;
      }
      const match = /^([a-zA-Z0-9_-]+):/.exec(line);
      if (match) frontmatterKeys.push(match[1]);
      continue;
    }

    const trimmed = line.trim();
    // CommonMark: a fence opens with three or more backticks or tildes and closes with
    // at least as many of the same character. The character is enough to pair them.
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const marker = (fenceMatch[1] as string)[0] as string;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      headings.push(`${headingMatch[1]} ${headingMatch[2].trim()}`);
    }
  }

  return {
    headings: headings.slice(0, 40),
    frontmatterKeys: Array.from(new Set(frontmatterKeys)).sort(),
  };
}
