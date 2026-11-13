import * as fs from "node:fs";
import * as path from "node:path";

export interface GitignoreUpdate {
  /** The entries this call appended, in the order written. */
  added: string[];
  /** One sentence for the user when the file could not be updated; otherwise null. */
  note: string | null;
}

/** A `.gitignore` decoded together with what is needed to write it back unchanged. */
interface DecodedGitignore {
  text: string;
  /** The byte-order mark this file started with, if any. */
  bom: Buffer;
  encoding: "utf8" | "utf16le" | "utf16be";
}

/**
 * Decodes a `.gitignore` by its byte-order mark, or `null` when it is not text this tool can
 * rewrite safely.
 *
 * Reading every file as UTF-8 was the bug: a UTF-16LE `.gitignore` — common on Windows — decodes
 * to text with interleaved NULs, and appending to that string and writing it back turned the
 * user's ignore rules into binary noise. The round-trip is verified against the original bytes,
 * so a file with invalid UTF-8 is refused rather than silently rewritten in a lossy encoding.
 */
function decodeGitignore(buffer: Buffer): DecodedGitignore | null {
  const startsWith = (...bytes: number[]): boolean =>
    buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);

  if (startsWith(0xef, 0xbb, 0xbf)) {
    const body = buffer.subarray(3);
    const text = body.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(body)) return null;
    return { text, bom: buffer.subarray(0, 3), encoding: "utf8" };
  }
  if (startsWith(0xff, 0xfe)) {
    const body = buffer.subarray(2);
    if (body.length % 2 !== 0) return null;
    const text = body.toString("utf16le");
    if (!Buffer.from(text, "utf16le").equals(body)) return null;
    return { text, bom: buffer.subarray(0, 2), encoding: "utf16le" };
  }
  if (startsWith(0xfe, 0xff)) {
    const body = buffer.subarray(2);
    if (body.length % 2 !== 0) return null;
    const swapped = Buffer.from(body);
    swapped.swap16();
    const text = swapped.toString("utf16le");
    if (!Buffer.from(text, "utf16le").equals(swapped)) return null;
    return { text, bom: buffer.subarray(0, 2), encoding: "utf16be" };
  }

  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) return null;
  return { text, bom: Buffer.alloc(0), encoding: "utf8" };
}

/** Encodes a `.gitignore` back in the encoding it was read in, byte-order mark included. */
function encodeGitignore(decoded: DecodedGitignore, text: string): Buffer {
  if (decoded.encoding === "utf8") {
    return Buffer.concat([decoded.bom, Buffer.from(text, "utf8")]);
  }
  const littleEndian = Buffer.from(text, "utf16le");
  if (decoded.encoding === "utf16le") return Buffer.concat([decoded.bom, littleEndian]);
  const bigEndian = Buffer.from(littleEndian);
  bigEndian.swap16();
  return Buffer.concat([decoded.bom, bigEndian]);
}

/**
 * What a pattern means, ignoring the spelling git treats as equivalent.
 *
 * Dedupe used to compare trimmed lines exactly, so `snapshot`, `/snapshot/` and `snapshot/` were
 * three entries and every `init` appended a fourth. A leading slash anchors a pattern and a
 * trailing one marks a directory; neither changes whether the same rule is already present.
 */
function canonicalIgnorePattern(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return trimmed;
  const negated = trimmed.startsWith("!");
  const body = (negated ? trimmed.slice(1) : trimmed).replace(/^\/+/, "").replace(/\/+$/, "");
  return `${negated ? "!" : ""}${body}`;
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

  let decoded: DecodedGitignore = { text: "", bom: Buffer.alloc(0), encoding: "utf8" };
  try {
    if (fs.existsSync(ignorePath)) {
      if (fs.statSync(ignorePath).isDirectory()) {
        return { added: [], note: `${ignorePath} is a directory, so it was not updated. ${manual}` };
      }
      const read = decodeGitignore(fs.readFileSync(ignorePath));
      if (read === null) {
        return {
          added: [],
          note:
            `${ignorePath} is not valid UTF-8, UTF-16LE or UTF-16BE text, so it was not updated. ` +
            manual,
        };
      }
      decoded = read;
    }
  } catch (err) {
    return {
      added: [],
      note: `${ignorePath} could not be read (${(err as Error).message}). ${manual}`,
    };
  }

  const existing = decoded.text;
  const present = new Set(existing.split(/\r?\n/).map(canonicalIgnorePattern));
  const added = wanted.filter((entry) => !present.has(canonicalIgnorePattern(entry)));
  if (added.length === 0) return { added: [], note: null };

  // Match the file's own line endings, so a CRLF `.gitignore` does not end up with one LF line.
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : newline;
  try {
    fs.writeFileSync(
      ignorePath,
      encodeGitignore(decoded, `${existing}${prefix}${added.join(newline)}${newline}`)
    );
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
