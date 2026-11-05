import type { PresetContext } from "./context.js";

/**
 * Detectors that answer with their evidence.
 *
 * A preset used to answer "does this look like me?" with a boolean, so the tool could
 * only ever report *what* it picked. The first-run wizard and `--autopilot` now report
 * *why* — `Because next.config.ts` — which means the match has to carry its reason.
 *
 * Each helper returns a short phrase, or null when the signal is absent. Detectors chain
 * them with `??`, so the first signal that fires is also the one that gets printed.
 */

/** The root file itself, e.g. `go.mod`. */
export function fileEvidence(context: PresetContext, name: string): string | null {
  return context.files.has(name) ? name : null;
}

/**
 * The first root or workspace file starting with `prefix`, e.g. `next.config.ts`.
 *
 * The real filename is returned rather than the prefix: it is the precise answer, and it
 * is the file a developer will open to check the tool's work.
 */
export function fileStartingWithEvidence(context: PresetContext, prefix: string): string | null {
  for (const file of context.files) {
    if (file.startsWith(prefix)) return file;
  }
  for (const file of context.workspaceFiles) {
    if (file.startsWith(prefix)) return file;
  }
  return null;
}

/** The first declared dependency that matched, phrased `depends on next`. */
export function dependencyEvidence(context: PresetContext, ...names: string[]): string | null {
  for (const name of names) {
    if (context.dependencies.has(name)) return `depends on ${name}`;
  }
  return null;
}

/** A needle found inside a manifest, e.g. `django in pyproject.toml`. */
export function manifestEvidence(
  context: PresetContext,
  manifest: string,
  needle: string
): string | null {
  const content = context.manifests[manifest];
  if (!content) return null;
  if (!content.toLowerCase().includes(needle.toLowerCase())) return null;
  return `${needle} in ${manifest}`;
}

/** The first root file ending with `suffix`, e.g. `main.tf`. */
export function suffixEvidence(context: PresetContext, suffix: string): string | null {
  for (const file of context.files) {
    if (file.endsWith(suffix)) return file;
  }
  return null;
}

/**
 * The documentation-shape signal, which is a count rather than a single file.
 *
 * Mirrors the `docs` preset's condition exactly: three or more Markdown files and no
 * `package.json` (a JavaScript repository that happens to keep a `docs/` folder is not a
 * documentation site).
 */
export function markdownEvidence(context: PresetContext): string | null {
  if (context.markdownCount < 3 || context.files.has("package.json")) return null;
  return `${context.markdownCount} markdown files, no package.json`;
}
