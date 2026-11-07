/**
 * `snapshot://` resources: the browse surface, where the tools are the act surface.
 *
 * The list is computed per call rather than declared once, because what exists depends on what is
 * on disk. A static table would advertise a manifest for a repository that has never been
 * generated, and the client would learn about it as a failed read.
 *
 * Part resources are served with their size in the description. That is deliberate: an agent
 * choosing between twelve parts needs to know that one of them is 300 kB before it attaches it,
 * and the number is the only part of that decision it cannot infer from the name.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildAgentContract } from "../agent/contract.js";
import { renderSkill } from "../agent/skill.js";
import { parsePartSections } from "./part.js";
import type { ResourceProvider, ToolContext } from "./types.js";
import { openWorkspace, partPathFor, readManifest, resolveRoot } from "./workspace.js";
import type { Workspace } from "./workspace.js";

/** Largest text a single resource read returns. Past this, the tools offer windows instead. */
const MAX_RESOURCE_BYTES = 512 * 1024;

const PART_URI = /^snapshot:\/\/parts\/(\d+)$/;
const REPORT_URIS = new Map<string, { file: string; title: string }>([
  ["snapshot://reports/audit", { file: "audit.md", title: "Secret audit and risk findings" }],
  ["snapshot://reports/tree", { file: "project-tree.md", title: "Project tree" }],
  ["snapshot://reports/navigation", { file: "navigation.md", title: "Navigation index" }],
]);

/** Resources that exist regardless of what is on disk, in the order `resources/list` reports them. */
export { STATIC_RESOURCE_URIS, RESOURCE_TEMPLATE_URIS } from "./uris.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncationMarker(originalBytes: number): string {
  return (
    `\n\n[truncated: ${formatBytes(originalBytes)} total. ` +
    "Use the snapshot_read tool for a line window.]\n"
  );
}

/** Cuts UTF-8 text at a byte ceiling without splitting a character. */
function capUtf8(text: string, limit: number): { text: string; truncated: boolean } {
  const size = Buffer.byteLength(text, "utf8");
  if (size <= limit) return { text, truncated: false };
  const cut = Buffer.from(text, "utf8").subarray(0, limit).toString("utf8").replace(/\uFFFD+$/, "");
  return { text: `${cut}${truncationMarker(size)}`, truncated: true };
}

/** Resolves the one root resources are served from. They carry no arguments, so it is the cwd. */
async function workspaceFor(context: ToolContext): Promise<Workspace | { error: string }> {
  const root = resolveRoot(undefined, context);
  if (!root.ok) return { error: root.message };
  const opened = await openWorkspace(root.root);
  if (!opened.ok) return { error: opened.message };
  return opened.workspace;
}

function readFileIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function buildResourceProvider(): ResourceProvider {
  return {
    async list(context: ToolContext) {
      const resources = [
        {
          uri: "snapshot://manifest",
          name: "manifest",
          title: "Snapshot manifest",
          description:
            "Every file in the snapshot with its layer, kind, language, part and hash, plus the " +
            "reason each excluded file was excluded.",
          mimeType: "application/json",
        },
        {
          uri: "snapshot://contract",
          name: "contract",
          title: "Tool contract",
          description: "The machine-readable description of the codebase-snapshot command line.",
          mimeType: "application/json",
        },
        {
          uri: "snapshot://skill",
          name: "skill",
          title: "Agent skill",
          description: "Usage guidance for an agent working with this tool.",
          mimeType: "text/markdown",
        },
      ];

      for (const [uri, report] of REPORT_URIS) {
        resources.push({
          uri,
          name: report.file.replace(/\.md$/, ""),
          title: report.title,
          description: `${report.title} from the most recent snapshot.`,
          mimeType: "text/markdown",
        });
      }

      const workspace = await workspaceFor(context);
      if ("error" in workspace) return resources;

      const read = readManifest(workspace);
      if (!read.ok) return resources;

      for (const part of read.manifest.parts) {
        resources.push({
          uri: `snapshot://parts/${part.index}`,
          name: `part-${String(part.index).padStart(3, "0")}`,
          title: `Part ${part.index} (${part.fileCount} files, ${formatBytes(part.byteSize)})`,
          description:
            `Part ${part.index} of ${read.manifest.parts.length}: ` +
            `${part.fileCount} file(s), ${part.lines} line(s), ${formatBytes(part.byteSize)}.`,
          mimeType: "text/markdown",
        });
      }

      return resources;
    },

    templates() {
      return [
        {
          uriTemplate: "snapshot://parts/{index}",
          name: "part",
          title: "Snapshot part",
          description: "One budgeted part of the snapshot, by its 1-based index.",
          mimeType: "text/markdown",
        },
      ];
    },

    async read(uri: string, context: ToolContext) {
      if (uri === "snapshot://contract") {
        const contract = buildAgentContract();
        return { uri, mimeType: "application/json", text: JSON.stringify(contract, null, 2) };
      }

      if (uri === "snapshot://skill") {
        return { uri, mimeType: "text/markdown", text: renderSkill() };
      }

      const workspace = await workspaceFor(context);
      if ("error" in workspace) return null;

      const report = REPORT_URIS.get(uri);
      if (report) {
        const text = readFileIfPresent(
          path.resolve(workspace.root, workspace.config.outDir, "reports", report.file)
        );
        if (text === null) return null;
        return { uri, mimeType: "text/markdown", text: capUtf8(text, MAX_RESOURCE_BYTES).text };
      }

      if (uri === "snapshot://manifest") {
        const read = readManifest(workspace);
        if (!read.ok) return null;
        const text = readFileIfPresent(read.file) ?? JSON.stringify(read.manifest, null, 2);
        return { uri, mimeType: "application/json", text: capUtf8(text, MAX_RESOURCE_BYTES).text };
      }

      const partMatch = PART_URI.exec(uri);
      if (partMatch) {
        const read = readManifest(workspace);
        if (!read.ok) return null;
        const index = Number(partMatch[1]);
        const part = read.manifest.parts.find((candidate) => candidate.index === index);
        if (!part) return null;
        // Confined: `parts[].filename` comes out of a file on disk. `readManifest` rejects a name
        // that is not bare, so this is the second of two answers to the same question — and the
        // cheap one, at the only call site where being wrong reads arbitrary files.
        const partPath = partPathFor(workspace, part.filename);
        if (partPath === null) return null;
        const text = readFileIfPresent(partPath);
        if (text === null) return null;
        return { uri, mimeType: "text/markdown", text: capUtf8(text, MAX_RESOURCE_BYTES).text };
      }

      return null;
    },
  };
}

/** Exposed for tests: the number of sections a part advertises versus the ones it contains. */
export function countSections(partText: string): number {
  return parsePartSections(partText).length;
}
