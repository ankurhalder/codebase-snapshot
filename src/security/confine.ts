import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Reads a snapshot file without following the path out of its snapshot directory.
 *
 * The part reader has always refused a symlink named like a part because a read-only MCP resource
 * is auto-approved by clients. The same rule has to cover the other files a snapshot exposes —
 * PROMPT.md, reports/*, manifest.json, WORKSPACE.json — or the guard protects one door and leaves
 * the rest open. A configured outDir may intentionally live outside the repository (the MCP
 * contract documents that), so confinement is to the snapshot directory, not to the repository.
 */
export type ConfinedReadFailureReason = "missing" | "outside" | "not-file" | "unreadable";

export type ConfinedReadResult =
  | {
      ok: true;
      text: string;
      /** Canonical path that was read. */
      path: string;
      stats: fs.Stats;
    }
  | {
      ok: false;
      reason: ConfinedReadFailureReason;
      message: string;
    };

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Reads one regular file under `baseDir`.
 *
 * The final component must be a regular file, not a symlink. A parent symlink is allowed only
 * when the canonical target still resolves under the canonical base. This is deliberately
 * stricter than realpath-then-contains: a snapshot this tool wrote never contains a file symlink,
 * and accepting one would make the check depend on where the link happened to point.
 */
export function readConfinedText(baseDir: string, relativePath: string): ConfinedReadResult {
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

  try {
    const text = fs.readFileSync(real, "utf8");
    return { ok: true, text, path: real, stats: fs.statSync(real) };
  } catch {
    return { ok: false, reason: "unreadable", message: "the file could not be read" };
  }
}
