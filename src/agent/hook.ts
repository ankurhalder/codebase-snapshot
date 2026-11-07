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
const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER}
#
# Refuse the commit when the snapshot is out of date with the tree.
#
# Remove this file to stop the check, or edit it — a hook this tool did not write is never
# overwritten, and neither is one it did: run \`${GENERATOR_NAME} init --install-hook\` again
# to restore the body below.
set -e

if [ ! -d snapshot ] && [ ! -f snapshot/manifest.json ]; then
  echo "${GENERATOR_NAME}: no snapshot found, skipping the staleness check." >&2
  echo "  Run \\"npx ${GENERATOR_NAME} generate\\" to create one." >&2
  exit 0
fi

if ! npx --no-install ${GENERATOR_NAME} validate >/dev/null 2>&1; then
  echo "${GENERATOR_NAME}: the snapshot is out of date." >&2
  echo "  Run \\"npx ${GENERATOR_NAME} generate\\", stage the change, and commit again." >&2
  echo "  (npx --no-install is used on purpose: this hook must not install anything)" >&2
  exit 1
fi
`;

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
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Installs (or refreshes) the pre-commit hook.
 *
 * Idempotent: a hook carrying {@link HOOK_MARKER} is replaced with the current body, so an
 * upgrade of this package updates the check. Anyone else's hook is untouched.
 */
export function installPreCommitHook(cwd: string): HookInstallResult {
  const gitDir = gitDirectory(cwd);
  if (gitDir === null) {
    return {
      path: null,
      written: false,
      notes: [
        "Not a git working tree (no .git directory or gitdir link), so no pre-commit hook was installed.",
      ],
    };
  }

  const hooksDir = path.join(gitDir, "hooks");
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
    fs.writeFileSync(hookPath, HOOK_SCRIPT, "utf8");
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
