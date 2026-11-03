import type { SourceSummary } from "../../types.js";

/**
 * How much of a file a heuristic summarizer will scan.
 *
 * The summaries are line-oriented: a multi-megabyte file would spend the whole
 * run in regexes for no benefit, and the part body is byte-budgeted anyway.
 */
export const MAX_SUMMARY_CHARS = 1_000_000;

export interface HeuristicResult {
  summary: SourceSummary;
  /**
   * `ast` only when a real parser produced this (TypeScript, and the script
   * block of a Vue/Svelte/Astro component). Everything else is `heuristic`, and
   * the manifest says so — a line-scan is not a parse.
   */
  quality: "ast" | "heuristic";
}

export interface LanguageProfile {
  readonly id: string;
  readonly extensions: readonly string[];
  summarize(path: string, content: string): HeuristicResult;
}

export function emptySummary(): SourceSummary {
  return {
    directives: [],
    imports: [],
    exports: [],
    reExports: [],
    functions: [],
    classes: [],
    interfaces: [],
    types: [],
    enums: [],
    variables: [],
    reactComponents: [],
    hooks: [],
    routeHandlers: [],
  };
}

function dedupeSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Deduplicates and sorts every bucket, so summaries are deterministic. */
export function finalizeSummary(summary: SourceSummary): SourceSummary {
  return {
    directives: dedupeSorted(summary.directives),
    imports: dedupeSorted(summary.imports),
    exports: dedupeSorted(summary.exports),
    reExports: dedupeSorted(summary.reExports),
    functions: dedupeSorted(summary.functions),
    classes: dedupeSorted(summary.classes),
    interfaces: dedupeSorted(summary.interfaces),
    types: dedupeSorted(summary.types),
    enums: dedupeSorted(summary.enums),
    variables: dedupeSorted(summary.variables),
    reactComponents: dedupeSorted(summary.reactComponents),
    hooks: dedupeSorted(summary.hooks),
    routeHandlers: dedupeSorted(summary.routeHandlers),
  };
}

/** Visits each line, bounded by {@link MAX_SUMMARY_CHARS}. */
export function eachLine(content: string, visit: (line: string) => void): void {
  const text = content.length > MAX_SUMMARY_CHARS ? content.slice(0, MAX_SUMMARY_CHARS) : content;
  for (const line of text.split(/\r?\n/)) visit(line);
}

/** True when the line starts in column zero (a top-level declaration). */
export function isTopLevel(line: string): boolean {
  return !/^[\s]/.test(line);
}

/** A leading lowercase or `_` means "not public" in Python, Ruby and PHP. */
export function isPublicName(name: string): boolean {
  return name.length > 0 && !name.startsWith("_") && /^[A-Za-z]/.test(name);
}

/** Go and Rust: a capitalised identifier is exported. */
export function isCapitalizedName(name: string): boolean {
  return /^[A-Z]/.test(name);
}
