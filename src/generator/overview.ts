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
  const lines = raw.split(/\r?\n/);
  const paragraph: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip the title, badges, HTML and rules: the summary is the first prose paragraph.
    if (paragraph.length === 0) {
      if (trimmed.length === 0) continue;
      if (/^#/.test(trimmed) || /^!\[/.test(trimmed) || /^</.test(trimmed) || /^[-*|]/.test(trimmed)) continue;
      if (/^\[[^\]]+\]:/.test(trimmed)) continue;
    } else if (trimmed.length === 0 || /^#/.test(trimmed)) {
      break;
    }
    paragraph.push(trimmed);
  }
  const summary = paragraph.join(" ").replace(/\s+/g, " ").trim();
  if (summary.length === 0) return {};
  return { summary: summary.length > SUMMARY_LIMIT ? summary.slice(0, SUMMARY_LIMIT - 1) + "…" : summary };
}

function readReleases(cwd: string): string[] {
  const raw = readText(path.join(cwd, "CHANGELOG.md"));
  if (raw === null) return [];
  const headings = raw
    .split(/\r?\n/)
    .filter((line) => /^##\s+\S/.test(line))
    .map((line) => line.replace(/^##\s+/, "").trim());
  return headings.slice(0, MAX_RELEASES);
}
