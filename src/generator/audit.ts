import type { Manifest, SecretFinding, SecretRule } from "../types.js";
import { findSecretInPath } from "../scanner/files.js";

/**
 * Builds the security/health report.
 *
 * This report deliberately contains **no source text**. It previously printed a
 * 120-character excerpt of every matched line, so each secret that had just been
 * redacted out of `parts/*.md` was written here in clear text. Paths are masked
 * with the same rules as the manifest: a token in a *filename* is a secret too,
 * and the matched-file table and the large-file table both print paths.
 */
export function generateAuditReport(
  manifest: Manifest,
  secretFindings: SecretFinding[],
  secretRules?: readonly SecretRule[]
): string {
  const mask = (value: string): string => findSecretInPath(value, secretRules)?.masked ?? value;
  const lines: string[] = [
    "# Codebase Health & Security Audit",
    "",
    `**Generated:** ${manifest.generatedAt}  `,
    `**Git Branch:** \`${manifest.git.branch}\` (\`${manifest.git.commit.slice(0, 8)}\`${manifest.git.isDirty ? " - dirty" : ""})  `,
    `**Total Files:** ${manifest.counts.totalFiles}  `,
    `**Total Lines:** ${manifest.counts.totalLines.toLocaleString()}  `,
    `**Total Size:** ${(manifest.counts.totalSizeBytes / (1024 * 1024)).toFixed(2)} MB  `,
    // This counts the bytes that were *emitted* after redaction, not the bytes
    // that were masked: calling it "redacted bytes" made a repository with zero
    // secrets report a non-zero redacted-byte figure directly above "no secrets
    // detected". The number of masked spans is reported in section 1 instead.
    `**Emitted Content Bytes:** ${manifest.totals.totalContentBytes.toLocaleString()}  `,
    "",
    "## 1. Security Scan & Redaction",
    "",
    "Matched values are replaced in place in `parts/*.md`; no excerpt of a matched",
    "line is reproduced in this report or anywhere else in the snapshot.",
    "",
  ];

  if (secretFindings.length === 0) {
    lines.push("✅ **No secret-like patterns detected.** Clean security scan.", "");
  } else {
    const byRule = new Map<string, number>();
    for (const finding of secretFindings) {
      byRule.set(finding.rule, (byRule.get(finding.rule) ?? 0) + 1);
    }

    lines.push(
      `⚠️ **${secretFindings.length} secret-like pattern(s) identified and redacted:**`,
      "",
      "| File | Line | Rule |",
      "| :--- | :--- | :--- |"
    );
    for (const finding of secretFindings) {
      lines.push(`| \`${mask(finding.path ?? "unknown")}\` | ${finding.line} | \`${finding.rule}\` |`);
    }
    lines.push("", "### Matches by rule", "", "| Rule | Matches |", "| :--- | :--- |");
    for (const [rule, count] of Array.from(byRule.entries()).sort((a, b) => b[1] - a[1])) {
      lines.push(`| \`${rule}\` | ${count} |`);
    }
    lines.push("");
  }

  // Parse diagnostics: the CLI already warns about every file whose AST summary was
  // incomplete, but the artifact an auditor reads carried none of it.
  const parseIssues = manifest.files.filter(
    (file) =>
      file.summary !== undefined &&
      typeof file.summary === "object" &&
      "parseErrors" in file.summary &&
      typeof (file.summary as { parseErrors?: unknown }).parseErrors === "number" &&
      (file.summary as { parseErrors: number }).parseErrors > 0
  );
  lines.push("## 2. Parse & AST Diagnostics", "");
  if (parseIssues.length === 0) {
    lines.push("✅ Every parsed file produced a complete structural summary.", "");
  } else {
    lines.push(
      `${parseIssues.length} file(s) produced an incomplete summary:`,
      "",
      "| File | Parse Errors |",
      "| :--- | ---: |"
    );
    for (const file of parseIssues) {
      const errors = (file.summary as { parseErrors: number }).parseErrors;
      lines.push(`| \`${mask(file.relativePath)}\` | ${errors} |`);
    }
    lines.push(
      "",
      "A parse error here means the summary is incomplete, not that the file is excluded —",
      "the content is still in the parts.",
      ""
    );
  }

  lines.push("## 3. Large Files Analysis", "");
  const largeFiles = manifest.files.filter((file) => file.isLarge);
  if (largeFiles.length === 0) {
    lines.push("✅ No files exceeded the large file budget.", "");
  } else {
    lines.push(
      `Found ${largeFiles.length} file(s) exceeding the large file budget (${(manifest.budgets.largeFileBytes / 1024).toFixed(0)} KB):`,
      "",
      "| File | Size (KB) | Lines | Preview Status |",
      "| :--- | :--- | :--- | :--- |"
    );
    for (const file of largeFiles) {
      const sizeKb = (file.sizeBytes / 1024).toFixed(1);
      const status = file.isPreviewTruncated ? "Truncated Head/Tail" : "Full";
      lines.push(`| \`${mask(file.relativePath)}\` | ${sizeKb} KB | ${file.lines} | ${status} |`);
    }
    lines.push("");
  }

  lines.push(
    "## 4. Architecture Layer Distribution",
    "",
    "| Layer | File Count | Percentage |",
    "| :--- | :--- | :--- |"
  );
  const totalFiles = manifest.counts.totalFiles || 1;
  for (const [layer, count] of Object.entries(manifest.layers).sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  )) {
    const pct = ((count / totalFiles) * 100).toFixed(1);
    lines.push(`| \`${layer}\` | ${count} | ${pct}% |`);
  }
  lines.push("");

  lines.push(
    "## 5. File Kind Distribution",
    "",
    "| Kind | File Count | Percentage |",
    "| :--- | :--- | :--- |"
  );
  for (const [kind, count] of Object.entries(manifest.kinds).sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  )) {
    const pct = ((count / totalFiles) * 100).toFixed(1);
    lines.push(`| \`${kind}\` | ${count} | ${pct}% |`);
  }
  lines.push("");

  lines.push("## 6. Skipped / Non-Text Files", "");
  if (manifest.skipped.length === 0) {
    lines.push("No files were skipped.", "");
  } else {
    lines.push(
      `Total skipped: ${manifest.skipped.length}`,
      "",
      "| File | Reason | Detail |",
      "| :--- | :--- | :--- |"
    );
    for (const skip of manifest.skipped) {
      lines.push(`| \`${mask(skip.path)}\` | \`${skip.reason}\` | ${skip.detail ?? "-"} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
