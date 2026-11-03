import { summarizeTypeScriptSource } from "../ts-parser.js";
import type { LanguageProfile } from "./shared.js";
import { emptySummary, finalizeSummary } from "./shared.js";

const SCRIPT_BLOCK = /<script[^>]*>([\s\S]*?)<\/script>/gi;

function componentName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

/**
 * Vue, Svelte and Astro single-file components.
 *
 * The template is markup, but the `<script>` block is ordinary TypeScript — so
 * it is handed to the real compiler rather than pattern-matched. That makes the
 * summary `ast` quality whenever a script block exists, which is the common case.
 */
export const sfcProfile: LanguageProfile = {
  id: "sfc",
  extensions: [".vue", ".svelte", ".astro"],
  summarize(path, content) {
    let script = "";
    for (const match of content.matchAll(SCRIPT_BLOCK)) {
      script += `${match[1]}\n`;
    }

    const name = componentName(path);

    if (!script.trim()) {
      // A template-only component still deserves an entry in the index.
      const summary = emptySummary();
      if (name) {
        summary.exports.push(name);
        summary.reactComponents.push(name);
      }
      return { summary: finalizeSummary(summary), quality: "heuristic" };
    }

    const summary = summarizeTypeScriptSource(`${name}.ts`, script);
    summary.reactComponents.push(name);
    summary.exports.push(name);
    return { summary, quality: "ast" };
  },
};
