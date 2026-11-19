import type { Manifest } from "../types.js";
import { escapeControls } from "../terminal.js";

function cell(value: string): string {
  return escapeControls(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/**
 * The selection report: why this snapshot holds what it holds.
 *
 * A narrowed snapshot (slice or budget) is a claim about relevance, and until this file it was a
 * claim the reader could only check by reading every part. The report lists each chosen file with
 * its cost and the reason the planner or the budget picked it, then what did not fit and what a
 * larger budget would buy next. The numbers come from the same blocks the manifest carries, so the
 * two cannot drift.
 */
export function generateSelectionReport(
  manifest: Manifest,
  selection: {
    kind: "slice" | "budget";
    detail: string;
    files: Array<{ path: string; tokens: number; why: string }>;
  }
): string {
  const lines: string[] = [];
  lines.push("# Selection");
  lines.push("");
  lines.push("**Kind:** `" + selection.kind + "`  ");
  const detail = selection.detail.replace(/\r?\n/g, " ");
  const colon = detail.indexOf(":");
  lines.push(
    "**" + (colon === -1 ? "Selection" : detail.slice(0, colon)) + ":**" +
      (colon === -1 ? " " + detail : detail.slice(colon + 1)) + "  "
  );
  lines.push("**Selected files:** " + selection.files.length + "  ");
  const spent = manifest.budget?.usedTokens ?? manifest.slice?.usedTokens ?? 0;
  lines.push("**Tokens spent:** " + spent.toLocaleString("en-US"));
  lines.push("");
  lines.push("## Why each file is here");
  lines.push("");
  lines.push("| File | Tokens | Reason |");
  lines.push("| :-- | --: | :-- |");
  for (const file of selection.files) {
    lines.push("| `" + cell(file.path) + "` | " + file.tokens.toLocaleString("en-US") + " | " + cell(file.why) + " |");
  }
  lines.push("");
  const dropped = selection.kind === "slice" ? manifest.slice?.dropped : manifest.budget?.dropped;
  if (typeof dropped === "number") {
    lines.push("## What was left out");
    lines.push("");
    lines.push(dropped + " file(s) were not selected. They are recorded in `manifest.json` as `skipped`");
    lines.push("with the reason `not-selected`, so nothing left the snapshot without a reason.");
    lines.push("");
  }
  const next = manifest.budget?.nextInLine ?? [];
  if (next.length > 0) {
    lines.push("## What a larger budget would buy");
    lines.push("");
    lines.push("Headroom: " + (manifest.budget?.headroomTokens ?? 0).toLocaleString("en-US") + " tokens.");
    lines.push("");
    lines.push("| File | Tokens |");
    lines.push("| :-- | --: |");
    for (const item of next) {
      lines.push("| `" + cell(item.path) + "` | " + item.tokens.toLocaleString("en-US") + " |");
    }
    lines.push("");
  }
  return lines.join("\n");
}
