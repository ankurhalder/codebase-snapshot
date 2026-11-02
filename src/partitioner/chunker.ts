import type { FileEntry, PartMetadata } from "../types.js";

export interface PartitionedPart {
  filename: string;
  markdown: string;
  metadata: PartMetadata;
}

export function partitionFiles(
  files: FileEntry[],
  maxPartBytes: number
): PartitionedPart[] {
  const parts: PartitionedPart[] = [];
  let currentFiles: FileEntry[] = [];
  let currentBytes = 0;
  let partIndex = 1;

  for (const file of files) {
    const fileRenderedBytes = Buffer.byteLength(
      renderFileMarkdown(file),
      "utf8"
    );

    if (
      currentFiles.length > 0 &&
      currentBytes + fileRenderedBytes > maxPartBytes
    ) {
      parts.push(createPart(partIndex, currentFiles));
      partIndex++;
      currentFiles = [];
      currentBytes = 0;
    }

    currentFiles.push(file);
    currentBytes += fileRenderedBytes;
  }

  if (currentFiles.length > 0) {
    parts.push(createPart(partIndex, currentFiles));
  }

  return parts;
}

function createPart(index: number, files: FileEntry[]): PartitionedPart {
  const filename = `part-${String(index).padStart(3, "0")}.md`;
  const layersCovered = Array.from(new Set(files.map((f) => f.layer))).sort();

  const fileHeaders = files.map(
    (f) => `- [${f.relativePath}](#${anchorForPath(f.relativePath)}) (${f.lines} lines, ${f.sizeBytes} B) [${f.layer} / ${f.kind}]`
  );

  const sections = files.map((f) => renderFileMarkdown(f));

  const markdown = [
    `# Snapshot Part ${String(index).padStart(3, "0")}`,
    "",
    `**Files in this part:** ${files.length}  `,
    `**Layers covered:** ${layersCovered.join(", ")}  `,
    "",
    "## Table of Contents",
    "",
    ...fileHeaders,
    "",
    "---",
    "",
    ...sections,
  ].join("\n");

  const lines = markdown.split("\n").length;
  const bytes = Buffer.byteLength(markdown, "utf8");

  const mappedFiles = files.map((f) => ({
    relativePath: f.relativePath,
    bytes: f.sizeBytes,
    lines: f.lines,
    layer: f.layer,
    kind: f.kind,
  }));

  const metadata: PartMetadata = {
    index,
    filename,
    bytes,
    lines,
    fileCount: files.length,
    layersCovered,
    files: mappedFiles,
    includedFiles: mappedFiles,
  };

  return {
    filename,
    markdown,
    metadata,
  };
}

export function anchorForPath(filePath: string): string {
  return filePath.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function renderFileMarkdown(file: FileEntry): string {
  const header = `## File: ${file.relativePath}`;
  const meta = [
    `- **Layer:** \`${file.layer}\``,
    `- **Kind:** \`${file.kind}\``,
    `- **Lines:** \`${file.lines}\``,
    `- **Size:** \`${file.sizeBytes} B\``,
    `- **SHA-256:** \`${file.hashSha256}\``,
  ];

  if (file.isLarge) {
    meta.push(`- **Notice:** Large file (> budget) - preview rendered.`);
  }

  return [
    header,
    "",
    ...meta,
    "",
    `\`\`\`${file.language}`,
    file.content ?? "",
    "```",
    "",
    "---",
    "",
  ].join("\n");
}

