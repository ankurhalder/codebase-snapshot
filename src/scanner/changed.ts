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
  /** The subset selected by `--staged`, whose bytes must come from the index. */
  stagedPaths: ReadonlySet<string>;
  /** Paths whose staged change is a deletion; they have no index blob to read. */
  deletedPaths: ReadonlySet<string>;
  /** How the set was produced, for the manifest and the summary line. */
  detail: string;
}

/**
 * Runs git and returns NUL-separated paths, or throws with a message worth reading.
 *
 * The output is used verbatim: git emits literal paths with `-z`, so neither `trim()` nor a
 * backslash rewrite is safe. A legal POSIX filename may begin or end with whitespace, and a
 * backslash is a legal character in a name on every platform. Both were rewritten, which made
 * the scope describe a path that does not exist — silently omitting the changed file, or worse,
 * matching a different file that did not change.
 */
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
  return output.split("\0").filter((entry) => entry.length > 0);
}

/**
 * Reads one path's staged bytes from the index.
 *
 * `--staged` used to select index *paths* and then read working-tree *bytes*, so a file with
 * staged changes plus later unstaged edits was snapshotted at content that is not what the next
 * commit will contain. `git cat-file blob :<path>` returns exactly the staged object.
 *
 * Returns `null` when the path has no blob in the index (a staged deletion). The caller records
 * that as `deleted` rather than letting it disappear.
 */
export function readStagedBlob(cwd: string, relativePath: string): Buffer | null {
  try {
    return execFileSync("git", ["cat-file", "blob", `:${relativePath}`], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch {
    return null;
  }
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
  const stagedPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  const descriptions: string[] = [];

  if (request.changedSince !== undefined) {
    assertUsableRef(request.changedSince);
    // The trailing `--` separates revisions from paths, so nothing after it can be read as one.
    // `--relative` keeps the listing relative to the directory git runs in (the scan root), and
    // no `--full-name` is passed: mixing the two bases produces paths that match nothing.
    // Three dots, not two: `<ref>...HEAD` is the diff from the merge base, so a feature branch
    // that forked a week ago does not inherit every commit `main` has taken since. Two dots
    // compared the ref's tree with the branch tip and listed those unrelated files as changed.
    for (const path of gitPaths(cwd, [
      "diff",
      "--name-only",
      "-z",
      "--relative",
      `${request.changedSince}...HEAD`,
      "--",
    ])) {
      paths.add(path);
    }
    // Reviews also cover what is not committed yet: the working tree against HEAD, which is the
    // same set two dots produced for the ref when the ref *was* HEAD.
    for (const path of gitPaths(cwd, [
      "diff",
      "--name-only",
      "-z",
      "--relative",
      "HEAD",
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
      stagedPaths.add(path);
    }
    for (const path of gitPaths(cwd, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--relative",
      "--diff-filter=D",
      "--",
    ])) {
      deletedPaths.add(path);
    }
    descriptions.push("staged");
  }

  return { paths, stagedPaths, deletedPaths, detail: descriptions.join(" and ") };
}
