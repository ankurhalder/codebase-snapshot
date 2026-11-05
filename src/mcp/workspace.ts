/**
 * How a tool addresses a repository: which root it may touch, what configuration applies, and
 * what the last snapshot on disk says.
 *
 * Three rules from the CLI are enforced here rather than re-implemented per tool, because a
 * second copy of them is how the two surfaces drift apart:
 *
 *  - **A config that exists but cannot be read is fatal.** Falling back to defaults would produce
 *    a snapshot with none of the developer's settings and still report success — the same failure
 *    the CLI refuses.
 *  - **`root` is confined.** An MCP server is reachable from any prompt in the client, so a
 *    tool argument must not be able to widen what the process will read. Symlinks are resolved
 *    before the check, so a link inside the repository cannot point the server at `~`.
 *  - **The manifest cache is keyed on what makes a manifest different.** Path alone would serve a
 *    stale manifest after a regenerate; mtime and size are what actually change.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfigFileDetailed, parseByteSize, resolveConfig } from "../config.js";
import { describeManifestShapeProblem } from "../validator/validate.js";
import type { Manifest, ResolvedSnapshotConfig } from "../types.js";
import type { ToolContext } from "./types.js";

export interface Workspace {
  /** Absolute, symlink-resolved repository root. */
  root: string;
  config: ResolvedSnapshotConfig;
  /** Absolute path of the config file that was loaded, when there was one. */
  configFile: string | null;
}

export type RootOutcome = { ok: true; root: string } | { ok: false; message: string };

/** Case-folded comparison on the filesystems that are case-insensitive by default. */
function foldForComparison(value: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
}

/** Resolves symlinks when possible and falls back to the absolute path when the target is new. */
function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function isInside(parent: string, child: string): boolean {
  const foldedParent = foldForComparison(parent);
  const foldedChild = foldForComparison(child);
  return foldedChild === foldedParent || foldedChild.startsWith(`${foldedParent}${path.sep}`);
}

/**
 * Resolves the `root` argument against the directories this server may read.
 *
 * The default is the directory the server was started for, so a client that passes nothing gets
 * the project it launched from. An explicit root is accepted only when it resolves inside the
 * configured roots; an absolute path elsewhere is refused with the same message a relative one
 * would get, because the answer is about where the process may read, not how it was written.
 */
export function resolveRoot(requested: unknown, context: ToolContext): RootOutcome {
  if (requested !== undefined && (typeof requested !== "string" || requested.trim().length === 0)) {
    return { ok: false, message: '"root" must be a non-empty string when provided.' };
  }
  const wanted = typeof requested === "string" ? requested.trim() : context.cwd;
  const absolute = path.resolve(context.cwd, wanted);

  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    return { ok: false, message: `"${wanted}" does not exist, so it cannot be a repository root.` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, message: `"${wanted}" is not a directory.` };
  }

  const resolved = canonicalPath(absolute);
  for (const allowed of context.roots) {
    if (isInside(canonicalPath(allowed), resolved)) return { ok: true, root: resolved };
  }
  const shown = context.roots.join(", ");
  return {
    ok: false,
    message:
      `"${wanted}" resolves outside the directories this server may read (${shown}). ` +
      "Restart it with --root <path> to add a repository.",
  };
}

export type WorkspaceOutcome = { ok: true; workspace: Workspace } | { ok: false; message: string };

/** Overrides a caller may apply. Deliberately narrow: these are the knobs `generate` accepts. */
export interface WorkspaceOverrides {
  maxPartBytes?: unknown;
  outDir?: unknown;
}

/**
 * Loads the configuration for a root and resolves it exactly as the CLI does.
 *
 * `includeSensitiveFiles` is not in {@link WorkspaceOverrides} and must not become one: a prompt
 * can ask for anything, and a tool that emits `.env` on request is a secret-exfiltration primitive
 * with a friendly name.
 */
export async function openWorkspace(
  root: string,
  overrides: WorkspaceOverrides = {}
): Promise<WorkspaceOutcome> {
  const loaded = await loadConfigFileDetailed(root);
  if (loaded.errors.length > 0) {
    return {
      ok: false,
      message:
        `The config file could not be read: ${loaded.errors.join("; ")} ` +
        "Fix it, or delete it to use the defaults — this server will not silently ignore it.",
    };
  }

  const cliOptions: { cwd: string; maxPartBytes?: number; outDir?: string } = { cwd: root };

  if (overrides.maxPartBytes !== undefined) {
    const parsed = parseByteSize(overrides.maxPartBytes as number | string);
    if (parsed === undefined) {
      return {
        ok: false,
        message: '"maxPartBytes" must be a byte count, for example 307200 or "300k".',
      };
    }
    cliOptions.maxPartBytes = parsed;
  }
  if (overrides.outDir !== undefined) {
    if (typeof overrides.outDir !== "string" || overrides.outDir.trim().length === 0) {
      return { ok: false, message: '"outDir" must be a non-empty string.' };
    }
    cliOptions.outDir = overrides.outDir.trim();
  }

  try {
    const config = resolveConfig(loaded.config, cliOptions, root);
    return { ok: true, workspace: { root, config, configFile: loaded.file } };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  manifest: Manifest;
}

/** One process serves one repository; the cache is small and never evicts. */
const manifestCache = new Map<string, CacheEntry>();

export type ManifestOutcome =
  | { ok: true; manifest: Manifest; file: string }
  | { ok: false; message: string; missing: boolean };

/** Absolute path of the manifest a workspace would have. */
export function manifestPathFor(workspace: Workspace): string {
  return path.resolve(workspace.root, workspace.config.outDir, "manifest.json");
}

/** Reads and shape-checks the manifest, reusing the cache when mtime and size are unchanged. */
export function readManifest(workspace: Workspace): ManifestOutcome {
  const file = manifestPathFor(workspace);
  const shown = path.relative(workspace.root, file).split(path.sep).join("/") || file;

  let stats: fs.Stats;
  try {
    stats = fs.statSync(file);
  } catch {
    return {
      ok: false,
      missing: true,
      message:
        `There is no snapshot manifest at ${shown}. ` +
        "Call snapshot_plan to preview what would be included, or snapshot_generate to write it.",
    };
  }

  const cached = manifestCache.get(file);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return { ok: true, manifest: cached.manifest, file };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return {
      ok: false,
      missing: false,
      message: `${shown} exists but could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, missing: false, message: `${shown} is not valid JSON.` };
  }

  const problem = describeManifestShapeProblem(parsed);
  if (problem) {
    return { ok: false, missing: false, message: `${shown} is not a snapshot manifest: ${problem}` };
  }

  const manifest = parsed as Manifest;
  manifestCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, manifest });
  return { ok: true, manifest, file };
}

/** Drops a cache entry, used after a tool has just written a new manifest. */
export function forgetManifest(file: string): void {
  manifestCache.delete(file);
}
