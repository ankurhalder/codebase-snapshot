import type { ResolvedArtifacts } from "../types.js";
import type { Manifest } from "../types.js";
import { UNTRUSTED_CONTENT_NOTICE, escapeControls, formatNumber, inlineCode, tableCell } from "../terminal.js";

/**
 * Renders the snapshot's own README.
 *
 * `artifacts` is the selection that was actually written. It used to be ignored, so a run with
 * `--skip-artifacts navigation,audit` still produced a README linking to `reports/navigation.md`
 * and `reports/audit.md` — three dangling links in a document whose only job is to tell a reader
 * where things are. A missing entry is `undefined`, which means "assume written" so the library's
 * older single-argument call keeps working.
 */
export function generateReadme(manifest: Manifest, artifacts?: ResolvedArtifacts): string {
  const wrote = (name: keyof ResolvedArtifacts): boolean => artifacts?.[name] !== false;

  const reportLinks: string[] = [];
  if (wrote("navigation")) {
    reportLinks.push(
      "- [reports/navigation.md](reports/navigation.md) — Comprehensive file directory mapping files to chunk files."
    );
  }
  if (wrote("projectTree")) {
    reportLinks.push(
      "- [reports/project-tree.md](reports/project-tree.md) — Full visual ASCII directory tree of the repository."
    );
  }
  if (wrote("audit")) {
    reportLinks.push(
      "- [reports/audit.md](reports/audit.md) — Security scan counts, large files report, and architectural breakdown."
    );
  }
  if (wrote("manifest")) {
    reportLinks.push(
      "- [manifest.json](manifest.json) — Complete machine-readable metadata and AST symbol registry."
    );
  }
  if (reportLinks.length === 0) {
    reportLinks.push(
      "- Nothing else was written: every other artifact was disabled for this run."
    );
  }

  const lines: string[] = [
    "# Codebase Snapshot",
    "",
    "This directory contains a complete, partitioned, and audited snapshot of this codebase, optimized for Large Language Models (LLMs) and automated agents.",
    "",
    UNTRUSTED_CONTENT_NOTICE,
    "",
    "## Snapshot Metrics",
    "",
    `- **Generated At:** \`${manifest.generatedAt}\``,
    `- **Schema Version:** \`${manifest.schemaVersion}\``,
    `- **Branch:** ${inlineCode(escapeControls(manifest.git.branch))} (\`${manifest.git.commit.slice(0, 8)}\`${manifest.git.isDirty ? " - dirty" : ""})`,
    `- **Total Tracked Files:** \`${manifest.counts.totalFiles}\``,
    `- **Source Lines:** \`${formatNumber(manifest.counts.totalLines)}\``,
    `- **Emitted Lines:** \`${formatNumber(manifest.totals.emittedLines ?? manifest.counts.totalLines)}\``,
    `- **Total Size:** \`${(manifest.counts.totalSizeBytes / (1024 * 1024)).toFixed(2)} MiB\``,
    `- **Emitted Content:** \`${(manifest.totals.totalContentBytes / (1024 * 1024)).toFixed(2)} MiB\``,
    `- **Part Count:** \`${manifest.counts.partsCount}\` (budget \`${(manifest.budgets.maxPartBytes / 1024).toFixed(0)} KB\` per part)`,
    `- **Generator:** \`${manifest.generator.name}@${manifest.generator.version}\``,
    "",
    "## Documentation & Reports",
    "",
    ...reportLinks,
  ];

  if (wrote("parts")) {
    lines.push(
      "",
      "## Snapshot Parts",
      "",
      "The codebase is partitioned into budget-safe chunks under `parts/` to avoid context window degradation:",
      "",
      "| Part | File Count | Size (KB) | Layers Covered |",
      "| :--- | :--- | :--- | :--- |"
    );

    for (const part of manifest.parts) {
      const sizeKb = (part.byteSize / 1024).toFixed(1);
      lines.push(
        `| [${part.filename}](parts/${part.filename}) | ${part.fileCount} | ${sizeKb} KB | ${tableCell(part.layersCovered.join(", "))} |`
      );
    }
  } else {
    lines.push("", "## Snapshot Parts", "", "No parts were written for this run.");
  }

  const readOrder: string[] = [];
  if (wrote("navigation") || wrote("projectTree")) {
    const first = [wrote("navigation") ? "`reports/navigation.md`" : null, wrote("projectTree") ? "`reports/project-tree.md`" : null]
      .filter(Boolean)
      .join(" or ");
    readOrder.push(`1. Read ${first} first to locate target features or files.`);
  }
  if (wrote("parts")) {
    readOrder.push(
      `${readOrder.length + 1}. Open only the specific \`parts/part-XXX.md\` file holding the target modules.`
    );
  }
  if (wrote("manifest")) {
    readOrder.push(
      `${readOrder.length + 1}. Inspect \`manifest.json\` for precise dependency and AST symbol maps.`
    );
  }
  readOrder.push(
    `${readOrder.length + 1}. Check \`manifest.validation.status\` before trusting the snapshot; \`snapshot validate\` re-checks it against disk.`
  );

  lines.push("", "## AI Agent Ingestion Guide", "", ...readOrder, "");

  return lines.join("\n");
}
