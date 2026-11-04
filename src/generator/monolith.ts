import { fenceForContent } from "../partitioner/chunker.js";
import { escapeControls, inlineCode } from "../terminal.js";
import type { FileEntry, Manifest } from "../types.js";

export function generateMonolithJson(
  manifest: Manifest,
  filesWithContent: FileEntry[]
): string {
  return JSON.stringify({ manifest, files: filesWithContent }, null, 2);
}

export function generateMonolithMarkdown(
  manifest: Manifest,
  filesWithContent: FileEntry[]
): string {
  const sections = filesWithContent.map((file) => {
    const content = (file.content ?? "").replace(/\r\n/g, "\n");
    // Adaptive fence: a fixed 3-backtick fence let any file containing a fenced
    // block escape its code block and inject document markup.
    const fence = fenceForContent(content);

    return [
      `## File: ${escapeControls(file.relativePath)}`,
      "",
      `- **Layer:** ${inlineCode(file.layer)}`,
      `- **Kind:** ${inlineCode(file.kind)}`,
      `- **Lines:** \`${file.originalLines}\``,
      `- **Size:** \`${file.sizeBytes} B\``,
      `- **Inclusion:** \`${file.inclusionMode}\``,
      "",
      `${fence}${file.language}`,
      content.endsWith("\n") ? content.slice(0, -1) : content,
      fence,
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
