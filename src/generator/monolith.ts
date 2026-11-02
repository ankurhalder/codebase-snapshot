import type { FileEntry, Manifest } from "../types.js";

export function generateMonolithJson(
  manifest: Manifest,
  filesWithContent: FileEntry[]
): string {
  return JSON.stringify(
    {
      manifest,
      files: filesWithContent,
    },
    null,
    2
  );
}

export function generateMonolithMarkdown(
  manifest: Manifest,
  filesWithContent: FileEntry[]
): string {
  const sections = filesWithContent.map((file) => {
    return [
      `## File: ${file.relativePath}`,
      "",
      `- **Layer:** \`${file.layer}\``,
      `- **Kind:** \`${file.kind}\``,
      `- **Lines:** \`${file.lines}\``,
      `- **Size:** \`${file.sizeBytes} B\``,
      "",
      `\`\`\`${file.language}`,
      file.content ?? "",
      "```",
      "",
      "---",
      "",
    ].join("\n");
  });

  return [
    `# Complete Codebase Monolith`,
    "",
    `**Generated:** ${manifest.generatedAt}  `,
    `**Total Files:** ${manifest.counts.totalFiles}  `,
    `**Total Lines:** ${manifest.counts.totalLines}  `,
    "",
    "---",
    "",
    ...sections,
  ].join("\n");
}

