import { anchorForPath } from "../partitioner/chunker.js";
import { codeCell, tableCell } from "../terminal.js";
import type { Manifest } from "../types.js";

/**
 * Escapes a Markdown link **label**.
 *
 * `tableCell` covers pipes, control characters and newlines, but a filename can
 * legally contain brackets: `[src/a](b).ts](…)` parses as a live link to `b`,
 * not as a label — the file directory could be made to point anywhere. Backslash
 * and both brackets are escaped so the label stays inert text.
 */
function linkLabel(value: string): string {
  // The path's own backslashes and brackets are escaped first; `tableCell` then re-spells control
  // and bidi characters. Doing it in that order keeps the `\u202E` spelling single-backslash —
  // escaping after `tableCell` would double the backslash it just introduced.
  return tableCell(value.replace(/[\\[\]()]/g, "\\$&"));
}

export function generateNavigation(manifest: Manifest): string {
  const lines: string[] = [
    "# Codebase Navigation Index",
    "",
    "Fast lookup index mapping every file to its snapshot chunk.",
    "",
    "## Parts Overview",
    "",
    "| Part | File Count | Size (KB) | Layers Covered |",
    "| :--- | :--- | :--- | :--- |",
  ];

  for (const part of manifest.parts) {
    const sizeKb = (part.byteSize / 1024).toFixed(1);
    lines.push(
      `| [${part.filename}](../parts/${part.filename}) | ${part.fileCount} | ${sizeKb} KB | ${tableCell(part.layersCovered.join(", "))} |`
    );
  }

  lines.push(
    "",
    "## File Directory",
    "",
    "| File | Part | Layer | Kind | Lines | Size |",
    "| :--- | :--- | :--- | :--- | :--- | :--- |"
  );

  const filePartMap = new Map<string, string>();
  for (const part of manifest.parts) {
    for (const file of part.includedFiles) {
      filePartMap.set(file.relativePath, part.filename);
    }
  }

  for (const file of manifest.files) {
    const partFilename = filePartMap.get(file.relativePath) || file.part || "none";
    // Anchors are emitted by the chunker immediately before each `### FILE:`
    // heading, so these links actually resolve. Only the visible label is
    // escaped: the anchor is a hex digest and the part name is generated, so the
    // link target stays byte-identical to what the chunker wrote.
    const anchor = anchorForPath(file.relativePath);
    const link = `[${linkLabel(file.relativePath)}](../parts/${partFilename}#${anchor})`;
    const sizeStr = `${(file.sizeBytes / 1024).toFixed(1)} KB`;
    lines.push(
      `| ${link} | ${codeCell(partFilename)} | ${codeCell(file.layer)} | ${codeCell(file.kind)} | ${file.lines} | ${sizeStr} |`
    );
  }

  lines.push("");
  return lines.join("\n");
}
