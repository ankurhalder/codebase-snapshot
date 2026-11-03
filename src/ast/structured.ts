import type { JsonSummary, MarkdownSummary } from "../types.js";

export function summarizeJson(content: string): JsonSummary {
  try {
    const parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
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

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

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

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (headingMatch) {
      headings.push(`${headingMatch[1]} ${headingMatch[2].trim()}`);
    }
  }

  return {
    headings: headings.slice(0, 40),
    frontmatterKeys: Array.from(new Set(frontmatterKeys)).sort(),
  };
}
