import type { Manifest, SecretFinding, SecretRule } from "../types.js";
import { findSecretInPath } from "../scanner/files.js";
import { codeCell, escapeControls, formatNumber, inlineCode, tableCell } from "../terminal.js";

/**
 * Builds the security/health report.
 *
 * This report deliberately contains **no source text**. It previously printed a
 * 120-character excerpt of every matched line, so each secret that had just been
 * redacted out of `parts/*.md` was written here in clear text. Paths are masked
 * with the same rules as the manifest: a token in a *filename* is a secret too,
 * and the matched-file table and the large-file table both print paths.
 *
 * Every path printed here is also re-spelled through {@link escapeControls}: the
 * tables are read on a terminal, and a bidi override in a name would reorder the
 * row around it. Escaping happens after masking, so a masked secret is never
 * un-masked by it.
 */
export function generateAuditReport(
  manifest: Manifest,
  secretFindings: SecretFinding[],
  secretRules?: readonly SecretRule[]
): string {
  const mask = (value: string): string =>
    escapeControls(findSecretInPath(value, secretRules)?.masked ?? value);
  // Every table row below puts a repository-supplied name inside inline code and a `|` cell, so a
  // layer called `core|x` or a path containing a backtick used to break the table it was listed in.
  const code = (value: string): string => codeCell(mask(value));
  const lines: string[] = [
    "# Codebase Health & Security Audit",
    "",
    `**Generated:** ${manifest.generatedAt}  `,
    `**Git Branch:** ${inlineCode(escapeControls(manifest.git.branch))} (\`${manifest.git.commit.slice(0, 8)}\`${manifest.git.isDirty ? " - dirty" : ""})  `,
    `**Total Files:** ${formatNumber(manifest.counts.totalFiles)}  `,
    `**Source Lines:** ${formatNumber(manifest.counts.totalLines)}  `,
    `**Emitted Lines:** ${formatNumber(manifest.totals.emittedLines ?? manifest.counts.totalLines)}  `,
    `**Total Size:** ${(manifest.counts.totalSizeBytes / (1024 * 1024)).toFixed(2)} MiB  `,
    // This counts the bytes that were *emitted* after redaction, not the bytes
    // that were masked: calling it "redacted bytes" made a repository with zero
    // secrets report a non-zero redacted-byte figure directly above "no secrets
    // detected". The number of masked lines is reported in section 1 instead.
    `**Emitted Content Bytes:** ${formatNumber(manifest.totals.totalContentBytes)}  `,
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
      for (const rule of finding.rules) byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    }

    // One row per line, listing every rule that matched it. A line that matched two rules used
    // to produce two rows with the same file and line, which reads like two separate leaks.
    lines.push(
      `⚠️ **${formatNumber(secretFindings.length)} line(s) contain values that were redacted:**`,
      "",
      "| File | Line | Rules |",
      "| :--- | ---: | :--- |"
    );
    for (const finding of secretFindings) {
      lines.push(
        `| ${code(finding.path ?? "unknown")} | ${finding.line} | ${finding.rules.map(code).join(", ")} |`
      );
    }
    lines.push("", "### Matches by rule", "", "| Rule | Lines |", "| :--- | ---: |");
    for (const [rule, count] of Array.from(byRule.entries()).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${code(rule)} | ${count} |`);
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
  // A previewed or oversized file is deliberately not parsed for a structural summary, so
  // "every parsed file" is true but misleading next to the generation warning that the same file
  // "was not parsed". Naming the skipped count makes the two accounts agree.
  const unparsedPreviews = manifest.files.filter(
    (file) =>
      file.summary === undefined && (file.isPreviewTruncated === true || file.isLarge === true)
  ).length;
  lines.push("## 2. Parse & AST Diagnostics", "");
  if (parseIssues.length === 0) {
    if (unparsedPreviews > 0) {
      lines.push(
        `✅ No parse errors among the files that were parsed; ${formatNumber(unparsedPreviews)} ` +
          "file(s) were previewed or too large to parse and produced no structural summary.",
        ""
      );
    } else {
      lines.push("✅ Every parsed file produced a complete structural summary.", "");
    }
  } else {
    lines.push(
      `${parseIssues.length} file(s) produced an incomplete summary:`,
      "",
      "| File | Parse Errors |",
      "| :--- | ---: |"
    );
    for (const file of parseIssues) {
      const errors = (file.summary as { parseErrors: number }).parseErrors;
      lines.push(`| ${code(file.relativePath)} | ${errors} |`);
    }
    lines.push(
      "",
      "A parse error here means the summary is incomplete, not that the file is excluded —",
      "the content is still in the parts.",
      ""
    );
  }

  lines.push("## 3. Large Files Analysis", "");
  // Truncation has two independent causes: a file over `largeFileBytes` is reduced to a head/tail
  // preview before partitioning, and a file that then does not fit `maxPartBytes` is cut again by
  // the chunker. The old section counted only the first, so a snapshot whose previews were clipped
  // by the part budget reported "no files exceeded the large file budget" with a straight face.
  const largeFiles = manifest.files.filter((file) => file.isLarge);
  const truncatedFiles = manifest.files.filter((file) => file.isPreviewTruncated);
  const affected = manifest.files.filter((file) => file.isLarge || file.isPreviewTruncated);
  if (affected.length === 0) {
    lines.push("✅ No files exceeded the large file budget and none were truncated.", "");
  } else {
    lines.push(
      `Found ${formatNumber(largeFiles.length)} file(s) over the large-file budget (${(manifest.budgets.largeFileBytes / 1024).toFixed(0)} KB) and ${formatNumber(truncatedFiles.length)} file(s) truncated by a budget:`,
      "",
      "| File | Size (B) | Source Lines | Included Bytes | Included Lines | Status | Cut by |",
      "| :--- | ---: | ---: | ---: | ---: | :--- | :--- |"
    );
    for (const file of affected) {
      const status = file.isPreviewTruncated ? "Truncated" : "Full";
      // `isLarge` is set by the size threshold before partitioning; anything false there was cut
      // by the part budget. A large file can additionally be clipped by the part budget.
      const cutBy = file.isLarge ? "largeFileBytes" : "maxPartBytes";
      lines.push(
        `| ${code(file.relativePath)} | ${file.sizeBytes} | ${file.lines} | ${file.includedBytes} | ${file.includedLines} | ${status} | ${cutBy} |`
      );
    }
    lines.push(
      "",
      `Truncated: ${formatNumber(truncatedFiles.length)} of ${formatNumber(manifest.counts.totalFiles)} file(s); every truncated block carries a \`[N lines omitted]\` notice naming its budget.`,
      ""
    );
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
    lines.push(`| ${code(layer)} | ${count} | ${pct}% |`);
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
    lines.push(`| ${code(kind)} | ${count} | ${pct}% |`);
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
      lines.push(`| ${code(skip.path)} | ${code(skip.reason)} | ${tableCell(skip.detail ?? "-")} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
