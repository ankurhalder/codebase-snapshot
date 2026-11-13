/**
 * The pre-commit hook that keeps a snapshot honest.
 *
 * `docs/stale-context-is-your-bug.md` makes the argument: a snapshot is only trustworthy if
 * something gates on it, and `validate` exists to be that gate. What was missing is the
 * thirty seconds of work between reading that argument and having it — generating the hook
 * by hand, getting the git directory right (a worktree and a submodule both put `.git`
 * somewhere else), and remembering `chmod +x`.
 *
 * Two rules from this repository apply to writing into someone's `.git`:
 *
 *  - **Never destroy user data.** An existing `pre-commit` that this tool did not write is
 *    left exactly as it is, and the note says what to add to it. There is no flag to force
 *    the overwrite, deliberately: a hook is a file someone else may depend on, and the cost
 *    of asking again is thirty seconds.
 *  - **Say what happened.** Every outcome — written, already ours, someone else's, no git
 *    here — is reported, and a caller that cannot write says why instead of exiting 0.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { GENERATOR_NAME } from "../version.js";

/** Marks a hook this tool wrote, so a re-run may replace it and a user can recognise it. */
export const HOOK_MARKER = `# ${GENERATOR_NAME}: pre-commit snapshot check`;

/**
 * The hook body.
 *
 * It runs `npx <package> validate`, which exits non-zero when the snapshot no longer matches
 * the tree, and it counts anything unexpected as a failure to check rather than a pass: a
 * gate that fails open is not a gate.
 */
/** Escapes a value for use inside a POSIX double-quoted shell word. */
function shellQuote(value: string): string {
  return value.replace(/[\\"`$]/g, (character) => `\\${character}`);
}

/**
 * The hook body, with the configured output directory baked in.
 *
 * The directory used to be hardcoded to `snapshot`. A project configured with `outDir:
 * ".context"` got a hook whose guard never matched, so it printed "no snapshot found, skipping
 * the staleness check" and exited 0 on every commit — a gate that silently never ran, which is
 * the one failure mode a commit gate must not have. The path is fixed here because the hook is
 * a shell script and has no way to read the config.
 *
 * The guard tests the **manifest**, not the directory: a directory left behind by a failed run
 * exists but holds no snapshot, and `[ ! -d … ]` was false for it, so the hook went on to run
 * `validate` on nothing.
 */
function hookScript(outDir: string): string {
  const dir = shellQuote(outDir.replace(/\\/g, "/"));
  return `#!/bin/sh
${HOOK_MARKER}
#
# Refuse the commit when the snapshot is out of date with the tree.
#
# Remove this file to stop the check, or edit it — a hook this tool did not write is never
# overwritten, and neither is one it did: run \`${GENERATOR_NAME} init --install-hook\` again
# to restore the body below.
set -e

SNAPSHOT_DIR="${dir}"

if [ ! -f "$SNAPSHOT_DIR/manifest.json" ]; then
  # Fail closed. A missing snapshot used to exit 0 with a reassuring message, so deleting or
  # renaming the output directory disabled the gate while every commit still succeeded — the one
  # failure mode a commit gate must not have. The opt-out is explicit and documented.
  if [ "\${CODEBASE_SNAPSHOT_ALLOW_MISSING:-}" = "1" ]; then
    echo "${GENERATOR_NAME}: no snapshot in $SNAPSHOT_DIR; skipping the check (CODEBASE_SNAPSHOT_ALLOW_MISSING=1)." >&2
    exit 0
  fi
  echo "${GENERATOR_NAME}: refusing the commit: no snapshot in $SNAPSHOT_DIR." >&2
  echo "  Run \\"npx ${GENERATOR_NAME} generate\\", stage it, and commit again." >&2
  echo "  To disable this gate, set CODEBASE_SNAPSHOT_ALLOW_MISSING=1." >&2
  exit 1
fi

if ! npx --no-install ${GENERATOR_NAME} validate >/dev/null 2>&1; then
  echo "${GENERATOR_NAME}: the snapshot is out of date." >&2
  echo "  Run \\"npx ${GENERATOR_NAME} generate\\", stage the change, and commit again." >&2
  echo "  (npx --no-install is used on purpose: this hook must not install anything)" >&2
  exit 1
fi
`;
}

export interface HookInstallResult {
  /** Absolute path of the hook file, or `null` when there was nowhere to write it. */
  path: string | null;
  /** True when this call wrote (or rewrote) the hook. */
  written: boolean;
  /** Human-readable outcomes, always at least one. */
  notes: string[];
}

/**
 * Resolves the repository's git directory.
 *
 * `.git` is a directory in a normal checkout and a *file* containing `gitdir: <path>` in a
 * worktree or a submodule. Writing to `<cwd>/.git/hooks` in those cases fails with ENOTDIR,
 * which is the kind of error that makes a feature look broken rather than unavailable.
 */
function gitDirectory(cwd: string): string | null {
  const dotGit = path.join(cwd, ".git");
  let stats: fs.Stats;
  try {
    stats = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stats.isDirectory()) return dotGit;
  if (!stats.isFile()) return null;

  try {
    const contents = fs.readFileSync(dotGit, "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(contents);
    if (!match) return null;
    const target = match[1] as string;
    const resolved = path.isAbsolute(target.trim()) ? target.trim() : path.join(cwd, target.trim());
    if (!fs.statSync(resolved).isDirectory()) return null;
    // A `.git` file is repository-controlled input: a cloned archive can point it at any
    // directory the user can write, and `init --install-hook` would then write an executable
    // script there. Accept only a target inside the repository, or the registered worktree
    // metadata that names this checkout back.
    if (isInside(path.resolve(cwd), path.resolve(resolved))) return resolved;
    return isRegisteredWorktree(path.resolve(resolved), cwd) ? resolved : null;
  } catch {
    return null;
  }
}

/** True when `child` is `parent` or inside it. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * True when `gitDir` is the metadata git itself registered for this worktree.
 *
 * A linked worktree's git directory lives in the main repository and carries a `gitdir` file
 * naming the worktree's own `.git`. That back-reference is what separates a worktree the user
 * created from a `.git` file a repository archive invented to redirect a write.
 */
function isRegisteredWorktree(gitDir: string, cwd: string): boolean {
  try {
    const back = fs.readFileSync(path.join(gitDir, "gitdir"), "utf8").trim();
    return path.resolve(gitDir, back) === path.join(path.resolve(cwd), ".git");
  } catch {
    return false;
  }
}

/** Runs git in `cwd` and returns trimmed stdout, or null when git cannot answer. */
function gitOutput(cwd: string, args: string[]): string | null {
  try {
    const output = childProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * The hooks directory git will actually run, or a refusal.
 *
 * `git rev-parse --git-path hooks` is the only answer that honours `core.hooksPath` (Husky sets
 * `.husky/_`) and a linked worktree's shared hooks directory. Writing `.git/hooks/pre-commit`
 * regardless produced a gate that git never ran while reporting success.
 *
 * A configured path outside the repository is refused rather than written: it belongs to another
 * repository or to the user's home directory, and a hook is an executable file.
 */
function configuredHooksDirectory(cwd: string): { dir: string } | { refusal: string } | null {
  const hooks = gitOutput(cwd, ["rev-parse", "--git-path", "hooks"]);
  if (hooks === null) return null;
  const resolved = path.resolve(cwd, hooks);
  const common = gitOutput(cwd, ["rev-parse", "--git-common-dir"]);
  const commonDir = common === null ? null : path.resolve(cwd, common);
  if (isInside(path.resolve(cwd), resolved)) return { dir: resolved };
  if (commonDir !== null && isInside(commonDir, resolved)) return { dir: resolved };
  return {
    refusal:
      `The hooks directory git reports (${resolved}) is outside this repository, so no hook was ` +
      `written. Add \`npx ${GENERATOR_NAME} validate\` to the hook manager that owns it instead.`,
  };
}

/**
 * Installs (or refreshes) the pre-commit hook.
 *
 * Idempotent: a hook carrying {@link HOOK_MARKER} is replaced with the current body, so an
 * upgrade of this package updates the check. Anyone else's hook is untouched.
 */
export function installPreCommitHook(cwd: string, outDir = "snapshot"): HookInstallResult {
  const configured = configuredHooksDirectory(cwd);
  if (configured !== null && "refusal" in configured) {
    return { path: null, written: false, notes: [configured.refusal] };
  }
  const gitDir = configured === null ? gitDirectory(cwd) : null;
  if (configured === null && gitDir === null) {
    return {
      path: null,
      written: false,
      notes: [
        "Not a git working tree (no .git directory or gitdir link), so no pre-commit hook was installed.",
      ],
    };
  }

  const hooksDir = configured === null ? path.join(gitDir as string, "hooks") : configured.dir;
  const hookPath = path.join(hooksDir, "pre-commit");

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch (err) {
    return {
      path: hookPath,
      written: false,
      notes: [`Could not create ${hooksDir}: ${(err as Error).message}`],
    };
  }

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(hookPath, "utf8");
  } catch {
    existing = null;
  }

  if (existing !== null && !existing.includes(HOOK_MARKER)) {
    // Someone else's hook. Not ours to replace, and not an error: the user asked for a
    // check, not for the removal of one they wrote.
    return {
      path: hookPath,
      written: false,
      notes: [
        `${hookPath} already exists and was not written by ${GENERATOR_NAME}; it was left untouched.`,
        `Add \`npx ${GENERATOR_NAME} validate\` to it to get the same check.`,
      ],
    };
  }

  try {
    fs.writeFileSync(hookPath, hookScript(outDir), "utf8");
    // git refuses to run a hook that is not executable, and on Windows the bit is ignored —
    // so this is best-effort with a note rather than a failure.
    fs.chmodSync(hookPath, 0o755);
  } catch (err) {
    return {
      path: hookPath,
      written: false,
      notes: [`Could not write ${hookPath}: ${(err as Error).message}`],
    };
  }

  return {
    path: hookPath,
    written: true,
    notes: [
      existing === null
        ? `Installed ${hookPath}: commits are refused while the snapshot is out of date.`
        : `Updated ${hookPath} to the current ${GENERATOR_NAME} check.`,
    ],
  };
}
