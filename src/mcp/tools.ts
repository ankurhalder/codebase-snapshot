/**
 * The seventeen tools this server exposes.
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
import { auditSnapshot } from "../auditor/health.js";
import { planForQuestion } from "./retrieval.js";
import { explainPath, renderExplainText } from "../explain.js";
import type { ExplainResult } from "../explain.js";
import { buildImportResolver, resolveSpecifier } from "../index.js";

/** One search reads at most this many bytes of part text. */
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
import { truncateToBytes } from "../partitioner/preview.js";
import { validateSnapshot } from "../validator/validate.js";
import { GENERATOR_VERSION } from "../version.js";
import { generateInWorker } from "./generate-worker.js";
import { findSection, parsePartSections, windowText } from "./part.js";
import type { JsonObject, JsonSchema } from "./protocol.js";
import type { FileEntry, ValidationDrift, ValidationResult } from "../types.js";
import type { McpTool, ToolAnnotations, ToolContext, ToolOutcome } from "./types.js";
import { forgetManifest, manifestPathFor, openWorkspace, partPathFor, readManifest, resolveRoot } from "./workspace.js";
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

/**
 * Where the snapshot lives, when it is not the `outDir` in the project configuration.
 *
 * Every read tool takes it, not just `snapshot_generate`. Without it a snapshot generated into
 * a custom directory — the one thing `generate` lets a caller choose — could not be inspected by
 * a single one of the seventeen tools: `snapshot_generate` wrote it, and everything else looked in
 * the configured directory and reported "there is no snapshot manifest here".
 */
const OUT_DIR_PROPERTY = {
  type: "string" as const,
  description:
    "Snapshot directory, relative to the root, and it must resolve inside the served repository. " +
    "Defaults to the project configuration's outDir.",
};

/** The override every tool takes from `args.outDir`, so the two cannot drift apart. */
const outDirOverride = (args: JsonObject): WorkspaceOverrides => ({ outDir: args.outDir });

/**
 * The scope and compression switches `generate` accepts, as schema properties and as overrides.
 *
 * One definition for both halves, because a flag that is advertised and not applied is the same
 * defect as one applied and not advertised. `snapshot_validate` needs them for a reason of its
 * own: it re-derives the effective configuration and compares digests, so a snapshot generated
 * with `--skeleton` or `--changed-since` could not be validated at all — every field of the
 * comparison disagreed with a configuration the server could not describe.
 */
const SCOPE_PROPERTIES: Record<string, JsonSchema> = {
  maxPartTokens: {
    type: "string",
    description:
      'Token ceiling per part, for example 32000 or "32k". Narrower than maxPartBytes; it converts at four bytes per token.',
  },
  skeleton: {
    type: "boolean",
    description:
      "Replace every function body with `{ /* ... */ }`, keeping signatures, imports and exports. Applies to TypeScript, JavaScript and JSX.",
  },
  sarif: {
    type: "boolean",
    description: "Also write reports/audit.sarif beside reports/audit.md, for CI code scanning.",
  },
  changedSince: {
    type: "string",
    description: 'Only files changed since this git ref, for example "main" or "HEAD~3".',
  },
  staged: {
    type: "boolean",
    description: "Only files staged in the git index.",
  },
  withDependents: {
    type: "boolean",
    description:
      "With staged or changedSince, also include the files that import the changed ones (one hop).",
  },
};

/** `args` → the overrides `openWorkspace` understands, for the tools that take them. */
function workspaceOverrides(args: JsonObject): WorkspaceOverrides {
  return {
    outDir: args.outDir,
    maxPartBytes: args.maxPartBytes,
    maxPartTokens: args.maxPartTokens,
    skeleton: args.skeleton,
    sarif: args.sarif,
    changedSince: args.changedSince,
    staged: args.staged,
    withDependents: args.withDependents,
  };
}


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

/**
 * Paths the model sees are POSIX-relative to the root, whatever platform is hosting.
 *
 * The containment check used to run *after* the "is it absolute?" test, so `../secret.txt` and
 * `src/../../outside.txt` were returned to the caller unchanged — and `snapshot_explain` then
 * joined that to the root and called `existsSync`, which turned a read-only tool into an existence
 * oracle for any path on the host. Everything is resolved against the root first now; the answer
 * is `null` for anything that does not land inside it.
 */
function toRelativePath(root: string, value: string): string | null {
  const cleaned = value.trim();
  if (cleaned.length === 0 || cleaned.includes("\0")) return null;
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(resolvedRoot, cleaned);
  const relative = path.relative(resolvedRoot, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
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
    // The rest of the same records. `variables` is where a `const`, a Python constant, a Go
    // `var`, a Rust `mod`, a C `#define` and a Terraform `variable` block all land, so leaving it
    // out made `snapshot_locate` miss most of what a non-JavaScript file declares; `directives`
    // carries `"use client"`-style markers, and `frontmatterKeys`/`keys` are the headings and
    // top-level names of a Markdown or JSON file.
    "variables",
    "directives",
    "frontmatterKeys",
    "keys",
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
  // The outDir override is confined to the same directories a root may name: one comes from a
  // prompt, the other from the server's launch directory, and a tool argument may not widen either.
  const opened = await openWorkspace(rootOutcome.root, overrides, context.roots, {
    allowExecutableConfig: false,
  });
  if (!opened.ok) return { ok: false, outcome: failure(opened.message) };
  return { ok: true, workspace: opened.workspace };
}

/** The symbol names a file summary carries, for a query filter. */
function symbolNamesOf(file: FileEntry): string[] {
  const summary = file.summary as unknown as Record<string, unknown> | undefined;
  if (summary === undefined) return [];
  const names: string[] = [];
  for (const key of ["exports", "functions", "classes", "interfaces", "types", "enums"]) {
    const value = summary[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) if (typeof item === "string") names.push(item);
  }
  return names;
}

const searchTool: McpTool = {
  name: "snapshot_search",
  title: "Search the snapshot text",
  description:
    "Case-insensitive text search across the emitted parts, bounded by a match cap and a scan " +
    "budget. Returns the path, part and line number of each match with a short snippet. Reads " +
    "only what the snapshot contains, so redacted values and excluded files are never found.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to find (at least 3 characters)." },
      regex: { type: "boolean", description: "Treat the query as a regular expression." },
      maxMatches: { type: "integer", description: "Cap on matches (default 50).", minimum: 1 },
      contextLines: { type: "integer", description: "Lines of context around each match (default 0).", minimum: 0 },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      matches: { type: "array", items: { type: "object" } },
      scanned: { type: "integer" },
      truncated: { type: "boolean" },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;
    const read = readManifest(workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    const query = typeof args.query === "string" ? args.query : "";
    if (query.trim().length < 3) return { text: "query must be at least 3 characters", isError: true };
    const cap = Math.max(1, Math.min(500, typeof args.maxMatches === "number" ? args.maxMatches : 50));
    const contextLines = Math.max(0, Math.min(10, typeof args.contextLines === "number" ? args.contextLines : 0));
    let pattern: RegExp;
    try {
      pattern = args.regex === true ? new RegExp(query, "i") : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch (error) {
      return { text: "not a valid regular expression: " + (error as Error).message, isError: true };
    }

    const matches: Array<{ path: string; part: string; line: number; text: string }> = [];
    const skippedOversize: string[] = [];
    let scanned = 0;
    let truncated = false;
    for (const part of read.manifest.parts) {
      if (matches.length >= cap) { truncated = true; break; }
      const partPath = partPathFor(workspace, part.filename);
      if (partPath === null) continue;
      let text: string;
      try {
        text = fs.readFileSync(partPath, "utf8");
      } catch {
        continue;
      }
      if (Buffer.byteLength(text, "utf8") > MAX_SEARCH_BYTES) {
        skippedOversize.push(part.filename);
        continue;
      }
      scanned += text.length;
      for (const section of parsePartSections(text)) {
        if (matches.length >= cap) { truncated = true; break; }
        const lines = section.body.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          if (!pattern.test(lines[index])) continue;
          const from = Math.max(0, index - contextLines);
          const to = Math.min(lines.length, index + contextLines + 1);
          const snippet = lines.slice(from, to).join("\n").trim().slice(0, 400);
          matches.push({ path: section.path, part: part.filename, line: index + 1, text: snippet });
          if (matches.length >= cap) { truncated = true; break; }
        }
      }
    }

    const lines = [
      matches.length + " match(es) in " + read.manifest.files.length + " file(s)." +
        (truncated ? " Results are capped; narrow the query." : ""),
      ...(skippedOversize.length > 0
        ? ["Skipped " + skippedOversize.length + " oversized part(s): " + skippedOversize.slice(0, 5).join(", ")]
        : []),
      ...matches.map((match) => match.path + ":" + match.line + " (" + match.part + "): " + match.text),
    ];
    return { text: lines.join("\n"), structured: { matches, scanned, truncated } };
  },
};

const statsTool: McpTool = {
  name: "snapshot_stats",
  title: "Snapshot statistics",
  description:
    "Counts and costs: files by layer and kind, part sizes, token estimate, the largest files " +
    "and the most expensive parts. Read from the manifest, so it is cheap and always agrees with " +
    "what the snapshot claims.",
  inputSchema: {
    type: "object",
    properties: { root: ROOT_PROPERTY, outDir: OUT_DIR_PROPERTY },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      files: { type: "integer" },
      parts: { type: "integer" },
      tokens: { type: "integer" },
      layers: { type: "object" },
      kinds: { type: "object" },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const read = readManifest(prepared.workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    const manifest = read.manifest;
    const heaviest = [...manifest.files]
      .sort((left, right) => right.includedBytes - left.includedBytes)
      .slice(0, 10)
      .map((file) => ({ path: file.relativePath, tokens: Math.ceil(file.includedBytes / 4), part: file.part }));
    const parts = manifest.parts.map((part) => ({ filename: part.filename, tokens: part.estimatedTokens }));
    const lines = [
      manifest.counts.totalFiles + " file(s) in " + manifest.counts.partsCount + " part(s), " +
        (manifest.totals.estimatedTokens ?? 0) + " estimated tokens.",
      "Layers: " + Object.entries(manifest.layers).map(([name, count]) => name + "=" + count).join(", "),
      "Kinds: " + Object.entries(manifest.kinds).map(([name, count]) => name + "=" + count).join(", "),
      "Heaviest: " + heaviest.slice(0, 5).map((file) => file.path + " (" + file.tokens + ")").join(", "),
    ];
    return {
      text: lines.join("\n"),
      structured: {
        files: manifest.counts.totalFiles,
        parts: manifest.counts.partsCount,
        tokens: manifest.totals.estimatedTokens ?? 0,
        layers: manifest.layers,
        kinds: manifest.kinds,
        heaviest,
        partSizes: parts,
      },
    };
  },
};

const reviewTool: McpTool = {
  name: "snapshot_review",
  title: "Review a change set against the snapshot",
  description:
    "One call for a review: is the snapshot current, what does the health audit say, and what " +
    "do the given paths contain? Combines validate, health and bounded reads so a reviewer does " +
    "not have to ask three questions to start. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "Changed paths to include." },
      linesPerFile: { type: "integer", description: "Head lines per path (default 60).", minimum: 10 },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      current: { type: "boolean" },
      score: { type: "integer" },
      failed: { type: "array", items: { type: "string" } },
      files: { type: "array", items: { type: "object" } },
      missing: { type: "array", items: { type: "string" } },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;
    const linesPerFile = Math.max(10, typeof args.linesPerFile === "number" ? args.linesPerFile : 60);
    const read = readManifest(workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };

    let validation;
    try {
      validation = validateSnapshot(workspace.config);
    } catch (error) {
      return { text: (error as Error).message, isError: true };
    }
    const report = auditSnapshot({
      snapshotDir: path.resolve(workspace.root, workspace.config.outDir),
      repoDir: workspace.root,
    });
    const failed = report.checks.filter((check) => check.status === "fail").map((check) => check.id + ": " + check.detail);

    const wanted = Array.isArray(args.paths) ? args.paths.filter((item) => typeof item === "string") : [];
    const byPath = new Map(read.manifest.files.map((file) => [file.relativePath.toLowerCase(), file]));
    const files = [];
    const missing: string[] = [];
    const body: string[] = [];
    for (const wantedPath of wanted) {
      const file = byPath.get(wantedPath.toLowerCase());
      if (file === undefined) {
        missing.push(wantedPath);
        continue;
      }
      const partPath = partPathFor(workspace, file.part);
      if (partPath === null) {
        missing.push(wantedPath + " (part missing)");
        continue;
      }
      let section = null;
      try {
        section = findSection(parsePartSections(fs.readFileSync(partPath, "utf8")), file.relativePath);
      } catch {
        section = null;
      }
      if (section === null) {
        missing.push(wantedPath + " (section not found)");
        continue;
      }
      const window = windowText(section.body, 1, linesPerFile);
      files.push({ path: file.relativePath, part: file.part, lines: window.text === "" ? 0 : window.text.split("\n").length });
      body.push("### " + file.relativePath + " (" + file.part + ")", window.text);
    }

    const summary = [
      validation.valid ? "Snapshot: current." : "Snapshot: stale; run snapshot_generate before trusting it.",
      "Health: " + report.score + "/100 (" + report.counts.pass + " passed, " + report.counts.warn + " warning(s), " + report.counts.fail + " failed).",
      ...failed.map((item) => "FAIL " + item),
    ];
    if (missing.length > 0) summary.push("Not in the snapshot: " + missing.join(", "));
    return {
      text: summary.join("\n") + (body.length === 0 ? "" : "\n\n" + body.join("\n\n")),
      structured: { current: validation.valid, score: report.score, failed, files, missing },
    };
  },
};

const diffContextTool: McpTool = {
  name: "snapshot_diff_context",
  title: "Context for a set of changed files",
  description:
    "Given the paths a change touched, return each one head window plus the files that import " +
    "it, within a token budget. The dependents are what a reviewer usually misses. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "Changed paths, as the manifest names them." },
      maxTokens: { type: "integer", description: "Budget for the block (default 15000).", minimum: 500 },
      linesPerFile: { type: "integer", description: "Head lines per changed file (default 80).", minimum: 10 },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
    required: ["paths"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      budgetTokens: { type: "integer" },
      usedTokens: { type: "integer" },
      changed: { type: "array", items: { type: "object" } },
      dependents: { type: "array", items: { type: "object" } },
      missing: { type: "array", items: { type: "string" } },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;
    const read = readManifest(workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    const wanted = Array.isArray(args.paths) ? args.paths.filter((item) => typeof item === "string") : [];
    if (wanted.length === 0) return { text: "paths must be a non-empty array", isError: true };
    const budget = Math.max(500, typeof args.maxTokens === "number" ? args.maxTokens : 15000);
    const linesPerFile = Math.max(10, typeof args.linesPerFile === "number" ? args.linesPerFile : 80);
    const byPath = new Map(read.manifest.files.map((file) => [file.relativePath.toLowerCase(), file]));
    const importers = new Map<string, string[]>();
    for (const entry of read.manifest.indexes.imports.byFile) {
      for (const specifier of entry.imports) {
        if (!specifier.startsWith(".")) continue;
        const base = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
        const parts: string[] = [];
        for (const segment of (base + "/" + specifier).split("/")) {
          if (segment === "" || segment === ".") continue;
          if (segment === "..") parts.pop();
          else parts.push(segment);
        }
        const joined = parts.join("/").toLowerCase();
        const withoutExtension = joined.replace(/\.[cm]?[jt]sx?$/, "");
        const target =
          byPath.get(joined) ??
          byPath.get(withoutExtension + ".ts") ??
          byPath.get(withoutExtension + ".tsx") ??
          byPath.get(withoutExtension + ".js") ??
          byPath.get(withoutExtension + ".py") ??
          byPath.get(withoutExtension + "/index.ts") ??
          byPath.get(withoutExtension);
        if (target === undefined) continue;
        const list = importers.get(target.relativePath) ?? [];
        list.push(entry.path);
        importers.set(target.relativePath, list);
      }
    }
    const missing: string[] = [];
    const changed = [];
    const text: string[] = [];
    let used = 0;
    for (const path of wanted) {
      const file = byPath.get(path.toLowerCase());
      if (file === undefined) {
        missing.push(path);
        continue;
      }
      const partPath = partPathFor(workspace, file.part);
      if (partPath === null) {
        missing.push(path + " (part missing)");
        continue;
      }
      let section;
      try {
        section = findSection(parsePartSections(fs.readFileSync(partPath, "utf8")), file.relativePath);
      } catch {
        section = null;
      }
      if (section === null) {
        missing.push(path + " (section not found)");
        continue;
      }
      const window = windowText(section.body, 1, linesPerFile);
      const tokens = Math.max(1, Math.ceil(Buffer.byteLength(window.text, "utf8") / 4));
      if (used + tokens > budget) {
        missing.push(path + " (budget)");
        continue;
      }
      used += tokens;
      changed.push({ path: file.relativePath, part: file.part, tokens });
      text.push("### " + file.relativePath + " (" + file.part + ")");
      text.push(window.text);
    }
    const dependents: Array<{ path: string; imports: string }> = [];
    for (const entry of changed) {
      for (const importer of importers.get(entry.path) ?? []) {
        if (!dependents.some((item) => item.path === importer)) dependents.push({ path: importer, imports: entry.path });
      }
    }
    const note =
      dependents.length === 0
        ? "No file in the snapshot imports the changed paths."
        : dependents.length + " dependent(s): " + dependents.map((item) => item.path).join(", ");
    return {
      text: text.join("\n\n") + "\n\n" + note,
      structured: { budgetTokens: budget, usedTokens: used, changed, dependents, missing },
    };
  },
};

const symbolTool: McpTool = {
  name: "snapshot_symbol",
  title: "Find a symbol definition",
  description:
    "Find where a function, class, interface, type or constant is defined in the snapshot and " +
    "return a window around the definition with line numbers. Searches the emitted parts, so " +
    "redaction still applies. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Symbol name, case-insensitive." },
      lines: { type: "integer", description: "Window size around the definition (default 40).", minimum: 5 },
      maxFiles: { type: "integer", description: "Cap on files searched (default 5).", minimum: 1 },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
    required: ["name"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      found: { type: "integer" },
      matches: { type: "array", items: { type: "object" } },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;
    const read = readManifest(workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (name === "") return { text: "name must be a non-empty string", isError: true };
    const lower = name.toLowerCase();
    const windowSize = Math.max(5, typeof args.lines === "number" ? args.lines : 40);
    const cap = Math.max(1, typeof args.maxFiles === "number" ? args.maxFiles : 5);
    const candidates = read.manifest.files.filter((file) =>
      symbolNamesOf(file).some((symbol) => symbol.toLowerCase() === lower || symbol.toLowerCase().endsWith("." + lower))
    );
    const matches = [];
    for (const file of candidates.slice(0, cap)) {
      const partPath = partPathFor(workspace, file.part);
      if (partPath === null) continue;
      let partText: string;
      try {
        partText = fs.readFileSync(partPath, "utf8");
      } catch {
        continue;
      }
      const section = findSection(parsePartSections(partText), file.relativePath);
      if (section === null) continue;
      const lines = section.body.split("\n");
      const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const definition = new RegExp(
        "^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|func|struct|impl|mod)\\s+" + escaped + "\\b",
        "i"
      );
      const index = lines.findIndex((line) => definition.test(line));
      if (index === -1) continue;
      const from = Math.max(0, index - 3);
      const to = Math.min(lines.length, index + windowSize);
      matches.push({
        path: file.relativePath,
        part: file.part,
        line: index + 1,
        text: lines.slice(from, to).join("\n"),
      });
    }
    if (matches.length === 0) {
      return {
        text: "No definition of " + name + " was found in the snapshot. It may be excluded, in a language without a symbol profile, or named differently; snapshot_explain says which for a path.",
        structured: { found: 0, matches: [] },
      };
    }
    const text = matches
      .map((match) => "### " + match.path + " (" + match.part + ", line " + match.line + ")\n" + match.text)
      .join("\n\n");
    return { text, structured: { found: matches.length, matches } };
  },
};

const contextTool: McpTool = {
  name: "snapshot_context",
  title: "Assemble a bounded context block",
  description:
    "Given file paths, symbol names, or both, return their contents (from the snapshot, so " +
    "redacted and preview-bounded) as one context block within a token budget. Each file " +
    "contributes a head window; files that do not fit are reported, never silently dropped.",
  inputSchema: {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" }, description: "Paths, as the manifest names them." },
      symbols: { type: "array", items: { type: "string" }, description: "Exported symbol names." },
      maxTokens: { type: "integer", description: "Budget for the block (default 20000).", minimum: 500 },
      linesPerFile: { type: "integer", description: "Head lines per file (default 80).", minimum: 10 },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      budgetTokens: { type: "integer" },
      usedTokens: { type: "integer" },
      files: { type: "array", items: { type: "object" } },
      missing: { type: "array", items: { type: "string" } },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;
    const read = readManifest(workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    const manifest = read.manifest;
    const wantedFiles = Array.isArray(args.files) ? args.files.filter((item) => typeof item === "string") : [];
    const wantedSymbols = Array.isArray(args.symbols)
      ? args.symbols.filter((item) => typeof item === "string").map((item) => item.toLowerCase())
      : [];
    if (wantedFiles.length === 0 && wantedSymbols.length === 0) {
      return { text: "Provide at least one of files or symbols.", isError: true };
    }
    const budget = Math.max(500, typeof args.maxTokens === "number" ? args.maxTokens : 20000);
    const linesPerFile = Math.max(10, typeof args.linesPerFile === "number" ? args.linesPerFile : 80);

    const byPath = new Map(manifest.files.map((file) => [file.relativePath.toLowerCase(), file]));
    const targets: FileEntry[] = [];
    const missing: string[] = [];
    for (const wanted of wantedFiles) {
      const found = byPath.get(wanted.toLowerCase());
      if (found === undefined) missing.push(wanted);
      else if (!targets.includes(found)) targets.push(found);
    }
    for (const symbol of wantedSymbols) {
      const matches = manifest.files.filter((file) =>
        symbolNamesOf(file).some((name) => name.toLowerCase() === symbol)
      );
      for (const file of matches) if (!targets.includes(file)) targets.push(file);
    }

    const sectionsByPart = new Map<string, ReturnType<typeof parsePartSections> | null>();
    const blocks: Array<{ path: string; part: string; lines: number; tokens: number }> = [];
    const text: string[] = [];
    let used = 0;
    for (const file of targets) {
      if (used >= budget) {
        missing.push(file.relativePath + " (budget)");
        continue;
      }
      const partPath = partPathFor(workspace, file.part);
      if (partPath === null) {
        missing.push(file.relativePath + " (part missing)");
        continue;
      }
      if (!sectionsByPart.has(file.part)) {
        try {
          sectionsByPart.set(file.part, parsePartSections(fs.readFileSync(partPath, "utf8")));
        } catch {
          sectionsByPart.set(file.part, null);
        }
      }
      const sections = sectionsByPart.get(file.part);
      const section = sections === null || sections === undefined ? null : findSection(sections, file.relativePath);
      if (section === null) {
        missing.push(file.relativePath + " (section not found)");
        continue;
      }
      const window = windowText(section.body, 1, linesPerFile);
      const body = window.text;
      let tokens = Math.max(1, Math.ceil(Buffer.byteLength(body, "utf8") / 4));
      if (used + tokens > budget) {
        const keep = Math.max(4, Math.floor(((budget - used) / tokens) * linesPerFile));
        const smaller = windowText(section.body, 1, Math.max(4, keep));
        if (Buffer.byteLength(smaller.text, "utf8") === 0) {
          missing.push(file.relativePath + " (budget)");
          continue;
        }
        const partial = Math.max(1, Math.ceil(Buffer.byteLength(smaller.text, "utf8") / 4));
        text.push("### " + file.relativePath + " (" + file.part + ", first " + Math.max(4, keep) + " lines)");
        text.push(smaller.text);
        blocks.push({ path: file.relativePath, part: file.part, lines: Math.max(4, keep), tokens: partial });
        used += partial;
        continue;
      }
      text.push("### " + file.relativePath + " (" + file.part + ")");
      text.push(body);
      blocks.push({ path: file.relativePath, part: file.part, lines: window.text === "" ? 0 : window.text.split("\n").length, tokens });
      used += tokens;
    }

    return {
      text: text.join("\n\n"),
      structured: { budgetTokens: budget, usedTokens: used, files: blocks, missing },
    };
  },
};

const queryTool: McpTool = {
  name: "snapshot_query",
  title: "Query the snapshot index",
  description:
    "Filter the snapshot by layer, kind, a path regular expression or a symbol name, and return " +
    "the matching files with their part, line count and token estimate. Use it to find a " +
    "starting set before snapshot_context or snapshot_read. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      layer: { type: "string", description: "Exact layer name, e.g. src or test." },
      kind: { type: "string", description: "Exact kind, e.g. source, test, config." },
      pathPattern: { type: "string", description: "Regular expression matched against the path." },
      symbol: { type: "string", description: "Case-insensitive substring of an exported symbol." },
      maxFiles: { type: "integer", description: "Cap on returned files (default 40).", minimum: 1 },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      matched: { type: "integer" },
      returned: { type: "integer" },
      files: { type: "array", items: { type: "object" } },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const read = readManifest(prepared.workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    const layer = typeof args.layer === "string" ? args.layer : undefined;
    const kind = typeof args.kind === "string" ? args.kind : undefined;
    const symbol = typeof args.symbol === "string" ? args.symbol.toLowerCase() : undefined;
    const maxFiles =
      typeof args.maxFiles === "number" ? Math.min(200, Math.max(1, args.maxFiles)) : 40;
    let pattern: RegExp | null = null;
    if (typeof args.pathPattern === "string") {
      try {
        pattern = new RegExp(args.pathPattern, "i");
      } catch (error) {
        return { text: "pathPattern is not a valid regular expression: " + (error as Error).message, isError: true };
      }
    }
    const matches = read.manifest.files.filter((file) => {
      if (layer !== undefined && file.layer !== layer) return false;
      if (kind !== undefined && file.kind !== kind) return false;
      if (pattern !== null && !pattern.test(file.relativePath)) return false;
      if (symbol !== undefined) {
        const names = symbolNamesOf(file);
        if (!names.some((name) => name.toLowerCase().includes(symbol))) return false;
      }
      return true;
    });
    const files = matches.slice(0, maxFiles).map((file) => ({
      path: file.relativePath,
      layer: file.layer,
      kind: file.kind,
      part: file.part,
      lines: file.includedLines,
      tokens: Math.max(1, Math.ceil(file.includedBytes / 4)),
    }));
    const lines = [
      matches.length + " file(s) matched; showing " + files.length + ".",
      ...files.map((file) => file.path + " (" + file.layer + ", " + file.part + ", " + file.tokens + " tokens)"),
    ];
    return { text: lines.join("\n"), structured: { matched: matches.length, returned: files.length, files } };
  },
};

const planForTool: McpTool = {
  name: "snapshot_plan_for",
  title: "Plan a reading order for a question",
  description:
    "Given a question and a token budget, return the smallest set of files from the snapshot " +
    "that answer it, in reading order, each with the reason it was chosen and the part it lives " +
    "in. Deterministic: path and symbol matches first, then the imports of the strongest " +
    "matches, packed to the budget. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "What you need to answer, in the user words." },
      maxTokens: { type: "integer", description: "Budget for the plan (default 30000).", minimum: 500 },
      includeTests: { type: "boolean", description: "Include test files (default false)." },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
    required: ["question"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      question: { type: "string" },
      budgetTokens: { type: "integer" },
      usedTokens: { type: "integer" },
      files: { type: "array", items: { type: "object" } },
      skipped: { type: "array", items: { type: "object" } },
      notes: { type: "array", items: { type: "string" } },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (question.length === 0) return { text: "question must be a non-empty string", isError: true };
    const maxTokens = typeof args.maxTokens === "number" ? args.maxTokens : undefined;
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const read = readManifest(prepared.workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    const plan = planForQuestion(read.manifest, question, {
      ...(maxTokens === undefined ? {} : { maxTokens }),
      includeTests: args.includeTests === true,
    });
    const lines = [
      "Plan for: " + question,
      "Budget: " + plan.usedTokens + " of " + plan.budgetTokens + " tokens; " +
        plan.files.length + " file(s).",
      ...plan.files.map(
        (file, index) =>
          (index + 1) + ". " + file.path + " (" + file.part + ", " + file.tokens + " tokens, " +
          file.mode + ") - " + file.why
      ),
      ...plan.notes.map((note) => "- " + note),
    ];
    return { text: lines.join("\n"), structured: plan as unknown as JsonObject };
  },
};

const healthTool: McpTool = {
  name: "snapshot_health",
  title: "Snapshot health audit",
  description:
    "Audit the generated snapshot against the repository: manifest shape, part hashes, the " +
    "artifacts it claims, unmasked secrets anywhere in the written text, values from files that " +
    "were excluded as sensitive, host paths, the recorded token count and freshness. Returns a " +
    "score and one entry per check. Read-only; it never regenerates anything.",
  inputSchema: {
    type: "object",
    properties: { root: ROOT_PROPERTY, outDir: OUT_DIR_PROPERTY },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      score: { type: "integer" },
      counts: { type: "object" },
      checks: { type: "array", items: { type: "object" } },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;
    const report = auditSnapshot({
      snapshotDir: path.resolve(workspace.root, workspace.config.outDir),
      repoDir: workspace.root,
    });
    const lines = [
      "Health: " + report.score + "/100 (" + report.counts.pass + " passed, " +
        report.counts.warn + " warning(s), " + report.counts.fail + " failed)",
      ...report.checks.map(
        (item) =>
          (item.status === "fail" ? "FAIL " : item.status === "warn" ? "WARN " : "PASS ") +
          item.id + ": " + item.detail
      ),
    ];
    return {
      text: lines.join("\n"),
      structured: {
        score: report.score,
        counts: report.counts,
        checks: report.checks.map((item) => ({
          id: item.id,
          title: item.title,
          severity: item.severity,
          status: item.status,
          detail: item.detail,
        })),
      },
    };
  },
};

const statusTool: McpTool = {
  name: "snapshot_status",
  title: "Snapshot status",
  description:
    "Report whether a snapshot exists for this repository, when it was built, and what it covers. " +
    "Reads the manifest rather than the repository, so it is cheap. Call it before deciding " +
    "whether a snapshot needs to be generated.",
  inputSchema: {
    type: "object",
    properties: { root: ROOT_PROPERTY, outDir: OUT_DIR_PROPERTY },
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
    const prepared = await prepare(args, context, outDirOverride(args));
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
      outDir: OUT_DIR_PROPERTY,
      maxPartBytes: {
        type: "string",
        description:
          'Byte budget per part, for example 307200 or "300k". Defaults to the project configuration.',
      },
      ...SCOPE_PROPERTIES,
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
    const prepared = await prepare(args, context, workspaceOverrides(args));
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;

    // Off the JSON-RPC thread, for the same reason `snapshot_generate` is: a dry run reads and
    // parses every file in the repository, so a synchronous one stops this server answering
    // `ping` for seconds — the failure the worker was added to fix. It was applied to one of the
    // two generate call sites.
    const result = await generateInWorker(workspace.root, workspace.cliOptions, { dryRun: true });
    if (!result.ok) return failure(result.message);
    const summary = result.summary;
    const topReasons = summary.skipReasons;

    const lines = [
      "Dry run — nothing was written.",
      `Preset: ${summary.preset}`,
      `Would include ${plural(summary.totalFiles, "file")} in ` +
        `${plural(summary.partsCount, "part")} (${formatBytes(summary.totalSizeBytes)} of source, ` +
        `${formatBytes(summary.totalContentBytes)} emitted).`,
      `Would skip ${plural(summary.skippedCount, "file")}.`,
    ];
    if (topReasons.length > 0) {
      lines.push("Top skip reasons:");
      for (const entry of topReasons) lines.push(`  - ${entry.reason} (${entry.count})`);
    }
    if (summary.warnings.length > 0) {
      lines.push(`Warnings (${summary.warnings.length}):`);
      for (const warning of summary.warnings.slice(0, 5)) lines.push(`  - ${warning}`);
    }

    return {
      text: lines.join("\n"),
      structured: {
        files: summary.totalFiles,
        skipped: summary.skippedCount,
        parts: summary.partsCount,
        sourceBytes: summary.totalSizeBytes,
        emittedBytes: summary.totalContentBytes,
        preset: summary.preset,
        maxPartBytes: workspace.config.maxPartBytes,
        layers: summary.layers,
        skipReasons: topReasons,
        warnings: summary.warnings.slice(0, 5),
        warningCount: summary.warnings.length,
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
      outDir: OUT_DIR_PROPERTY,
      maxPartBytes: {
        type: "string",
        description:
          'Byte budget per part, for example 307200 or "300k". Defaults to the project configuration.',
      },
      ...SCOPE_PROPERTIES,
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
    const prepared = await prepare(args, context, workspaceOverrides(args));
    if (!prepared.ok) return prepared.outcome;
    const workspace = prepared.workspace;

    // Off the JSON-RPC thread: a synchronous generate stops this server answering `ping` for
    // seconds on a large repository, and a client with a socket timeout then reports a working
    // tool call as a dead server.
    context.notify?.({ message: "generating", progress: 1, total: 2 });
    const result = await generateInWorker(workspace.root, workspace.cliOptions);
    if (!result.ok) return failure(result.message);
    context.notify?.({ message: "writing the snapshot", progress: 2, total: 2 });
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
    properties: { root: ROOT_PROPERTY, outDir: OUT_DIR_PROPERTY, ...SCOPE_PROPERTIES },
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
    const prepared = await prepare(args, context, workspaceOverrides(args));
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
      outDir: OUT_DIR_PROPERTY,
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
    const prepared = await prepare(args, context, outDirOverride(args));
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
      // Indexed rather than a linear scan of `matches` per route: with a few hundred routes and
      // a few thousand matches the old `matches.some(...)` was quadratic on every locate call.
      const matchedPaths = new Set(matches.map((match) => match.path));
      for (const route of manifest.indexes.routes) {
        // A route is matched on its path *or* its method: "which endpoints accept POST"
        // is the same question as "where is /api/x", and only the path was searchable.
        const method = route.methods.find((name) => name.toLowerCase().includes(needle));
        if (!route.path.toLowerCase().includes(needle) && method === undefined) continue;
        if (matchedPaths.has(route.path)) continue;
        matchedPaths.add(route.path);
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
      outDir: OUT_DIR_PROPERTY,
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
    const prepared = await prepare(args, context, outDirOverride(args));
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
      outDir: OUT_DIR_PROPERTY,
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
      pageable: { type: "boolean" },
      reason: { type: "string" },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
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

    const partPath = partPathFor(workspace, entry.part);
    if (partPath === null) {
      return failure(
        `${entry.part} is not a part of this snapshot: its name leaves ${workspace.config.outDir}/parts. ` +
          "Run snapshot_generate to rebuild it."
      );
    }
    let partText: string;
    try {
      partText = fs.readFileSync(partPath, "utf8");
    } catch {
      return failure(
        `${entry.part} could not be read, so the snapshot is damaged. Run snapshot_generate to rebuild it.`
      );
    }

    const section = findSection(parsePartSections(partText), entry.relativePath);
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
    /** The window ended inside a line too long to return, so no `fromLine` can reach the rest. */
    let clippedInsideLine = false;
    if (Buffer.byteLength(body, "utf8") > MAX_RESULT_BYTES) {
      // Bytes, not code units. `String.prototype.slice` counts UTF-16 code units, so a
      // body of three-byte characters came back up to three times over the limit — and
      // slicing at an odd index could split a surrogate pair, emitting a lone half that
      // no JSON parser downstream can accept. `truncateToBytes` walks the boundary.
      const clipped = truncateToBytes(body, MAX_RESULT_BYTES);
      const lastBreak = clipped.content.lastIndexOf("\n");
      if (lastBreak > 0) {
        body = clipped.content.slice(0, lastBreak);
      } else {
        // A single line longer than one result can carry. The old code returned its prefix and
        // advanced `fromLine` by one, so the rest of the line was unreachable: the next call was
        // "past the end of the file". Say so explicitly instead of pretending to paginate.
        body = clipped.content;
        clippedInsideLine = true;
      }
      truncatedByBytes = true;
    }
    const returnedLines = body.length === 0 ? 0 : body.split("\n").length;
    const moreRemain =
      !clippedInsideLine && !window.pastEnd && (window.truncated || truncatedByBytes);

    const header = [
      `${entry.relativePath} — ${entry.part}, ${entry.layer}/${entry.kind}, ${entry.language}`,
      // The line range is the answer to "where am I in this file", and it is computed from the
      // body the window was taken from, so it is just as meaningful for a preview as for a full
      // file. It used to be replaced — not augmented — by the preview note, so a 40-line window
      // into a 300-line preview came back with no range at all and the caller could not tell
      // where the window ended. Both facts are stated now, and `signatures` is no longer
      // silently treated as a full file.
      ...(section.inclusion === "preview"
        ? [
            "Bounded preview: the snapshot holds this file's head and tail only, so these line " +
              "numbers count the preview, not the source.",
          ]
        : section.inclusion === "signatures"
          ? [
              "Signatures: function and method bodies were replaced with `{ /* ... */ }` when the " +
                "snapshot was generated.",
            ]
          : []),
      window.totalLines === 0
        ? "This file is empty."
        : window.pastEnd
          ? `This file has ${window.totalLines} line(s); fromLine=${window.fromLine} is past its end.`
          : clippedInsideLine
            ? `Line ${window.fromLine} of ${window.totalLines}: this line is longer than one result can carry, so this page ends mid-line.`
            : `Lines ${window.fromLine}\u2013${window.fromLine + returnedLines - 1} of ${window.totalLines}.`,
    ];
    const lines = [...header, "", body];
    if (moreRemain) {
      const next = window.fromLine + returnedLines;
      lines.push("", `Truncated. Call snapshot_read with fromLine=${next} for the rest.`);
    } else if (clippedInsideLine) {
      lines.push(
        "",
        "Truncated. The remainder of this line is not reachable through snapshot_read; read the " +
          "file from disk to see it."
      );
    }

    return {
      text: lines.join("\n"),
      structured: {
        path: entry.relativePath,
        part: entry.part,
        // The window itself: a caller that wants to measure or re-send what it received should
        // not have to strip the header and the paging note back off `text`.
        body,
        layer: entry.layer,
        kind: entry.kind,
        language: entry.language,
        inclusion: section.inclusion ?? entry.inclusionMode,
        fromLine: window.fromLine,
        returnedLines,
        totalLines: window.totalLines,
        truncated: moreRemain || clippedInsideLine,
        pageable: !clippedInsideLine,
        ...(clippedInsideLine
          ? { reason: "line exceeds the result limit; its remainder is not reachable by fromLine" }
          : {}),
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
      outDir: OUT_DIR_PROPERTY,
      ...SCOPE_PROPERTIES,
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
    const prepared = await prepare(args, context, workspaceOverrides(args));
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
    healthTool,
    searchTool,
    statsTool,
    reviewTool,
    diffContextTool,
    symbolTool,
    contextTool,
    queryTool,
    planForTool,
    planTool,
    generateTool,
    validateTool,
    locateTool,
    dependentsTool,
    readTool,
    explainTool,
  ];
}
