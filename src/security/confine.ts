import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Reads a snapshot file without following the path out of its snapshot directory.
 *
 * The part reader has always refused a symlink named like a part because a read-only MCP resource
 * is auto-approved by clients. The same rule has to cover every other file a snapshot exposes:
 * PROMPT.md, reports, manifest.json, WORKSPACE.json, parts and declared artifacts. A configured
 * outDir may intentionally live outside the repository (the MCP contract documents that), so
 * confinement is to the snapshot directory, not to the repository.
 */
export type ConfinedReadFailureReason = "missing" | "outside" | "not-file" | "unreadable";

export interface ConfinedFailure {
  ok: false;
  reason: ConfinedReadFailureReason;
  message: string;
}

export type ConfinedTextResult =
  | {
      ok: true;
      text: string;
      /** Canonical path that was read. */
      path: string;
      stats: fs.Stats;
    }
  | ConfinedFailure;

export type ConfinedBytesResult =
  | {
      ok: true;
      bytes: Buffer;
      path: string;
      stats: fs.Stats;
    }
  | ConfinedFailure;

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolves a regular file under `baseDir`, refusing a symlink in the final component. */
function resolveConfined(
  baseDir: string,
  relativePath: string
):
  | { ok: true; path: string; stats: fs.Stats }
  | ConfinedFailure {
  if (relativePath.length === 0 || relativePath.includes("\0")) {
    return { ok: false, reason: "not-file", message: "the file name is empty or contains a NUL byte" };
  }
  if (path.isAbsolute(relativePath)) {
    return { ok: false, reason: "outside", message: "an absolute path is not a snapshot-relative file" };
  }

  let baseReal: string;
  try {
    baseReal = fs.realpathSync(path.resolve(baseDir));
  } catch {
    return { ok: false, reason: "missing", message: "the snapshot directory does not exist" };
  }

  const candidate = path.resolve(baseReal, relativePath);
  if (!isInside(baseReal, candidate)) {
    return { ok: false, reason: "outside", message: "the path resolves outside the snapshot directory" };
  }

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable",
      message: code === "ENOENT" || code === "ENOTDIR"
        ? "the file does not exist"
        : "the file could not be inspected",
    };
  }
  if (stats.isSymbolicLink()) {
    return { ok: false, reason: "not-file", message: "the file is a symbolic link" };
  }
  if (!stats.isFile()) {
    return { ok: false, reason: "not-file", message: "the path is not a regular file" };
  }

  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { ok: false, reason: "unreadable", message: "the file could not be resolved" };
  }
  if (!isInside(baseReal, real)) {
    return { ok: false, reason: "outside", message: "the file resolves outside the snapshot directory" };
  }
  return { ok: true, path: real, stats };
}

/** Reads a confined file as bytes; used where the caller must hash the exact source bytes. */
export function readConfinedBytes(baseDir: string, relativePath: string): ConfinedBytesResult {
  const resolved = resolveConfined(baseDir, relativePath);
  if (!resolved.ok) return resolved;
  try {
    const bytes = fs.readFileSync(resolved.path);
    return { ok: true, bytes, path: resolved.path, stats: fs.statSync(resolved.path) };
  } catch {
    return { ok: false, reason: "unreadable", message: "the file could not be read" };
  }
}

/** Reads a confined file as UTF-8 text. */
export function readConfinedText(baseDir: string, relativePath: string): ConfinedTextResult {
  const resolved = resolveConfined(baseDir, relativePath);
  if (!resolved.ok) return resolved;
  try {
    const text = fs.readFileSync(resolved.path, "utf8");
    return { ok: true, text, path: resolved.path, stats: fs.statSync(resolved.path) };
  } catch {
    return { ok: false, reason: "unreadable", message: "the file could not be read" };
  }
}
