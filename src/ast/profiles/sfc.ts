import { summarizeTypeScriptSource } from "../ts-parser.js";
import type { LanguageProfile } from "./shared.js";
import { emptySummary, finalizeSummary } from "./shared.js";

const SCRIPT_BLOCK = /<script([^>]*)>([\s\S]*?)<\/script>/gi;

/** `lang="tsx"` / `lang='jsx'`: the block holds JSX, whatever the component's extension says. */
const JSX_LANG = /\blang\s*=\s*["']?[tj]sx\b/i;

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
    // Which script kind the block is parsed as. A `.ts` kind reads `<div>hi</div>` as a type
    // assertion and then reports four to six parse errors for a file that is perfectly valid —
    // and never records the component, because it finds no JSX. Astro frontmatter is JSX-capable
    // by construction, and a Vue or Svelte block says so with `lang="tsx"` / `lang="jsx"`.
    let usesJsx = path.toLowerCase().endsWith(".astro");

    // Astro keeps its script in a leading `---` fence rather than a <script> tag.
    if (path.toLowerCase().endsWith(".astro")) {
      const frontmatter = ASTRO_FRONTMATTER.exec(content);
      if (frontmatter) script += `${frontmatter[1]}\n`;
    }

    for (const match of content.matchAll(SCRIPT_BLOCK)) {
      if (JSX_LANG.test(match[1] ?? "")) usesJsx = true;
      script += `${match[2]}\n`;
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

    const summary = summarizeTypeScriptSource(`${name}.${usesJsx ? "tsx" : "ts"}`, script);
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
