import * as fs from "node:fs";
import * as path from "node:path";
import { stripJsonComments } from "../ast/structured.js";

/**
 * What a repository says about itself, in its own words.
 *
 * The brief can prove what is inside a snapshot from the manifest, but not what the software is
 * for. Three files usually say it: `package.json` description, the opening paragraph of
 * `README.md`, and the most recent release headings of `CHANGELOG.md`. All three are the
 * owner's prose, so they are read here and masked by the caller like any other reproduced text.
 */
export interface ProjectOverview {
  /** `description` from package.json, when it has one. */
  description?: string;
  /** The first real paragraph of README.md, capped. */
  summary?: string;
  /** Release headings from CHANGELOG.md, newest first. */
  releases: string[];
}

const SUMMARY_LIMIT = 400;
const MAX_RELEASES = 2;

export function readProjectOverview(cwd: string): ProjectOverview {
  return {
    ...readDescription(cwd),
    ...readSummary(cwd),
    releases: readReleases(cwd),
  };
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readDescription(cwd: string): { description?: string } {
  const raw = readText(path.join(cwd, "package.json"));
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(stripJsonComments(raw)) as { description?: unknown };
    return typeof parsed.description === "string" && parsed.description.trim().length > 0
      ? { description: parsed.description.trim() }
      : {};
  } catch {
    return {};
  }
}

function readSummary(cwd: string): { summary?: string } {
  const raw = readText(path.join(cwd, "README.md"));
  if (raw === null) return {};
  // Markup is removed before the paragraph is found, not after. A centred header puts the first
  // prose inside `<p>` with `<br>` and `<code>` in it: skipping HTML lines would lose the summary
  // entirely, and leaving them in printed tags into the brief.
  const text = raw
    // Heading elements are removed whole: after stripping tags `<h1>Demo</h1>` becomes the line
    // "Demo", which reads as the first prose paragraph and then ends the paragraph at the next
    // blank line - the summary of every centred README became its own title.
    .replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, "\n")
    // Block boundaries become line breaks, so `<p>` prose starts its own paragraph.
    .replace(/<\/(p|div|section|header|footer|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const paragraph: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    // Skip the title, badges and rules: the summary is the first prose paragraph.
    if (paragraph.length === 0) {
      if (trimmed.length === 0) continue;
      if (/^#/.test(trimmed) || /^!\[/.test(trimmed) || /^[-*|]/.test(trimmed)) continue;
      if (/^\[[^\]]+\]:/.test(trimmed)) continue;
    } else if (trimmed.length === 0 || /^#/.test(trimmed)) {
      break;
    }
    paragraph.push(trimmed);
  }
  const summary = paragraph.join(" ").replace(/\s+/g, " ").trim();
  if (summary.length === 0) return {};
  return { summary: truncate(summary, SUMMARY_LIMIT) };
}

/** Cuts at a word boundary, so a summary does not end mid-word. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  const space = window.lastIndexOf(" ");
  return (space > limit / 2 ? window.slice(0, space) : window).trim() + "…";
}

function readReleases(cwd: string): string[] {
  const raw = readText(path.join(cwd, "CHANGELOG.md"));
  if (raw === null) return [];
  // A changelog has other `##` headings ("A note on version numbers"); calling them releases
  // makes the brief claim a release history that does not exist.
  const headings = raw
    .split(/\r?\n/)
    .map((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1]?.trim())
    .filter((heading): heading is string => heading !== undefined && /^v?\d+\.\d+/.test(heading));
  return headings.slice(0, MAX_RELEASES);
}
