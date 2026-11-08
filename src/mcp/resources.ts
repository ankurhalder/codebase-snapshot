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
 *
 * A resource read is all-or-nothing. A resource whose complete text does not fit one read fails
 * with a clear error naming its size and the tool to use instead; it is never truncated, because
 * half a JSON document does not parse and half a part is not the part. The descriptions say so
 * before the read, so a client choosing between resources is not surprised by the refusal.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildAgentContract } from "../agent/contract.js";
import { renderSkill } from "../agent/skill.js";
import { parsePartSections } from "./part.js";
import type { ResourceProvider, ToolContext } from "./types.js";
import { openWorkspace, partPathFor, readManifest, resolveRoot } from "./workspace.js";
import type { Workspace } from "./workspace.js";

/**
 * Largest text a single resource read returns.
 *
 * The cap is a context-budget guard, and a resource read is all-or-nothing: the first 512 kB of a
 * JSON document is not a smaller document, it is invalid JSON, and the first 512 kB of a part is a
 * fragment that looks like a complete file. A read that cannot return the whole resource therefore
 * fails with {@link ResourceTooLargeError} — naming the size, the limit and the tool to use
 * instead — so a client is never handed a silently truncated document.
 */
export const MAX_RESOURCE_BYTES = 512 * 1024;

/** Raised when the complete text of a resource would exceed {@link MAX_RESOURCE_BYTES}. */
export class ResourceTooLargeError extends Error {
  constructor(
    readonly uri: string,
    readonly bytes: number,
    readonly limit: number,
    message: string
  ) {
    super(message);
    this.name = "ResourceTooLargeError";
  }
}

/** Throws the actionable refusal for a resource that cannot be returned in one read. */
function refuseTooLarge(uri: string, bytes: number, advice: string): never {
  throw new ResourceTooLargeError(
    uri,
    bytes,
    MAX_RESOURCE_BYTES,
    `${uri} is ${formatBytes(bytes)}, above the ${formatBytes(MAX_RESOURCE_BYTES)} single-read ` +
      `limit, so it was not returned. ${advice}`
  );
}

/** Returns `text` unchanged when it fits one read, and refuses it when it does not. */
function ensureSingleRead(uri: string, text: string, advice: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_RESOURCE_BYTES) refuseTooLarge(uri, bytes, advice);
  return text;
}

/** Why the manifest resource is never returned in pieces. */
const MANIFEST_ADVICE =
  "Cutting a JSON document at the limit leaves invalid JSON, so this resource is never truncated. " +
  "Use the snapshot_locate, snapshot_read and snapshot_status tools instead — they read the " +
  "manifest directly — or read manifest.json from the snapshot directory.";

/** Why a part is never returned in pieces. */
const PART_ADVICE =
  "A part cut at the limit is a fragment of a file, not the file. Use snapshot_locate to find the " +
  "file inside this part that you need, then snapshot_read for a bounded window of it.";

/** Why a report is never returned in pieces. */
const REPORT_ADVICE =
  "A report cut at the limit would look complete and would not be. Read it from the snapshot " +
  "directory instead: the file on disk is complete.";

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
            "reason each excluded file was excluded. A manifest larger than 512 kB is refused " +
            "with its size instead of truncated: cut JSON does not parse. Use snapshot_locate, " +
            "snapshot_read and snapshot_status for a large repository.",
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
          description:
            `${report.title} from the most recent snapshot. A report larger than 512 kB is ` +
            "refused rather than truncated; read the file from the snapshot directory.",

          mimeType: "text/markdown",
        });
      }

      const workspace = await workspaceFor(context);
      if ("error" in workspace) return resources;

      const read = readManifest(workspace);
      if (!read.ok) return resources;

      for (const part of read.manifest.parts) {
        // The description is the size warning: a client reads it before it attaches anything, so a
        // part this one read cannot return says so here rather than only in the error.
        const readable = part.byteSize <= MAX_RESOURCE_BYTES;
        resources.push({
          uri: `snapshot://parts/${part.index}`,
          name: `part-${String(part.index).padStart(3, "0")}`,
          title: `Part ${part.index} (${part.fileCount} files, ${formatBytes(part.byteSize)})`,
          description:
            `Part ${part.index} of ${read.manifest.parts.length}: ` +
            `${part.fileCount} file(s), ${part.lines} line(s), ${formatBytes(part.byteSize)}.` +
            (readable
              ? ""
              : ` Above the ${formatBytes(MAX_RESOURCE_BYTES)} single-read limit, so this resource ` +
                "is refused rather than truncated; use snapshot_locate and snapshot_read."),
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
        return {
          uri,
          mimeType: "application/json",
          text: ensureSingleRead(
            uri,
            JSON.stringify(contract, null, 2),
            "Run 'codebase-snapshot describe --format json' for the complete contract."
          ),
        };
      }

      if (uri === "snapshot://skill") {
        return {
          uri,
          mimeType: "text/markdown",
          text: ensureSingleRead(
            uri,
            renderSkill(),
            "Print it with 'codebase-snapshot skill'."
          ),
        };
      }

      const workspace = await workspaceFor(context);
      if ("error" in workspace) return null;

      const report = REPORT_URIS.get(uri);
      if (report) {
        const text = readFileIfPresent(
          path.resolve(workspace.root, workspace.config.outDir, "reports", report.file)
        );
        if (text === null) return null;
        return { uri, mimeType: "text/markdown", text: ensureSingleRead(uri, text, REPORT_ADVICE) };
      }

      if (uri === "snapshot://manifest") {
        const read = readManifest(workspace);
        if (!read.ok) return null;
        const text = readFileIfPresent(read.file) ?? JSON.stringify(read.manifest, null, 2);
        return { uri, mimeType: "application/json", text: ensureSingleRead(uri, text, MANIFEST_ADVICE) };
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
        // The recorded size is a fact from the manifest, but the file on disk is what would be
        // returned, so the refusal is decided by the file. Checking before the read means a part
        // far over the limit never has to be loaded into memory to be refused.
        let partBytes: number;
        try {
          partBytes = fs.statSync(partPath).size;
        } catch {
          return null;
        }
        if (partBytes > MAX_RESOURCE_BYTES) refuseTooLarge(uri, partBytes, PART_ADVICE);
        const text = readFileIfPresent(partPath);
        if (text === null) return null;
        return { uri, mimeType: "text/markdown", text: ensureSingleRead(uri, text, PART_ADVICE) };
      }

      return null;
    },
  };
}

/** Exposed for tests: the number of sections a part advertises versus the ones it contains. */
export function countSections(partText: string): number {
  return parsePartSections(partText).length;
}
