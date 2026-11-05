/**
 * Two prompts, both about order of operations rather than features.
 *
 * Prompts are user-invoked, so they must be worth a keystroke: `orient` replaces the blank-page
 * turn where an agent starts guessing at file paths, and `keep-current` exists because "is this
 * still true" is the question this project exists to make answerable.
 */
import type { JsonObject } from "./protocol.js";
import type { McpPrompt } from "./types.js";

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

export function buildPrompts(): McpPrompt[] {
  return [
    {
      name: "orient",
      title: "Orient in this repository",
      description: "Map the repository from the snapshot before reading any of it.",
      arguments: [
        {
          name: "focus",
          description: "Optional area to concentrate on, for example \"authentication\".",
          required: false,
        },
      ],
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
  ];
}
