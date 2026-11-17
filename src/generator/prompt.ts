import { DEFAULT_ATTACHMENT_SLOTS } from "../config.js";
import type { ProjectOverview } from "./overview.js";
import type { CommitRecord } from "../scanner/files.js";
import type { Manifest, OwnerBrief, PromptTask, ResolvedArtifacts } from "../types.js";
import { escapeControls, formatNumber, inlineCode } from "../terminal.js";

/**
 * Renders `PROMPT.md`: the brief a snapshot is handed over with, and the apparatus that keeps
 * the handover honest.
 *
 * The first version of this file was a packing slip - it said how to read the parts and nothing
 * about the job, the system or the standard. A model that receives a codebase without those
 * produces a summary. The structure here is taken from briefs that worked: what the system is,
 * what was already fixed, what counts as a finding, what coverage is owed, and one calibration
 * example of the class worth finding.
 *
 * Everything factual is rendered from the manifest and the repository history, so the brief
 * cannot describe a different run. Everything static is a standard, not a description.
 */

/** Basename of the artifact this module renders. */
export const PROMPT_FILENAME = "PROMPT.md";

const MAX_PART_ROWS = 16;
const MAX_LAYER_ROWS = 8;
const MAX_INCOMPLETE_ROWS = 50;
const MAX_CENTRAL_FILES = 5;
const MAX_ENTRY_POINTS = 4;
const MAX_LARGEST_FILES = 3;
/** `1 part` / `2 parts`, so a one-part snapshot does not read as machine output. */
const partWord = (count: number): string => (count === 1 ? "part" : "parts");

/** "`a`, `b` and `c`" — the list form the delivery sentences need. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

/** `attachmentSlots: 0` means the destination imposes no file limit. */
const UNLIMITED_SLOTS = 0;

/** Names an entry point by convention; the manifest has no field that says "start here". */
const ENTRY_POINT = /(^|\/)(index|cli|main|bin|server|app|mod)\.[cm]?[jt]sx?$/;
/** A test by directory or by file name, so the ratio holds for repositories without a test layer. */
const TEST_PATH = /(^|\/)(tests?|__tests__)\//;
const TEST_FILE = /\.(test|spec)\.[^.]+$/;

export interface PromptContext {
  /** Files the destination accepts; `0` means no limit. */
  slots?: number;
  /** The job the brief is written for. */
  task?: PromptTask;
  /** The owner-written half, already masked. */
  brief?: OwnerBrief;
  /** The last commits, already masked, newest first. */
  history?: readonly CommitRecord[];
  /** What the repository says about itself, already masked. */
  overview?: ProjectOverview;
}

export function generatePrompt(
  manifest: Manifest,
  artifacts?: ResolvedArtifacts,
  context: PromptContext = {}
): string {
  const slots = context.slots ?? DEFAULT_ATTACHMENT_SLOTS;
  const task = context.task ?? "audit";
  const history = context.history ?? [];
  const overview = context.overview ?? { releases: [] };
  const brief = context.brief;
  // A missing selection means "assume written", so the library call that predates it keeps
  // working and a caller that does not care about the selection still gets a full brief.
  const wrote = (name: keyof ResolvedArtifacts): boolean => artifacts?.[name] !== false;
  // Whether `manifest.json` itself was written. The brief names that file as the place to check
  // skips, the call graph and the validation state; with the artifact disabled it must not.
  const sawManifest = wrote("manifest");
  const code = (value: string): string => inlineCode(escapeControls(value));
  // Owner prose, commit messages and the README summary are reproduced text: a NUL or a bidi
  // override in any of them reaches an artifact otherwise. The repo escapes them everywhere
  // else, and the brief must not be the one place that does not.
  const text = (value: string): string => escapeControls(value);
  const hasOwnerHistory = (brief?.history ?? "").trim().length > 0;

  const lines: string[] = [
    "# PROMPT.md",
    "",
    wrote("parts")
      ? "The brief and the apparatus for this snapshot. Paste this file first, then the parts it names."
      : "The brief and the apparatus for this snapshot. Paste this file first; this run wrote no parts, and the brief says what it did write.",
    "",
    "It is generated rather than written once: the system map, the omissions, the fingerprint and",
    "the history below are read from `manifest.json` and this repository, so they describe this run.",
    "Regenerate it after the code moves.",
    "",
    "---",
    "",
    "```text",
    "You are working on a codebase you cannot clone, run or grep. Everything you know about it comes",
    "from the snapshot that follows this instruction. Where these notes and the snapshot disagree,",
    "the snapshot is what exists.",
    ""
  ];
  if (brief?.preamble !== undefined) lines.push(text(brief.preamble), "");
  if (manifest.config.stripComments === true) {
    lines.push(
      "Comment text was removed from JavaScript and TypeScript bodies before emission. Line " +
        "numbers did not move, so a citation is still a source line; the files record " +
        "`inclusionMode: \"comments-stripped\"`.",
      ""
    );
  }
  if (manifest.budget !== undefined) {
    lines.push(
      "This snapshot was fitted to a **token budget** of " +
        manifest.budget.maxTokens +
        " tokens: " +
        manifest.budget.files.length +
        " file(s) were selected whole, in value order (" +
        manifest.budget.usedTokens +
        " tokens used), and " +
        manifest.budget.dropped +
        " scanned path(s) did not fit. They are recorded in `skipped[]` with reason " +
        "\"not-selected\"; do not describe them from memory." +
        (manifest.budget.coverage === undefined
          ? ""
          : " Coverage: " +
            manifest.budget.coverage.symbols.kept + "/" + manifest.budget.coverage.symbols.total + " exported " +
            "symbol(s), " +
            manifest.budget.coverage.entryPoints.kept + "/" + manifest.budget.coverage.entryPoints.total + " entry " +
            "point(s)."),
      ""
    );
  }
  if (manifest.slice !== undefined) {
    lines.push(
      "This snapshot is a **task slice**: it contains the " +
        manifest.slice.files.length +
        " file(s) the planner chose for the question \"" +
        text(manifest.slice.question) +
        "\" within " +
        manifest.slice.budgetTokens +
        " tokens (" +
        manifest.slice.usedTokens +
        " used). Every other scanned path was not selected and is recorded in `skipped[]` with " +
        "reason \"not-selected\"; do not describe those paths from memory, and say so if the task " +
        "needs one of them.",
      ""
    );
  }
  if (manifest.delta !== undefined) {
    const delta = manifest.delta;
    lines.push(
      "This snapshot is a **delta** against `" +
        code(delta.base.path) +
        "` (fingerprint `" +
        code(delta.base.fingerprint.slice(0, 12)) +
        "`): " +
        delta.changed.length +
        " changed, " +
        delta.added.length +
        " added, " +
        delta.removed.length +
        " removed, and " +
        delta.unchanged.length +
        " unchanged files are not in the parts. The unchanged paths are listed in `delta.unchanged` " +
        "and in `skipped[]` with reason \"unchanged\"; do not describe them from memory.",
      ""
    );
  }

  lines.push(...jobSection(task, history.length > 0 || hasOwnerHistory), "");
  lines.push(...stakesSection(brief, code, text));
  lines.push(...haveSection(wrote), "");
  lines.push(...whatThisIsSection(overview, text), "");
  lines.push(...systemSection(manifest, code, brief, text, sawManifest), "");
  lines.push(...historySection(history, brief, code, text), "");
  lines.push(...barSection(brief, code, text), "");
  lines.push(...coverageSection(manifest, code, wrote("audit"), wrote("parts"), sawManifest), "");
  lines.push(...answerSection(), "");
  lines.push(...calibrationSection(brief, code, text), "");
  lines.push(...ownerNotesSection(brief, code, text));
  lines.push(...snapshotSection(manifest, code, wrote("parts")), "");
  const accompanying: string[] = [];
  if (wrote("manifest")) accompanying.push("`manifest.json`");
  if (wrote("readme")) accompanying.push("`README.md`");
  if (wrote("navigation")) accompanying.push("`reports/navigation.md`");
  if (wrote("projectTree")) accompanying.push("`reports/project-tree.md`");
  if (wrote("audit")) accompanying.push("`reports/audit.md`");
  // The opt-in reports were written by this run and are not named by the rest of the brief, so
  // the one list of "what else you were given" has to carry them or the reader never opens them.
  const blankLinesRemoved = manifest.files.filter((file) => file.emptyLinesRemoved === true).length;
  if (blankLinesRemoved > 0) {
    lines.push(
      "Blank lines were removed from " + blankLinesRemoved + " file(s) (`--remove-empty-lines`), so " +
        "line numbers in those bodies do not match the source file. The manifest marks each with " +
        "`emptyLinesRemoved: true`; do not cite a line number for them without saying so.",
      ""
    );
  }
  if (manifest.artifacts?.diff !== undefined) accompanying.push("`reports/diff.md`");
  if (manifest.artifacts?.log !== undefined) accompanying.push("`reports/log.md`");
  if (manifest.artifacts?.tokenTree !== undefined) accompanying.push("`reports/tokens.md`");
  lines.push(...deliverySection(manifest, wrote("parts"), slots, accompanying));

  lines.push(
    "## Your task",
    "",
    "<replace with the question, the area to review, or the subsystem to audit>",
    "```"
  );

  lines.push(
    "",
    "---",
    "",
    "## Why this file exists",
    "",
    "Parts on their own are a dump: the model receives text, has no idea what was left out of it,",
    "and fills the gap by invention. A brief on its own is a wish list: it cannot say which files",
    "are present, which are partial or which part holds what. This file is both halves, and the",
    "facts in it move with the snapshot.",
    "",
    "## Keeping it true",
    "",
    sawManifest
      ? "- It is one of the artifacts recorded in `manifest.json` under `artifacts.prompt`, so deleting"
      : "- It is one of the artifacts of this run, so a later check notices it changed — except that",
    sawManifest
      ? "  or editing `PROMPT.md` makes `snapshot validate` fail."
      : "  `manifest.json` was not written in this run, so `validate` has nothing to check against.",
    "- `--skip-artifacts prompt`, or `artifacts: { prompt: false }` in the config, turns it off.",
    "- The history section disappears when git cannot be read, rather than being invented.",
    "- If the code moves, regenerate. A brief naming the previous run parts is worse than no",
    "  brief, because it reads as current.",
    ""
  );

  return lines.join("\n");
}

/** What the reader was given, and only what was actually written. */
function haveSection(wrote: (name: keyof ResolvedArtifacts) => boolean): string[] {
  const out = ["## What you have", ""];
  const bullets: string[] = [];
  if (wrote("readme")) {
    bullets.push("- `README.md` - orientation: metrics, the part table, and the fingerprint.");
  }
  if (wrote("manifest")) {
    bullets.push(
      "- `manifest.json` - the index. Per file: `relativePath`, `layer`, `kind`, `language`,",
      "  `part`, `sha256`, `inclusionMode`, `truncationReason`, `omittedRanges`. It also carries",
      "  every excluded path under `skipped[]` with its reason, and `incomplete[]`, which names",
      "  every included file whose emitted body is not the whole file."
    );
  }
  if (wrote("navigation")) {
    bullets.push(
      wrote("parts")
        ? "- `reports/navigation.md` - file to part. Locate here before you read anything."
        : "- `reports/navigation.md` - file to part. Its links point at part files that were " +
          "not written in this run, so it locates files rather than files you were given."
    );
  }
  if (wrote("projectTree")) {
    bullets.push("- `reports/project-tree.md` - the directory shape of what was included.");
  }
  if (wrote("audit")) {
    bullets.push(
      "- `reports/audit.md` - secret findings, the files whose lines were redacted, large files,",
      "  parse diagnostics and the git state the snapshot was taken from."
    );
  }
  if (wrote("parts")) {
    bullets.push(
      "- `parts/part-NNN.md` - the code itself, split to a fixed byte budget. Each part states its",
      "  own number, the files it contains, and the fingerprint it was built from."
    );
  }
  if (wrote("monolith")) {
    bullets.push(
      "- `full-codebase.json` and `full-codebase.md` - the entire payload in one file each.",
      "  Where they are present, they supersede the parts: nothing was left out of them."
    );
  }
  if (bullets.length === 0) {
    bullets.push(
      "- Nothing but this brief: every code artifact was disabled for this run. Ask for a snapshot",
      "  generated with the artifacts you need, and do not answer from memory."
    );
  }
  out.push(...bullets);
  return out;
}

/** The system as the index can prove it: layers, hubs, entry points, surfaces, size. */
function systemSection(
  manifest: Manifest,
  code: (value: string) => string,
  brief: OwnerBrief | undefined,
  escape: (value: string) => string,
  sawManifest: boolean
): string[] {
  const out = ["## The system", ""];
  if (brief?.system !== undefined) {
    out.push(...ownerBlock(brief.system, brief.path, code, escape), "", "What the index records:", "");
  }

  const layers = Object.entries(manifest.layers).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (layers.length > 0) {
    const shown = layers
      .slice(0, MAX_LAYER_ROWS)
      .map(([name, count]) => code(name) + " " + formatNumber(count));
    const rest =
      layers.length > MAX_LAYER_ROWS
        ? ", and " + formatNumber(layers.length - MAX_LAYER_ROWS) + " more"
        : "";
    out.push("- Layers, by file count: " + shown.join(", ") + rest + ".");
  }

  const central = manifest.indexes.imports.centralFiles;
  if (central.length > 0) {
    const shown = central
      .slice(0, MAX_CENTRAL_FILES)
      .map((entry) => code(entry.path) + " (" + formatNumber(entry.importedByCount) + ")")
      .join(", ");
    out.push(
      "- Load-bearing modules, by how many files import them: " + shown + ".",
      "  A change here reaches the most call sites; read it before judging anything that uses it."
    );
  }

  const entryPoints = manifest.files
    .map((file) => file.relativePath)
    .filter((path) => ENTRY_POINT.test(path))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)
    .slice(0, MAX_ENTRY_POINTS);
  out.push(
    entryPoints.length > 0
      ? "- Entry points by convention: " + entryPoints.map(code).join(", ") + "."
      : "- No entry point was identifiable by name. The largest files below are where execution"
  );
  if (entryPoints.length === 0) {
    out.push(
      sawManifest
        ? "  starts, and the call graph in `manifest.json` is the map."
        : "  starts, and no manifest was written in this run, so the index is not here to read."
    );
  }

  const routes = manifest.indexes.routes.length;
  const handlers = manifest.indexes.handlers.length;
  const components = manifest.indexes.components.length;
  const routesShown = manifest.indexes.routes.slice(0, 4).map((route) => code(route.path));
  const componentsShown = manifest.indexes.components.slice(0, 4).map((entry) => code(entry.path));
  if (routes + handlers + components === 0) {
    out.push(
      "- No routes, handlers or UI components were recorded: this snapshot indexes no HTTP or",
      "  component surface. Do not go looking for one, and do not infer one from a file name."
    );
  } else {
    const parts: string[] = [];
    if (routes > 0) {
      parts.push(
        formatNumber(routes) + (routes === 1 ? " route" : " routes") + ", e.g. " + routesShown.join(", ")
      );
    }
    if (handlers > 0) parts.push(formatNumber(handlers) + (handlers === 1 ? " handler" : " handlers"));
    if (components > 0) {
      parts.push(
        formatNumber(components) +
          (components === 1 ? " component" : " components") +
          ", e.g. " +
          componentsShown.join(", ")
      );
    }
    out.push("- Surfaces the index found: " + parts.join("; ") + ".");
  }

  const largest = [...manifest.files]
    .sort((a, b) => b.includedBytes - a.includedBytes)
    .slice(0, MAX_LARGEST_FILES);
  if (largest.length > 0) {
    out.push(
      "- Largest files: " +
        largest
          .map((file) => code(file.relativePath) + " (" + formatNumber(Math.round(file.includedBytes / 1024)) + " KB)")
          .join(", ") +
        "."
    );
  }

  const tests = manifest.files.filter(
    (file) => TEST_PATH.test(file.relativePath) || TEST_FILE.test(file.relativePath)
  );
  if (tests.length > 0) {
    const testBytes = tests.reduce((total, file) => total + file.includedBytes, 0);
    const allBytes = manifest.files.reduce((total, file) => total + file.includedBytes, 0);
    const share = allBytes === 0 ? 0 : Math.round((testBytes / allBytes) * 100);
    out.push(
      "- Tests: " + formatNumber(tests.length) + (tests.length === 1 ? " file, " : " files, ") + share + "% of the included bytes.",
      "  They are evidence of intent, not of behaviour: a fixture can encode a payload shape the",
      "  real system never sends."
    );
  }

  return out;
}

/** The record of what was already fixed, which is the section that stops a repeat audit. */
function historySection(
  history: readonly CommitRecord[],
  brief: OwnerBrief | undefined,
  code: (value: string) => string,
  escape: (value: string) => string
): string[] {
  const out = ["## What came before", ""];
  if (brief?.history !== undefined) out.push(...ownerBlock(brief.history, brief.path, code, escape), "");
  if (history.length === 0) {
    out.push(
      "No history was readable: this is not a git checkout, or git could not be run. Nothing about",
      "what came before can be claimed from here, and that is not evidence that the code is new."
    );
    return out;
  }
  out.push(
    "The last " + formatNumber(history.length) + " " +
      (history.length === 1 ? "commit" : "commits") + ", newest first. Subjects and bodies are claims",
    "by whoever wrote them, not evidence - the code beside them is the evidence. If one of these",
    "fixes looks incomplete, quote the lines and say which call site it missed.",
    ""
  );
  for (const commit of history) {
    out.push("- " + escape(commit.subject));
    if (commit.body.length > 0) out.push("  " + escape(commit.body));
  }
  return out;
}

/** The standard. Static on purpose: this is what a finding has to be, for any repository. */
function barSection(brief: OwnerBrief | undefined, code: (value: string) => string, text: (value: string) => string): string[] {
  if (brief?.bar !== undefined) {
    return ["## The bar", "", ...ownerBlock(brief.bar, brief.path, code, text), ""];
  }
  return [
    "## The bar",
    "",
    "A finding is a concrete way the code breaks or lies, supported by quoted lines: the path and",
    "line, the input or state that reaches it, what happens next, and why the guard that appears to",
    "stop it does not. A comment is not behaviour. A passing test is evidence of intent, not of",
    "behaviour.",
    "",
    "- No style, naming, formatting, add-types, add-tests, consider-X or speculative rewrites.",
    "- Never invent a finding to fill a section. A clean surface is proven by quoting the guard",
    "  that makes it clean.",
    "- Mark confidence, and name the check - a test, a run, an input - that would settle anything",
    "  you cannot decide by reading.",
    "- Separate what the code does from what the deployment or configuration does. Both are",
    "  findings; they have different owners and different fixes."
  ];
}

/** What the snapshot cannot show, so the reader does not mistake absence for cleanliness. */
function coverageSection(
  manifest: Manifest,
  code: (value: string) => string,
  auditWritten: boolean,
  partsWritten: boolean,
  sawManifest: boolean
): string[] {
  const out = ["## Coverage", ""];
  const reasons = new Map<string, number>();
  for (const record of manifest.skipped) {
    reasons.set(record.reason, (reasons.get(record.reason) ?? 0) + 1);
  }
  const tally = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => code(reason) + " " + formatNumber(count))
    .join(", ");
  const found = manifest.totals.candidateFiles;
  const included = manifest.totals.includedFiles;
  const skipped = manifest.counts.skippedCount;
  const counted =
    formatNumber(found) + (found === 1 ? " path was" : " paths were") + " found; " +
    (partsWritten
      ? formatNumber(included) + (included === 1 ? " is" : " are") + " in the parts"
      : formatNumber(included) +
        (included === 1 ? " was" : " were") +
        " partitioned, but no part file was written") +
    " and " +
    formatNumber(skipped) + (skipped === 1 ? " was" : " were") + " skipped" +
    (tally.length > 0 ? " (" + tally + ")" : "") + ".";
  out.push(
    "- " + counted,
    partsWritten
      ? sawManifest
        ? "  `manifest.skipped[]` names each one and why. An absent path is not a clean path."
        : "  No manifest was written in this run, so the per-path reasons are not in this snapshot."
      : "  The code itself is not in this snapshot: only the index and the reports were written."
  );
  out.push(...incompleteSection(manifest, code));
  out.push(...redactionSection(manifest, auditWritten));
  out.push(
    "- Everything unseen is unread, never clean. If you were given only some of the parts, say",
    "  which ones are missing before you answer. A file the index names but the parts do not carry",
    "  is an input defect, not a code finding - report it as one."
  );
  return out;
}

/** What the answer has to contain to be worth the tokens. */
function answerSection(): string[] {
  return [
    "## What a useful answer contains",
    "",
    "- An opening line, filled from This snapshot below:",
    "",
    "    snapshot <fingerprint> generated <generatedAt>",
    "",
    "- What you read and what you did not, named by path or by part.",
    "- Findings ordered by consequence, each with the lines quoted.",
    "- The checks or attacks that failed, and the line or guard that blocked them. A failed attack",
    "  is how anyone knows an invariant is real rather than asserted.",
    "- What you retracted after re-reading.",
    "- What only a run, a test or a host can settle, and the check that would settle each.",
    "- One paragraph on the failure you would bet on next.",
    "- A closing line: Needed but not received: <paths>, or none. That line is not decoration -",
    "  an invented function is indistinguishable from a real one, and this is where you name",
    "  the gap you filled by asking instead of guessing."
  ];
}

/**
 * Three examples of the class worth finding, drawn from real audits of this kind of tool.
 *
 * They are generic on purpose: a repository-specific example would be invented, and an invented
 * example teaches the model to invent.
 */
function calibrationSection(
  brief: OwnerBrief | undefined,
  code: (value: string) => string,
  text: (value: string) => string
): string[] {
  if (brief?.calibration !== undefined) {
    return ["## Calibration", "", ...ownerBlock(brief.calibration, brief.path, code, text), ""];
  }
  return [
    "## Calibration",
    "",
    "The findings that matter here do not crash. They look like:",
    "",
    "- a guard applied at one call site and not its twin - the route checks, the timer does not;",
    "- a budget shorter than the work it guards, so the caller gives up while the work continues;",
    "- a success flag that means the call returned, consumed as the change happened;",
    "- a document that describes a different run than the one beside it;",
    "- a default that fabricates a number when the measurement failed.",
    "",
    "None of these throw. All are invisible in a summary."
  ];
}

/** The job, which is the one section that changes with `promptTask`. */
function jobSection(task: PromptTask, hasHistory: boolean): string[] {
  const out = ["## The job", ""];
  if (task === "audit") {
    out.push(
      "Find what is still wrong or will break. How you read the code is yours to decide - by",
      "subsystem, by data flow, by the invariants you derive yourself. What you owe in return is an",
      "honest account of what you covered and what you did not.",
      ""
    );
    if (hasHistory) {
      out.push(
        "Another pass of the same findings is worth nothing. This repository carries a record of",
        "what was already fixed, below. Verify that those fixes hold instead of rediscovering them,",
        "and treat a variant of one at a different call site as a new finding."
      );
    } else {
      out.push(
        "Another pass of the same findings is worth nothing, but no earlier round is readable here,",
        "so you cannot tell what has already been tried. Do not assume this is the first attempt."
      );
    }
    out.push(
      "",
      "If the task at the end asks for something narrower - explain a file, review a change, answer",
      "a question - that task wins. The standard and the coverage duty below still apply to it."
    );
  } else if (task === "review") {
    out.push(
      "Review the change or the area named in the task against this snapshot. Report what breaks,",
      "what the change claims but does not do, and what a reader would believe that the code does",
      "not support. Restating the diff is not a review; the standard and the coverage duty below",
      "still apply."
    );
  } else {
    out.push(
      "Explain how the part of the system named in the task works: the data flow, the boundaries",
      "and the invariants it depends on. Cite the lines. If the snapshot does not contain what you",
      "need, say which file you need rather than reconstructing it from the shape of the names."
    );
  }
  return out;
}

/** What is at stake, when the owner has said. It sits beside the job, not in an appendix. */
function stakesSection(brief: OwnerBrief | undefined, code: (value: string) => string, text: (value: string) => string): string[] {
  if (brief?.stakes === undefined) return [];
  return ["## Stakes", "", ...ownerBlock(brief.stakes, brief.path, code, text), ""];
}

/** What the repository says about itself, when it says anything. */
function whatThisIsSection(
  overview: ProjectOverview,
  escape: (value: string) => string
): string[] {
  const body: string[] = [];
  if (overview.description !== undefined) {
    body.push("- Declared in `package.json`: " + escape(overview.description));
  }
  if (overview.summary !== undefined) {
    body.push("- From the `README.md` first paragraph: " + escape(overview.summary));
  }
  if (overview.releases.length > 0) {
    body.push("- Most recent releases: " + overview.releases.map(escape).join("; ") + ".");
  }
  if (body.length === 0) return [];
  return [
    "## What this is",
    "",
    ...body,
    "",
    "Those are the project's own claims, not evidence about the code.",
    ""
  ];
}

/** Anything the owner wrote that the merge did not recognise. Never dropped. */
function ownerNotesSection(
  brief: OwnerBrief | undefined,
  code: (value: string) => string,
  text: (value: string) => string
): string[] {
  if (brief === undefined || brief.notes.length === 0) return [];
  const out: string[] = ["## Owner notes", ""];
  for (const note of brief.notes) {
    out.push("### " + note.heading, "", ...ownerBlock(note.body, brief.path, code, text), "");
  }
  return out;
}

/**
 * One owner-written block, marked as such.
 *
 * The marker is the whole reason this is a function: a reader has to be able to tell an
 * assertion by the owner from a measurement by the tool, in a document where both appear.
 */
function ownerBlock(
  body: string,
  path: string,
  code: (value: string) => string,
  escape: (value: string) => string
): string[] {
  return ["> Written by the project owner in " + code(path) + ", not generated.", "", escape(body)];
}

/** The fingerprint and the counts, so the answer can name the state it describes. */
function snapshotSection(
  manifest: Manifest,
  code: (value: string) => string,
  partsWritten: boolean
): string[] {
  const out = ["## This snapshot", ""];
  out.push("- Fingerprint: " + code(manifest.fingerprint) + " - quote it verbatim in your answer.");
  out.push(
    "- Generated: " + code(manifest.generatedAt) + " from branch " + code(manifest.git.branch) +
      " at commit " + code(manifest.git.commit.slice(0, 8)) + "."
  );
  out.push(
    manifest.git.isDirty
      ? "  The working tree had uncommitted changes at generation time."
      : "  The working tree was clean at generation time."
  );
  out.push(
    "- Validation: the generation-time check was " + code(manifest.validation.status) + ".",
    "  That describes the run, not now: if the tree may have moved since, the snapshot is a",
    "  claim that needs re-checking, not a fact."
  );
  if (!partsWritten) {
    // The partition is recorded in `manifest.parts[]` either way, because every file points at
    // one. Listing those as files to open when no part file was written was a lie the reader
    // could not detect until the attachment failed.
    out.push(
      "- No part files were written: the `parts` artifact was disabled for this run.",
      "  `manifest.parts[]` still records the partition that was planned, so the index lines up",
      "  with `files[].part`; the code itself is not in this snapshot."
    );
  } else if (manifest.parts.length > 0) {
    out.push(
      "- Parts: " + formatNumber(manifest.parts.length) + " at a " +
        formatNumber(Math.round(manifest.budgets.maxPartBytes / 1024)) + " KB ceiling" +
        (manifest.parts.length === 1 ? ":" : " each:")
    );
    for (const part of manifest.parts.slice(0, MAX_PART_ROWS)) {
      out.push("  - " + code(part.filename) + " - " + formatNumber(part.fileCount) + " file(s)");
    }
    if (manifest.parts.length > MAX_PART_ROWS) {
      out.push(
        "  - and " + formatNumber(manifest.parts.length - MAX_PART_ROWS) +
          " more, tabled in `README.md`"
      );
    }
  }
  return out;
}

/**
 * The list of files that are not whole, which is the section that earns its place.
 *
 * Left implicit, a preview reads as a complete file whose middle happens to be missing: the reader
 * has no way to tell and no reason to ask.
 */
function incompleteSection(manifest: Manifest, code: (value: string) => string): string[] {
  const out: string[] = [];
  const list = manifest.incomplete;
  if (list.length === 0) {
    out.push("- Partial files: none. Every included file is present in full.");
    return out;
  }
  out.push(
    "- Partial files: " + formatNumber(list.length) + ". These are present only in part, and the",
    "  missing lines are named, not implied:"
  );
  for (const entry of list.slice(0, MAX_INCOMPLETE_ROWS)) {
    const ranges = entry.omittedRanges
      .map(([start, end]) => (start === end ? String(start) : start + "-" + end))
      .join(", ");
    out.push(
      "  - " + code(entry.relativePath) + " in " + code(entry.part) + " - " + entry.reason +
        ", lines " + ranges + " (" + formatNumber(entry.omittedLines) + " of " +
        formatNumber(entry.lines) + " missing)"
    );
  }
  if (list.length > MAX_INCOMPLETE_ROWS) {
    out.push(
      "  - and " + formatNumber(list.length - MAX_INCOMPLETE_ROWS) +
        " more, all named in `manifest.json` under `incomplete[]`"
    );
  }
  return out;
}

/**
 * Which lines were masked, and the one sentence that stops a mask being read as an empty value.
 *
 * The count is in the manifest either way; only the per-file detail lives in `reports/audit.md`, so
 * the sentence changes with that artifact rather than pointing at a file that was not written.
 */
function redactionSection(manifest: Manifest, auditWritten: boolean): string[] {
  const redacted = manifest.totals.redactedLines;
  if (redacted === 0) {
    return ["- Redacted: no line matched a secret rule."];
  }
  const where = auditWritten
    ? "`reports/audit.md` names the files; the values are not recoverable from it."
    : "`reports/audit.md` was disabled for this run, so only the count is available.";
  return [
    "- Redacted: " + formatNumber(redacted) + " line(s) had values masked before you received them.",
    "  A masked span is a deliberate redaction, not an empty value.",
    "  " + where
  ];
}

/**
 * The delivery plan: arithmetic a reader cannot do from the brief alone.
 *
 * A snapshot is pasted into a surface that takes a fixed number of files, and the parts are most
 * of that budget, so "attach the snapshot" can be advice that cannot be followed. This section
 * states what fits, what to leave behind, and what to do when the parts do not fit.
 */
function deliverySection(
  manifest: Manifest,
  partsWritten: boolean,
  slots: number,
  others: readonly string[]
): string[] {
  if (!partsWritten || manifest.parts.length === 0) return [];
  const parts = manifest.parts.length;
  // Every file besides the parts, named as it exists: a skipped artifact used to be counted and
  // named anyway, which made the arithmetic promise a file the reader would never be given.
  const wholeSet = parts + others.length;
  const rest = others.length === 0 ? "and nothing else" : "plus " + joinNames(others);
  const unlimited = slots <= UNLIMITED_SLOTS;
  const out: string[] = ["## Attaching this", ""];
  out.push(
    "Paste this file as text: instructions cost no attachment slot. Attach the files it names.",
    "",
    "- Every part opens with `# Codebase Snapshot Part NNN of MMM` and repeats the fingerprint",
    "  above, so check both before relying on one. A part you were not given is not an empty part."
  );
  if (unlimited) {
    out.push(
      "- No attachment limit is configured, so every file can travel: " + parts + " " +
        partWord(parts) + " " + rest + " (" + wholeSet + " files)."
    );
  } else if (wholeSet <= slots) {
    out.push(
      "- A " + slots + "-file destination carries the whole set: " + parts + " " +
        partWord(parts) + " " + rest + " - " + wholeSet + " of " + slots + "."
    );
  } else if (parts + 1 <= slots) {
    out.push(
      "- A " + slots + "-file destination carries " + parts + " " + partWord(parts) + " and",
      "  " + (others[0] ?? "one more file") + " (" + (parts + 1) + " of " + slots + "); " +
      (others.length > 1 ? joinNames(others.slice(1)) + " stay" : "the rest stays") +
      " behind - the brief above carries what they add."
    );
  } else if (parts <= slots) {
    out.push(
      parts === 1
        ? "- The only part fills a " + slots + "-file destination, so " + rest + " stay behind."
        : "- The " + parts + " parts fill a " + slots + "-file destination, so " + rest + " stay",
      "  behind. The brief above carries what they add."
    );
    if (parts > 1) {
      out.push(
        "  Either raise `--max-part-bytes` to merge the parts, or set",
        "  `--max-parts " + slots + "` and let the parts grow to the count instead."
      );
    }
  } else {
    out.push(
      "- The " + parts + " parts do not fit a " + slots + "-file destination: at most " + slots +
        " can be attached.",
      "  Choose by task - `reports/navigation.md` maps a file to its part - and name the parts",
      "  you left out, or regenerate with `--max-part-bytes " + suggestBudgetBytes(manifest, slots) +
        "` for about " + (slots - 1) + " parts. `--max-parts " + slots + "` grows the parts until",
      "  they fit instead, and says so when they end up larger than maxPartBytes."
    );
  }
  out.push(
    "- If you were given only some of them, say which parts are missing before you answer, and",
    "  name the files you needed. Do not infer the contents of a part you did not receive.",
    ""
  );
  return out;
}

/**
 * The part budget that would merge this run into `slots - 1` parts, rounded up.
 *
 * Not the linear total / target: parts are packed greedily with per-file anchors and headings, and
 * a part ends at the first file that does not fit, so the emitted bytes overshoot the payload. The
 * margin is measured rather than derived, and the number is a target, not a promise.
 */
function suggestBudgetBytes(manifest: Manifest, slots: number): string {
  const total = manifest.parts.reduce((sum, part) => sum + part.byteSize, 0);
  const target = Math.max(1, slots - 1);
  const estimated = Math.ceil((total / target) * 1.15);
  const rounded = Math.ceil(estimated / 16384) * 16384;
  const budget = Math.max(rounded, manifest.budgets.maxPartBytes);
  return Math.round(budget / 1024) + "k";
}
