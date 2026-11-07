import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PRESETS } from "../presets/index.js";
import { DEFAULT_SECRET_PATTERNS } from "../security/patterns.js";
import { REDACTION_MARKER } from "../security/redact.js";
import type { DiscoveryMode, SecretRule, SkipRecord } from "../types.js";

export interface GitInfo {
  branch: string;
  commit: string;
  isDirty: boolean;
}

/** How candidate files are discovered (the type itself lives in `types.ts`). */
export type { DiscoveryMode } from "../types.js";

export function isDiscoveryMode(value: unknown): value is DiscoveryMode {
  return value === "auto" || value === "git" || value === "walk";
}

export interface CollectOptions {
  /**
   * When non-empty, only files matching at least one pattern are candidates.
   * Applied before `excludePatterns`, which then narrows the result further.
   */
  includePatterns?: string[];
  excludePatterns?: string[];
  /**
   * Emit credential-bearing files (`.env`, `*.pem`, `.npmrc`, `id_rsa`, …).
   * Default `false`: they are skipped with `reason: "sensitive-file"`.
   */
  includeSensitiveFiles?: boolean;
  /**
   * Secret rules used to scan *paths* (defaults are always applied). Pass
   * `config.secretRules` so `customPatterns` also protect file names.
   */
  secretRules?: readonly SecretRule[];
  /**
   * Top-level directory names this run is about to write — `outDir` and `tmpDir`.
   *
   * They are excluded from the scan without a `skipped[]` record because that is this tool's own
   * bookkeeping and a first run cannot have written a marker into them yet. A directory with one
   * of these *names* that carries no marker is still excluded when it is one of these paths, but
   * is an ordinary directory when it is not: dropping it silently was the bug.
   */
  toolOwnedPaths?: readonly string[];
  /**
   * How candidates are discovered: `auto` (git when usable, refusal when the
   * directory claims to be a repository but git cannot list it), `git` (require
   * git), or `walk` (walk the tree, reading the root `.gitignore` directly).
   * Defaults to the configured mode, then `auto`.
   */
  discovery?: DiscoveryMode;
}

export interface CollectResult {
  files: string[];
  skipped: SkipRecord[];
}

/**
 * Every ecosystem ignore any preset can contribute.
 *
 * Callers merge the preset's ignores into `excludePatterns`, which loses the
 * provenance: a Rust preset's `target` was reported as `reason: "excluded"`,
 * implying the developer had written it, while the docs say preset ignores are
 * `default-ignore` and `excluded` means a user-supplied glob. Matching against
 * the union restores the distinction without changing the call sites.
 */
const PRESET_IGNORES: ReadonlySet<string> = new Set(
  PRESETS.flatMap((preset) => preset.exclude ?? [])
);

/** The raw text of a link when the platform can report it, else its target. */
function readLinkTarget(linkPath: string, fallback: string): string {
  try {
    return fs.readlinkSync(linkPath);
  } catch {
    return fallback;
  }
}

/** Absolute path containment, used to refuse links that leave the root. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/**
 * Ceiling on any single git listing.
 *
 * Node's default is 1 MB, which is not a lot of paths — a monorepo with a few hundred thousand
 * tracked-and-ignored entries exceeds it. The limit exists so a runaway listing cannot exhaust
 * memory, not so a legitimate one can fail; these are the sizes the sibling helpers already use.
 */
const GIT_OUTPUT_LIMIT = 68_157_440;

export function getGitInfo(cwd: string, fallbackBranch = "main"): GitInfo {
  try {
    // One subprocess, not three.
    //
    // This used to spawn `git rev-parse --abbrev-ref HEAD`, `git rev-parse HEAD` and
    // `git status --porcelain` in sequence. Process creation is the expensive part —
    // roughly 40-80 ms per spawn on Windows — and `status --porcelain=v2 --branch`
    // reports all three answers in its `# branch.*` headers.
    //
    // `--abbrev-ref HEAD` printed the literal string "HEAD" on a detached HEAD, which
    // is a normal CI state; recording it produced misleading metadata and a permanent
    // "generated on branch HEAD" warning from validate. A detached HEAD cannot name a
    // branch, so the fallback is used, and `(detached)` is how v2 spells it.
    //
    // `-z` disables C-quoting of paths, so a path containing a newline cannot be
    // mistaken for a header: parsing stops at the first record that is not a header,
    // and everything from there on is an entry, which is all `isDirty` needs.
    //
    // `execFileSync`, not `execSync`: the same call written as a command string goes through a
    // shell on this platform, so every path in the output is quoted for it and a repository
    // whose name contains shell metacharacters was misparsed. Nothing here is user input any
    // more either way, but `src/scanner/changed.ts` already runs git the direct way.
    //
    // `maxBuffer`, because the default is 1 MB and this output is *proportional to the number
    // of changed files*: on a repository with more than roughly ten thousand dirty entries
    // `git status` overflows, `execSync` throws ENOBUFS, and the catch below reported the
    // dirtiest possible tree as `isDirty: false`. Every sibling call in this file already
    // passes a limit — this one just kept Node's default.
    const output = childProcess.execFileSync(
      "git",
      ["status", "--porcelain=v2", "--branch", "-z"],
      {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        maxBuffer: GIT_OUTPUT_LIMIT,
      }
    );

    let branch = fallbackBranch;
    let commit = "unknown";
    let isDirty = false;

    const records = output.split("\0").flatMap((record) => record.split("\n"));
    for (const record of records) {
      if (record.length === 0) continue;
      if (!record.startsWith("# ")) {
        isDirty = true;
        break;
      }
      const oid = record.match(/^# branch\.oid (.+)$/);
      if (oid) {
        commit = oid[1] === "(initial)" ? "unknown" : oid[1];
        continue;
      }
      const head = record.match(/^# branch\.head (.+)$/);
      if (head) {
        branch = head[1] === "(detached)" ? fallbackBranch : head[1];
      }
    }

    return { branch, commit, isDirty };
  } catch (err) {
    // An overflowed buffer is *evidence*, not a failure to answer: `git status` only exceeds
    // the ceiling when it has an enormous number of entries, which is the definition of a dirty
    // tree. Reporting "clean" there was the worst possible answer, because the snapshot then
    // claims its own contents match the commit that is being described.
    const code = (err as { code?: unknown }).code;
    const isDirty = code === "ENOBUFS";
    return { branch: fallbackBranch, commit: "unknown", isDirty };
  }
}

/**
 * Names ignored by convention, everywhere in the tree.
 *
 * `snapshot` and `snapshot.tmp` used to be here, which meant a directory a user happened to call
 * `snapshot` was ignored at any depth — cost free while it was also silently dropped, but wrong:
 * it is a normal directory unless it is this tool's output, and this tool's output is recognised
 * by its ownership marker and by the exact `outDir`/`tmpDir` a run is writing, not by its name.
 * Those names are handled by {@link makeToolOwnedDecider} now.
 */
const DEFAULT_IGNORED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "out",
];

const DEFAULT_IGNORED_FILES = [
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "composer.lock",
];

/**
 * Credential-bearing files. They are skipped by default: no default secret
 * pattern can reliably mask a private key or a registry token, and these files
 * were previously emitted verbatim into `parts/*.md`.
 */
const SENSITIVE_BASENAME =
  /^(?:\.env(?:[._-][A-Za-z0-9_-]*)*|\.env(?:backup|bak|old|orig|copy|save)|\.envrc|\.npmrc(?:\.[A-Za-z0-9_-]+)?|\.yarnrc(?:\.yml)?|\.netrc(?:\.[A-Za-z0-9_-]+)?|\.git-credentials|\.htpasswd|\.pgpass|\.vault-token|vault[-_]agent[-_]token|id_[a-z0-9_]+(?:\.[A-Za-z0-9_-]+)?|credentials(?:\.(?:json|ya?ml|toml))?|service[-_]?account(?:\.[a-z0-9_-]+)*\.json|secrets?\.(?:json|ya?ml|toml)|env|[A-Za-z0-9_-]{1,64}\.env)$/i;
const SENSITIVE_PATH =
  /(?:^|\/)\.(?:aws|ssh|gnupg)\/|(?:^|\/)\.docker\/config\.json$|(?:^|\/)\.kube\/config$/i;
const SENSITIVE_EXT = /\.(?:pem|key|p12|pfx|jks|keystore|ppk|asc|kdbx|tfstate|tfvars)$/i;

/** `name.example`, `name.sample.json`, `id_rsa.template`, … */
const TEMPLATE_SUFFIX = /\.(?:example|sample|template|dist)(?=$|[.])/i;

/**
 * Editor, backup and download leftovers that hide a sensitive name behind a
 * suffix: `.env~` (Emacs), `.env.swp` (vi), `.npmrc.bak`, `.credentials.old`.
 * The deny list is spelled with `$` anchors, so without this normalisation one
 * keystroke of renaming disabled it entirely.
 */
const BACKUP_SUFFIX = /(?:~|\.(?:bak|backup|old|orig|save|copy|swp|swo|tmp|part))$/i;

/**
 * Normalises a file name before deny-list matching.
 *
 * - Trailing spaces and dots are legal in the Windows namespace and are ignored
 *   by Win32 path resolution, so `.npmrc ` *is* `.npmrc`.
 * - Backup suffixes are stripped until stable: `.env.bak~` → `.env`.
 */
function normaliseName(name: string): string {
  let normalised = name.trim().replace(/[. ]+$/, "");
  let previous = "";
  while (previous !== normalised) {
    previous = normalised;
    normalised = normalised.replace(BACKUP_SUFFIX, "");
  }
  return normalised;
}

const matchesSensitiveList = (posixPath: string, base: string): boolean =>
  SENSITIVE_BASENAME.test(base) ||
  SENSITIVE_PATH.test(posixPath) ||
  SENSITIVE_EXT.test(base);

export function isSensitivePath(relativePath: string): boolean {
  const posixPath = relativePath.replace(/\\/g, "/");
  const raw = posixPath.split("/").pop() ?? posixPath;
  const base = normaliseName(raw);

  // A template is allowed only when it would otherwise be denied on its own
  // merit, so `credentials.example.json` is emitted while `credentials.json` is
  // not, and `.env.example` is emitted while `.env.production.local` is not.
  if (TEMPLATE_SUFFIX.test(base)) {
    const stripped = base.replace(new RegExp(TEMPLATE_SUFFIX.source, "gi"), "");
    if (matchesSensitiveList(posixPath, stripped)) return false;
  }

  return matchesSensitiveList(posixPath, base);
}

/**
 * Rules used for path scanning when a caller does not pass `secretRules`.
 *
 * `resolveConfig` registers the resolved set (defaults + `customPatterns`), so
 * every `collectFiles` call in the same run sees custom rules without each call
 * site having to thread them; an explicit `options.secretRules` always wins.
 */


/**
 * Global copies of the rule patterns, compiled once per rule object.
 *
 * `findSecretInPath` runs on every candidate path, every skipped path, every layer and
 * kind name, and every string in every AST summary. It allocated 30+ new `RegExp`
 * objects on each call: on a 2,000-file repository with 20 identifiers per file that is
 * over a million compilations for a single run. A `RegExp` is immutable in everything
 * but `lastIndex`, so one global copy per rule is safe to share as long as the index is
 * reset before each scan — which the loop below does.
 */
const GLOBAL_PATTERNS = new WeakMap<RegExp, RegExp>();

function globalPattern(pattern: RegExp): RegExp {
  let compiled = GLOBAL_PATTERNS.get(pattern);
  if (compiled === undefined) {
    // A fresh global copy: the shared rule patterns are deliberately stateless
    // (no `g`), and `exec` on a non-global regex never advances `lastIndex` —
    // looping it directly returns the same match forever.
    compiled = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, "")}g`);
    GLOBAL_PATTERNS.set(pattern, compiled);
  }
  return compiled;
}

const DEFAULT_PATH_RULES: SecretRule[] = [...DEFAULT_SECRET_PATTERNS];

function pathScanRules(extraRules: readonly SecretRule[] | undefined): SecretRule[] {
  if (extraRules === undefined || extraRules.length === 0) return DEFAULT_PATH_RULES;
  return [...DEFAULT_SECRET_PATTERNS, ...extraRules];
}

/**
 * Reports a secret-shaped value in a *path*.
 *
 * File names are emitted verbatim into `project-tree.md`, `navigation.md`,
 * `manifest.files[].relativePath`, the `## Skipped` table of the audit and
 * `skipped[].path`, so a token in a name leaks exactly like a token in a body —
 * and content redaction never sees it.
 *
 * `extraRules` are the caller's custom patterns. A `valueGroup` rule is masked
 * whole here: a path has no `key: value` context to anchor on.
 */
export function findSecretInPath(
  relativePath: string,
  extraRules?: readonly SecretRule[]
): { rules: string[]; masked: string } | null {
  const posixPath = relativePath.replace(/\\/g, "/");
  const spans: Array<{ start: number; end: number }> = [];
  const rules: string[] = [];

  for (const { rule, pattern } of pathScanRules(extraRules)) {
    const scan = globalPattern(pattern);
    scan.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = scan.exec(posixPath)) !== null) {
      if (match[0].length === 0) {
        scan.lastIndex += 1;
        continue;
      }
      spans.push({ start: match.index, end: match.index + match[0].length });
      if (!rules.includes(rule)) rules.push(rule);
    }
  }
  if (spans.length === 0) return null;

  // Union merge: overlapping matches produce one marker, never a fragment.
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }

  let out = "";
  let cursor = 0;
  for (const span of merged) {
    out += posixPath.slice(cursor, span.start);
    out += REDACTION_MARKER;
    cursor = span.end;
  }
  out += posixPath.slice(cursor);

  return { rules, masked: out };
}

/**
 * Masks the path of every skip record, whatever its reason.
 *
 * `findSecretInPath` was only consulted on the `sensitive-path` route, so a
 * credential-bearing *name* was masked when the reason was `sensitive-path` and
 * emitted raw when the reason was anything else — `certs/AKIA….key` reached
 * `manifest.skipped[].path` and the audit table as a `sensitive-file` skip.
 * Masking in one pass here keeps every future reason covered too; `reason` and
 * `detail` are preserved untouched.
 */
export function maskSkipPaths(
  records: readonly SkipRecord[],
  extraRules?: readonly SecretRule[]
): SkipRecord[] {
  return records.map((record) => {
    const hit = findSecretInPath(record.path, extraRules);
    // `detail` names the link target or the exclude pattern, so it can carry the
    // same token the path did — it is emitted into the manifest, the audit table
    // and `explain`, so it is masked with the same rules.
    const detail = record.detail ? findSecretInPath(record.detail, extraRules) : null;
    return {
      ...record,
      path: hit ? hit.masked : record.path,
      ...(detail ? { detail: detail.masked } : {}),
    };
  });
}

/**
 * Translates a glob (`**`, `*`, `?`, `{a,b}`, `[abc]`) into a RegExp. A pattern
 * without a leading `/` matches at any depth, mirroring `.gitignore` semantics.
 *
 * Brace groups and character classes are supported because they are what people
 * actually write: `*.{ts,tsx}` previously matched nothing at all, since `{` and
 * `}` were escaped as literals.
 */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const anchored = normalized.startsWith("/");
  const body = anchored ? normalized.slice(1) : normalized;

  const prefix = anchored || body.includes("/") ? "^" : "(?:^|.*/)";
  return new RegExp(`${prefix}${globBodyToRegExp(body, true)}(?:/.*)?$`);
}

/** One level of brace nesting, which covers `*.{ts,tsx}` and `src/{app,lib}/**`. */
function globBodyToRegExp(body: string, allowBraces: boolean): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i];

    if (char === "*") {
      if (body[i + 1] === "*") {
        i += 1;
        if (body[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      out += "[^/]";
      continue;
    }

    if (char === "{" && allowBraces) {
      const close = findClosing(body, i, "{", "}");
      if (close !== -1) {
        const alternatives = body
          .slice(i + 1, close)
          .split(",")
          .map((part) => globBodyToRegExp(part.trim(), false));
        if (alternatives.length > 1) {
          out += `(?:${alternatives.join("|")})`;
          i = close;
          continue;
        }
      }
    }

    if (char === "[") {
      const close = body.indexOf("]", i + 1);
      if (close !== -1 && close > i + 1) {
        const inner = body.slice(i + 1, close);
        const negated = inner.startsWith("!") || inner.startsWith("^");
        const chars = negated ? inner.slice(1) : inner;
        // `-` keeps range semantics; everything else that is special is escaped.
        const safe = chars.replace(/[\\^\]]/g, (value) => `\\${value}`);
        out += negated ? `[^/${safe}]` : `[${safe}]`;
        i = close;
        continue;
      }
    }

    out += "\\^$.|+()[]{}".includes(char) ? `\\${char}` : char;
  }
  return out;
}

function findClosing(body: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === open) depth += 1;
    else if (body[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Path exclusion with proper segment semantics.
 *
 * A plain (non-glob) pattern matches a whole path segment sequence, so
 * `"test"` matches `test/a.ts` and `src/test/b.ts` but **not** `contest/entry.ts`
 * (the previous implementation was a raw `String.includes`).
 */
export function matchesExclude(relativePath: string, pattern: string): boolean {
  const posixPath = relativePath.replace(/\\/g, "/");
  const cleaned = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").trim();
  if (!cleaned) return false;

  if (/[*?{[]/.test(cleaned)) {
    return globToRegExp(cleaned).test(posixPath);
  }

  return (
    posixPath === cleaned ||
    posixPath.startsWith(`${cleaned}/`) ||
    posixPath.includes(`/${cleaned}/`) ||
    posixPath.endsWith(`/${cleaned}`)
  );
}

interface GitignoreRule {
  pattern: string;
  negated: boolean;
  dirOnly: boolean;
}

/**
 * Removes the trailing spaces gitignore(5) says are insignificant.
 *
 * A trailing space is only significant when it is escaped, so `name\ ` keeps its
 * space and `name ` does not. Walking back from the end and counting the
 * preceding backslashes is what distinguishes the two: an odd count means the
 * space itself is escaped.
 */
function trimUnescapedTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) {
    let backslashes = 0;
    for (let i = end - 2; i >= 0 && line[i] === "\\"; i--) backslashes += 1;
    if (backslashes % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
}

/**
 * Parses `<dir>/.gitignore` into ordered rules. A missing or unreadable file has none.
 *
 * Only the rules are returned, not a matcher, because a matcher needs the directory it was read
 * for: nested `.gitignore` files were ignored entirely, so a `dist/` rule inside `packages/foo`
 * had no effect in a non-git checkout while git honoured it — the same repository produced two
 * different snapshots depending on whether `.git` was readable.
 *
 * The line grammar follows gitignore(5) rather than "trim and look at the first character":
 * `\#` and `\!` are literal leading characters, not a comment and not a negation, and a trailing
 * space only counts when it is backslash-escaped. Treating them as ordinary characters made a
 * `walk` scan include files that git ignores.
 */
function readGitignoreRules(dir: string): GitignoreRule[] {
  const gitignorePath = path.join(dir, ".gitignore");
  let raw: string;
  try {
    raw = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    return [];
  }

  const rules: GitignoreRule[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = trimUnescapedTrailingSpaces(rawLine.replace(/\r$/, ""));
    if (!line) continue;
    // An unescaped `#` opens a comment; `\#` is the literal character.
    if (line.startsWith("#")) continue;

    let negated = false;
    let pattern = line;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    } else if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
      // Escape consumed: the remaining pattern is a literal `#` or `!`.
      pattern = pattern.slice(1);
    }

    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    if (pattern) rules.push({ pattern, negated, dirOnly });
  }
  return rules;
}

/** Escapes one literal character for use inside a RegExp body. */
function escapeRegExpChar(character: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(character) ? `\\${character}` : character;
}

/**
 * Matches `target` against one gitignore pattern, with gitignore's own semantics.
 *
 * This used to be reached only when the pattern contained a backslash; every other pattern was
 * handed to `matchesExclude`, which is a *different* language. Two whole classes of rule were
 * therefore wrong in `walk` mode, and both are fixed by using this matcher unconditionally:
 *
 * - **Root-anchored rules never matched.** `readGitignoreRules` keeps the leading `/`, and
 *   `matchesExclude` compares it against a path that has no leading slash, so `/build`
 *   could not equal `build`, could not prefix `build/x`, and could not appear between two
 *   slashes. A `/secret-notes.txt` rule silently kept its file in the snapshot.
 * - **Unanchored rules with an inner slash matched too deep.** gitignore(5) anchors a pattern
 *   that contains a non-trailing `/` to the directory holding the `.gitignore`, so `doc/frotz`
 *   ignores the top-level `doc/frotz` only. `matchesExclude` matched `a/doc/frotz` as well.
 *
 * `anchored || body.includes("/")` below is exactly that rule, so this function is the whole
 * of gitignore matching and `matchesExclude` is left to configuration excludes, where "match
 * at any depth" is the documented behaviour.
 */
function matchGitignorePattern(target: string, pattern: string): boolean {
  const anchored = pattern.startsWith("/");
  const body = anchored ? pattern.slice(1) : pattern;
  let source = "";
  for (let i = 0; i < body.length; i++) {
    const character = body[i];
    if (character === "\\") {
      const next = body[i + 1];
      if (next !== undefined) {
        source += escapeRegExpChar(next);
        i += 1;
      } else {
        source += "\\\\";
      }
      continue;
    }
    if (character === "*") {
      if (body[i + 1] === "*") {
        i += 1;
        if (body[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    // `[abc]`, `[!abc]`, `[0-9]`: a character class is part of gitignore's pattern language,
    // and escaping the brackets made every rule that used one match nothing at all —
    // `*.[oa]`, `[Tt]humbs.db` and `log[0-9].txt` were ignored in `walk` mode while the same
    // rules worked in `git` mode. Parsed exactly like `globBodyToRegExp` does, so the two
    // matchers cannot disagree about what a class means.
    if (character === "[") {
      const close = body.indexOf("]", i + 1);
      if (close !== -1 && close > i + 1) {
        const inner = body.slice(i + 1, close);
        const negated = inner.startsWith("!") || inner.startsWith("^");
        const chars = negated ? inner.slice(1) : inner;
        // `-` keeps range semantics; everything else that is special is escaped.
        const safe = chars.replace(/[\\^\]]/g, (value) => `\\${value}`);
        source += negated ? `[^/${safe}]` : `[${safe}]`;
        i = close;
        continue;
      }
    }
    source += escapeRegExpChar(character);
  }
  const prefix = anchored || body.includes("/") ? "^" : "(?:^|.*/)";
  return new RegExp(`${prefix}${source}(?:/.*)?$`).test(target);
}

/** One `.gitignore` file together with the directory it governs, relative to the scan root. */
interface GitignoreLayer {
  prefix: string;
  rules: readonly GitignoreRule[];
}

/**
 * Whether one rule ignores `scoped`.
 *
 * A pattern ending in `/` matches a **directory** and everything below it. The old
 * code reduced the candidate to its first path segment (`scoped.replace(/\/.*$/, "")`),
 * so `public/build/app.js` became `public` — a string that can never equal the rule's
 * `public/build`, which meant a multi-segment directory rule never matched in `walk`
 * mode and the directory it ignored was scanned back into the snapshot. A directory
 * rule is now tried against every directory prefix of the candidate, and against the
 * candidate itself only when the candidate *is* a directory — so `build/` no longer
 * drops a regular file named `build`.
 */
function matchesGitignoreRule(
  rule: GitignoreRule,
  scoped: string,
  isDirectory: boolean
): boolean {
  if (!rule.dirOnly) return matchGitignorePattern(scoped, rule.pattern);
  const segments = scoped.split("/");
  const limit = isDirectory ? segments.length : segments.length - 1;
  for (let depth = 1; depth <= limit; depth += 1) {
    if (matchGitignorePattern(segments.slice(0, depth).join("/"), rule.pattern)) return true;
  }
  return false;
}

/**
 * Whether the accumulated `.gitignore` layers ignore `relativePath`, or `null` for no opinion.
 *
 * The deepest layer with an opinion wins, which is git's precedence rule: a pattern in a nested
 * `.gitignore` overrides the same path in an ancestor's, in both directions.
 */
function gitignoreVerdict(
  layers: readonly GitignoreLayer[],
  relativePath: string,
  isDirectory: boolean
): boolean | null {
  let verdict: boolean | null = null;

  for (const layer of layers) {
    let scoped: string;
    if (layer.prefix === "") {
      scoped = relativePath;
    } else if (relativePath.startsWith(`${layer.prefix}/`)) {
      scoped = relativePath.slice(layer.prefix.length + 1);
    } else {
      // A nested rule never governs paths outside its own directory.
      continue;
    }

    let layerVerdict: boolean | null = null;
    for (const rule of layer.rules) {
      if (matchesGitignoreRule(rule, scoped, isDirectory)) layerVerdict = !rule.negated;
    }
    if (layerVerdict !== null) verdict = layerVerdict;
  }

  return verdict;
}

/**
 * Explains *why* a path is in the built-in ignore list, or `null` when it is not.
 *
 * Returning the reason instead of a bare boolean is what lets the manifest say
 * "this file exists but was skipped, and here is the rule" — a directory named
 * `out` or `build` used to drop real source silently and inexplicably. Exported
 * so `explain` can report the real reason instead of `not-discovered`.
 */
export function defaultIgnoreReason(relativePath: string): string | null {
  const posixPath = relativePath.replace(/\\/g, "/");
  const parts = posixPath.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (DEFAULT_IGNORED_DIRS.includes(parts[i])) {
      return `built-in ignore: directory "${parts[i]}"`;
    }
    // A crashed atomic swap can leave `snapshot.backup-<pid>-<ts>` behind;
    // scanning our own leftovers back into the next snapshot is never intended.
    if (parts[i].startsWith("snapshot.backup-")) {
      return `built-in ignore: leftover snapshot backup "${parts[i]}"`;
    }
  }
  const base = parts[parts.length - 1];
  if (DEFAULT_IGNORED_FILES.includes(base)) {
    return `built-in ignore: filename "${base}"`;
  }
  return null;
}

/**
 * Lists paths git ignores, one entry per ignored directory (`--directory`
 * collapses them so `node_modules/` is a single line).
 *
 * They are needed because `--exclude-standard` hides them from the candidate
 * listing, which left a gitignored `.env` with no `skipped[]` record at all —
 * the manifest claimed nothing had been dropped.
 */
function listIgnoredPaths(cwd: string): string[] {
  try {
    const stdout = childProcess.execFileSync(
      "git",
      ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
      {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        maxBuffer: GIT_OUTPUT_LIMIT,
      }
    );
    return stdout
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.replace(/\\/g, "/"));
  } catch {
    return [];
  }
}

/**
 * True when `target` is a directory carrying this tool's ownership marker.
 */
function hasSnapshotMarker(target: string): boolean {
  try {
    return (
      fs.statSync(target).isDirectory() &&
      fs.existsSync(path.join(target, ".codebase-snapshot"))
    );
  } catch {
    return false;
  }
}

/**
 * True when a path belongs to this tool's own output rather than to the user.
 *
 * A run used to record its own output directory in `skipped[]` — run 1 skipped
 * nothing, run 2 skipped `snapshot` — so two identical runs produced different
 * manifests, and the monolith (which embeds the manifest) changed size with
 * them. A `--max-monolith-bytes` picked from run 1 could then flip a file off on
 * run 2. Output and crash leftovers are therefore excluded without a `skipped[]`
 * record, *provided the directory actually carries this tool's marker*, so two
 * identical runs stay identical.
 *
 * The name alone is not enough, and used to be treated as though it were. Every
 * directory called `snapshot`, `snapshot.tmp` or `snapshot.backup-*` was dropped
 * at any depth, so a directory the user committed under that name vanished from
 * the snapshot with nothing recorded anywhere — the opposite lie to the one the
 * `skipped[]` record exists to prevent. A directory with no marker is now an
 * ordinary directory: its contents are scanned like any others, unless it is the
 * configured output directory or the top-level `outDir`/`tmpDir` this run is
 * about to write (`toolOwnedPaths`), which cannot carry a marker on a first run.
 */
function makeToolOwnedDecider(
  cwd: string,
  toolOwnedPaths: readonly string[]
): (relativePath: string) => boolean {
  const markers = new Map<string, boolean>();
  const reservedPaths = new Set(toolOwnedPaths.filter((entry) => entry.length > 0));
  return (relativePath: string): boolean => {
    const parts = relativePath.replace(/\\/g, "/").split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join("/");
      let hasMarker = markers.get(prefix);
      if (hasMarker === undefined) {
        hasMarker = fs.existsSync(path.join(cwd, prefix, ".codebase-snapshot"));
        markers.set(prefix, hasMarker);
      }
      if (hasMarker) return true;
      if (reservedPaths.has(prefix)) return true;
    }
    return false;
  };
}

/** lstat-cached "is this path a link?" probe, used on the git discovery path. */
function makeLinkProbe(): (absolutePath: string) => boolean {
  const cache = new Map<string, boolean>();
  return (absolutePath: string): boolean => {
    let known = cache.get(absolutePath);
    if (known === undefined) {
      try {
        known = fs.lstatSync(absolutePath).isSymbolicLink();
      } catch {
        known = false;
      }
      cache.set(absolutePath, known);
    }
    return known;
  };
}

/**
 * Applies the "directory links are never followed" rule to paths that came from
 * git.
 *
 * `git ls-files` lists the tracked files *under* a junction, so the walker's
 * link policy never ran on the git path: the same content was emitted twice
 * (`aaa-link/UNIQUE.ts` and `zzz-target/UNIQUE.ts`) with an empty `skipped[]`.
 * Any candidate below a linked directory is dropped and the link is reported
 * once; a link that leads outside the root is reported as `outside-root`.
 */
function dropLinkedDirectories(
  cwd: string,
  candidates: string[],
  skipped: SkipRecord[]
): string[] {
  const isLink = makeLinkProbe();
  let rootReal = cwd;
  try {
    rootReal = fs.realpathSync(cwd);
  } catch {
    /* keep cwd */
  }

  const reported = new Set<string>();
  const kept: string[] = [];

  for (const candidate of candidates) {
    const parts = candidate.split("/");
    let linkedDir: string | null = null;
    // `depth <= parts.length` also tests the candidate itself: on a POSIX
    // checkout git records a symbolic link as an entry in its own right, so a
    // link to a directory arrived as a file called `aaa-link` and was emitted.
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join("/");
      if (isLink(path.join(cwd, prefix))) {
        linkedDir = prefix;
        break;
      }
    }
    if (linkedDir === null) {
      kept.push(candidate);
      continue;
    }
    if (reported.has(linkedDir)) continue;
    reported.add(linkedDir);

    const absolute = path.join(cwd, linkedDir);
    let targetReal = absolute;
    try {
      targetReal = fs.realpathSync(absolute);
    } catch {
      /* broken link: reported below */
    }
    const target = readLinkTarget(absolute, targetReal);
    const what = linkedDir === candidate ? "symbolic link" : "directory link";
    skipped.push(
      isInside(rootReal, targetReal)
        ? {
            path: linkedDir,
            reason: "symlink",
            detail: `${what} not followed (target: ${target})`,
          }
        : {
            path: linkedDir,
            reason: "outside-root",
            detail: `link target resolves outside the scanned root (target: ${target}); not followed`,
          }
    );
  }

  return kept;
}

/**
 * Lists candidates through `git ls-files`, recording ignored paths as skips.
 *
 * Extracted so `collectFiles` can choose between git and the walk without
 * duplicating the listing logic; a throw from here means git is unusable.
 */
function listGitCandidates(
  cwd: string,
  skipped: SkipRecord[],
  isToolOwned: (relativePath: string) => boolean
): string[] {
  const stdout = childProcess.execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_LIMIT,
    }
  );
  let candidates = stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/\\/g, "/"));

  // `git ls-files` reports the files *below* a directory link, so the link
  // policy the walker applies has to be re-applied to git's answer.
  candidates = dropLinkedDirectories(cwd, candidates, skipped);

  // Ignored paths are invisible to `--exclude-standard`. Record them so the
  // manifest can account for every file that exists but was not emitted.
  const known = new Set(candidates);
  for (const ignoredPath of listIgnoredPaths(cwd)) {
    const trimmed = ignoredPath.replace(/\/+$/, "");
    if (known.has(trimmed) || known.has(ignoredPath)) continue;
    if (isToolOwned(trimmed)) continue;
    if (isSensitivePath(trimmed)) {
      skipped.push({
        path: trimmed,
        reason: "sensitive-file",
        detail:
          "credential-bearing file, ignored by .gitignore; enable includeSensitiveFiles to emit it",
      });
    } else {
      // Recorded whether it is a file or a directory: the same `.gitignore`d
      // path outside a git repository produced a `gitignore` record, and the
      // manifest must not depend on which discovery path ran.
      skipped.push({
        path: trimmed,
        reason: "gitignore",
        detail: ignoredPath.endsWith("/")
          ? "ignored by .gitignore (directory, not descended)"
          : "ignored by .gitignore",
      });
    }
  }

  return candidates;
}

/**
 * Collects candidate file paths.
 *
 * Uses `git ls-files -z` when git is available: `-z` is required because the
 * default output C-quotes paths containing non-ASCII characters, which silently
 * mangled `src/café.ts` into a path that never existed and dropped the file.
 */
export function collectFiles(cwd: string, options: CollectOptions = {}): CollectResult {
  const includePatterns = options.includePatterns ?? [];
  const excludePatterns = options.excludePatterns ?? [];
  const includeSensitiveFiles = options.includeSensitiveFiles ?? false;
  const pathRules = options.secretRules;
  const toolOwnedPaths = new Set(
    (options.toolOwnedPaths ?? []).map((entry) => entry.replace(/\\/g, "/"))
  );
  const isToolOwned = makeToolOwnedDecider(cwd, [...toolOwnedPaths]);

  let candidates: string[];
  const skipped: SkipRecord[] = [];
  // Explicit, never a process-wide default: a module-level "current discovery mode"
  // meant the mode depended on the last `resolveConfig` that ran in the process, so one
  // caller could enumerate files differently from another — and a test that scanned two
  // projects in sequence got the first project's mode in the second.
  const discovery = options.discovery ?? "auto";

  if (discovery === "walk") {
    // The documented escape hatch. The walker reads every `.gitignore` it meets —
    // nested ones included — and still applies the secret deny list. What it cannot
    // reproduce is git's own ignore sources (`.git/info/exclude`, the global
    // `core.excludesFile`), git's inclusion of files that are tracked although a
    // `.gitignore` now matches them, and its treatment of a submodule as a single
    // entry instead of a tree to descend into.
    const walked = walkDirectory(cwd, cwd, rootRealFor(cwd), new Set<string>(), toolOwnedPaths);
    candidates = walked.files;
    for (const record of walked.skipped) skipped.push(record);
  } else {
    try {
      candidates = listGitCandidates(cwd, skipped, isToolOwned);
    } catch {
      // `git` mode promises git, so a directory without a usable repository is a
      // refusal rather than a quiet fallback to the walk.
      if (discovery === "git") {
        throw new Error(
          "Discovery mode is `git`, but git could not list this directory's files. " +
            "Run inside a working repository, or pass --discovery walk (or auto) to scan the tree " +
            "directly."
        );
      }
      // A walk changes what is scanned, and this directory claims to be a
      // repository: refuse rather than silently ship a different snapshot. The
      // reason names only what a walk genuinely cannot reproduce — nested
      // `.gitignore` files *are* honoured by it.
      if (fs.existsSync(path.join(cwd, ".git"))) {
        throw new Error(
          "This directory is a git repository, but git could not list its files. " +
            "A plain walk honours .gitignore files, but git also applies .git/info/exclude and " +
            "your global excludes file, includes files that are tracked although a .gitignore now " +
            "matches them, and treats a submodule as a single entry. " +
            "Fix the repository (git status should work), run outside git, or pass " +
            "--discovery walk to accept those differences."
        );
      }
      const walked = walkDirectory(cwd, cwd, rootRealFor(cwd), new Set<string>(), toolOwnedPaths);
      candidates = walked.files;
      // `push(...array)` would pass one argument per element; see the note in `walkDirectory`.
      for (const record of walked.skipped) skipped.push(record);
    }
  }

  const files = candidates
    .filter((file) => {
      // Our own output is bookkeeping, never a user-facing skip (C25).
      if (isToolOwned(file)) return false;
      const ignored = defaultIgnoreReason(file);
      if (ignored) {
        skipped.push({ path: file, reason: "default-ignore", detail: ignored });
        return false;
      }
      // `include` is an allow-list: when it is non-empty, anything it does not
      // match is out, and the reason is recorded so the omission is auditable
      // rather than a file that simply never appears.
      if (includePatterns.length > 0 && !includePatterns.some((pattern) => matchesExclude(file, pattern))) {
        skipped.push({
          path: file,
          reason: "excluded",
          detail: `does not match any include pattern (${includePatterns.join(", ")})`,
        });
        return false;
      }

      for (const pattern of excludePatterns) {
        if (matchesExclude(file, pattern)) {
          // The reason follows the rule's source: a preset's ecosystem ignore is
          // built-in (`default-ignore`), the developer's own glob is `excluded`.
          const fromPreset = PRESET_IGNORES.has(pattern);
          skipped.push({
            path: file,
            reason: fromPreset ? "default-ignore" : "excluded",
            detail: fromPreset
              ? `preset ignore: "${pattern}"`
              : `matches exclude pattern "${pattern}"`,
          });
          return false;
        }
      }

      if (!includeSensitiveFiles && isSensitivePath(file)) {
        skipped.push({
          path: file,
          reason: "sensitive-file",
          detail: "credential-bearing file; enable includeSensitiveFiles to emit it",
        });
        return false;
      }

      const secret = findSecretInPath(file, pathRules);
      if (secret) {
        skipped.push({
          path: secret.masked,
          reason: "sensitive-path",
          detail:
            `path matches secret rule "${secret.rules.join('", "')}"; the file was skipped and ` +
            "its path is masked here because paths are emitted into every artifact",
        });
        return false;
      }
      return true;
    })
    .sort();

  // Every recorded path is masked, whatever the reason: `sensitive-path` used to
  // be the only route that consulted the rules, so `certs/AKIA….key` reached
  // `manifest.skipped[].path` and the audit table raw as a `sensitive-file` skip.
  // Records are masked here as well as at the artifact sinks: this is the value every
  // consumer sees, and a path that leaks a token is worse than a skipped file.
  return { files, skipped: maskSkipPaths(skipped, pathRules) };
}

/**
 * Real path of the scanned root, resolved once per `collectFiles` call.
 *
 * `walkDirectory` used to call `fs.realpathSync` for every directory it entered
 * — once for the directory and once for the root — which is O(depth) per call on
 * Windows and therefore O(depth²) for a deep tree (79 s at 1,000 levels). The
 * walk never follows a directory link, so no per-directory realpath is needed;
 * only link *targets* are resolved, when one is encountered.
 */
function rootRealFor(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

/** One directory being walked, with the position reached inside it. */
interface WalkFrame {
  dir: string;
  entries: fs.Dirent[];
  index: number;
  gitignoreLayers: readonly GitignoreLayer[];
}

/**
 * Walks `dir` depth-first without recursing.
 *
 * A recursive walker is one directory per stack frame, so a path 2 400 levels deep overflowed the
 * JavaScript stack and killed every command — `generate`, `validate`, `report`, `explain` — on a
 * tree that is otherwise perfectly readable. An explicit frame stack makes the depth a memory
 * question rather than a crash, and it visits entries in exactly the order the recursion did, so
 * manifests stay byte-identical.
 */
function walkDirectory(
  dir: string,
  baseDir: string,
  rootReal: string,
  visited: Set<string>,
  reservedPaths: ReadonlySet<string> = new Set<string>(),
  parentGitignoreLayers: readonly GitignoreLayer[] = []
): CollectResult {
  const results: CollectResult = { files: [], skipped: [] };
  const stack: WalkFrame[] = [];

  const relativeToBase = (target: string): string =>
    path.relative(baseDir, target).replace(/\\/g, "/") || ".";

  /** Reads one directory and pushes its frame; false when it cannot be walked. */
  const enter = (current: string, layers: readonly GitignoreLayer[]): boolean => {
    // Directory links are never descended (see the symlink branch below), so the tree really is a
    // tree; the visited guard is cheap insurance against a filesystem that reports a reparse point
    // as a plain directory.
    if (visited.has(current)) return false;
    visited.add(current);

    const localRules = readGitignoreRules(current);
    const gitignoreLayers: readonly GitignoreLayer[] =
      localRules.length === 0
        ? layers
        : [
            ...layers,
            { prefix: path.relative(baseDir, current).replace(/\\/g, "/"), rules: localRules },
          ];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      results.skipped.push({
        path: relativeToBase(current),
        reason: "read-error",
        detail: "directory unreadable",
      });
      return false;
    }

    stack.push({ dir: current, entries, index: 0, gitignoreLayers });
    return true;
  };

  const rootFrame = enter(dir, parentGitignoreLayers);
  if (!rootFrame) return results;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as WalkFrame;
    if (frame.index >= frame.entries.length) {
      stack.pop();
      continue;
    }
    const entry = frame.entries[frame.index] as fs.Dirent;
    frame.index += 1;

    const fullPath = path.join(frame.dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

    // Without git there is no candidate listing to filter later, so this is the only place an
    // omission can be reported. The exception is the tool's own output directory for this run,
    // which cannot carry a marker before its first run.
    //
    // `reservedPaths` already holds exactly the directories this run writes, so the name
    // check that used to sit beside it only had the effect of *not* skipping a custom
    // outDir: with `outDir: ".context"`, `isToolOwnedDirName(".context")` is false, the
    // walker descended into it, and an empty or gitignored `.context` was recorded in
    // `skipped[]` on the first run and omitted on later ones once it carried a marker —
    // so two identical runs produced different manifests.
    if (reservedPaths.has(relPath)) continue;
    if (entry.isDirectory() && DEFAULT_IGNORED_DIRS.includes(entry.name)) {
      results.skipped.push({
        path: relPath,
        reason: "default-ignore",
        detail: `built-in ignore: directory "${entry.name}" (not descended)`,
      });
      continue;
    }
    if (DEFAULT_IGNORED_FILES.includes(entry.name) || entry.name.startsWith("snapshot.backup-")) {
      results.skipped.push({
        path: relPath,
        reason: "default-ignore",
        detail: "built-in ignore: filename",
      });
      continue;
    }

    if (gitignoreVerdict(frame.gitignoreLayers, relPath, entry.isDirectory()) === true) {
      // A gitignored custom output directory is our own bookkeeping, not a
      // user-facing skip (C25).
      if (!hasSnapshotMarker(fullPath)) {
        results.skipped.push({
          path: relPath,
          reason: isSensitivePath(relPath) ? "sensitive-file" : "gitignore",
          detail: "ignored by .gitignore",
        });
      }
      continue;
    }

    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      // A directory link is NEVER followed.
      //
      // Following one duplicated content: with `zzz-target/UNIQUE.ts` and a
      // junction `aaa-link -> zzz-target`, the walker emitted `aaa-link/UNIQUE.ts`
      // and the real path, so which name was recorded depended on directory order
      // and the manifest was not stable across filesystems. Following a junction
      // could also pull files in from outside the repository. A file link still
      // follows, but only while its target stays inside the root.
      let targetReal: string;
      try {
        targetReal = fs.realpathSync(fullPath);
      } catch {
        results.skipped.push({ path: relPath, reason: "read-error", detail: "broken symlink" });
        continue;
      }

      let stats: fs.Stats;
      try {
        stats = fs.statSync(fullPath);
      } catch {
        results.skipped.push({ path: relPath, reason: "read-error", detail: "unreadable symlink" });
        continue;
      }

      const linkTarget = readLinkTarget(fullPath, targetReal);

      // Containment is decided first: "this link points outside the repository"
      // is the accurate reason for a junction onto an external directory, and it
      // is the security-relevant one.
      if (!isInside(rootReal, targetReal)) {
        results.skipped.push({
          path: relPath,
          reason: "outside-root",
          detail: `link target resolves outside the scanned root (target: ${linkTarget}); not followed`,
        });
        continue;
      }
      if (stats.isDirectory()) {
        results.skipped.push({
          path: relPath,
          reason: "symlink",
          detail: `directory link not followed (target: ${linkTarget})`,
        });
        continue;
      }
      if (!stats.isFile()) {
        results.skipped.push({
          path: relPath,
          reason: "symlink",
          detail: `link to neither a file nor a directory (target: ${linkTarget})`,
        });
        continue;
      }
      isDirectory = false;
      isFile = true;
    }

    if (isDirectory) {
      // Descending here, before the rest of this frame, is what keeps the visit order identical to
      // the recursive version this replaced.
      enter(fullPath, frame.gitignoreLayers);
    } else if (isFile) {
      results.files.push(relPath);
    }
  }

  return results;
}
