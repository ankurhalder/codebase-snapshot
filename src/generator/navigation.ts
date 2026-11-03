import { anchorForPath } from "../partitioner/chunker.js";
import type { Manifest } from "../types.js";

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
      `| [${part.filename}](../parts/${part.filename}) | ${part.fileCount} | ${sizeKb} KB | ${part.layersCovered.join(", ")} |`
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
    // heading, so these links actually resolve.
    const anchor = anchorForPath(file.relativePath);
    const link = `[${file.relativePath}](../parts/${partFilename}#${anchor})`;
    const sizeStr = `${(file.sizeBytes / 1024).toFixed(1)} KB`;
    lines.push(
      `| ${link} | \`${partFilename}\` | \`${file.layer}\` | \`${file.kind}\` | ${file.lines} | ${sizeStr} |`
    );
  }

  lines.push("");
  return lines.join("\n");
}
