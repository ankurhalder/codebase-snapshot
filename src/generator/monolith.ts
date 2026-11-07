import { fenceForContent } from "../partitioner/chunker.js";
import { escapeControls, inlineCode } from "../terminal.js";
import type { FileEntry, Manifest } from "../types.js";

export function generateMonolithJson(
  manifest: Manifest,
  filesWithContent: FileEntry[]
): string {
  // A file cannot contain its own sha256 — there is no fixed point — so this copy of the manifest
  // keeps `artifacts.fullJson` null instead of writing a digest that describes different bytes,
  // and says where the real one lives. Everything else in it matches `manifest.json`.
  const embedded: Manifest = {
    ...manifest,
    selfReference:
      "This manifest is embedded in full-codebase.json, which cannot record its own digest. " +
      "manifest.json holds the byteSize and sha256 of this file.",
  };
  return JSON.stringify({ manifest: embedded, files: filesWithContent }, null, 2);
}

export function generateMonolithMarkdown(
  manifest: Manifest,
  filesWithContent: FileEntry[]
): string {
  const sections = filesWithContent.map((file) => {
    const content = (file.content ?? "").replace(/\r\n|\r/g, "\n");
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
