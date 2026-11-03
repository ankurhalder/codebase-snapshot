import type { Manifest } from "../types.js";
import { UNTRUSTED_CONTENT_NOTICE, escapeControls } from "../terminal.js";

export function generateReadme(manifest: Manifest): string {
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
    `- **Branch:** \`${manifest.git.branch}\` (\`${manifest.git.commit.slice(0, 8)}\`${manifest.git.isDirty ? " - dirty" : ""})`,
    `- **Total Tracked Files:** \`${manifest.counts.totalFiles}\``,
    `- **Total Code Lines:** \`${manifest.counts.totalLines.toLocaleString()}\``,
    `- **Total Size:** \`${(manifest.counts.totalSizeBytes / (1024 * 1024)).toFixed(2)} MB\``,
    `- **Emitted Content:** \`${(manifest.totals.totalContentBytes / (1024 * 1024)).toFixed(2)} MB\``,
    `- **Part Count:** \`${manifest.counts.partsCount}\` (budget \`${(manifest.budgets.maxPartBytes / 1024).toFixed(0)} KB\` per part)`,
    `- **Generator:** \`${manifest.generator.name}@${manifest.generator.version}\``,
    "",
    "## Documentation & Reports",
    "",
    "- [reports/navigation.md](reports/navigation.md) — Comprehensive file directory mapping files to chunk files.",
    "- [reports/project-tree.md](reports/project-tree.md) — Full visual ASCII directory tree of the repository.",
    "- [reports/audit.md](reports/audit.md) — Security scan counts, large files report, and architectural breakdown.",
    "- [manifest.json](manifest.json) — Complete machine-readable metadata and AST symbol registry.",
    "",
    "## Snapshot Parts",
    "",
    "The codebase is partitioned into budget-safe chunks under `parts/` to avoid context window degradation:",
    "",
    "| Part | File Count | Size (KB) | Layers Covered |",
    "| :--- | :--- | :--- | :--- |",
  ];

  for (const part of manifest.parts) {
    const sizeKb = (part.byteSize / 1024).toFixed(1);
    lines.push(
      `| [${part.filename}](parts/${part.filename}) | ${part.fileCount} | ${sizeKb} KB | ${escapeControls(part.layersCovered.join(", "))} |`
    );
  }

  lines.push(
    "",
    "## AI Agent Ingestion Guide",
    "",
    "1. Read `reports/navigation.md` or `reports/project-tree.md` first to locate target features or files.",
    "2. Open only the specific `parts/part-XXX.md` file holding the target modules.",
    "3. Inspect `manifest.json` for precise dependency and AST symbol maps.",
    "4. Check `manifest.validation.status` before trusting the snapshot; `snapshot validate` re-checks it against disk.",
    ""
  );

  return lines.join("\n");
}
