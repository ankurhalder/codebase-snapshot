import type { JsonSummary, MarkdownSummary } from "../types.js";

/**
 * Strips `//` and block comments the way JSONC does, plus trailing commas, without touching
 * anything inside a string literal.
 *
 * `JSON.parse` alone made every `.jsonc` file — and every `tsconfig.json` an editor had
 * reformatted — report `invalid-json`, losing its key shape entirely. Two things this file's
 * matcher did that `src/config.ts`'s did not, and both are JSONC, not extensions of it:
 *
 * - **Trailing commas.** `{ "a": 1, }` is valid JSONC and invalid JSON.
 * - **`\r`-only line endings.** A `//` comment ended only at `\n`, so on a CR-delimited file it
 *   swallowed everything to the end of the document.
 *
 * A block comment keeps the line breaks it spans. Dropping them renumbered every line after it,
 * and the only thing a reader has to place a summary key is the line number.
 */
export function stripJsonComments(content: string): string {
  const text = content.replace(/^\uFEFF/, "");
  const withoutComments = stripComments(text);
  return stripTrailingCommas(withoutComments);
}

/** Removes `//` and block comments; block comments leave their line terminators behind. */
function stripComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index += 1;
      index -= 1; // let the loop emit the terminator
      continue;
    }

    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n" || text[index] === "\r") out += text[index];
        index += 1;
      }
      index += 1; // skip the closing "/"
      continue;
    }

    out += char;
  }

  return out;
}

/** Removes the `,` before `}`/`]` that JSONC allows and `JSON.parse` rejects. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next] as string)) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
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

/**
 * How many opening lines are a YAML front-matter block, or `0` when they are not one.
 *
 * Front matter is only front matter if it *closes*, and if what it holds can be YAML. The old test
 * asked only the first question — it scanned to the end of the file for any `---` line — so a
 * document that opens with a **horizontal rule** and uses another one as a section divider had
 * everything between them read as front matter, and every heading in that span disappeared from the
 * summary. The index then claimed a document with no sections.
 *
 * The block is accepted when every line is a YAML mapping entry, a list item, a comment, a blank
 * line or an indented continuation. A Markdown heading, a code fence or plain prose settles it: this
 * is not YAML, so the opening `---` is a rule.
 *
 * `...` closes a YAML document just as `---` does; both are legal terminators.
 */
function frontMatterEnd(lines: readonly string[]): number {
  if (lines.length < 3 || (lines[0] as string).trim() !== "---") return 0;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const candidate = line.trim();

    if (candidate === "---" || candidate === "...") {
      // A block with no content at all is indistinguishable from two rules, and treating it as
      // front matter would change nothing observable — say "not front matter" either way.
      return index > 1 ? index : 0;
    }
    if (candidate === "") continue;
    // A YAML comment. `# Heading` is not: CommonMark requires a space after the hashes, and YAML
    // comments have no such requirement, so the space is what separates them.
    if (/^#(\s|$)/.test(candidate)) continue;
    if (/^(`{3,}|~{3,})/.test(candidate)) return 0;
    if (/^#{1,6}\s+\S/.test(candidate)) return 0;

    const isYamlMapping = /^[A-Za-z0-9_.-]+\s*:(\s|$)/.test(candidate);
    const isListItem = /^-(?:(\s|$))/.test(candidate);
    const isIndented = /^[ \t]/.test(line);
    if (!isYamlMapping && !isListItem && !isIndented) return 0;
  }
  return 0;
}

export function summarizeMarkdown(content: string): MarkdownSummary {
  const headings: string[] = [];
  const frontmatterKeys: string[] = [];
  // Split on every terminator, so a CRLF or CR-only document is read line by line rather than as
  // one long line whose `---` never equals itself.
  const lines = content.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);

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
  let fence: { marker: string; length: number } | null = null;

  const frontMatterEndLine = frontMatterEnd(lines);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;

    if (index === 0 && frontMatterEndLine > 0) {
      inFrontmatter = true;
      continue;
    }

    if (inFrontmatter) {
      const trimmedFrontmatter = line.trim();
      if (trimmedFrontmatter === "---" || trimmedFrontmatter === "...") {
        inFrontmatter = false;
        continue;
      }
      const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line);
      if (match) frontmatterKeys.push(match[1] as string);
      continue;
    }

    const trimmed = line.trim();
    // CommonMark: a fence opens with three or more backticks or tildes, and closes with a run of
    // the *same* character that is **at least as long** and carries **no info string**.
    // Storing only the character paired them wrongly twice over: a three-backtick line inside a
    // four-backtick block ended the block, and a closing line with an info string (```` ```bash ````)
    // was accepted as a close instead of being read as content.
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
    if (fenceMatch) {
      const run = fenceMatch[1] as string;
      const rest = (fenceMatch[2] as string).trim();
      if (fence === null) {
        fence = { marker: run[0] as string, length: run.length };
      } else if (run[0] === fence.marker && run.length >= fence.length && rest === "") {
        fence = null;
      }
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
