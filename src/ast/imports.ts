/**
 * The import specifiers one file declares, read exactly the way `generate` reads them.
 *
 * `--with-dependents` is decided from the generated summaries, so anything that has to answer the
 * same question later — `explain`, `validate` — must parse the file the same way. A second,
 * simpler "find the import lines" implementation is how two accounts of one import graph begin:
 * it would disagree on `require`, on `${…}` in a dynamic import, on a file the parser rejected,
 * and the disagreement would surface as a snapshot that is "drifted" or an explanation that is
 * wrong, neither of which points at the real cause.
 */
import * as fs from "node:fs";

import { summarizeTypeScriptSource } from "./ts-parser.js";
import { summarizeWithProfile } from "./profiles/index.js";
import { decodeText } from "../scanner/binary.js";

/** Extensions the generator hands to the TypeScript summarizer. */
const TS_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const isTsSource = (relativePath: string): boolean => {
  const lower = relativePath.toLowerCase();
  return TS_SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
};

/** Import specifiers from text already decoded, or `[]` when the language has no importer. */
export function importsOfText(relativePath: string, text: string): string[] {
  if (isTsSource(relativePath)) return summarizeTypeScriptSource(relativePath, text).imports;
  return summarizeWithProfile(relativePath, text)?.summary.imports ?? [];
}

/**
 * Import specifiers of one file on disk.
 *
 * A file this cannot read, a binary file and a file the parser rejects all contribute `[]`, which
 * is what the generator saw for them too — so the answer stays consistent with the snapshot
 * rather than becoming a third opinion about it.
 */
export function importsOfFile(relativePath: string, absolutePath: string): string[] {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return [];
  }
  const decoded = decodeText(buffer);
  if (decoded.binary) return [];
  return importsOfText(relativePath, decoded.text);
}
