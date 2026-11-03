import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Everything preset detection is allowed to look at.
 *
 * Built once per run: the previous implementation re-read `package.json` inside
 * every detector, which was both slow and incapable of seeing anything outside
 * the JavaScript ecosystem.
 */
export interface PresetContext {
  cwd: string;
  /** Top-level file names, e.g. `next.config.ts`. */
  files: ReadonlySet<string>;
  /** Top-level directory names. */
  dirs: ReadonlySet<string>;
  /** `dependencies` + `devDependencies` + `peerDependencies` names. */
  dependencies: ReadonlySet<string>;
  /** Small snapshots of well-known manifests, for keyword detection. */
  manifests: Readonly<Record<string, string>>;
}

/** Manifests small enough to read whole, and useful for keyword checks. */
const MANIFEST_FILES = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
];

const MANIFEST_MAX_BYTES = 100_000;

function readManifest(cwd: string, name: string): string | null {
  const full = path.join(cwd, name);
  try {
    const stats = fs.statSync(full);
    if (!stats.isFile() || stats.size > MANIFEST_MAX_BYTES) return null;
    return fs.readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

function collectDependencies(manifests: Record<string, string>): Set<string> {
  const names = new Set<string>();
  const raw = manifests["package.json"];
  if (!raw) return names;

  try {
    const parsed = JSON.parse(raw) as Record<string, Record<string, string> | undefined>;
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const block = parsed[section];
      if (block && typeof block === "object") {
        for (const name of Object.keys(block)) names.add(name);
      }
    }
  } catch {
    // A malformed package.json is not fatal: detection simply falls through to
    // presets that do not need it.
  }
  return names;
}

/** Reads the repository once and hands every detector the same view. */
export function buildPresetContext(cwd: string): PresetContext {
  const files = new Set<string>();
  const dirs = new Set<string>();

  try {
    for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.add(entry.name);
      else if (entry.isFile()) files.add(entry.name);
    }
  } catch {
    // An unreadable directory yields an empty context and the `generic` preset.
  }

  const manifests: Record<string, string> = {};
  for (const name of MANIFEST_FILES) {
    const content = readManifest(cwd, name);
    if (content !== null) manifests[name] = content;
  }

  return {
    cwd,
    files,
    dirs,
    dependencies: collectDependencies(manifests),
    manifests,
  };
}

export function hasFile(context: PresetContext, name: string): boolean {
  return context.files.has(name);
}

export function hasDir(context: PresetContext, name: string): boolean {
  return context.dirs.has(name);
}

/** True when any top-level file starts with `prefix`, e.g. `next.config`. */
export function hasFileStartingWith(context: PresetContext, prefix: string): boolean {
  for (const file of context.files) {
    if (file.startsWith(prefix)) return true;
  }
  return false;
}

/** True when a manifest exists and contains `needle`, case-insensitively. */
export function manifestContains(context: PresetContext, manifest: string, needle: string): boolean {
  const content = context.manifests[manifest];
  if (!content) return false;
  return content.toLowerCase().includes(needle.toLowerCase());
}

/** `hasDependency(context, "next", "nuxt")` — true when any name is present. */
export function hasDependency(context: PresetContext, ...names: string[]): boolean {
  return names.some((name) => context.dependencies.has(name));
}
