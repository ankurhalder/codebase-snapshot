/**
 * The import graph: which file a specifier points at, and which files that makes dependents.
 *
 * This lives on its own because three callers need the same answer and must not each own a copy
 * of it. `generate --with-dependents` widens a changed-files scope by one hop of importers;
 * `explain` has to say whether a file it is explaining would be in that widened scope; and
 * `validate` has to know whether a file the snapshot dropped as `unchanged` has since become an
 * importer of something that changed. Each of them used to answer with its own path-set
 * comparison, so all three agreed the moment the scope was applied and disagreed as soon as
 * `--with-dependents` was involved — the generator included a file the other two called
 * unchanged, and every one of them was telling the truth about a different rule.
 */
import * as path from "node:path";

const RELATIVE_SPECIFIER = /^\.{1,2}\//;

/** Extensions a bare `./x` may resolve to, so `import "./user"` finds `user.ts`. */
const IMPORT_CANDIDATE_SUFFIXES = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.mjs",
];

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/**
 * One-pass lookup tables for relative-import resolution.
 *
 * `resolveSpecifier` used to fall back to scanning every known file for every
 * unresolved import — 100k files × 100k imports — and built a RegExp from the
 * candidate path, so a directory named `[unmatched` aborted the run and `[id]`
 * matched unrelated files. Both are gone: every candidate is a map lookup, and
 * no path is ever used as a pattern.
 *
 * Exported so a consumer can answer "what imports this file" from the snapshot's own
 * index using the same rules the generator used. `manifest.indexes.imports.byFile`
 * records the *raw* specifiers a file imports (`"./user.js"`), and a second
 * implementation of the resolution would eventually disagree with this one — leaving
 * two accounts of one graph.
 */
export interface ImportResolver {
  byPath: Map<string, string>;
  byPathFolded: Map<string, string>;
  byStem: Map<string, string>;
  byStemFolded: Map<string, string>;
}

/** Anything that knows its own repository-relative path; `FileEntry` is the common case. */
export interface ImportCandidate {
  relativePath: string;
}

export function buildImportResolver(files: readonly ImportCandidate[]): ImportResolver {
  const byPath = new Map<string, string>();
  const byPathFolded = new Map<string, string>();
  const byStem = new Map<string, string>();
  const byStemFolded = new Map<string, string>();
  // First writer wins, so ambiguity resolves to the lexicographically first
  // path (the scanner hands files over sorted) and stays deterministic.
  const remember = (map: Map<string, string>, key: string, value: string): void => {
    if (!map.has(key)) map.set(key, value);
  };

  for (const file of files) {
    const relativePath = file.relativePath;
    remember(byPath, relativePath, relativePath);
    remember(byPathFolded, relativePath.toLowerCase(), relativePath);

    const extension = path.posix.extname(relativePath);
    if (!SOURCE_EXTENSIONS.has(extension)) continue;
    const stem = relativePath.slice(0, -extension.length);
    remember(byStem, stem, relativePath);
    remember(byStemFolded, stem.toLowerCase(), relativePath);
    // `import "./dir"` resolves to `dir/index.ts`.
    if (path.posix.basename(stem) === "index") {
      const directory = path.posix.dirname(stem);
      remember(byStem, directory, relativePath);
      remember(byStemFolded, directory.toLowerCase(), relativePath);
    }
  }

  return { byPath, byPathFolded, byStem, byStemFolded };
}

/** Best-effort resolution of a relative import to an included file. */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  resolver: ImportResolver
): string | null {
  if (!RELATIVE_SPECIFIER.test(specifier)) return null;
  const joined = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier)
  );

  const exact = (key: string): string | null =>
    resolver.byPath.get(key) ?? resolver.byPathFolded.get(key.toLowerCase()) ?? null;

  const direct = exact(joined);
  if (direct) return direct;

  for (const suffix of IMPORT_CANDIDATE_SUFFIXES) {
    const hit = exact(`${joined}${suffix}`);
    if (hit) return hit;
  }

  // An extensionless import (`./x`), a directory import (`./dir` → index), or a
  // TypeScript-style `./x.js` that actually lives in `./x.ts`.
  const stem = joined.replace(/\.(?:js|mjs|cjs|jsx)$/, "");
  const byStem = (key: string): string | null =>
    resolver.byStem.get(key) ?? resolver.byStemFolded.get(key.toLowerCase()) ?? null;
  return byStem(joined) ?? byStem(stem);
}

/**
 * True when `imports` — the specifiers one file imports — reach anything in `changedPaths`.
 *
 * One hop, and only one hop. The test is against the **changed set**, never against a set that
 * is being extended while it is tested: doing that walked the graph transitively, so a changed
 * `a.ts` pulled in `b.ts` (which imports it) and then `c.ts` (which imports `b.ts`), and whether
 * the two-hop file was included depended on whether its name happened to sort after `b.ts`. The
 * same repository produced different snapshots depending on file names.
 */
export function importsChangedFile(
  importerPath: string,
  imports: readonly string[],
  changedPaths: ReadonlySet<string>,
  resolver: ImportResolver
): boolean {
  for (const specifier of imports) {
    const resolved = resolveSpecifier(importerPath, specifier, resolver);
    if (resolved !== null && changedPaths.has(resolved)) return true;
  }
  return false;
}
