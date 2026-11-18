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
  // The parts and the other two packs are written with LF; this one used to keep the source's
  // CRLF, so the same file had two different byte shapes depending on which pack a reader opened,
  // and the manifest's includedBytes counted the LF body. Normalise here too.
  const files = filesWithContent.map((file) =>
    file.content === undefined
      ? file
      : { ...file, content: file.content.replace(/\r\n|\r/g, "\n") }
  );
  return JSON.stringify({ manifest: embedded, files }, null, 2);
}

/** Attributes and text are escaped; bodies ride in CDATA with the one illegal sequence split. */
function xmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cdata(value: string): string {
  return "<![CDATA[" + value.replace(/\]\]>/g, "]]]]><![CDATA[>") + "]]>";
}

/**
 * The repository as one XML document, for the tools that read that shape.
 *
 * One <file> element per included file, with the metadata the manifest carries as attributes and
 * the body in CDATA. `]]>` cannot appear inside CDATA, so it is split across two sections — the
 * standard trick, and the reason a file containing that sequence still produces valid XML.
 */
export function generateMonolithXml(manifest: Manifest, filesWithContent: FileEntry[]): string {
  const files = filesWithContent.map((file) => {
    const content = (file.content ?? "").replace(/\r\n|\r/g, "\n");
    return [
      "  <file path=\"" + xmlAttribute(file.relativePath) + "\" language=\"" + xmlAttribute(file.language) +
        "\" layer=\"" + xmlAttribute(file.layer) + "\" kind=\"" + xmlAttribute(file.kind) +
        "\" lines=\"" + file.originalLines + "\" bytes=\"" + file.sizeBytes +
        "\" inclusion=\"" + file.inclusionMode + "\">",
      "    " + cdata(content),
      "  </file>",
    ].join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<codebase_snapshot generator="' + xmlAttribute(manifest.generator.name) + '" version="' +
      xmlAttribute(manifest.generator.version) + '" fingerprint="' + xmlAttribute(manifest.fingerprint) +
      '" files="' + filesWithContent.length + '">',
    ...files,
    "</codebase_snapshot>",
    "",
  ].join("\n");
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
