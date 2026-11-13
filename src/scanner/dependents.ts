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
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

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
 * Package-rooted languages (Go modules, Rust `crate::`, PHP PSR-4, JVM packages, Swift modules)
 * are deliberately absent: their specifiers are resolved through a manifest — `go.mod`,
 * `Cargo.toml`, `composer.json` — and guessing a path from them would fabricate edges that
 * `validate` then has to disagree about.
 */
const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);
const RUBY_EXTENSIONS = new Set([".rb", ".rake", ".gemspec"]);
const C_EXTENSIONS = new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".m", ".mm"]);

/** Suffixes a Python module specifier may resolve to, in the order Python's own finder tries. */
const PYTHON_SUFFIXES = [".py", ".pyi", "/__init__.py", "/__init__.pyi"];

/**
 * Whether this platform's filesystems fold case by default.
 *
 * The folded maps used to be consulted unconditionally, so on Linux — where `Foo.ts` and
 * `foo.ts` are different files — `import "./foo"` resolved to `Foo.ts` even though node and
 * TypeScript would fail to resolve it. A false dependent edge is as wrong as a missing one, so
 * folding is now a platform property and never overrides an exact match.
 */
const CASE_INSENSITIVE_FILESYSTEM = process.platform === "win32" || process.platform === "darwin";

/** One `compilerOptions.paths` entry, with its targets already in repository-relative form. */
interface TsconfigPathRule {
  pattern: string;
  targets: readonly string[];
}

/** The `baseUrl`/`paths` shape of the nearest `tsconfig.json`. */
export interface TsconfigPaths {
  /** Repository-relative base directory for non-relative specifiers, or null when unset. */
  baseUrl: string | null;
  paths: readonly TsconfigPathRule[];
}

const TSCONFIG_CACHE = new Map<string, { key: string; value: TsconfigPaths | null }>();

/**
 * Reads `baseUrl` and `paths` from `<cwd>/tsconfig.json`, following `extends`.
 *
 * Type aliases — `@/lib/db`, `~/components/Button` — are the default in Next.js, Vite, Nuxt and
 * most large TypeScript repositories. `resolveSpecifier` only understood relative specifiers, so
 * every file importing through an alias was invisible to `--with-dependents`: the graph was
 * empty for exactly the files a change was most likely to break.
 *
 * `ts.parseJsonConfigFileContent` is used for the `extends` chain and for TypeScript's own
 * resolution of `baseUrl`, rather than a hand-written JSON reader that would disagree with the
 * compiler about comments and inherited fields. Failure is not fatal: a repository without a
 * readable tsconfig simply has no aliases, exactly as before.
 */
export function tsconfigPathsFor(cwd: string): TsconfigPaths | null {
  const configPath = path.join(cwd, "tsconfig.json");
  let stats: fs.Stats;
  try {
    stats = fs.statSync(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  const key = `${stats.mtimeMs}:${stats.size}`;
  const cached = TSCONFIG_CACHE.get(configPath);
  if (cached !== undefined && cached.key === key) return cached.value;

  let value: TsconfigPaths | null = null;
  try {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error === undefined) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, cwd, undefined, configPath);
      const options = parsed.options;
      const baseUrl =
        typeof options.baseUrl === "string" ? repositoryRelative(cwd, options.baseUrl) : null;
      const rules: TsconfigPathRule[] = [];
      if (options.paths !== undefined) {
        for (const [pattern, targets] of Object.entries(options.paths)) {
          if (!Array.isArray(targets)) continue;
          rules.push({
            pattern,
            targets: targets.map((target) => String(target).replace(/\\/g, "/")),
          });
        }
      }
      // A baseUrl outside the repository is not a path this graph can see into; recording it
      // would fabricate passes into `../shared` that the snapshot does not contain.
      if (baseUrl !== null || rules.length > 0) value = { baseUrl, paths: rules };
    }
  } catch (err) {
    // A malformed tsconfig is a project problem, not a reason to fail a snapshot. The other
    // language profiles behave the same way: a manifest they cannot read means no edges.
    value = null;
  }
  TSCONFIG_CACHE.set(configPath, { key, value });
  return value;
}

/** `target` relative to `cwd` as a POSIX path, or null when it escapes the repository. */
function repositoryRelative(cwd: string, target: string): string | null {
  const relative = path.relative(cwd, target).replace(/\\/g, "/");
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative))
    ? relative
    : null;
}

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
  /** Type aliases the graph could resolve, when a tsconfig was supplied. */
  tsconfig: TsconfigPaths | null;
}

/** Anything that knows its own repository-relative path; `FileEntry` is the common case. */
export interface ImportCandidate {
  relativePath: string;
}

/** Extra inputs to the resolver. */
export interface ImportResolverOptions {
  /**
   * Paths that changed but were not included — deleted modules.
   *
   * `resolveSpecifier` used to resolve against included files only, so when `a.ts` was deleted,
   * `import "./a"` in `b.ts` resolved to `null` and `b.ts` was not added as a dependent — the
   * one file the change was most likely to break. A tombstone makes the edge resolvable without
   * pretending the file is in the snapshot.
   */
  extraPaths?: Iterable<string>;
  /** `baseUrl`/`paths` from the repository's tsconfig, when the caller read one. */
  tsconfig?: TsconfigPaths | null;
}

function rememberFirst(map: Map<string, string>, key: string, value: string): void {
  if (!map.has(key)) map.set(key, value);
}

export function buildImportResolver(
  files: readonly ImportCandidate[],
  options: ImportResolverOptions = {}
): ImportResolver {
  const byPath = new Map<string, string>();
  const byPathFolded = new Map<string, string>();
  const byStem = new Map<string, string>();
  const byStemFolded = new Map<string, string>();

  const register = (relativePath: string): void => {
    rememberFirst(byPath, relativePath, relativePath);
    if (CASE_INSENSITIVE_FILESYSTEM) {
      rememberFirst(byPathFolded, relativePath.toLowerCase(), relativePath);
    }

    const extension = path.posix.extname(relativePath);
    if (!SOURCE_EXTENSIONS.has(extension)) return;
    const stem = relativePath.slice(0, -extension.length);
    rememberFirst(byStem, stem, relativePath);
    if (CASE_INSENSITIVE_FILESYSTEM) {
      rememberFirst(byStemFolded, stem.toLowerCase(), relativePath);
    }
    // `import "./dir"` resolves to `dir/index.ts`.
    if (path.posix.basename(stem) === "index") {
      const directory = path.posix.dirname(stem);
      rememberFirst(byStem, directory, relativePath);
      if (CASE_INSENSITIVE_FILESYSTEM) {
        rememberFirst(byStemFolded, directory.toLowerCase(), relativePath);
      }
    }
  };

  // Included files first: a tombstone must never shadow a file the snapshot contains.
  for (const file of files) register(file.relativePath);
  if (options.extraPaths !== undefined) {
    for (const extra of options.extraPaths) {
      if (!byPath.has(extra)) register(extra);
    }
  }

  return { byPath, byPathFolded, byStem, byStemFolded, tsconfig: options.tsconfig ?? null };
}

/** Best-effort resolution of a relative import to an included file. */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  resolver: ImportResolver
): string | null {
  const extension = path.posix.extname(fromFile).toLowerCase();

  const exact = (key: string): string | null =>
    resolver.byPath.get(key) ??
    (CASE_INSENSITIVE_FILESYSTEM ? resolver.byPathFolded.get(key.toLowerCase()) : undefined) ??
    null;
  const firstOf = (candidates: readonly string[]): string | null => {
    for (const candidate of candidates) {
      const hit = exact(candidate);
      if (hit) return hit;
    }
    return null;
  };
  /** Exact, extension, directory-index and `.js`-to-`.ts` candidates for one path. */
  const lookupPath = (joined: string): string | null => {
    const direct = exact(joined);
    if (direct) return direct;
    for (const suffix of IMPORT_CANDIDATE_SUFFIXES) {
      const hit = exact(`${joined}${suffix}`);
      if (hit) return hit;
    }
    const stem = joined.replace(/\.(?:js|mjs|cjs|jsx)$/, "");
    const byStem = (key: string): string | null =>
      resolver.byStem.get(key) ??
      (CASE_INSENSITIVE_FILESYSTEM ? resolver.byStemFolded.get(key.toLowerCase()) : undefined) ??
      null;
    return byStem(joined) ?? byStem(stem);
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

  if (!RELATIVE_SPECIFIER.test(specifier)) {
    return resolveTsconfigSpecifier(specifier, resolver, lookupPath);
  }
  const joined = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), specifier)
  );
  return lookupPath(joined);
}

/**
 * Resolves a non-relative specifier through `compilerOptions.baseUrl` and `paths`.
 *
 * The substitution follows TypeScript's rule: the first `*` in the pattern captures, and every
 * `*` in a target is replaced with that capture. Candidates then go through the same
 * extension/index/`.js`-to-`.ts` lookup as a relative import, so an alias to a directory or to a
 * `.js` specifier behaves like the real module resolver.
 */
function resolveTsconfigSpecifier(
  specifier: string,
  resolver: ImportResolver,
  lookupPath: (joined: string) => string | null
): string | null {
  const config = resolver.tsconfig;
  if (!config) return null;

  for (const rule of config.paths) {
    const star = rule.pattern.indexOf("*");
    let captured: string | null;
    if (star === -1) {
      captured = specifier === rule.pattern ? "" : null;
    } else {
      const prefix = rule.pattern.slice(0, star);
      const suffix = rule.pattern.slice(star + 1);
      if (
        specifier.length < prefix.length + suffix.length ||
        !specifier.startsWith(prefix) ||
        !specifier.endsWith(suffix)
      ) {
        captured = null;
      } else {
        captured = specifier.slice(prefix.length, specifier.length - suffix.length);
      }
    }
    if (captured === null) continue;
    for (const target of rule.targets) {
      const substituted = target.split("*").join(captured);
      const base = config.baseUrl === null ? substituted : path.posix.join(config.baseUrl, substituted);
      const hit = lookupPath(path.posix.normalize(base));
      if (hit) return hit;
    }
  }

  if (config.baseUrl !== null) {
    return lookupPath(path.posix.normalize(path.posix.join(config.baseUrl, specifier)));
  }
  return null;
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
