import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Everything preset detection is allowed to look at.
 *
 * Built once per run: the previous implementation re-read `package.json` inside
 * every detector, which was both slow and incapable of seeing anything outside
 * the JavaScript ecosystem.
 *
 * Detection stays bounded: the root is read once, and a workspace root (and only
 * a workspace root) additionally looks one level into its packages so a Next.js
 * app in `apps/web` is still a Next.js repository — see {@link isWorkspace}.
 */
export interface PresetContext {
  cwd: string;
  /** Top-level file names, e.g. `next.config.ts`. */
  files: ReadonlySet<string>;
  /** Top-level directory names. */
  dirs: ReadonlySet<string>;
  /** `dependencies` + `devDependencies` + `peerDependencies` names, root and workspace. */
  dependencies: ReadonlySet<string>;
  /** Small snapshots of well-known manifests, for keyword detection. */
  manifests: Readonly<Record<string, string>>;
  /** True when the root declares a workspace (`pnpm-workspace.yaml`, `workspaces`, nx/turbo/lerna). */
  isWorkspace: boolean;
  /**
   * Top-level entry names of the workspace's packages, deduplicated.
   *
   * Flattened on purpose: a detector only needs "does some package carry a
   * `next.config.*`/`vite.config.*` marker", not which package it was.
   */
  workspaceFiles: ReadonlySet<string>;
  /**
   * `.md`/`.mdx` files at the root and up to two directories down.
   *
   * Only counted when the root has no `package.json` (the `docs` preset's other
   * condition), so ordinary repositories pay nothing for it.
   */
  markdownCount: number;
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

/**
 * Bounds for the workspace and markdown probes.
 *
 * Detection may look slightly past the repository root, never scan it: a
 * 200 000-file monorepo must still be classified from a few dozen directory
 * listings.
 */
const MAX_WORKSPACE_PACKAGES = 64;
const MAX_MARKDOWN_DIRS = 256;
const MAX_MARKDOWN_FILES = 4_000;
/** Roots that are workspaces but declare no globs still get the usual layouts. */
const DEFAULT_WORKSPACE_PATTERNS = ["apps/*", "packages/*", "libs/*"];

/** Directories that never hold workspace packages or documentation sources. */
const SKIPPED_WALK_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".svelte-kit",
  ".astro",
  ".angular",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
  ".eggs",
  "snapshot",
  "snapshot.tmp",
]);

function readSmallFile(fullPath: string): string | null {
  try {
    const stats = fs.statSync(fullPath);
    if (!stats.isFile() || stats.size > MANIFEST_MAX_BYTES) return null;
    return fs.readFileSync(fullPath, "utf8");
  } catch {
    return null;
  }
}

function readManifest(cwd: string, name: string): string | null {
  return readSmallFile(path.join(cwd, name));
}

/** Dependency names declared by one `package.json` body. */
function dependenciesFromPackageJson(raw: string): Set<string> {
  const names = new Set<string>();
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

function collectDependencies(manifests: Record<string, string>): Set<string> {
  const raw = manifests["package.json"];
  return raw === undefined ? new Set<string>() : dependenciesFromPackageJson(raw);
}

/** `workspaces` from `package.json`, in either the array or `{ packages }` form. */
function packageJsonWorkspacePatterns(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as { workspaces?: unknown };
    const workspaces = parsed.workspaces;
    if (Array.isArray(workspaces)) {
      return workspaces.filter((entry): entry is string => typeof entry === "string");
    }
    if (workspaces && typeof workspaces === "object") {
      const listed = (workspaces as { packages?: unknown }).packages;
      if (Array.isArray(listed)) {
        return listed.filter((entry): entry is string => typeof entry === "string");
      }
    }
  } catch {
    // Malformed JSON is reported by the config layer; detection falls through.
  }
  return [];
}

/**
 * Package globs from `pnpm-workspace.yaml`.
 *
 * Only the `packages:` block is read, and only its `- pattern` lines: a full
 * YAML parser is not worth a runtime dependency for this one list.
 */
function pnpmWorkspacePatterns(raw: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^packages\s*:/.test(trimmed)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (!trimmed.startsWith("-")) {
      // Any other top-level key ends the block.
      inPackages = false;
      continue;
    }
    const value = trimmed
      .replace(/^-\s*/, "")
      .replace(/\s+#.*$/, "")
      .replace(/^["']|["']$/g, "")
      .trim();
    if (value !== "" && !value.startsWith("!")) patterns.push(value);
  }
  return patterns;
}

/** Directory names listed directly under `parent`, bounded and filtered. */
function childDirectories(cwd: string, parent: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(cwd, parent), { withFileTypes: true });
  } catch {
    return [];
  }
  const children: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || SKIPPED_WALK_DIRS.has(entry.name)) continue;
    children.push(`${parent}/${entry.name}`);
  }
  return children;
}

/**
 * Workspace package directories implied by the declared globs.
 *
 * `apps/*` and `packages/**` list one level under their parent; a literal entry
 * such as `packages/core` is a package itself. Anything deeper is ignored on
 * purpose: the point is to find framework markers, not to map the workspace.
 */
function workspacePackageDirs(cwd: string, patterns: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    if (dirs.size >= MAX_WORKSPACE_PACKAGES) break;
    const cleaned = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (cleaned === "") continue;
    const star = cleaned.indexOf("*");
    if (star === -1) {
      dirs.add(cleaned);
      continue;
    }
    const parent = cleaned.slice(0, star).replace(/\/+$/, "");
    if (parent === "" || parent.includes("*")) continue;
    for (const child of childDirectories(cwd, parent)) {
      dirs.add(child);
      if (dirs.size >= MAX_WORKSPACE_PACKAGES) break;
    }
  }
  return Array.from(dirs).slice(0, MAX_WORKSPACE_PACKAGES);
}

interface WorkspaceView {
  files: Set<string>;
  dependencies: Set<string>;
}

/** Reads the bounded view of the workspace's packages. */
function scanWorkspacePackages(cwd: string, patterns: readonly string[]): WorkspaceView {
  const files = new Set<string>();
  const dependencies = new Set<string>();
  for (const relative of workspacePackageDirs(cwd, patterns)) {
    const full = path.join(cwd, relative);
    try {
      for (const entry of fs.readdirSync(full, { withFileTypes: true })) files.add(entry.name);
    } catch {
      // A package directory that disappeared between listing and reading is not
      // worth failing detection over.
    }
    const raw = readSmallFile(path.join(full, "package.json"));
    if (raw !== null) {
      for (const name of dependenciesFromPackageJson(raw)) dependencies.add(name);
    }
  }
  return { files, dependencies };
}

/**
 * Markdown files at the root and up to two directories down.
 *
 * Bounded by directory and file counts. `node_modules`, VCS metadata and build
 * output are skipped: a generated `README.md` in `dist/` is not documentation.
 */
function countMarkdownFiles(cwd: string): number {
  let count = 0;
  let directoriesSeen = 0;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  while (queue.length > 0 && directoriesSeen < MAX_MARKDOWN_DIRS && count < MAX_MARKDOWN_FILES) {
    const current = queue.shift();
    if (current === undefined) break;
    directoriesSeen += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        if (/\.mdx?$/i.test(entry.name)) count += 1;
        continue;
      }
      if (!entry.isDirectory() || current.depth >= 2) continue;
      if (entry.name.startsWith(".") || SKIPPED_WALK_DIRS.has(entry.name)) continue;
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return count;
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

  const rootDependencies = collectDependencies(manifests);
  const packageJson = manifests["package.json"];
  const declaredWorkspaces = packageJson === undefined ? [] : packageJsonWorkspacePatterns(packageJson);
  const isWorkspace =
    files.has("pnpm-workspace.yaml") ||
    files.has("nx.json") ||
    files.has("turbo.json") ||
    files.has("lerna.json") ||
    (packageJson !== undefined && packageJson.includes('"workspaces"')) ||
    declaredWorkspaces.length > 0;

  let workspace: WorkspaceView = { files: new Set<string>(), dependencies: new Set<string>() };
  if (isWorkspace) {
    const pnpmRaw = files.has("pnpm-workspace.yaml")
      ? readSmallFile(path.join(cwd, "pnpm-workspace.yaml"))
      : null;
    const declared = pnpmRaw === null ? [] : pnpmWorkspacePatterns(pnpmRaw);
    const patterns =
      declared.length > 0
        ? declared
        : declaredWorkspaces.length > 0
          ? declaredWorkspaces
          : DEFAULT_WORKSPACE_PATTERNS;
    workspace = scanWorkspacePackages(cwd, patterns);
  }

  return {
    cwd,
    files,
    dirs,
    dependencies: new Set([...rootDependencies, ...workspace.dependencies]),
    manifests,
    isWorkspace,
    workspaceFiles: workspace.files,
    // The `docs` preset requires "no package.json", so the walk is only useful
    // when the root has none; every other repository skips it entirely.
    markdownCount: files.has("package.json") ? 0 : countMarkdownFiles(cwd),
  };
}

export function hasFile(context: PresetContext, name: string): boolean {
  return context.files.has(name);
}

export function hasDir(context: PresetContext, name: string): boolean {
  return context.dirs.has(name);
}

/**
 * True when the root or a workspace package has a file starting with `prefix`,
 * e.g. `next.config` or `vite.config`.
 *
 * Only marker prefixes are asked for here, so the workspace view cannot confuse
 * a detector that is looking at the repository root itself.
 */
export function hasFileStartingWith(context: PresetContext, prefix: string): boolean {
  for (const file of context.files) {
    if (file.startsWith(prefix)) return true;
  }
  for (const file of context.workspaceFiles) {
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
