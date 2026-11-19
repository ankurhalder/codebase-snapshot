/**
 * The 26 tools this server exposes.
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
import { buildImportResolver, resolveSafeOutputDirs, resolveSpecifier, tsconfigPathsFor } from "../index.js";

/** One search reads at most this many bytes of part text. */
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
import { truncateToBytes } from "../partitioner/preview.js";
import { validateSnapshot } from "../validator/validate.js";
import { GENERATOR_VERSION } from "../version.js";
import { generateInWorker } from "./generate-worker.js";
import { findSection, parsePartSections, windowText } from "./part.js";
import { estimateTokens } from "../tokenize.js";
import { createHash, randomUUID } from "node:crypto";
import type { JsonObject, JsonSchema } from "./protocol.js";
import type { FileEntry, Manifest, ValidationDrift, ValidationResult } from "../types.js";
import type { McpTool, ToolAnnotations, ToolContext, ToolCost, ToolOutcome } from "./types.js";
import { forgetManifest, manifestPathFor, openWorkspace, partPathFor, readManifest, resolveRoot } from "./workspace.js";
import { readConfinedText } from "../security/confine.js";
import { unsafeRegExpReason } from "../security/regex.js";
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

/**
 * Caps one block at the per-response limit, the same way `snapshot_read` does.
 *
 * Three tools render file bodies (`context`, `diff_context`, `symbol`) and only `read` enforced the
 * limit. A single 200 KB line came back whole from `context`, measured, and unlabelled; the response
 * a client received was four times what any of its siblings would send.
 */
function capResultText(text: string): { text: string; clipped: boolean } {
  const clipped = truncateToBytes(text, MAX_RESULT_BYTES);
  return { text: clipped.isTruncated ? clipped.content : text, clipped: clipped.isTruncated };
}

const ROOT_PROPERTY = {
  type: "string" as const,
  description: "Repository root. Defaults to the directory this server was started in.",
};

/**
 * Where the snapshot lives, when it is not the `outDir` in the project configuration.
 *
 * Every read tool takes it, not just `snapshot_generate`. Without it a snapshot generated into
 * a custom directory — the one thing `generate` lets a caller choose — could not be inspected by
 * a single one of the 26 tools: `snapshot_generate` wrote it, and everything else looked in
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
  only: {
    type: "array",
    items: { type: "string" },
    description: "Globs to include: replaces the config allow-list for this run.",
  },
  ignore: {
    type: "array",
    items: { type: "string" },
    description: "Globs to exclude, added to the config deny-list for this run.",
  },
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
    only: args.only,
    ignore: args.ignore,
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

/** One commit as `reports/log.md` records it: short hash, date, subject. */
interface HistoryEntry {
  hash: string;
  date: string;
  subject: string;
}

function parseHistoryReport(text: string): HistoryEntry[] {
  const fence = /```text\n([\s\S]*?)```/.exec(text);
  if (fence === null) return [];
  const entries: HistoryEntry[] = [];
  for (const line of fence[1].split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    entries.push({ hash: parts[0].trim(), date: parts[1].trim(), subject: parts.slice(2).join("\t").trim() });
  }
  return entries;
}

const historyTool: ToolSpec = {
  name: "snapshot_history",
  title: "Recent commits behind the snapshot",
  description:
    "The commits the snapshot was built from, from reports/log.md. Answers \"when was this " +
    "written and why\" without leaving the snapshot. Generate the report with includeLogs. " +
    "Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "Most recent commits to return (default 20).", minimum: 1, maximum: 200 },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      commits: { type: "array", items: { type: "object" } },
      recorded: { type: "integer" },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const snapshotDir = path.resolve(prepared.workspace.root, prepared.workspace.config.outDir);
    const reportRead = readConfinedText(snapshotDir, path.posix.join("reports", "log.md"));
    if (!reportRead.ok) {
      return {
        text:
          "This snapshot has no readable reports/log.md. Generate it with " +
          "`snapshot_generate { includeLogs: 20 }`, or `generate --include-logs 20` on the command line; " +
          "the report is opt-in because the commit subjects are repository content, and it must be " +
          "a regular file inside the snapshot.",
        isError: true,
      };
    }
    const text = reportRead.text;
    // The manifest records a digest for reports/log.md when it wrote one. A tool that reports
    // commit subjects from a file edited after generation is repeating unverifiable repository
    // content as history, so the digest is checked here the way `validate` checks artifacts.
    const manifestRead = readManifest(prepared.workspace);
    const recordedLog = manifestRead.ok ? manifestRead.manifest.artifacts?.log : undefined;
    if (recordedLog !== undefined && recordedLog !== null) {
      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      if (digest !== recordedLog.sha256) {
        return {
          text:
            "reports/log.md changed after the snapshot was generated (its digest no longer matches " +
            "the manifest). Regenerate the snapshot rather than trusting this history.",
          isError: true,
        };
      }
    }
    const limit = Math.max(1, typeof args.limit === "number" ? args.limit : 20);
    const commits = parseHistoryReport(text).slice(0, limit);
    return {
      text:
        commits.length === 0
          ? "reports/log.md holds no commit line; regenerate it with includeLogs."
          : [commits.length + " commit(s), newest first:", ...commits.map((commit) => "  " + commit.hash + "  " + commit.date + "  " + commit.subject)].join("\n"),
      structured: { commits, recorded: parseHistoryReport(text).length },
    };
  },
};

const budgetTool: ToolSpec = {
  name: "snapshot_budget",
  title: "What a larger budget would buy",
  description:
    "Run the planner at several token budgets and report what each one adds: files, tokens used, " +
    "entry points kept and the files gained over the previous budget. Answers \"should I raise the " +
    "budget, and what would I get?\" without writing a snapshot. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      budgets: {
        type: "array",
        items: { type: "integer", minimum: 500 },
        description: "Token budgets to compare, ascending (default 10000, 30000, 60000).",
      },
      question: { type: "string", description: "Optional question to plan for; absent plans for the repository as a whole." },
      includeTests: { type: "boolean", description: "Include test files (default false)." },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { budgets: { type: "array", items: { type: "object" } } },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const read = readManifest(prepared.workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    const requested = Array.isArray(args.budgets)
      ? args.budgets.filter((value) => typeof value === "number").map((value) => Math.max(500, value))
      : [10000, 30000, 60000];
    const budgets = [...new Set(requested)].sort((left, right) => left - right);
    if (budgets.length === 0) return { text: "budgets must hold at least one number", isError: true };
    const question = typeof args.question === "string" ? args.question : "";
    const rows = [];
    let previous = new Set<string>();
    for (const budget of budgets) {
      const plan = planForQuestion(read.manifest, question, {
        maxTokens: budget,
        ...(args.includeTests === true ? { includeTests: true } : {}),
      });
      const paths = new Set(plan.files.map((file) => file.path));
      const gained = [...paths].filter((path) => !previous.has(path)).sort();
      previous = paths;
      rows.push({
        budget,
        files: plan.files.length,
        usedTokens: plan.usedTokens,
        gained,
      });
    }
    const lines = [question === "" ? "No question: planning for the repository as a whole." : "Question: " + question];
    if (read.manifest.files.length === 0) {
      lines.push("The snapshot holds no files, so every budget selects nothing. Check manifest.skipped for why.");
    }
    for (const row of rows) {
      lines.push(
        row.budget.toLocaleString("en-US") + " tokens: " + row.files + " file(s), " +
          row.usedTokens.toLocaleString("en-US") + " used" +
          (row.files === 0 && read.manifest.files.length > 0 ? " - no file fits this budget" : "") +
          (row.gained.length === 0 ? "" : ", " + row.gained.length + " gained (" + row.gained.slice(0, 4).join(", ") + (row.gained.length > 4 ? ", …" : "") + ")")
      );
    }
    return { text: lines.join("\n"), structured: { budgets: rows } };
  },
};

const testsTool: ToolSpec = {
  name: "snapshot_tests",
  title: "Tests that cover a file, and files a test covers",
  description:
    "The test side of the graph. Given a path, the tests that import it (plus the ones named " +
    "after it); with no path, every test file and how many files it exercises. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Source or test path relative to the repository root." },
      maxFiles: { type: "integer", description: "Cap on listed tests (default 50).", minimum: 1 },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      tests: { type: "array", items: { type: "object" } },
      covered: { type: "array", items: { type: "string" } },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const read = readManifest(prepared.workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    const cap = Math.max(1, typeof args.maxFiles === "number" ? args.maxFiles : 50);
    const isTest = (filePath: string): boolean =>
      /(^|\/)(tests?|__tests__|spec)\//.test(filePath) || /\.(test|spec)\.[a-z0-9]+$/i.test(filePath);
    const byPath = new Map(read.manifest.files.map((file) => [file.relativePath, file]));
    const resolver = buildImportResolver(read.manifest.files, {
      tsconfig: tsconfigPathsFor(prepared.workspace.root),
    });
    const testFiles = read.manifest.files.filter((file) => isTest(file.relativePath));
    const importsOf = (filePath: string): string[] => {
      const entry = read.manifest.indexes.imports.byFile.find((candidate) => candidate.path === filePath);
      return (entry?.imports ?? [])
        .map((specifier) => resolveSpecifier(filePath, specifier, resolver))
        .filter((target): target is string => target !== null && byPath.has(target));
    };

    const wanted = typeof args.path === "string" ? args.path.trim() : "";
    const tests = [];
    const covered = new Set();
    for (const testFile of testFiles) {
      const imports = importsOf(testFile.relativePath);
      for (const target of imports) if (!isTest(target)) covered.add(target);
      if (wanted !== "") {
        const stem = wanted.replace(/\.[a-z0-9]+$/i, "");
        const named = testFile.relativePath.replace(/\.[a-z0-9]+$/i, "").includes(stem);
        if (!imports.includes(wanted) && !named) continue;
      }
      tests.push({ path: testFile.relativePath, part: testFile.part, covers: imports.filter((target) => !isTest(target)) });
    }
    tests.sort((left, right) => left.path.localeCompare(right.path));
    const reported = tests.slice(0, cap);
    const text =
      reported.length === 0
        ? wanted === ""
          ? "No test file is in the snapshot."
          : "No test in the snapshot imports " + wanted + " or is named after it."
        : [
            (wanted === "" ? reported.length + " test file(s):" : reported.length + " test(s) for " + wanted + ":"),
            ...reported.map((testFile) =>
              "  " + testFile.path + " (" + testFile.covers.length + " file(s) it imports)"
            ),
          ].join("\n");
    return { text, structured: { tests: reported, covered: [...covered].sort() } };
  },
};

const workspaceTool: ToolSpec = {
  name: "snapshot_workspace",
  title: "Workspace index",
  description:
    "The members of a multi-repository workspace and the imports that cross between them, from " +
    "WORKSPACE.json. Answers which member depends on which before a change. Read-only.",
  inputSchema: {
    type: "object",
    properties: { root: ROOT_PROPERTY, outDir: OUT_DIR_PROPERTY },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      members: { type: "array", items: { type: "object" } },
      links: { type: "array", items: { type: "object" } },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    // This tool resolved its own root, so it could read WORKSPACE.json from any directory the
    // process could open. prepare() applies resolveRoot and the same outDir confinement as every
    // other tool.
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const snapshotDir = path.resolve(prepared.workspace.root, prepared.workspace.config.outDir);
    const index = path.join(snapshotDir, "WORKSPACE.json");
    const read = readConfinedText(snapshotDir, "WORKSPACE.json");
    if (!read.ok) {
      return {
        text:
          "No workspace index at " + index + " (the file is absent, or it is not a regular file " +
          "inside the snapshot). Generate one with " +
          "`generate --workspace member-a,member-b`; a single snapshot has no members to list.",
        isError: true,
      };
    }
    const text = read.text;
    let document: {
      members?: Array<{ name?: string; files?: number; tokens?: number; fingerprint?: string }>;
      links?: Array<{ from?: string; to?: string; specifiers?: number }>;
    };
    try {
      document = JSON.parse(text) as typeof document;
    } catch (error) {
      return { text: "WORKSPACE.json is not valid JSON: " + (error as Error).message, isError: true };
    }
    const members = document.members ?? [];
    const links = document.links ?? [];
    const lines = [
      members.length + " member(s):",
      ...members.map(
        (member) =>
          "  " + (member.name ?? "?") + " (" + (member.files ?? 0) + " files, " + (member.tokens ?? 0) + " tokens)"
      ),
      links.length === 0 ? "No cross-member import was found." : links.length + " cross-member link(s):",
      ...links.map(
        (link) => "  " + (link.from ?? "?") + " -> " + (link.to ?? "?") + " (" + (link.specifiers ?? 0) + " specifier(s))"
      ),
    ];
    return { text: lines.join("\n"), structured: { members, links } };
  },
};

const neighborsTool: ToolSpec = {
  name: "snapshot_neighbors",
  title: "Imports and importers of a file",
  description:
    "Both directions of the import graph for one path: what it imports and what imports it, " +
    "resolved against the snapshot and listed with their parts. The question a change asks first. " +
    "Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the repository root." },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      imports: { type: "array", items: { type: "object" } },
      importedBy: { type: "array", items: { type: "object" } },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const read = readManifest(prepared.workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    const wanted = typeof args.path === "string" ? args.path : "";
    const file = read.manifest.files.find((candidate) => candidate.relativePath === wanted) ??
      read.manifest.files.find((candidate) => candidate.relativePath.toLowerCase() === wanted.toLowerCase());
    if (file === undefined) return { text: wanted + " is not in the snapshot; snapshot_explain says why.", isError: true };

    const byPath = new Map(read.manifest.files.map((candidate) => [candidate.relativePath, candidate]));
    const resolver = buildImportResolver(read.manifest.files, {
      tsconfig: tsconfigPathsFor(prepared.workspace.root),
    });
    const entry = read.manifest.indexes.imports.byFile.find((candidate) => candidate.path === file.relativePath);
    const imports: Array<{ path: string; part: string | null; resolved: boolean }> = [];
    for (const specifier of entry?.imports ?? []) {
      const resolved = resolveSpecifier(file.relativePath, specifier, resolver);
      const target = resolved === null ? undefined : byPath.get(resolved);
      imports.push({ path: resolved ?? specifier, part: target?.part ?? null, resolved: target !== undefined });
    }
    const importedBy: Array<{ path: string; part: string }> = [];
    for (const other of read.manifest.files) {
      if (other.relativePath === file.relativePath) continue;
      const otherEntry = read.manifest.indexes.imports.byFile.find((candidate) => candidate.path === other.relativePath);
      if (otherEntry === undefined) continue;
      for (const specifier of otherEntry.imports) {
        if (resolveSpecifier(other.relativePath, specifier, resolver) === file.relativePath) {
          importedBy.push({ path: other.relativePath, part: other.part });
          break;
        }
      }
    }

    const lines = [
      file.relativePath + " (" + file.part + ")",
      "Imports: " + (imports.length === 0 ? "none recorded" : ""),
      ...imports.map((item) => "  -> " + item.path + (item.part === null ? " (outside the snapshot)" : " (" + item.part + ")")),
      "Imported by: " + (importedBy.length === 0 ? "nothing in the snapshot" : ""),
      ...importedBy.map((item) => "  <- " + item.path + " (" + item.part + ")"),
    ];
    return { text: lines.join("\n"), structured: { imports, importedBy } };
  },
};

const entrypointsTool: ToolSpec = {
  name: "snapshot_entrypoints",
  title: "Likely entry points",
  description:
    "The files a reader should start from: conventional entry points (index, main, app, server, " +
    "cli) and manifests, with their importer counts. The same heuristic the token-budget planner " +
    "uses, exposed so an agent can start where a maintainer would. Read-only.",
  inputSchema: {
    type: "object",
    properties: { root: ROOT_PROPERTY, outDir: OUT_DIR_PROPERTY },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { entries: { type: "array", items: { type: "object" } } },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const read = readManifest(prepared.workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    const pattern = /(^|\/)(index|main|app|server|cli)\.(ts|tsx|js|mjs|cjs|py|go|rs|java|cs|rb|php)$/;
    const manifests = new Set(["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "composer.json", "Gemfile"]);
    const centrality = new Map(read.manifest.indexes.imports.centralFiles.map((item) => [item.path, item.importedByCount]));
    const entries = read.manifest.files
      .filter((file) => pattern.test(file.relativePath) || manifests.has(file.relativePath))
      .map((file) => ({
        path: file.relativePath,
        part: file.part,
        importedBy: centrality.get(file.relativePath) ?? 0,
        tokens: Math.ceil(file.includedBytes / 4),
        manifest: manifests.has(file.relativePath),
      }))
      .sort((left, right) => Number(right.manifest) - Number(left.manifest) || right.importedBy - left.importedBy);
    const lines =
      entries.length === 0
        ? ["No conventional entry point was found; start from snapshot_stats and the largest files."]
        : [
            entries.length + " candidate entry point(s):",
            ...entries.map((item) => "  " + item.path + " (" + item.part + ", " + item.importedBy + " importer(s), " + item.tokens + " tokens)"),
          ];
    return { text: lines.join("\n"), structured: { entries } };
  },
};

const routesTool: ToolSpec = {
  name: "snapshot_routes",
  title: "Routes and handlers",
  description:
    "Every route a summary recorded - HTTP methods from decorators, framework attributes and " +
    "route tables - with the file and part that declare it. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Only routes whose text matches this regular expression." },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { total: { type: "integer" }, routes: { type: "array", items: { type: "object" } } },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const read = readManifest(prepared.workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    let filter: RegExp | null = null;
    if (typeof args.pattern === "string") {
      const unsafe = unsafeRegExpReason(args.pattern);
      if (unsafe !== null) {
        return { text: "pattern is refused: " + unsafe + ".", isError: true };
      }
      try {
        filter = new RegExp(args.pattern, "i");
      } catch (error) {
        return { text: "pattern is not a valid regular expression: " + (error as Error).message, isError: true };
      }
    }
    const routes: Array<{ route: string; path: string; part: string }> = [];
    for (const file of read.manifest.files) {
      const summary = file.summary as { routeHandlers?: unknown } | undefined;
      if (summary === undefined || !Array.isArray(summary.routeHandlers)) continue;
      for (const route of summary.routeHandlers as string[]) {
        if (filter !== null && !filter.test(route) && !filter.test(file.relativePath)) continue;
        routes.push({ route, path: file.relativePath, part: file.part });
      }
    }
    routes.sort((left, right) => left.path.localeCompare(right.path) || left.route.localeCompare(right.route));
    const text =
      routes.length === 0
        ? "No route was recorded. Routes come from decorators, framework attributes and route tables."
        : [
            routes.length + " route(s):",
            ...routes.map((route) => route.route.trim() + "  (" + route.path + ", " + route.part + ")"),
          ].join("\n");
    return { text, structured: { total: routes.length, routes } };
  },
};

const cyclesTool: ToolSpec = {
  name: "snapshot_cycles",
  title: "Import cycles",
  description:
    "Strongly connected components in the import graph: files that import each other in a loop. " +
    "Computed with the same resolver the generator uses, so a reported cycle is one the snapshot " +
    "really has. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      maxComponents: { type: "integer", description: "Cap on reported components (default 20).", minimum: 1 },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      components: { type: "array", items: { type: "object" } },
      filesInCycles: { type: "integer" },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const read = readManifest(prepared.workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    const cap = Math.max(1, typeof args.maxComponents === "number" ? args.maxComponents : 20);
    const byPath = new Map(read.manifest.files.map((file) => [file.relativePath, file]));
    const resolver = buildImportResolver(read.manifest.files, {
      tsconfig: tsconfigPathsFor(prepared.workspace.root),
    });
    const edges = new Map<string, string[]>();
    for (const path of byPath.keys()) edges.set(path, []);
    for (const entry of read.manifest.indexes.imports.byFile) {
      const targets = edges.get(entry.path);
      if (targets === undefined) continue;
      for (const specifier of entry.imports) {
        const resolved = resolveSpecifier(entry.path, specifier, resolver);
        if (resolved !== null && byPath.has(resolved) && !targets.includes(resolved)) targets.push(resolved);
      }
    }

    let index = 0;
    const indices = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];
    const strongConnect = (node: string): void => {
      indices.set(node, index);
      low.set(node, index);
      index += 1;
      stack.push(node);
      onStack.add(node);
      for (const target of edges.get(node) ?? []) {
        if (!indices.has(target)) {
          strongConnect(target);
          low.set(node, Math.min(low.get(node) as number, low.get(target) as number));
        } else if (onStack.has(target)) {
          low.set(node, Math.min(low.get(node) as number, indices.get(target) as number));
        }
      }
      if (low.get(node) === indices.get(node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop() as string;
          onStack.delete(member);
          component.push(member);
          if (member === node) break;
        }
        if (component.length > 1 || (edges.get(node) ?? []).includes(node)) components.push(component.sort());
      }
    };
    for (const node of byPath.keys()) if (!indices.has(node)) strongConnect(node);

    components.sort((left, right) => right.length - left.length || left[0].localeCompare(right[0]));
    const reported = components.slice(0, cap).map((component) => ({ size: component.length, files: component }));
    const filesInCycles = components.reduce((total, component) => total + component.length, 0);
    const text =
      components.length === 0
        ? "No import cycle was found."
        : [
            components.length + " cycle(s), " + filesInCycles + " file(s):",
            ...reported.map((component, position) => position + 1 + ". " + component.files.join(" -> ")),
          ].join("\n");
    return { text, structured: { components: reported, filesInCycles } };
  },
};

const searchTool: ToolSpec = {
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
    if (args.regex === true) {
      const unsafe = unsafeRegExpReason(query);
      if (unsafe !== null) {
        return { text: "regex is refused: " + unsafe + ".", isError: true };
      }
    }
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
      const partBytes = Buffer.byteLength(text, "utf8");
      if (partBytes > MAX_SEARCH_BYTES) {
        skippedOversize.push(part.filename);
        truncated = true;
        continue;
      }
      if (scanned + partBytes > MAX_SEARCH_BYTES) {
        truncated = true;
        break;
      }
      scanned += partBytes;
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

    // "3 match(es) in 4 file(s)" read as "three matches spread over four files"; the four was
    // the size of the snapshot, not the number of files with a hit. Both numbers, each labelled.
    const matchedFiles = new Set(matches.map((match) => match.path)).size;
    const lines = [
      matches.length === 0
        ? "No match in " + read.manifest.files.length + " file(s)."
        : matches.length + " match(es) in " + matchedFiles + " file(s) of " +
          read.manifest.files.length + " searched." +
          (truncated ? " Results are capped, so not every file was searched; narrow the query." : ""),
      ...(skippedOversize.length > 0
        ? ["Skipped " + skippedOversize.length + " oversized part(s): " + skippedOversize.slice(0, 5).join(", ")]
        : []),
      ...matches.map((match) => match.path + ":" + match.line + " (" + match.part + "): " + match.text),
    ];
    return { text: lines.join("\n"), structured: { matches, scanned, truncated } };
  },
};

const statsTool: ToolSpec = {
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
      heaviest: { type: "array", items: { type: "object" } },
      partSizes: { type: "array", items: { type: "object" } },
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
    // "part sizes" that carried only tokens were misnamed: a caller sizing a transfer wants bytes,
    // a caller budgeting context wants tokens, and both are in the manifest.
    const parts = manifest.parts.map((part) => ({
      filename: part.filename,
      bytes: part.byteSize,
      tokens: part.estimatedTokens,
    }));
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

const reviewTool: ToolSpec = {
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
      routes: { type: "array", items: { type: "object" } },
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
      validation = validateSnapshot(configAsGenerated(workspace, read.manifest));
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

    // A route method is the shape of the change a reviewer most needs to see, and the summary
    // already recorded it. Naming it here saves opening the file to find out.
    const routes: Array<{ path: string; methods: string[] }> = [];
    for (const file of files) {
      const entry = byPath.get(file.path.toLowerCase());
      const summaryOfFile = entry?.summary as { routeHandlers?: unknown } | undefined;
      if (summaryOfFile === undefined || !Array.isArray(summaryOfFile.routeHandlers)) continue;
      const methods = summaryOfFile.routeHandlers as string[];
      if (methods.length > 0) routes.push({ path: file.path, methods });
    }

    const summary = [
      validation.valid ? "Snapshot: current." : "Snapshot: stale; run snapshot_generate before trusting it.",
      "Health: " + report.score + "/100 (" + report.counts.pass + " passed, " + report.counts.warn + " warning(s), " + report.counts.fail + " failed).",
      ...failed.map((item) => "FAIL " + item),
    ];
    if (missing.length > 0) summary.push("Not in the snapshot: " + missing.join(", "));
    if (routes.length > 0) {
      summary.push("Routes touched: " + routes.map((route) => route.methods.join("/") + " " + route.path).join("; "));
    }
    return {
      text: summary.join("\n") + (body.length === 0 ? "" : "\n\n" + body.join("\n\n")),
      structured: { current: validation.valid, score: report.score, failed, files, missing, routes },
    };
  },
};

const diffContextTool: ToolSpec = {
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
    // The importers are resolved with the generator's resolver, not a hand-rolled one. The old
    // loop handled only relative specifiers and a fixed extension list, so a tsconfig path alias
    // (`@/user`) produced **no dependents at all** — silently, in the one tool whose description
    // says the dependents are what a reviewer misses. `--delta` already used this resolver, so the
    // client and the CLI disagreed about the same import graph.
    const resolver = buildImportResolver(read.manifest.files, {
      tsconfig: tsconfigPathsFor(workspace.root),
    });
    const importers = new Map<string, string[]>();
    for (const entry of read.manifest.indexes.imports.byFile) {
      for (const specifier of entry.imports) {
        const target = resolveSpecifier(entry.path, specifier, resolver);
        if (target === null) continue;
        const list = importers.get(target) ?? [];
        list.push(entry.path);
        importers.set(target, list);
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
      const capped = capResultText(window.text);
      changed.push({ path: file.relativePath, part: file.part, tokens });
      text.push(
        "### " + file.relativePath + " (" + file.part + (capped.clipped ? ", first 64 KiB" : "") + ")"
      );
      text.push(capped.text);
    }
    const dependents: Array<{ path: string; imports: string }> = [];
    for (const entry of changed) {
      for (const importer of importers.get(entry.path) ?? []) {
        if (!dependents.some((item) => item.path === importer)) dependents.push({ path: importer, imports: entry.path });
      }
    }
    // "Nothing imports the changed paths" is only true when the changed paths were read. When they
    // were not, the honest answer is that they are not in the snapshot — otherwise a caller reads
    // "no dependent" as a fact about a file it never received.
    const note =
      changed.length === 0 && missing.length > 0
        ? "Not in the snapshot: " + missing.join(", ") + "."
        : dependents.length === 0
          ? "No file in the snapshot imports the changed paths."
          : dependents.length + " dependent(s): " + dependents.map((item) => item.path).join(", ");
    const missingNote =
      missing.length === 0 || changed.length === 0 ? "" : "Also not returned: " + missing.join(", ") + ".";
    return {
      text: [text.join("\n\n"), note, missingNote].filter((part) => part !== "").join("\n\n"),
      structured: { budgetTokens: budget, usedTokens: used, changed, dependents, missing },
    };
  },
};

const symbolTool: ToolSpec = {
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
      references: {
        type: "boolean",
        description: "Also report call sites: other files whose body mentions the name (default true).",
      },
      maxReferences: { type: "integer", description: "Cap on reported call sites (default 20).", minimum: 1 },
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
      references: { type: "array", items: { type: "object" } },
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
      const capped = capResultText(lines.slice(from, to).join("\n"));
      matches.push({
        path: file.relativePath,
        part: file.part,
        line: index + 1,
        text: capped.text,
        ...(capped.clipped ? { clippedAtBytes: MAX_RESULT_BYTES } : {}),
      });
    }
    if (matches.length === 0) {
      return {
        text: "No definition of " + name + " was found in the snapshot. It may be excluded, in a language without a symbol profile, or named differently; snapshot_explain says which for a path.",
        structured: { found: 0, matches: [] },
      };
    }
    // Call sites: the definition alone says what a symbol is, not who depends on it. The parts
    // are the only source — reading the working tree would hand back the file the snapshot
    // excluded. Case-sensitive on purpose: a case-insensitive scan of a common word is noise.
    const callSites: Array<{ path: string; line: number; text: string; definition: boolean }> = [];
    let referencesTruncated = false;
    if (args.references !== false) {
      const limit = Math.max(1, typeof args.maxReferences === "number" ? args.maxReferences : 20);
      const definitionKeys = new Set(matches.map((match) => match.path + ":" + match.line));
      const word = new RegExp("\\b" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      // One parsed part per part, not one per file in it. `scanned` is charged once when a part is
      // read, so a 15-file part that happens to come first no longer consumes the whole 4 MB
      // budget before the next part is opened.
      const sectionsByPart = new Map<string, ReturnType<typeof parsePartSections>>();
      let scanned = 0;
      for (const file of read.manifest.files) {
        if (callSites.length >= limit) break;
        const partPath = partPathFor(workspace, file.part);
        if (partPath === null) continue;
        let sections = sectionsByPart.get(partPath);
        if (sections === undefined) {
          if (scanned >= MAX_SEARCH_BYTES) {
            referencesTruncated = true;
            break;
          }
          let partText: string;
          try {
            partText = fs.readFileSync(partPath, "utf8");
          } catch {
            continue;
          }
          const bytes = Buffer.byteLength(partText, "utf8");
          if (scanned + bytes > MAX_SEARCH_BYTES) {
            referencesTruncated = true;
            break;
          }
          scanned += bytes;
          sections = parsePartSections(partText);
          sectionsByPart.set(partPath, sections);
        }
        const section = findSection(sections, file.relativePath);
        if (section === null) continue;
        const bodyLines = section.body.split("\n");
        for (let index = 0; index < bodyLines.length && callSites.length < limit; index += 1) {
          if (!word.test(bodyLines[index])) continue;
          callSites.push({
            path: file.relativePath,
            line: index + 1,
            text: bodyLines[index].trim().slice(0, 200),
            definition: definitionKeys.has(file.relativePath + ":" + (index + 1)),
          });
        }
      }
    }

    const text = matches
      .map((match) => "### " + match.path + " (" + match.part + ", line " + match.line + ")\n" + match.text)
      .join("\n\n") +
      (args.references === false
        ? ""
        : "\n\n" + (callSites.length === 0
            ? "No call site was found in the snapshot."
            : "Call sites (" + callSites.length + "):\n" +
              callSites.map((site) => "  " + site.path + ":" + site.line + "  " + site.text).join("\n"))) +
      (referencesTruncated
        ? "\n\nSearch stopped at the 4 MB part budget; call sites in later parts were not read. " +
          "Narrow the name or inspect the remaining parts directly."
        : "");
    return {
      text,
      structured: { found: matches.length, matches, references: callSites, truncated: referencesTruncated },
    };
  },
};

const contextTool: ToolSpec = {
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
      const capped = capResultText(window.text);
      const body = capped.text;
      let tokens = Math.max(1, Math.ceil(Buffer.byteLength(body, "utf8") / 4));
      if (used + tokens > budget) {
        const keep = Math.max(4, Math.floor(((budget - used) / tokens) * linesPerFile));
        const smaller = windowText(section.body, 1, Math.max(4, keep));
        if (Buffer.byteLength(smaller.text, "utf8") === 0) {
          missing.push(file.relativePath + " (budget)");
          continue;
        }
        const smallerCapped = capResultText(smaller.text);
        const partial = Math.max(1, Math.ceil(Buffer.byteLength(smallerCapped.text, "utf8") / 4));
        text.push(
          "### " + file.relativePath + " (" + file.part + ", first " + Math.max(4, keep) + " lines" +
            (smallerCapped.clipped ? ", first 64 KiB" : "") + ")"
        );
        text.push(smallerCapped.text);
        blocks.push({ path: file.relativePath, part: file.part, lines: Math.max(4, keep), tokens: partial });
        used += partial;
        continue;
      }
      text.push(
        "### " + file.relativePath + " (" + file.part + (capped.clipped ? ", first 64 KiB" : "") + ")"
      );
      text.push(body);
      blocks.push({ path: file.relativePath, part: file.part, lines: window.text === "" ? 0 : window.text.split("\n").length, tokens });
      used += tokens;
    }

    // Whatever was asked for and not returned is named in the text, not only in the structured
    // field: most clients show the text, and an empty block for a path that does not exist reads
    // as "this file is empty" when it means "this file is not here".
    const notes = [];
    if (missing.length > 0) notes.push("Not returned: " + missing.join(", ") + ".");
    if (blocks.length === 0 && notes.length === 0) notes.push("Nothing was requested.");
    return {
      text: [text.join("\n\n"), ...notes].filter((part) => part !== "").join("\n\n"),
      structured: { budgetTokens: budget, usedTokens: used, files: blocks, missing },
    };
  },
};

const queryTool: ToolSpec = {
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
      const unsafe = unsafeRegExpReason(args.pathPattern);
      if (unsafe !== null) {
        return { text: "pathPattern is refused: " + unsafe + ".", isError: true };
      }
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

const planForTool: ToolSpec = {
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

const answerTool: ToolSpec = {
  name: "snapshot_answer",
  title: "Question in, budgeted context out",
  description:
    "The one-call version of plan-then-read: plan a question, then return each chosen file as a " +
    "head window with line numbers within the token budget. Every included file says why it is " +
    "there; every planned file that did not fit says so. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "What you need to answer." },
      maxTokens: { type: "integer", description: "Budget for the whole block (default 20000).", minimum: 500 },
      linesPerFile: { type: "integer", description: "Head lines per file (default 60).", minimum: 10 },
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
      omitted: { type: "array", items: { type: "object" } },
    },
  },
  annotations: READ_ONLY,
  async handler(args, context) {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (question.length === 0) return { text: "question must be a non-empty string", isError: true };
    const prepared = await prepare(args, context, outDirOverride(args));
    if (!prepared.ok) return prepared.outcome;
    const read = readManifest(prepared.workspace);
    if (!read.ok) return { text: read.message + " Call snapshot_generate first.", isError: true };
    const maxTokens = Math.max(500, typeof args.maxTokens === "number" ? args.maxTokens : 20000);
    const linesPerFile = Math.max(10, typeof args.linesPerFile === "number" ? args.linesPerFile : 60);
    const plan = planForQuestion(read.manifest, question, {
      maxTokens,
      ...(args.includeTests === true ? { includeTests: true } : {}),
    });
    if (read.manifest.files.length === 0) {
      return {
        text:
          "The snapshot holds no files, so nothing can be assembled for this question. " +
          "manifest.skipped records why paths were not emitted (excluded, binary, unchanged).",
        structured: { question, budgetTokens: maxTokens, usedTokens: 0, files: [], omitted: [] },
      };
    }
    const blocks: Array<{
      path: string;
      why: string;
      tokens: number;
      text: string;
      truncated: boolean;
      totalLines: number;
      clippedAtBytes?: number;
    }> = [];
    // The planner's own skips belong in the answer. With a tight budget it planned one cheap file
    // and left the strong match out; the text said "1 skipped for budget" while `omitted` was
    // empty, so a client reading the structured reply could not tell what it had missed. The
    // planner records the path and the reason, and both survive into this reply.
    const omitted: Array<{ path: string; reason: string }> = plan.skipped.map((entry) => ({
      path: entry.path,
      reason: entry.reason,
    }));
    let used = 0;
    const parts = new Map<string, string>();
    for (const planned of plan.files) {
      if (used >= maxTokens) {
        omitted.push({ path: planned.path, reason: "the budget was spent on earlier files" });
        continue;
      }
      const partPath = partPathFor(prepared.workspace, planned.part);
      if (partPath === null) {
        omitted.push({ path: planned.path, reason: "its part is not in the snapshot" });
        continue;
      }
      let partText = parts.get(partPath);
      if (partText === undefined) {
        try {
          partText = fs.readFileSync(partPath, "utf8");
        } catch {
          omitted.push({ path: planned.path, reason: "its part could not be read" });
          continue;
        }
        parts.set(partPath, partText);
      }
      const section = findSection(parsePartSections(partText), planned.path);
      if (section === null) {
        omitted.push({ path: planned.path, reason: "no section in its part" });
        continue;
      }
      const window = windowText(section.body, 1, linesPerFile);
      const numbered = window.text
        .split("\n")
        .map((line, index) => String(index + 1).padStart(5, " ") + "  " + line)
        .join("\n");
      // `snapshot_read` caps one response at MAX_RESULT_BYTES; this tool did not, so a single long
      // line came back as a 200 KB block with no note. The same cap, applied per block, keeps one
      // tool from being the one that floods the transport.
      const clipped = truncateToBytes(numbered, MAX_RESULT_BYTES);
      const bodyText = clipped.isTruncated ? clipped.content : numbered;
      // Measure what is actually returned, not the window before clipping: `usedTokens` used to
      // describe 200 KB of text while 64 KB was sent.
      const tokens = estimateTokens(bodyText);
      if (used + tokens > maxTokens && blocks.length > 0) {
        omitted.push({ path: planned.path, reason: "did not fit the remaining budget" });
        continue;
      }
      blocks.push({
        path: planned.path,
        why: planned.why,
        tokens,
        text: bodyText,
        truncated: window.truncated || clipped.isTruncated,
        totalLines: window.totalLines,
        ...(clipped.isTruncated ? { clippedAtBytes: MAX_RESULT_BYTES } : {}),
      });
      used += tokens;
    }
    const lines = [
      "# Answer context: " + question,
      "Budget: " + used + " of " + maxTokens + " tokens; " + blocks.length + " file(s).",
    ];
    for (const block of blocks) {
      lines.push("");
      lines.push(
        "## " + block.path + " (" + block.tokens + " tokens, " +
          (block.clippedAtBytes !== undefined
            ? "first " + Math.round(block.clippedAtBytes / 1024) + " KiB of the window"
            : block.truncated
              ? "first lines of " + block.totalLines
              : "whole file") +
          ")"
      );
      lines.push("Why: " + block.why);
      lines.push("```");
      lines.push(block.text);
      lines.push("```");
    }
    if (omitted.length > 0) {
      lines.push("");
      lines.push("Not included:");
      for (const entry of omitted) lines.push("- " + entry.path + " - " + entry.reason);
    }
    // The planner's own notes are the explanation when nothing was assembled: without them an
    // empty answer looks like the tool failed rather than like the question matched nothing.
    if (plan.notes.length > 0) {
      lines.push("");
      lines.push("Notes:");
      for (const note of plan.notes) lines.push("- " + note);
    }
    return {
      text: lines.join("\n"),
      structured: { question, budgetTokens: maxTokens, usedTokens: used, files: blocks, omitted },
    };
  },
};

const healthTool: ToolSpec = {
  name: "snapshot_health",
  title: "Snapshot health audit",
  description:
    "Audit the generated snapshot against the repository: manifest shape, part hashes, the " +
    "artifacts it claims, unmasked secrets anywhere in the written text, values from files that " +
    "were excluded as sensitive, host paths, the recorded token count and freshness. Returns a " +
    "score and one entry per check. Read-only; it never regenerates anything.",
  inputSchema: {
    type: "object",
    properties: {
      maxScanBytes: {
        type: "integer",
        minimum: 1024,
        description: "Cap on the text the secret and host-path scans read (default 8 MB).",
      },
      deep: {
        type: "boolean",
        description:
          "Replay every full body against the source on disk. Slower, and catches a generator that wrote the wrong bytes.",
      },
      root: ROOT_PROPERTY,
      outDir: OUT_DIR_PROPERTY,
    },
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
      ...(typeof args.maxScanBytes === "number" ? { maxScanBytes: args.maxScanBytes } : {}),
      ...(args.deep === true ? { deep: true } : {}),
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

const statusTool: ToolSpec = {
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
      // "No snapshot yet" is an answer; "the manifest is not a snapshot" is a failure, and a
      // client that receives it as a normal status will plan around a snapshot that cannot be
      // read. The two are different results, so they are reported differently.
      return {
        text: read.message,
        isError: read.missing === true ? undefined : true,
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
      `Git: ${manifest.git.branch}${manifest.git.branchFromGit === false ? " (fallback; no git branch)" : ""} @ ${manifest.git.commit}${manifest.git.isDirty ? " (dirty)" : " (clean)"}`,
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

const planTool: ToolSpec = {
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
    const controller = new AbortController();
    context.onCancel?.(() => controller.abort());
    const result = await generateInWorker(workspace.root, workspace.cliOptions, {
      dryRun: true,
      signal: controller.signal,
    });
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

const generateTool: ToolSpec = {
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
      includeDiffs: {
        type: "boolean",
        description: "Also write reports/diff.md from the uncommitted diff.",
      },
      includeLogs: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Also write reports/log.md with this many recent commits.",
      },
      tokenTree: {
        type: "boolean",
        description: "Also write reports/tokens.md with per-file token estimates.",
      },
      stripComments: {
        type: "boolean",
        description: "Remove comment text from JavaScript/TypeScript bodies (line numbers kept).",
      },
      removeEmptyLines: {
        type: "boolean",
        description: "Drop blank lines from emitted bodies (line numbers move; recorded per file).",
      },
      pack: {
        type: "string",
        enum: ["single", "xml", "json"],
        description: "Also write one full-repository file in this format.",
      },
      slice: {
        type: "string",
        description: "Narrow the snapshot to what the planner picks for this question.",
      },
      sliceTokens: {
        type: "integer",
        minimum: 500,
        description: "Token budget for `slice` (default 30000, as the CLI).",
      },
      budgetTokens: {
        type: "integer",
        minimum: 500,
        description: "Fit the snapshot into this token budget, highest value first.",
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
    const controller = new AbortController();
    context.onCancel?.(() => controller.abort());
    const reportOptions = {
      ...(args.includeDiffs === true ? { includeDiffs: true as const } : {}),
      ...(typeof args.includeLogs === "number" ? { includeLogs: args.includeLogs } : {}),
      ...(args.tokenTree === true ? { tokenTree: true as const } : {}),
      ...(args.stripComments === true ? { stripComments: true as const } : {}),
      ...(args.removeEmptyLines === true ? { removeEmptyLines: true as const } : {}),
      ...(typeof args.pack === "string" ? { pack: args.pack as "single" | "xml" | "json" } : {}),
      ...(Array.isArray(args.only) ? { only: args.only.filter((value) => typeof value === "string") } : {}),
      ...(Array.isArray(args.ignore) ? { ignore: args.ignore.filter((value) => typeof value === "string") } : {}),
    };
    // A slice and a budget narrow the selection rather than changing settings, so they travel as
    // generate options; the CLI refuses the pair, and so does this tool.
    if (typeof args.slice === "string" && typeof args.budgetTokens === "number") {
      return failure("slice and budgetTokens both narrow the selection; pass one.");
    }
    const narrow = {
      ...(typeof args.slice === "string"
        ? { slice: { question: args.slice, ...(typeof args.sliceTokens === "number" ? { maxTokens: args.sliceTokens } : {}) } }
        : {}),
      ...(typeof args.budgetTokens === "number" ? { budgetTokens: args.budgetTokens } : {}),
    };
    let lockRoots: [string, string];
    try {
      const safe = resolveSafeOutputDirs(workspace.config);
      lockRoots = [safe.outDir, safe.tmpDir];
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
    const result = await generateInWorker(
      workspace.root,
      { ...workspace.cliOptions, ...reportOptions },
      { signal: controller.signal, narrow, runId: randomUUID(), lockRoots }
    );
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

/**
 * The configuration `validate` should compare against: the manifest's record of how the snapshot
 * was generated, for the settings that only a run flag can carry.
 *
 * `validate` compares a configuration digest, and that digest covers the artifact selection
 * (`tokenTree`, `includeDiffs`, …), `stripComments`, `removeEmptyLines`, `pack`, `logCount`,
 * `skeleton`, `sarif` and `maxParts`. None of those is in the config file when they came from a
 * flag, so a tool that resolves the bare config reported a freshly generated snapshot "out of
 * date — 2 settings changed". The manifest records them now; use that record. Everything the
 * config file does set (budgets, include/exclude, layers, kinds, preset) still comes from the
 * current config, so real configuration drift is still reported. */
function configAsGenerated(workspace: Workspace, manifest: Manifest): Workspace["config"] {
  const recorded = manifest.config;
  const cli = workspace.cliOptions;
  const source = workspace.sourceConfig;
  const configured = (key: string): boolean =>
    source !== null && Object.prototype.hasOwnProperty.call(source, key);
  const sourceArtifacts =
    source !== null && source.artifacts !== null && typeof source.artifacts === "object"
      ? (source.artifacts as Record<string, unknown>)
      : null;
  // A setting the config file names must be compared against the current file, so editing it is
  // drift. A setting only a run flag supplied has to come from the manifest, or a snapshot
  // generated with --skeleton could never validate. The source config is what distinguishes them;
  // taking the whole recorded configuration made every config edit invisible.
  const artifacts = { ...workspace.config.artifacts };
  if (recorded?.artifacts !== undefined) {
    for (const [key, value] of Object.entries(recorded.artifacts)) {
      if (sourceArtifacts === null || !Object.prototype.hasOwnProperty.call(sourceArtifacts, key)) {
        (artifacts as Record<string, unknown>)[key] = value;
      }
    }
  }
  // Include artifacts whenever the manifest records them: a run flag such as --token-tree is
  // invisible in the current config and can only be reconstructed from the manifest.
  let artifactOverride = recorded?.artifacts !== undefined;
  if (cli.includeDiffs === true) {
    artifacts.diff = true;
    artifactOverride = true;
  }
  if (cli.includeLogs !== undefined) {
    artifacts.log = true;
    artifactOverride = true;
  }
  if (cli.tokenTree === true) {
    artifacts.tokenTree = true;
    artifactOverride = true;
  }
  const choose = <T>(key: string, recordedValue: T | undefined, current: T, cliValue?: T): T =>
    cliValue !== undefined
      ? cliValue
      : configured(key)
        ? current
        : (recordedValue ?? current);
  return {
    ...workspace.config,
    ...(artifactOverride ? { artifacts } : {}),
    ...(cli.stripComments === true || configured("stripComments") || recorded?.stripComments !== undefined
      ? { stripComments: choose("stripComments", recorded?.stripComments, workspace.config.stripComments, cli.stripComments === true ? true : undefined) }
      : {}),
    ...(cli.removeEmptyLines === true || configured("removeEmptyLines") || recorded?.removeEmptyLines !== undefined
      ? { removeEmptyLines: choose("removeEmptyLines", recorded?.removeEmptyLines, workspace.config.removeEmptyLines, cli.removeEmptyLines === true ? true : undefined) }
      : {}),
    ...(cli.pack !== undefined || configured("pack") || recorded?.pack !== undefined
      ? { pack: choose("pack", recorded?.pack ?? undefined, workspace.config.pack, cli.pack) }
      : {}),
    ...(cli.includeLogs !== undefined || configured("logCount") || recorded?.logCount !== undefined
      ? { logCount: choose("logCount", recorded?.logCount, workspace.config.logCount, cli.includeLogs) }
      : {}),
    ...(cli.skeleton === true || configured("skeleton") || recorded?.skeleton !== undefined
      ? { skeleton: choose("skeleton", recorded?.skeleton, workspace.config.skeleton, cli.skeleton === true ? true : undefined) }
      : {}),
    ...(cli.sarif === true || configured("sarif") || recorded?.sarif !== undefined
      ? { sarif: choose("sarif", recorded?.sarif, workspace.config.sarif, cli.sarif === true ? true : undefined) }
      : {}),
    ...(configured("maxParts") || recorded?.maxParts !== undefined
      ? { maxParts: choose("maxParts", recorded?.maxParts, workspace.config.maxParts) }
      : {}),
    ...(cli.maxPartTokens !== undefined || configured("maxPartTokens") || recorded?.maxPartTokens !== undefined
      ? { maxPartTokens: choose("maxPartTokens", recorded?.maxPartTokens, workspace.config.maxPartTokens, cli.maxPartTokens) }
      : {}),
    ...(cli.changedSince !== undefined || configured("changedSince") || recorded?.changedSince !== undefined
      ? { changedSince: choose("changedSince", recorded?.changedSince, workspace.config.changedSince, cli.changedSince) }
      : {}),
    ...(cli.staged === true || configured("staged") || recorded?.staged !== undefined
      ? { staged: choose("staged", recorded?.staged, workspace.config.staged, cli.staged === true ? true : undefined) }
      : {}),
    ...(cli.withDependents === true || configured("withDependents") || recorded?.withDependents !== undefined
      ? { withDependents: choose("withDependents", recorded?.withDependents, workspace.config.withDependents, cli.withDependents === true ? true : undefined) }
      : {}),
    ...(configured("promptTask") || recorded?.promptTask !== undefined
      ? { promptTask: choose("promptTask", recorded?.promptTask, workspace.config.promptTask) }
      : {}),
  };
}

const validateTool: ToolSpec = {
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

    const read = readManifest(workspace);
    if (!read.ok) return failure(read.message);
    let result: ValidationResult;
    try {
      result = validateSnapshot(configAsGenerated(workspace, read.manifest));
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

const locateTool: ToolSpec = {
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
const dependentsTool: ToolSpec = {
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

    const resolver = buildImportResolver(manifest.files, {
      tsconfig: tsconfigPathsFor(prepared.workspace.root),
    });
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

const readTool: ToolSpec = {
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

    // The JSON Schema declares the minimums, but a handler is called by handlers and by tests,
    // and a schema is not enforcement. A request for zero or −3 lines returned one line and said
    // nothing; asking for the impossible now says so.
    if (typeof args.fromLine === "number" && (!Number.isInteger(args.fromLine) || args.fromLine < 1)) {
      return failure('"fromLine" must be an integer of at least 1 (received ' + String(args.fromLine) + ").");
    }
    if (typeof args.lines === "number" && (!Number.isInteger(args.lines) || args.lines < 1)) {
      return failure('"lines" must be an integer of at least 1 (received ' + String(args.lines) + ").");
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

const explainTool: ToolSpec = {
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
/** A tool before its cost class is attached; `buildTools` is the one place that knows the table. */
type ToolSpec = Omit<McpTool, "cost">;

/** The cost class of each tool, in one table so a new tool cannot ship without one. */
const TOOL_COSTS: Record<string, ToolCost> = {
  snapshot_status: "cheap",
  snapshot_health: "expensive",
  snapshot_budget: "medium",
  snapshot_history: "cheap",
  snapshot_tests: "cheap",
  snapshot_workspace: "cheap",
  snapshot_entrypoints: "cheap",
  snapshot_neighbors: "medium",
  snapshot_routes: "cheap",
  snapshot_cycles: "medium",
  snapshot_search: "medium",
  snapshot_stats: "cheap",
  snapshot_review: "expensive",
  snapshot_diff_context: "medium",
  snapshot_symbol: "medium",
  snapshot_context: "medium",
  snapshot_query: "cheap",
  snapshot_plan_for: "cheap",
  snapshot_answer: "medium",
  snapshot_plan: "expensive",
  snapshot_generate: "expensive",
  snapshot_validate: "medium",
  snapshot_locate: "cheap",
  snapshot_dependents: "cheap",
  snapshot_read: "medium",
  snapshot_explain: "cheap",
};

export function buildTools(): McpTool[] {
  return [
    statusTool,
    healthTool,
    budgetTool,
    historyTool,
    testsTool,
    workspaceTool,
    entrypointsTool,
    neighborsTool,
    routesTool,
    cyclesTool,
    searchTool,
    statsTool,
    reviewTool,
    diffContextTool,
    symbolTool,
    contextTool,
    queryTool,
    planForTool,
    answerTool,
    planTool,
    generateTool,
    validateTool,
    locateTool,
    dependentsTool,
    readTool,
    explainTool,
  ].map((tool) => {
    const cost = TOOL_COSTS[tool.name];
    if (cost === undefined) throw new Error("no cost class for tool " + tool.name);
    return { ...tool, cost };
  });
}
