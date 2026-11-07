/**
 * The set of files a change touched.
 *
 * Reviewing a pull request with a model is the case this exists for: the diff is small, the
 * repository is not, and packing all of it costs a context window to answer a question about
 * four files. `--changed-since main` narrows the snapshot to what actually moved.
 *
 * The set is computed with git rather than by guessing, and every failure is an error rather
 * than an empty set: a typo in the ref would otherwise produce a snapshot of nothing, which
 * reads as "this PR changed no files" — the most expensive possible wrong answer.
 */
import { execFileSync } from "node:child_process";

export interface ChangedScopeRequest {
  /** A git ref to compare the working tree against (`main`, `HEAD~3`, a sha). */
  changedSince?: string;
  /** Only what is staged for the next commit. */
  staged?: boolean;
}

export interface ChangedScope {
  /** Repository-relative paths, POSIX separators. */
  paths: ReadonlySet<string>;
  /** How the set was produced, for the manifest and the summary line. */
  detail: string;
}

/** Runs git and returns NUL-separated paths, or throws with a message worth reading. */
function gitPaths(cwd: string, args: string[]): string[] {
  let output: string;
  try {
    output = execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    const reason = stderr.trim() || (err as Error).message;
    throw new Error(
      `Could not list changed files (git ${args.join(" ")}): ${reason}. ` +
        "A changed-files snapshot needs a git working tree and a ref that exists; " +
        "run `codebase-snapshot generate` without --changed-since to scan everything."
    );
  }
  return output
    .split("\0")
    .map((entry) => entry.trim().replace(/\\/g, "/"))
    .filter((entry) => entry.length > 0);
}

/**
 * Rejects a ref that git would read as an option.
 *
 * The ref is the one argument a caller can put into `git diff`'s command line, so a value
 * starting with `-` is a flag injection rather than a revision: `--changed-since=-o/etc/passwd`
 * reached git as `--output=…`, and a config file — which can be committed by a pull request and
 * is read by a CI job — is enough to supply one. A leading `-` is never a ref name (git refuses
 * to create one), so refusing it loses nothing.
 */
function assertUsableRef(ref: string): void {
  if (ref.startsWith("-")) {
    throw new Error(
      `--changed-since must be a git ref, not an option (received ${JSON.stringify(ref)}). ` +
        "Name a branch, tag, or commit such as `main` or `HEAD~1`."
    );
  }
}

/**
 * Resolves the request into a path set.
 *
 * `--changed-since <ref>` is the working tree against that ref — committed, staged and
 * unstaged changes all count, because all three are what a reviewer is looking at — plus
 * untracked files, which `git diff` never lists and which are exactly what a new feature
 * starts with. `--staged` is the index against `HEAD`. Both together are a union.
 */
export function resolveChangedScope(cwd: string, request: ChangedScopeRequest): ChangedScope {
  const paths = new Set<string>();
  const descriptions: string[] = [];

  if (request.changedSince !== undefined) {
    assertUsableRef(request.changedSince);
    // The trailing `--` separates revisions from paths, so nothing after it can be read as one.
    // `--relative` keeps the listing relative to the directory git runs in (the scan root), and
    // no `--full-name` is passed: mixing the two bases produces paths that match nothing.
    for (const path of gitPaths(cwd, [
      "diff",
      "--name-only",
      "-z",
      "--relative",
      request.changedSince,
      "--",
    ])) {
      paths.add(path);
    }
    for (const path of gitPaths(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"])) {
      paths.add(path);
    }
    descriptions.push(`changed since ${request.changedSince}`);
  }

  if (request.staged === true) {
    for (const path of gitPaths(cwd, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--relative",
      "--",
    ])) {
      paths.add(path);
    }
    descriptions.push("staged");
  }

  return { paths, detail: descriptions.join(" and ") };
}
