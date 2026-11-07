/**
 * The eight tools this server exposes.
 *
 * Each one answers a question an agent actually asks, and nothing else: what is here, what would
 * be here, make it, is it still true, where is it, show me, why is it missing. A tool that does
 * not map to one of those does not ship — tool lists are context, and a seventh tool that is
 * merely convenient costs attention on every turn.
 *
 * Two rules run through every handler:
 *
 *  - **Nothing reads the working tree to answer a content question.** `snapshot_read` serves the
 *    file as the snapshot contains it, which is why an excluded `.env` cannot be read back and a
 *    redacted credential stays redacted.
 *  - **Output is bounded and says so.** Structured results carry counts; text results carry a
 *    pointer to the next window rather than an ever-growing dump.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { explainPath, renderExplainText } from "../explain.js";
import type { ExplainResult } from "../explain.js";
import { buildImportResolver, generateSnapshot, resolveSpecifier } from "../index.js";
import { truncateToBytes } from "../partitioner/preview.js";
import { validateSnapshot } from "../validator/validate.js";
import { GENERATOR_VERSION } from "../version.js";
import { generateInWorker } from "./generate-worker.js";
import { findSection, parsePartSections, windowText } from "./part.js";
import type { JsonObject } from "./protocol.js";
import type { FileEntry, Manifest, ValidationDrift, ValidationResult } from "../types.js";
import type { McpTool, ToolAnnotations, ToolContext, ToolOutcome } from "./types.js";
import { forgetManifest, manifestPathFor, openWorkspace, readManifest, resolveRoot } from "./workspace.js";
import type { Workspace, WorkspaceOverrides } from "./workspace.js";

/**
 * Read-only tools never touch the filesystem, so a client can run them without asking the user.
 * `snapshot_generate` is the only one that writes, and it is marked accordingly.
 */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const WRITES: ToolAnnotations = {
  readOnlyHint: false,
  // It replaces the snapshot directory but never anything it did not write, so it is additive with
  // respect to the user's files.
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Largest text block any one tool returns. Past this an agent should ask for a window. */
const MAX_RESULT_BYTES = 64 * 1024;

const ROOT_PROPERTY = {
  type: "string" as const,
  description: "Repository root. Defaults to the directory this server was started in.",
};

function failure(message: string): ToolOutcome {
  return { text: message, isError: true };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeFor(workspace: Workspace, absolute: string): string {
  return path.relative(workspace.root, absolute).split(path.sep).join("/");
}

/** Counts plus a capped sample, so a large drift report stays a usable size. */
function capped<T>(values: readonly T[], limit = 20): { count: number; sample: T[] } {
  return { count: values.length, sample: values.slice(0, limit) };
}

function summarizeDrift(drift: ValidationDrift): JsonObject {
  return {
    missingInSnapshot: capped(drift.missingInSnapshot),
    missingOnDisk: capped(drift.missingOnDisk),
    unreadable: capped(drift.unreadable),
    hashMismatches: capped(drift.hashMismatches),
    partIssues: capped(drift.partIssues),
    totalsMismatches: capped(drift.totalsMismatches),
    configMismatches: capped(drift.configMismatches),
  };
}

/** Paths the model sees are POSIX-relative to the root, whatever platform is hosting. */
function toRelativePath(root: string, value: string): string | null {
  const cleaned = value.trim();
  if (cleaned.length === 0) return null;
  if (!path.isAbsolute(cleaned)) {
    return cleaned.replace(/\\/g, "/").replace(/^\.\//, "");
  }
  const relative = path.relative(root, cleaned);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

/**
 * Every named thing the snapshot recorded about a file.
 *
 * Only `exports`, `reactComponents` and `routeHandlers` were searched, so
 * `snapshot_locate` could not find a function, class, interface, type, enum or hook that
 * the file does not export — which is most of the code in most files — and could not
 * find a Markdown heading at all. A symbol search that silently covers a third of the
 * symbols sends an agent to read whole files, which is the cost the tool exists to avoid.
 */
function symbolsOf(entry: FileEntry): string[] {
  const summary = entry.summary;
  if (!summary || typeof summary !== "object") return [];
  const names: string[] = [];

  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") names.push(item);
    }
  };

  // `SourceSummary` and `MarkdownSummary` share no base type, so the fields are read
  // through a record rather than by widening either one.
  const record = summary as unknown as Record<string, unknown>;
  for (const field of [
    "exports",
    "reactComponents",
    "routeHandlers",
    "functions",
    "classes",
    "interfaces",
    "types",
    "enums",
    "hooks",
    "headings",
  ]) {
    collect(record[field]);
  }

  return names;
}

/** Reads and validates `root`, then loads the configuration for it. */
async function prepare(
  args: JsonObject,
  context: ToolContext,
  overrides: WorkspaceOverrides = {}
): Promise<{ ok: true; workspace: Workspace } | { ok: false; outcome: ToolOutcome }> {
  const rootOutcome = resolveRoot(args.root, context);
  if (!rootOutcome.ok) return { ok: false, outcome: failure(rootOutcome.message) };
  const opened = await openWorkspace(rootOutcome.root, overrides);
  if (!opened.ok) return { ok: false, outcome: failure(opened.message) };
  return { ok: true, workspace: opened.workspace };
}

const statusTool: McpTool = {
  name: "snapshot_status",
  title: "Snapshot status",
  description:
    "Report whether a snapshot exists for this repository, when it was built, and what it covers. " +
    "Reads the manifest rather than the repository, so it is cheap. Call it before deciding " +
    "whether a snapshot needs to be generated.",
  inputSchema: {
    type: "object",
    properties: { root: ROOT_PROPERTY },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      present: { type: "boolean" },
      root: { type: "string" },
      outDir: { type: "string" },
      fingerprint: { type: "string" },
      generatedAt: { type: "string" },
      generatorVersion: { type: "string" },
      generatorVersionMatches: { type: "boolean" },
      includedFiles: { type: "integer" },
      skippedFiles: { type: "integer" },
      partCount: { type: "integer" },
      warningCount: { type: "integer" },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context);
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;
    const read = readManifest(workspace);

    if (!read.ok) {
      return {
        text: read.message,
        structured: {
          present: false,
          root: workspace.root,
          outDir: workspace.config.outDir,
          message: read.message,
        },
      };
    }

    const manifest = read.manifest;
    const versionMatches = manifest.generator.version === GENERATOR_VERSION;
    const lines = [
      `Snapshot: ${workspace.config.outDir}/`,
      `Generated: ${manifest.generatedAt} by ${manifest.generator.name} ${manifest.generator.version}`,
      `Files: ${manifest.counts.totalFiles} included, ${manifest.counts.skippedCount} skipped, ` +
        `${plural(manifest.counts.partsCount, "part")}`,
      `Content: ${formatBytes(manifest.counts.totalSizeBytes)} of source in ${formatBytes(manifest.totals.totalContentBytes)} emitted`,
      `Fingerprint: ${manifest.fingerprint}`,
      `Git: ${manifest.git.branch} @ ${manifest.git.commit}${manifest.git.isDirty ? " (dirty)" : " (clean)"}`,
    ];
    if (manifest.totals.warningCount > 0) lines.push(`Warnings: ${manifest.totals.warningCount}`);
    if (!versionMatches) {
      lines.push(
        `Note: written by ${manifest.generator.version}, this server is ${GENERATOR_VERSION}. ` +
          "Re-run snapshot_generate if the difference matters."
      );
    }

    return {
      text: lines.join("\n"),
      structured: {
        present: true,
        root: workspace.root,
        outDir: workspace.config.outDir,
        fingerprint: manifest.fingerprint,
        generatedAt: manifest.generatedAt,
        generatorVersion: manifest.generator.version,
        generatorVersionMatches: versionMatches,
        includedFiles: manifest.counts.totalFiles,
        skippedFiles: manifest.counts.skippedCount,
        partCount: manifest.counts.partsCount,
        warningCount: manifest.totals.warningCount,
        preset: manifest.config.preset,
        maxPartBytes: manifest.budgets.maxPartBytes,
      },
    };
  },
};

const planTool: McpTool = {
  name: "snapshot_plan",
  title: "Preview a snapshot",
  description:
    "Preview a snapshot without writing anything: how many files and parts it would contain, " +
    "and why every excluded file was excluded. Use it to choose a part budget before generating.",
  inputSchema: {
    type: "object",
    properties: {
      root: ROOT_PROPERTY,
      maxPartBytes: {
        type: "string",
        description:
          'Byte budget per part, for example 307200 or "300k". Defaults to the project configuration.',
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      files: { type: "integer" },
      skipped: { type: "integer" },
      parts: { type: "integer" },
      sourceBytes: { type: "integer" },
      emittedBytes: { type: "integer" },
      preset: { type: "string" },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, { maxPartBytes: args.maxPartBytes });
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;

    let manifest: Manifest;
    try {
      manifest = generateSnapshot(workspace.config, { dryRun: true });
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }

    const reasons = new Map<string, number>();
    for (const record of manifest.skipped) {
      reasons.set(record.reason, (reasons.get(record.reason) ?? 0) + 1);
    }
    const topReasons = [...reasons.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count }));

    const lines = [
      "Dry run — nothing was written.",
      `Preset: ${manifest.config.preset}`,
      `Would include ${plural(manifest.counts.totalFiles, "file")} in ` +
        `${plural(manifest.counts.partsCount, "part")} (${formatBytes(manifest.counts.totalSizeBytes)} of source, ` +
        `${formatBytes(manifest.totals.totalContentBytes)} emitted).`,
      `Would skip ${plural(manifest.counts.skippedCount, "file")}.`,
    ];
    if (topReasons.length > 0) {
      lines.push("Top skip reasons:");
      for (const entry of topReasons) lines.push(`  - ${entry.reason} (${entry.count})`);
    }
    if (manifest.warnings.length > 0) {
      lines.push(`Warnings (${manifest.warnings.length}):`);
      for (const warning of manifest.warnings.slice(0, 5)) lines.push(`  - ${warning}`);
    }

    return {
      text: lines.join("\n"),
      structured: {
        files: manifest.counts.totalFiles,
        skipped: manifest.counts.skippedCount,
        parts: manifest.counts.partsCount,
        sourceBytes: manifest.counts.totalSizeBytes,
        emittedBytes: manifest.totals.totalContentBytes,
        preset: manifest.config.preset,
        maxPartBytes: manifest.budgets.maxPartBytes,
        layers: manifest.layers,
        skipReasons: topReasons,
        warnings: manifest.warnings.slice(0, 5),
        warningCount: manifest.warnings.length,
      },
    };
  },
};

const generateTool: McpTool = {
  name: "snapshot_generate",
  title: "Generate the snapshot",
  description:
    "Write the snapshot to its output directory and return its fingerprint, parts and counts. " +
    "Replaces the previous snapshot in that directory. A large repository can take several seconds.",
  inputSchema: {
    type: "object",
    properties: {
      root: ROOT_PROPERTY,
      maxPartBytes: {
        type: "string",
        description:
          'Byte budget per part, for example 307200 or "300k". Defaults to the project configuration.',
      },
      outDir: {
        type: "string",
        description: "Output directory relative to the root. Defaults to the project configuration.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      fingerprint: { type: "string" },
      files: { type: "integer" },
      skipped: { type: "integer" },
      parts: { type: "integer" },
      emittedBytes: { type: "integer" },
    },
  },
  annotations: WRITES,
  async handler(args, context) {
    const prepared = await prepare(args, context, {
      maxPartBytes: args.maxPartBytes,
      outDir: args.outDir,
    });
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;

    // Off the JSON-RPC thread: a synchronous generate stops this server answering `ping` for
    // seconds on a large repository, and a client with a socket timeout then reports a working
    // tool call as a dead server.
    const result = await generateInWorker(workspace.root, workspace.cliOptions);
    if (!result.ok) return failure(result.message);
    const summary = result.summary;
    // The new manifest has the same path as the cached one; dropping it here means the next call
    // cannot be served a snapshot from before this write on a filesystem with coarse mtimes.
    forgetManifest(manifestPathFor(workspace));

    const written = relativeFor(workspace, path.resolve(workspace.root, workspace.config.outDir));
    const lines = [
      `Wrote ${written}/`,
      `Files: ${summary.totalFiles} included, ${summary.skippedCount} skipped, ` +
        `${plural(summary.partsCount, "part")}`,
      `Parts: ${summary.parts.map((part) => `${part.filename} (${formatBytes(part.byteSize)})`).join(", ")}`,
      `Fingerprint: ${summary.fingerprint}`,
    ];
    if (summary.warnings.length > 0) {
      lines.push(`Warnings (${summary.warnings.length}):`);
      for (const warning of summary.warnings.slice(0, 5)) lines.push(`  - ${warning}`);
    }

    return {
      text: lines.join("\n"),
      structured: {
        fingerprint: summary.fingerprint,
        files: summary.totalFiles,
        skipped: summary.skippedCount,
        parts: summary.partsCount,
        emittedBytes: summary.totalContentBytes,
        outDir: written,
        partFiles: summary.parts.map((part) => part.filename),
        warningCount: summary.warnings.length,
      },
    };
  },
};

const validateTool: McpTool = {
  name: "snapshot_validate",
  title: "Validate the snapshot",
  description:
    "Re-read the repository and report whether the snapshot on disk still matches it. Use it " +
    "before trusting context that came from an earlier session, or after changing the config.",
  inputSchema: {
    type: "object",
    properties: { root: ROOT_PROPERTY },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      current: { type: "boolean" },
      manifestPresent: { type: "boolean" },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context);
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;

    let result: ValidationResult;
    try {
      result = validateSnapshot(workspace.config);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }

    const lines: string[] = [];
    if (result.valid) {
      lines.push("The snapshot matches the repository.");
    } else {
      lines.push("The snapshot is out of date.");
      const drift = result.drift;
      const observations: Array<[string, number]> = [
        ["file(s) changed on disk", drift.hashMismatches.length],
        ["file(s) added since the snapshot", drift.missingInSnapshot.length],
        ["file(s) gone since the snapshot", drift.missingOnDisk.length],
        ["part file(s) damaged or missing", drift.partIssues.length],
        ["setting(s) changed since the snapshot", drift.configMismatches.length],
        ["internal count(s) disagreeing", drift.totalsMismatches.length],
      ];
      for (const [label, count] of observations) {
        if (count > 0) lines.push(`  - ${count} ${label}`);
      }
      for (const error of result.errors.slice(0, 5)) lines.push(`  - ${error}`);
      lines.push("Run snapshot_generate to refresh it.");
    }
    for (const warning of result.warnings.slice(0, 5)) lines.push(`Note: ${warning}`);

    return {
      text: lines.join("\n"),
      structured: {
        current: result.valid,
        manifestPresent: result.manifestPresent,
        drift: summarizeDrift(result.drift),
        errors: result.errors.slice(0, 10),
        warnings: result.warnings.slice(0, 10),
      },
      // A stale snapshot is an answer, not a tool failure: the caller asked whether it is current.
    };
  },
};

const locateTool: McpTool = {
  name: "snapshot_locate",
  title: "Locate code in the snapshot",
  description:
    "Find which part holds the code you need. Matches file paths, exported symbols, component " +
    "names and routes from the snapshot's index, so one part can be read instead of all of them.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Text to match, case-insensitively, against paths and exported symbols.",
      },
      by: {
        type: "string",
        enum: ["auto", "path", "symbol", "route", "layer", "kind"],
        default: "auto",
        description: "Restrict what is matched. Defaults to every category.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 20,
        description: "Maximum matches to return.",
      },
      root: ROOT_PROPERTY,
    },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { total: { type: "integer" } },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context);
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;

    const read = readManifest(workspace);
    if (!read.ok) return failure(read.message);

    const query = String(args.query ?? "").trim();
    if (query.length === 0) return failure('"query" must not be empty.');
    const needle = query.toLowerCase();
    const by = typeof args.by === "string" ? args.by : "auto";
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const manifest = read.manifest;

    interface Match {
      path: string;
      part: string;
      layer: string;
      kind: string;
      matchedBy: string;
      detail?: string;
    }
    const matches: Match[] = [];
    const add = (entry: FileEntry, matchedBy: string, detail?: string): void => {
      matches.push({
        path: entry.relativePath,
        part: entry.part,
        layer: entry.layer,
        kind: entry.kind,
        matchedBy,
        ...(detail ? { detail } : {}),
      });
    };

    const wants = (category: string): boolean => by === "auto" || by === category;

    for (const entry of manifest.files) {
      if (wants("path") && entry.relativePath.toLowerCase().includes(needle)) {
        add(entry, "path");
        continue;
      }
      if (wants("symbol")) {
        const symbol = symbolsOf(entry).find((name) => name.toLowerCase().includes(needle));
        if (symbol) {
          add(entry, "symbol", symbol);
          continue;
        }
      }
      // Substring, like every other category. Exact equality meant a query had to name a
      // layer perfectly, so `by: "layer", query: "s"` found nothing while `by: "path"`
      // with the same query found plenty — the same tool answering the same question two
      // different ways, which teaches an agent not to trust either.
      if (wants("layer") && entry.layer.toLowerCase().includes(needle)) add(entry, "layer");
      else if (wants("kind") && entry.kind.toLowerCase().includes(needle)) add(entry, "kind");
    }

    if (wants("route")) {
      for (const route of manifest.indexes.routes) {
        // A route is matched on its path *or* its method: "which endpoints accept POST"
        // is the same question as "where is /api/x", and only the path was searchable.
        const method = route.methods.find((name) => name.toLowerCase().includes(needle));
        if (!route.path.toLowerCase().includes(needle) && method === undefined) continue;
        if (matches.some((match) => match.path === route.path)) continue;
        matches.push({
          path: route.path,
          part: route.part,
          layer: "route",
          kind: "route",
          matchedBy: "route",
          detail: route.methods.join(", "),
        });
      }
    }

    if (matches.length === 0) {
      return {
        text:
          `Nothing in the snapshot matches "${query}". ` +
          "Try a shorter fragment, or snapshot_explain a path to see whether it is included at all.",
        structured: { total: 0, matches: [] },
      };
    }

    const shown = matches.slice(0, limit);
    const lines = [
      `${matches.length} match${matches.length === 1 ? "" : "es"} for "${query}"` +
        (matches.length > shown.length ? ` (showing ${shown.length})` : "") +
        ":",
    ];
    for (const match of shown) {
      const detail = match.detail ? ` — ${match.detail}` : "";
      lines.push(`  ${match.path}${detail}  [${match.part}, ${match.layer}/${match.kind}]`);
    }
    if (matches.length > shown.length) {
      lines.push("Raise `limit` to see more.");
    }

    return {
      text: lines.join("\n"),
      structured: { total: matches.length, returned: shown.length, matches: shown },
    };
  },
};

/**
 * The import graph, in both directions.
 *
 * `manifest.indexes.imports` has always held enough to answer "what does this file use" and
 * "what uses this file" — `centralFiles` ranks the most-imported files — but nothing an agent
 * could ask. So the one question that decides what to read next ("if I change this, what
 * breaks?") was answered by reading parts until the picture appeared, which is the cost the
 * snapshot exists to remove.
 *
 * The resolution runs through `buildImportResolver`, the same code the generator used, so
 * this cannot describe a different graph from the one in `centralFiles`.
 */
const dependentsTool: McpTool = {
  name: "snapshot_dependents",
  title: "Follow the import graph",
  description:
    "For one file in the snapshot: what it imports, and which files import it. Answers " +
    "\"what breaks if I change this?\" without reading the parts.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Snapshot-relative path, exactly as snapshot_locate or manifest.files[] reports it.",
      },
      direction: {
        type: "string",
        enum: ["both", "imports", "imported-by"],
        default: "both",
        description: "Which edges to return.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        default: 50,
        description: "Maximum entries per direction.",
      },
      root: ROOT_PROPERTY,
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      imports: { type: "array" },
      importedBy: { type: "array" },
      unresolved: { type: "array" },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context);
    if (!prepared.ok) return prepared.outcome;

    const read = readManifest(prepared.workspace);
    if (!read.ok) return failure(read.message);
    const manifest = read.manifest;

    const requested = String(args.path ?? "").trim().replace(/\\/g, "/");
    if (requested.length === 0) return failure('"path" must not be empty.');

    const filesByPath = new Map(manifest.files.map((file) => [file.relativePath, file]));
    const entry =
      filesByPath.get(requested) ??
      manifest.files.find((file) => file.relativePath.toLowerCase() === requested.toLowerCase());
    if (!entry) {
      return failure(
        `${requested} is not in the snapshot. Use snapshot_locate to find its path, or ` +
          "snapshot_explain to see whether it was excluded."
      );
    }

    const direction = args.direction === "imports" || args.direction === "imported-by"
      ? String(args.direction)
      : "both";
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 50;

    const resolver = buildImportResolver(manifest.files);
    const imports: Array<{ path: string; specifier: string; part: string }> = [];
    const unresolved: string[] = [];

    if (direction !== "imported-by") {
      const own = manifest.indexes.imports.byFile.find((file) => file.path === entry.relativePath);
      for (const specifier of own?.imports ?? []) {
        const resolved = resolveSpecifier(entry.relativePath, specifier, resolver);
        if (resolved === null) {
          unresolved.push(specifier);
          continue;
        }
        const target = filesByPath.get(resolved);
        if (target) imports.push({ path: resolved, specifier, part: target.part });
      }
    }

    const importedBy: Array<{ path: string; part: string }> = [];
    if (direction !== "imports") {
      for (const candidate of manifest.indexes.imports.byFile) {
        if (candidate.path === entry.relativePath) continue;
        const edge = candidate.imports.some(
          (specifier) => resolveSpecifier(candidate.path, specifier, resolver) === entry.relativePath
        );
        if (!edge) continue;
        const source = filesByPath.get(candidate.path);
        importedBy.push({ path: candidate.path, part: source?.part ?? "" });
      }
    }

    const shownImports = imports.slice(0, limit);
    const shownImportedBy = importedBy.slice(0, limit);

    const lines = [
      `${entry.relativePath} — ${importedBy.length} importer(s), ${imports.length} import(s), ` +
        `${unresolved.length} outside the snapshot.`,
    ];
    if (direction !== "imports") {
      lines.push("", "Imported by:");
      if (shownImportedBy.length === 0) lines.push("  (nothing in the snapshot imports it)");
      for (const item of shownImportedBy) lines.push(`  ${item.path}  [${item.part}]`);
      if (importedBy.length > shownImportedBy.length) {
        lines.push(`  … ${importedBy.length - shownImportedBy.length} more; raise \`limit\`.`);
      }
    }
    if (direction !== "imported-by") {
      lines.push("", "Imports:");
      if (shownImports.length === 0) lines.push("  (none recorded for this file)");
      for (const item of shownImports) {
        lines.push(`  ${item.path}  (from "${item.specifier}")  [${item.part}]`);
      }
      if (imports.length > shownImports.length) {
        lines.push(`  … ${imports.length - shownImports.length} more; raise \`limit\`.`);
      }
      if (unresolved.length > 0) {
        lines.push("", `Outside the snapshot (${unresolved.length}): ${unresolved.join(", ")}`);
      }
    }

    return {
      text: lines.join("\n"),
      structured: {
        path: entry.relativePath,
        imports: shownImports,
        importedBy: shownImportedBy,
        unresolved,
      },
    };
  },
};

const readTool: McpTool = {
  name: "snapshot_read",
  title: "Read a file from the snapshot",
  description:
    "Return a line window of one file as the snapshot contains it: redacted, and bounded to a " +
    "preview when the source is large. Reports the next `fromLine` when more remains.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to the repository root, as snapshot_locate reports it.",
      },
      fromLine: {
        type: "integer",
        minimum: 1,
        default: 1,
        description: "First line to return, 1-based.",
      },
      lines: {
        type: "integer",
        minimum: 1,
        maximum: 2000,
        default: 200,
        description: "How many lines to return.",
      },
      root: ROOT_PROPERTY,
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      part: { type: "string" },
      fromLine: { type: "integer" },
      returnedLines: { type: "integer" },
      totalLines: { type: "integer" },
      nextFromLine: { type: "integer" },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context);
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;

    if (typeof args.path !== "string") return failure('"path" must be a string.');
    const relativePath = toRelativePath(workspace.root, args.path);
    if (!relativePath) {
      return failure(
        `"${args.path}" is outside ${workspace.root}. Paths are read relative to the repository root.`
      );
    }

    const read = readManifest(workspace);
    if (!read.ok) return failure(read.message);
    const manifest = read.manifest;

    const entry =
      manifest.files.find((file) => file.relativePath === relativePath) ??
      manifest.files.find((file) => file.relativePath.toLowerCase() === relativePath.toLowerCase());

    if (!entry) {
      const skipped = manifest.skipped.find((record) => record.path === relativePath);
      if (skipped) {
        const detail = skipped.detail ? ` (${skipped.detail})` : "";
        return failure(
          `${relativePath} is not in the snapshot: ${skipped.reason}${detail}. ` +
            "Sensitive and ignored files stay out unless they are included explicitly."
        );
      }
      return failure(
        `${relativePath} is not in the snapshot. Call snapshot_locate to find the path, or ` +
          "snapshot_explain to learn why it was excluded."
      );
    }

    const partPath = path.resolve(workspace.root, workspace.config.outDir, "parts", entry.part);
    let partText: string;
    try {
      partText = fs.readFileSync(partPath, "utf8");
    } catch {
      return failure(
        `${entry.part} could not be read, so the snapshot is damaged. Run snapshot_generate to rebuild it.`
      );
    }

    const section = findSection(parsePartSections(partText), entry.relativePath, entry.hashSha256);
    if (!section) {
      return failure(
        `${relativePath} is recorded in ${entry.part} but its section could not be located there. ` +
          "Run snapshot_generate to rebuild the snapshot."
      );
    }

    const fromLine = typeof args.fromLine === "number" ? args.fromLine : 1;
    const lineCount = typeof args.lines === "number" ? args.lines : 200;
    const window = windowText(section.body, fromLine, lineCount);

    let body = window.text;
    let truncatedByBytes = false;
    if (Buffer.byteLength(body, "utf8") > MAX_RESULT_BYTES) {
      // Bytes, not code units. `String.prototype.slice` counts UTF-16 code units, so a
      // body of three-byte characters came back up to three times over the limit — and
      // slicing at an odd index could split a surrogate pair, emitting a lone half that
      // no JSON parser downstream can accept. `truncateToBytes` walks the boundary.
      const clipped = truncateToBytes(body, MAX_RESULT_BYTES);
      body = clipped.content;
      const lastBreak = body.lastIndexOf("\n");
      body = lastBreak > 0 ? body.slice(0, lastBreak) : body;
      truncatedByBytes = true;
    }
    const returnedLines = body.length === 0 ? 0 : body.split("\n").length;
    const moreRemain = window.truncated || truncatedByBytes;

    const header = [
      `${entry.relativePath} — ${entry.part}, ${entry.layer}/${entry.kind}, ${entry.language}`,
      section.inclusion === "preview"
        ? "Bounded preview: this source file is large, so the snapshot holds only its head and tail."
        : `Lines ${window.fromLine}\u2013${window.fromLine + returnedLines - 1} of ${window.totalLines}.`,
    ];
    const lines = [...header, "", body];
    if (moreRemain) {
      const next = window.fromLine + returnedLines;
      lines.push("", `Truncated. Call snapshot_read with fromLine=${next} for the rest.`);
    }

    return {
      text: lines.join("\n"),
      structured: {
        path: entry.relativePath,
        part: entry.part,
        layer: entry.layer,
        kind: entry.kind,
        language: entry.language,
        inclusion: section.inclusion ?? entry.inclusionMode,
        fromLine: window.fromLine,
        returnedLines,
        totalLines: window.totalLines,
        truncated: moreRemain,
        nextFromLine: moreRemain ? window.fromLine + returnedLines : null,
        sha256: entry.hashSha256,
      },
    };
  },
};

const explainTool: McpTool = {
  name: "snapshot_explain",
  title: "Explain one path",
  description:
    "Explain how the next snapshot would treat one path: its layer, kind, language and part, or " +
    "the exact reason it is excluded. Answers \"why is this file missing\".",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path relative to the repository root. Directories are explained as a whole.",
      },
      root: ROOT_PROPERTY,
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      included: { type: "boolean" },
      reason: { type: "string" },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context);
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;

    if (typeof args.path !== "string") return failure('"path" must be a string.');
    const relativePath = toRelativePath(workspace.root, args.path);
    if (!relativePath) {
      return failure(`"${args.path}" is outside ${workspace.root}.`);
    }

    let result: ExplainResult;
    try {
      result = explainPath(workspace.config, relativePath);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }

    return {
      text: renderExplainText(result),
      structured: {
        path: result.path,
        included: result.included,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.layer ? { layer: result.layer } : {}),
        ...(result.kind ? { kind: result.kind } : {}),
        ...(result.language ? { language: result.language } : {}),
        ...(result.part ? { part: result.part } : {}),
        ...(result.inclusionMode ? { inclusion: result.inclusionMode } : {}),
        ...(typeof result.lines === "number" ? { lines: result.lines } : {}),
        ...(typeof result.bytes === "number" ? { bytes: result.bytes } : {}),
        ...(typeof result.secretCount === "number" ? { secretCount: result.secretCount } : {}),
      },
    };
  },
};

/** Every tool this server exposes, in the order a first-time caller should read them. */
export function buildTools(): McpTool[] {
  return [
    statusTool,
    planTool,
    generateTool,
    validateTool,
    locateTool,
    dependentsTool,
    readTool,
    explainTool,
  ];
}
