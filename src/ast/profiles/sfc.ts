import { summarizeTypeScriptSource } from "../ts-parser.js";
import type { LanguageProfile } from "./shared.js";
import { emptySummary, finalizeSummary } from "./shared.js";

const SCRIPT_BLOCK = /<script[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * The `---` fence at the top of an Astro component.
 *
 * In Astro this fence *is* the component's script: it is where imports, props and
 * all the TypeScript live. Most real `.astro` files have no `<script>` tag at all,
 * so parsing only `<script>` blocks made the common case fall back to `heuristic`.
 */
const ASTRO_FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/;

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

    // Astro keeps its script in a leading `---` fence rather than a <script> tag.
    if (path.toLowerCase().endsWith(".astro")) {
      const frontmatter = ASTRO_FRONTMATTER.exec(content);
      if (frontmatter) script += `${frontmatter[1]}\n`;
    }

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
    // `summarizeTypeScriptSource` already sorted and de-duplicated its lists, and the
    // component name is pushed afterwards — so a component whose script also exported
    // its own name (the normal `<script setup>` shape) was listed twice, and the index
    // that consumers search was not in the order it claims. `finalizeSummary` restores
    // both invariants after the push.
    summary.reactComponents.push(name);
    summary.exports.push(name);
    return { summary: finalizeSummary(summary), quality: "ast" };
  },
};
