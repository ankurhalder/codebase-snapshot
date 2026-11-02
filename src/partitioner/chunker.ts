import * as crypto from "node:crypto";
import type { FileEntry, PartMetadata } from "../types.js";

export interface PartitionedPart {
  filename: string;
  markdown: string;
  metadata: PartMetadata;
}

export function partitionFiles(
  files: FileEntry[],
  maxPartBytes: number,
  contentFingerprint?: string
): PartitionedPart[] {
  const renderedSections = files.map((file) => {
    const text = renderFileSection(file);
    return {
      file,
      text,
      byteSize: Buffer.byteLength(text, "utf8"),
    };
  });

  const chunks: Array<{ files: FileEntry[]; body: string[]; bytes: number }> = [];
  let current = { files: [] as FileEntry[], body: [] as string[], bytes: 0 };
  const flush = (): void => {
    if (current.files.length === 0) return;
    chunks.push(current);
    current = { files: [], body: [], bytes: 0 };
  };

  for (const s of renderedSections) {
    const projectedHeaderBudget = 24_000 + current.files.length * 160;
    if (
      current.files.length > 0 &&
      current.bytes + s.byteSize + projectedHeaderBudget > maxPartBytes
    ) {
      flush();
    }
    current.files.push(s.file);
    current.body.push(s.text);
    current.bytes += s.byteSize;
  }
  flush();

  const total = chunks.length;
  const zeroPad = (index: number, t: number) =>
    String(index).padStart(Math.max(3, String(t).length), "0");

  return chunks.map((chunk, index) => {
    const filename = `part-${zeroPad(index + 1, total)}.md`;
    for (const f of chunk.files) {
      f.part = filename;
    }
    const layersCovered = Array.from(new Set(chunk.files.map((f) => f.layer))).sort();
    const prev = index === 0 ? "none" : `part-${zeroPad(index, total)}.md`;
    const next =
      index === total - 1 ? "none" : `part-${zeroPad(index + 2, total)}.md`;

    const layerCounts: Record<string, number> = {};
    const kindCounts: Record<string, number> = {};
    for (const f of chunk.files) {
      layerCounts[f.layer] = (layerCounts[f.layer] || 0) + 1;
      kindCounts[f.kind] = (kindCounts[f.kind] || 0) + 1;
    }
    const topEntries = (counts: Record<string, number>, limit: number) =>
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([k, v]) => `${k} (${v})`)
        .join(", ");

    let byteSize = 0;
    let content = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const header = [
        `# Codebase Snapshot Part ${zeroPad(index + 1, total)} of ${zeroPad(total, total)}`,
        "",
        `- Previous: ${prev}`,
        `- Next: ${next}`,
        `- Files: ${chunk.files.length}`,
        `- Byte Size: ${byteSize}`,
        `- Content Fingerprint: ${contentFingerprint || "none"}`,
        `- Layers: ${topEntries(layerCounts, 6) || "none"}`,
        `- Kinds: ${topEntries(kindCounts, 8) || "none"}`,
        "",
        "## Files",
        "",
        "```text",
        ...chunk.files.map((f) => f.relativePath),
        "```",
        "",
        "## Contents",
        "",
      ].join("\n");

      content = (header + chunk.body.join("")).replace(/\r\n/g, "\n");
      const nextByteSize = Buffer.byteLength(content, "utf8");
      if (nextByteSize === byteSize) break;
      byteSize = nextByteSize;
    }

    const sha = crypto.createHash("sha256").update(content).digest("hex");
    const lines = content.split("\n").length;

    const mappedFiles = chunk.files.map((f) => ({
      path: f.relativePath,
      relativePath: f.relativePath,
      bytes: f.sizeBytes,
      sizeBytes: f.sizeBytes,
      lines: f.lines,
      layer: f.layer,
      kind: f.kind,
    }));

    const metadata: PartMetadata = {
      index: index + 1,
      filename,
      bytes: byteSize,
      byteSize,
      sha256: sha,
      lines,
      fileCount: chunk.files.length,
      layersCovered,
      files: chunk.files.map((f) => f.relativePath),
      includedFiles: mappedFiles,
    };

    return {
      filename,
      markdown: content,
      metadata,
    };
  });
}

function renderFileSection(file: FileEntry): string {
  const content = file.content ?? "";
  const fence = fenceForContent(content);
  const summaryLines = renderSummary(file.summary);

  return [
    `### FILE: ${file.relativePath}`,
    "",
    `- Layer: ${file.layer}`,
    `- Kind: ${file.kind}`,
    `- Language: ${file.language}`,
    `- Inclusion: ${file.inclusionMode}`,
    `- Source Bytes: ${file.sizeBytes}`,
    `- Source Lines: ${file.lines}`,
    `- SHA-256: ${file.hashSha256}`,
    ...summaryLines,
    "",
    file.inclusionMode === "summary-only" ? "#### Bounded Preview" : "#### Content",
    "",
    `${fence}${file.language}`,
    content.endsWith("\n") ? content.slice(0, -1) : content,
    fence,
    "",
    "",
  ].join("\n");
}

function fenceForContent(content: string): string {
  const matches = content.match(/`+/g);
  const maxRun = matches?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  return "`".repeat(Math.max(4, maxRun + 1));
}

function renderSummary(summary: FileEntry["summary"]): string[] {
  if (!summary) return [];
  if (typeof summary === "string") return [`- Summary: ${summary}`];
  return ["- Summary:", "```json", JSON.stringify(summary, null, 2), "```"];
}

export function anchorForPath(filePath: string): string {
  return filePath.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}
