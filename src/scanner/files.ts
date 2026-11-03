import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SkipRecord } from "../types.js";

export interface GitInfo {
  branch: string;
  commit: string;
  isDirty: boolean;
}

export interface CollectOptions {
  excludePatterns?: string[];
  /**
   * Emit credential-bearing files (`.env`, `*.pem`, `.npmrc`, `id_rsa`, …).
   * Default `false`: they are skipped with `reason: "sensitive-file"`.
   */
  includeSensitiveFiles?: boolean;
}

export interface CollectResult {
  files: string[];
  skipped: SkipRecord[];
}

export function getGitInfo(cwd: string, fallbackBranch = "main"): GitInfo {
  try {
    const branch =
      childProcess
        .execSync("git rev-parse --abbrev-ref HEAD", {
          cwd,
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8",
        })
        .trim() || fallbackBranch;

    const commit =
      childProcess
        .execSync("git rev-parse HEAD", {
          cwd,
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8",
        })
        .trim() || "unknown";

    const status = childProcess
      .execSync("git status --porcelain", {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      })
      .trim();

    return { branch, commit, isDirty: status.length > 0 };
  } catch {
    return { branch: fallbackBranch, commit: "unknown", isDirty: false };
  }
}

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
  "snapshot",
  "snapshot.tmp",
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
  /^(?:\.env(?:[._-][A-Za-z0-9_-]*)*|\.env(?:backup|bak|old|orig|copy|save)|\.envrc|\.npmrc(?:\.[A-Za-z0-9_-]+)?|\.yarnrc(?:\.yml)?|\.netrc(?:\.[A-Za-z0-9_-]+)?|\.git-credentials|\.htpasswd|\.pgpass|id_[a-z0-9_]+(?:\.[A-Za-z0-9_-]+)?|credentials(?:\.json)?|service[-_]?account(?:\.[a-z0-9_-]+)*\.json|secrets?\.(?:json|ya?ml))$/i;
const SENSITIVE_PATH =
  /(?:^|\/)\.(?:aws|ssh|gnupg)\/|(?:^|\/)\.docker\/config\.json$|(?:^|\/)\.kube\/config$/i;
const SENSITIVE_EXT = /\.(?:pem|key|p12|pfx|jks|keystore|ppk|asc|kdbx|tfstate|tfvars)$/i;

/** `name.example`, `name.sample.json`, `id_rsa.template`, … */
const TEMPLATE_SUFFIX = /\.(?:example|sample|template|dist)(?=$|[.])/i;

const matchesSensitiveList = (posixPath: string, base: string): boolean =>
  SENSITIVE_BASENAME.test(base) ||
  SENSITIVE_PATH.test(posixPath) ||
  SENSITIVE_EXT.test(base);

export function isSensitivePath(relativePath: string): boolean {
  const posixPath = relativePath.replace(/\\/g, "/");
  const base = posixPath.split("/").pop() ?? posixPath;

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
 * Translates a glob (`**`, `*`, `?`) into a RegExp. A pattern without a leading
 * `/` matches at any depth, mirroring `.gitignore` semantics.
 */
export function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const anchored = normalized.startsWith("/");
  const body = anchored ? normalized.slice(1) : normalized;

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
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }

  const prefix = anchored || body.includes("/") ? "^" : "(?:^|.*/)";
  return new RegExp(`${prefix}${out}(?:/.*)?$`);
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

  if (cleaned.includes("*") || cleaned.includes("?")) {
    return globToRegExp(cleaned).test(posixPath);
  }

  return (
    posixPath === cleaned ||
    posixPath.startsWith(`${cleaned}/`) ||
    posixPath.includes(`/${cleaned}/`) ||
    posixPath.endsWith(`/${cleaned}`)
  );
}

/** Reads `<dir>/.gitignore` (single level) and returns an ordered matcher. */
function readGitignoreMatcher(dir: string): (relativePath: string) => boolean {
  const gitignorePath = path.join(dir, ".gitignore");
  let raw: string;
  try {
    raw = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    return () => false;
  }

  const rules: Array<{ pattern: string; negated: boolean; dirOnly: boolean }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const negated = trimmed.startsWith("!");
    let pattern = negated ? trimmed.slice(1) : trimmed;
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    if (pattern) rules.push({ pattern, negated, dirOnly });
  }

  return (relativePath: string): boolean => {
    let ignored = false;
    for (const rule of rules) {
      const target = rule.dirOnly
        ? relativePath.replace(/\/.*$/, "")
        : relativePath;
      if (matchesExclude(target, rule.pattern)) ignored = !rule.negated;
    }
    return ignored;
  };
}

function isDefaultIgnored(relativePath: string): boolean {
  const posixPath = relativePath.replace(/\\/g, "/");
  const parts = posixPath.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (DEFAULT_IGNORED_DIRS.includes(parts[i])) return true;
  }
  const base = parts[parts.length - 1];
  return DEFAULT_IGNORED_FILES.includes(base);
}

/**
 * Collects candidate file paths.
 *
 * Uses `git ls-files -z` when git is available: `-z` is required because the
 * default output C-quotes paths containing non-ASCII characters, which silently
 * mangled `src/café.ts` into a path that never existed and dropped the file.
 */
export function collectFiles(cwd: string, options: CollectOptions = {}): CollectResult {
  const excludePatterns = options.excludePatterns ?? [];
  const includeSensitiveFiles = options.includeSensitiveFiles ?? false;

  let candidates: string[];
  let walkSkips: SkipRecord[] = [];

  try {
    const stdout = childProcess.execSync(
      "git ls-files -z --cached --others --exclude-standard",
      {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      }
    );
    candidates = stdout
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.replace(/\\/g, "/"));
  } catch {
    const walked = walkDirectory(cwd, cwd, new Set<string>());
    candidates = walked.files;
    walkSkips = walked.skipped;
  }

  const skipped: SkipRecord[] = [...walkSkips];

  const files = candidates
    .filter((file) => {
      if (isDefaultIgnored(file)) return false;
      for (const pattern of excludePatterns) {
        if (matchesExclude(file, pattern)) return false;
      }
      if (!includeSensitiveFiles && isSensitivePath(file)) {
        skipped.push({
          path: file,
          reason: "sensitive-file",
          detail: "credential-bearing file; enable includeSensitiveFiles to emit it",
        });
        return false;
      }
      return true;
    })
    .sort();

  return { files, skipped };
}

function walkDirectory(
  dir: string,
  baseDir: string,
  visited: Set<string>
): CollectResult {
  const results: CollectResult = { files: [], skipped: [] };

  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    realDir = dir;
  }
  if (visited.has(realDir)) return results;
  visited.add(realDir);

  const ignoredByGitignore = dir === baseDir ? readGitignoreMatcher(baseDir) : () => false;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    results.skipped.push({ path: dir, reason: "read-error", detail: "directory unreadable" });
    return results;
  }

  for (const entry of entries) {
    if (DEFAULT_IGNORED_DIRS.includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
    if (ignoredByGitignore(relPath)) continue;

    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();

    if (entry.isSymbolicLink()) {
      // Symlinks are neither isDirectory() nor isFile(); previously they were
      // dropped without a trace.
      try {
        const stats = fs.statSync(fullPath);
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
        if (!isDirectory && !isFile) {
          results.skipped.push({ path: relPath, reason: "symlink", detail: "not a file or directory" });
          continue;
        }
        results.skipped.push({
          path: relPath,
          reason: "symlink",
          detail: isDirectory ? "followed directory symlink" : "followed file symlink",
        });
      } catch {
        results.skipped.push({ path: relPath, reason: "read-error", detail: "broken symlink" });
        continue;
      }
    }

    if (isDirectory) {
      const nested = walkDirectory(fullPath, baseDir, visited);
      results.files.push(...nested.files);
      results.skipped.push(...nested.skipped);
    } else if (isFile) {
      results.files.push(relPath);
    }
  }

  return results;
}
