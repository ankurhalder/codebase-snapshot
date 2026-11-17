import type { Manifest } from "../types.js";

// Per-file token counts, grouped by directory. The manifest carries a total; a reader deciding
// what to drop needs the breakdown, sorted by cost, with directory rollups.

export interface TokenTreeReport {
  text: string;
  heaviest: Array<{ path: string; tokens: number }>;
}

function tokensOf(bytes: number): number {
  return Math.max(1, Math.ceil(bytes * 0.25));
}

export function generateTokenTree(manifest: Manifest): TokenTreeReport | null {
  if (manifest.files.length === 0) return null;
  const rows = manifest.files
    .map((file) => ({ path: file.relativePath, layer: file.layer, part: file.part, tokens: tokensOf(file.includedBytes) }))
    .sort((left, right) => right.tokens - left.tokens || left.path.localeCompare(right.path));

  const byDirectory = new Map<string, number>();
  for (const row of rows) {
    const directory = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/")) : ".";
    byDirectory.set(directory, (byDirectory.get(directory) ?? 0) + row.tokens);
  }
  const directories = [...byDirectory.entries()].sort((left, right) => right[1] - left[1]);
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);

  const rowsTable = rows.map((row) => "| " + row.path + " | " + row.layer + " | " + row.part + " | " + row.tokens + " |");
  const directoryTable = directories.map(
    (entry) => "| " + entry[0] + " | " + entry[1] + " | " + ((entry[1] / total) * 100).toFixed(1) + "% |"
  );

  const text = [
    "# Token tree",
    "",
    "Estimated tokens per file (one token per four bytes of emitted body), sorted by cost. The total",
    "is the same estimate the manifest carries: an estimate, not a count.",
    "",
    "## Directories",
    "",
    "| Directory | Tokens | Share |",
    "| :-- | --: | --: |",
    ...directoryTable,
    "",
    "## Files",
    "",
    "| File | Layer | Part | Tokens |",
    "| :-- | :-- | :-- | --: |",
    ...rowsTable,
    "",
    "**Total: " + total + " tokens across " + rows.length + " files.**",
    "",
  ].join("\n");

  return { text, heaviest: rows.slice(0, 20).map((row) => ({ path: row.path, tokens: row.tokens })) };
}
