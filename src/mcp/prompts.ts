/**
 * Seven prompts: the two about order of operations (orient, keep-current) and five that turn the
 * tools into a job (audit, review, explain, onboard, security-review).
 *
 * Prompts are user-invoked, so they must be worth a keystroke: `orient` replaces the blank-page
 * turn where an agent starts guessing at file paths, and `keep-current` exists because "is this
 * still true" is the question this project exists to make answerable.
 */
import type { JsonObject } from "./protocol.js";
import type { McpPrompt } from "./types.js";

const AUDIT = `Audit this repository without changing it. Produce evidence, not impressions.

1. Call snapshot_health. Report the score, every failed check, and every warning with the artifact it names.
2. Call snapshot_validate. If it reports drift, say so and stop: an audit of a stale snapshot is an audit of nothing.
3. Call snapshot_query with layer "config" and read the files it returns with snapshot_read, one window at a time.
4. Call snapshot_explain for every path you expected to find and did not; the answer says whether it was ignored, sensitive or binary.
5. Report: what the snapshot covers, what it cannot see, and the three findings that would matter most to whoever receives this context. Cite paths and parts. Do not edit any file.`;

const REVIEW = `Review a change against the context you were given.

1. Call snapshot_validate first. If the snapshot is stale, call snapshot_generate once, then validate again.
2. Call snapshot_plan_for with the change description as the question. Read the plan in order with snapshot_read; do not read a part end to end.
3. For every file you intend to discuss, call snapshot_dependents and name what imports it. A change is a change to its dependents.
4. Report: what the change does, the files it touches, the call sites that must change with it, and the risks you can prove from the code. Mark anything you inferred rather than read.
5. Cite paths with their part. If the snapshot does not contain a file you need, say which one and why rather than guessing at its contents.`;

const EXPLAIN = `Explain one path from the snapshot.

1. Call snapshot_explain for the path. Report the inclusion mode and, when it is absent, the recorded reason.
2. If it is included, call snapshot_locate and snapshot_dependents, then snapshot_read the windows that matter.
3. Describe what the file does, who depends on it, and the two or three things a new reader would get wrong about it.
4. Quote only what the snapshot contains. If a region was omitted, say which lines and why.`;

const ONBOARD = `Produce a guided tour of this repository for a new contributor.

1. Call snapshot_status. If there is no snapshot, snapshot_generate first.
2. Call snapshot_plan_for with "entry points, request flow, and the files a new contributor must read" and a budget of 20000 tokens.
3. Walk the plan in order with snapshot_read. For each file, one sentence on why it is on the tour.
4. Call snapshot_query for layer "test" and name the tests that show how the project is exercised.
5. Finish with: the five files to read first (in order), the command to run the tests, and the one thing that will surprise them. Cite paths with their part.`;

const SECURITY = `Review this repository for security problems, using the snapshot as the evidence.

1. Call snapshot_health. A failed secrets check is the first finding, and it is critical. Do not repeat the secret value.
2. Call snapshot_query for config, auth and route files. Read the ones that decide who may do what.
3. Look for: authentication and authorization checks, secrets in code, unsafe deserialization, path traversal, shell invocation with interpolated input, and dependencies that are fetched at runtime.
4. Report each finding as: severity, the path and part, the code you read, why it is a problem, and the smallest fix. Separate what the snapshot proves from what it cannot see (secrets excluded from the snapshot, generated code, runtime configuration).
5. Do not modify files. If the snapshot excluded something relevant, call snapshot_explain and say what is missing.`;

const ORIENT = `You have a codebase-snapshot server for this repository. Build a map of it before reading any code.

1. Call snapshot_status. If no snapshot exists, call snapshot_plan to preview it, then snapshot_generate.
2. Call snapshot_locate for the areas that matter. Search by exported symbol, route or path fragment rather than guessing filenames.
3. Report back: the layers present, the entry points, and the files that matter here — cited as paths with their part.
4. Read one file at a time with snapshot_read, one window at a time. Do not read a part end to end.`;

const KEEP_CURRENT = `Keep the context you were given provably current while you work.

1. Before relying on a snapshot from an earlier session, call snapshot_validate.
2. If it reports drift, call snapshot_generate once, then snapshot_validate again.
3. After changes you make, call snapshot_validate and report what it said.
4. Never call a snapshot current unless snapshot_validate said so in this session.`;

function withFocus(base: string, focus: unknown): string {
  return typeof focus === "string" && focus.trim().length > 0
    ? `${base}\n\nFocus for this pass: ${focus.trim()}`
    : base;
}

const PROMPTS: McpPrompt[] = [
  {
    name: "orient",
    title: "Orient in this repository",
    description: "Map the repository from the snapshot before reading any of it.",
    arguments: [{ name: "focus", description: "Optional area to concentrate on.", required: false }],
    build(args: JsonObject) {
      return {
        description: "Map the repository before reading it.",
        messages: [{ role: "user", content: { type: "text", text: withFocus(ORIENT, args.focus) } }],
      };
    },
  },
  {
    name: "keep-current",
    title: "Keep the snapshot current",
    description: "Validate before trusting earlier context, and again after making changes.",
    arguments: [],
    build() {
      return {
        description: "Keep the context current.",
        messages: [{ role: "user", content: { type: "text", text: KEEP_CURRENT } }],
      };
    },
  },
  {
    name: "audit",
    title: "Audit the snapshot and the repository",
    description: "Evidence first: health, drift, the files that were excluded, and the findings that matter.",
    arguments: [{ name: "focus", description: "Optional area to concentrate on.", required: false }],
    build(args: JsonObject) {
      return {
        description: "Audit with evidence.",
        messages: [{ role: "user", content: { type: "text", text: withFocus(AUDIT, args.focus) } }],
      };
    },
  },
  {
    name: "review",
    title: "Review a change",
    description: "Plan the reading for a change, read it, and name the dependents and risks.",
    arguments: [{ name: "change", description: "What changed, or the branch to review.", required: true }],
    build(args: JsonObject) {
      const change = typeof args.change === "string" ? args.change.trim() : "";
      return {
        description: "Review a change.",
        messages: [
          { role: "user", content: { type: "text", text: REVIEW + (change === "" ? "" : "\n\nThe change: " + change) } },
        ],
      };
    },
  },
  {
    name: "explain",
    title: "Explain one path",
    description: "Why a file is in the snapshot, what it does, and who depends on it.",
    arguments: [{ name: "path", description: "Path relative to the repository root.", required: true }],
    build(args: JsonObject) {
      const target = typeof args.path === "string" ? args.path.trim() : "";
      return {
        description: "Explain a path.",
        messages: [
          { role: "user", content: { type: "text", text: EXPLAIN + (target === "" ? "" : "\n\nThe path: " + target) } },
        ],
      };
    },
  },
  {
    name: "onboard",
    title: "Guided tour for a new contributor",
    description: "A reading order for someone who has never seen this repository.",
    arguments: [],
    build() {
      return { description: "Onboard a new contributor.", messages: [{ role: "user", content: { type: "text", text: ONBOARD } }] };
    },
  },
  {
    name: "security-review",
    title: "Security review",
    description: "Authentication, authorization, secrets and injection, with what the snapshot cannot see.",
    arguments: [],
    build() {
      return { description: "Security review.", messages: [{ role: "user", content: { type: "text", text: SECURITY } }] };
    },
  },
];

export function buildPrompts(): McpPrompt[] {
  return PROMPTS;
}
