import * as fs from "node:fs";
import * as path from "node:path";

export interface GitignoreUpdate {
  /** The entries this call appended, in the order written. */
  added: string[];
  /** One sentence for the user when the file could not be updated; otherwise null. */
  note: string | null;
}

/**
 * Appends entries to the repository's `.gitignore`, and never fails a command over it.
 *
 * Two commands write files that a repository should not track — `init` (the snapshot and
 * scratch directories) and `skill --install` (the agent skill) — and both need the same three
 * properties: an entry is appended at most once even in a CRLF file, nothing is thrown, and a
 * failure says exactly what to add by hand.
 *
 * A `.gitignore` that is a *directory* used to raise a raw `EISDIR` from the read, which aborted
 * `init` after the config had already been written; the update is a convenience, so it is a note
 * now and the command finishes what it promised.
 */
export function appendGitignoreEntries(
  cwd: string,
  entries: readonly string[]
): GitignoreUpdate {
  const wanted = [...new Set(entries)].filter((entry) => entry.trim().length > 0);
  if (wanted.length === 0) return { added: [], note: null };

  const ignorePath = path.join(cwd, ".gitignore");
  const manual = `Add ${wanted.map((entry) => `"${entry}"`).join(" and ")} to your .gitignore yourself.`;

  let existing = "";
  try {
    if (fs.existsSync(ignorePath)) {
      if (fs.statSync(ignorePath).isDirectory()) {
        return { added: [], note: `${ignorePath} is a directory, so it was not updated. ${manual}` };
      }
      existing = fs.readFileSync(ignorePath, "utf8");
    }
  } catch (err) {
    return {
      added: [],
      note: `${ignorePath} could not be read (${(err as Error).message}). ${manual}`,
    };
  }

  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const added = wanted.filter((entry) => !present.has(entry));
  if (added.length === 0) return { added: [], note: null };

  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  try {
    fs.writeFileSync(ignorePath, `${existing}${prefix}${added.join("\n")}\n`, "utf8");
  } catch (err) {
    return { added: [], note: `${(err as Error).message}. ${manual}` };
  }
  return { added, note: null };
}

/**
 * A path as `.gitignore` spells it: forward slashes, relative to the repository root.
 *
 * `.gitignore` matching is slash-based on every platform, so a Windows install must not write
 * `.claude\skills\…\SKILL.md` — git would read the backslashes as escapes.
 */
export function gitignorePath(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath).split(path.sep).join("/");
}
