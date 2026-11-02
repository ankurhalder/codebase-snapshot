import type { Manifest, SecretFinding } from "../types.js";

export function generateAuditReport(
  manifest: Manifest,
  secretFindings: SecretFinding[]
): string {
  const lines: string[] = [
    "# Codebase Health & Security Audit",
    "",
    `**Generated:** ${manifest.generatedAt}  `,
    `**Git Branch:** \`${manifest.git.branch}\` (\`${manifest.git.commit.slice(0, 8)}\`${manifest.git.isDirty ? " - dirty" : ""})  `,
    `**Total Files:** ${manifest.counts.totalFiles}  `,
    `**Total Lines:** ${manifest.counts.totalLines.toLocaleString()}  `,
    `**Total Size:** ${(manifest.counts.totalSizeBytes / (1024 * 1024)).toFixed(2)} MB  `,
    "",
    "## 1. Security Scan & Redaction",
    "",
  ];

  if (secretFindings.length === 0) {
    lines.push("✅ **No secret-like patterns detected.** Clean security scan.", "");
  } else {
    lines.push(
      `⚠️ **${secretFindings.length} secret-like pattern(s) identified and redacted:**`,
      "",
      "| File | Line | Rule | Snippet |",
      "| :--- | :--- | :--- | :--- |"
    );
    for (const f of secretFindings) {
      lines.push(
        `| \`${f.path ?? "unknown"}\` | ${f.line} | \`${f.rule}\` | \`${f.snippet.replace(/\|/g, "\\|")}\` |`
      );
    }
    lines.push("");
  }

  lines.push("## 2. Large Files Analysis", "");
  const largeFiles = manifest.files.filter((f) => f.isLarge);
  if (largeFiles.length === 0) {
    lines.push("✅ No files exceeded the large file budget.", "");
  } else {
    lines.push(
      `Found ${largeFiles.length} file(s) exceeding the large file budget (${(manifest.budgets.largeFileBytes / 1024).toFixed(0)} KB):`,
      "",
      "| File | Size (KB) | Lines | Preview Status |",
      "| :--- | :--- | :--- | :--- |"
    );
    for (const f of largeFiles) {
      const sizeKb = (f.sizeBytes / 1024).toFixed(1);
      const status = f.isPreviewTruncated ? "Truncated Head/Tail" : "Full";
      lines.push(`| \`${f.relativePath}\` | ${sizeKb} KB | ${f.lines} | ${status} |`);
    }
    lines.push("");
  }

  lines.push("## 3. Architecture Layer Distribution", "", "| Layer | File Count | Percentage |", "| :--- | :--- | :--- |");
  const totalFiles = manifest.counts.totalFiles || 1;
  for (const [layer, count] of Object.entries(manifest.layers).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / totalFiles) * 100).toFixed(1);
    lines.push(`| \`${layer}\` | ${count} | ${pct}% |`);
  }
  lines.push("");

  lines.push("## 4. File Kind Distribution", "", "| Kind | File Count | Percentage |", "| :--- | :--- | :--- |");
  for (const [kind, count] of Object.entries(manifest.kinds).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / totalFiles) * 100).toFixed(1);
    lines.push(`| \`${kind}\` | ${count} | ${pct}% |`);
  }
  lines.push("");

  lines.push("## 5. Skipped / Non-Text Files", "");
  if (manifest.skipped.length === 0) {
    lines.push("No files were skipped.", "");
  } else {
    lines.push(`Total skipped: ${manifest.skipped.length}`, "", "| File | Reason | Detail |", "| :--- | :--- | :--- |");
    for (const s of manifest.skipped) {
      lines.push(`| \`${s.path}\` | \`${s.reason}\` | ${s.detail ?? "-"} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
