/**
 * The import specifiers one file declares, read exactly the way `generate` reads them.
 *
 * `--with-dependents` is decided from the generated summaries, so anything that has to answer the
 * same question later — `explain`, `validate` — must parse the file the same way. A second,
 * simpler "find the import lines" implementation is how two accounts of one import graph begin:
 * it would disagree on `require`, on `${…}` in a dynamic import, on a file the parser rejected,
 * and the disagreement would surface as a snapshot that is "drifted" or an explanation that is
 * wrong, neither of which points at the real cause.
 *
 * The size ceiling is part of that agreement. `generateSnapshot` refuses to build a structural
 * summary for a body over {@link SUMMARY_MAX_SOURCE_BYTES} — the TypeScript parser's AST costs far
 * more memory than the file — and this module used to have no ceiling at all, so `validate` and
 * `explain` read and parsed files the generator had skipped. Whichever way the rule goes, all
 * three commands have to answer it the same way; they answer it by sharing this constant.
 */
import * as fs from "node:fs";

import { summarizeTypeScriptSource } from "./ts-parser.js";
import { summarizeWithProfile } from "./profiles/index.js";
import { decodeText } from "../scanner/binary.js";

/**
 * The largest body that gets a structural summary.
 *
 * Exported because it is a documented boundary, not an implementation detail: a file above it has
 * no summary, and therefore no imports, in every command.
 */
export const SUMMARY_MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** Extensions the generator hands to the TypeScript summarizer. */
const TS_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const isTsSource = (relativePath: string): boolean => {
  const lower = relativePath.toLowerCase();
  return TS_SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

/** Import specifiers from text already decoded, or `[]` when the language has no importer. */
export function importsOfText(relativePath: string, text: string): string[] {
  if (Buffer.byteLength(text, "utf8") > SUMMARY_MAX_SOURCE_BYTES) return [];
  if (isTsSource(relativePath)) return summarizeTypeScriptSource(relativePath, text).imports;
  return summarizeWithProfile(relativePath, text)?.summary.imports ?? [];
}

/**
 * Import specifiers of one file on disk.
 *
 * A file this cannot read, a binary file, an oversized file and a file the parser rejects all
 * contribute `[]`, which is what the generator saw for them too — so the answer stays consistent
 * with the snapshot rather than becoming a third opinion about it.
 */
export function importsOfFile(relativePath: string, absolutePath: string): string[] {
  let buffer: Buffer;
  try {
    // Stat first: reading a 50 MB file to discover it is over the ceiling is the cost this
    // ceiling exists to avoid.
    const stats = fs.statSync(absolutePath);
    if (!stats.isFile() || stats.size > SUMMARY_MAX_SOURCE_BYTES) return [];
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return [];
  }
  const decoded = decodeText(buffer);
  if (decoded.binary) return [];
  return importsOfText(relativePath, decoded.text);
}
