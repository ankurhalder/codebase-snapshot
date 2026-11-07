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
 * Extensions whose relative imports are *not* JavaScript's `./x` shape.
 *
 * `importsOfText` has recorded Python, Ruby, C/C++ and Dart imports since the language profiles
 * landed, and `resolveSpecifier` only ever understood `./` and `../`, so every non-JavaScript edge
 * in the graph pointed at nothing: `from .models import Order` was in the manifest, resolved to
 * `null`, and the module that imports it was dropped from a `--with-dependents` snapshot.
 *
 * Each of these languages spells "this directory" differently, and the difference is the whole
 * reason a single rule cannot serve them:
 *
 * - **Python** writes it with dots: `from .models import Order` is `.models`, `from ..util import x`
 *   is `..util`. One dot is the current package (the file's directory), two is its parent.
 * - **Ruby** has no marker at all — `require_relative "user"` is relative to the file and
 *   `require "json"` is a gem. The profile prefixes the first form with `./` so the two stay
 *   distinguishable.
 * - **C and C++** use `#include "board.h"` for a local header and `<stdio.h>` for a system one.
 *   The profile prefixes the quoted form with `./`.
 * - **Dart** writes a relative import bare: `import 'widget.dart'` next to the file, while
 *   `package:flutter/…` and `dart:async` are not paths in this repository at all.
 *
 * Package-rooted languages (Go modules, Rust `crate::`, PHP PSR-4, JVM packages, Swift modules) are
 * deliberately absent: their specifiers are resolved through a manifest — `go.mod`, `Cargo.toml`,
 * `composer.json` — and guessing a path from them would fabricate edges that `validate` then has
 * to disagree about.
 */
const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);
const RUBY_EXTENSIONS = new Set([".rb", ".rake", ".gemspec"]);
const C_EXTENSIONS = new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".m", ".mm"]);

/** Suffixes a Python module specifier may resolve to, in the order Python's own finder tries. */
const PYTHON_SUFFIXES = [".py", ".pyi", "/__init__.py", "/__init__.pyi"];

/** One-pass lookup tables for relative-import resolution.
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
  const extension = path.posix.extname(fromFile).toLowerCase();

  const exact = (key: string): string | null =>
    resolver.byPath.get(key) ?? resolver.byPathFolded.get(key.toLowerCase()) ?? null;
  const firstOf = (candidates: readonly string[]): string | null => {
    for (const candidate of candidates) {
      const hit = exact(candidate);
      if (hit) return hit;
    }
    return null;
  };

  if (PYTHON_EXTENSIONS.has(extension) && specifier.startsWith(".")) {
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
    const rest = specifier.slice(dots).replace(/\./g, "/");
    let base = path.posix.dirname(fromFile);
    // One dot is this package; every further dot is one directory up.
    for (let up = 1; up < dots; up += 1) base = path.posix.dirname(base);
    const joined = rest ? path.posix.normalize(path.posix.join(base, rest)) : base;
    return firstOf([joined, ...PYTHON_SUFFIXES.map((suffix) => `${joined}${suffix}`)]);
  }

  if (RUBY_EXTENSIONS.has(extension) && specifier.startsWith("./")) {
    // `require_relative` only: the profile keeps a bare `require` bare, because a gem name is not
    // a path and resolving one would invent an edge to any same-named file.
    const joined = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromFile), specifier)
    );
    return firstOf([`${joined}.rb`, joined]);
  }

  if (C_EXTENSIONS.has(extension) && specifier.startsWith("./")) {
    // `#include "local.h"` only: `<stdio.h>` is recorded without the prefix and stays unresolved.
    const joined = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromFile), specifier)
    );
    return exact(joined);
  }

  if (extension === ".dart" && !specifier.includes(":")) {
    // Dart has no `./` convention: a specifier with no scheme is a path beside this file.
    const joined = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromFile), specifier)
    );
    return firstOf([joined, `${joined}.dart`]);
  }

  if (!RELATIVE_SPECIFIER.test(specifier)) return null;
  const joined = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier)
  );

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
