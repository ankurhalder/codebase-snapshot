import * as fs from "node:fs";
import * as path from "node:path";

import { appendGitignoreEntries, gitignorePath } from "../gitignore.js";
import { SKILL_NAME, renderSkill } from "./skill.js";

export type SkillTarget = "claude" | "cursor" | "all";
export const SKILL_TARGETS: SkillTarget[] = ["claude", "cursor", "all"];

export interface SkillWrite {
  target: Exclude<SkillTarget, "all">;
  path: string;
  action: "created" | "updated" | "unchanged";
}

export interface SkillInstallResult {
  cwd: string;
  written: SkillWrite[];
  /** Paths added to `.gitignore`, so an install does not leave untracked files behind. */
  gitignored: string[];
  /** Anything the user has to know but that did not stop the install. */
  notes: string[];
}

const REFUSED = "Refusing to install the agent skill";

/**
 * The marker 4.1.0 and earlier wrapped its `AGENTS.md` section in.
 *
 * Nothing writes it any more (see `installSkill`); it is matched only to tell a
 * repository that still carries one that the block is still there and no longer
 * maintained.
 */
const LEGACY_AGENTS_MARKER = "<!-- codebase-snapshot:skill:start -->";

/** Where each target puts the skill, relative to the repository root. */
function targetPath(cwd: string, target: Exclude<SkillTarget, "all">): string {
  switch (target) {
    case "claude":
      return path.join(cwd, ".claude", "skills", SKILL_NAME, "SKILL.md");
    case "cursor":
      return path.join(cwd, ".cursor", "rules", `${SKILL_NAME}.mdc`);
  }
}

/**
 * Refuses a target path that resolves outside the repository.
 *
 * `skill --install` is the one command that writes into a repository it did not
 * create, so the write has to be proved to land inside it. Two escape routes
 * exist and both are checked here, before any directory or file is created:
 *
 * - **Links in the path.** A symlink — and an NTFS junction, which `lstat` and
 *   `realpath` treat the same way — is followed by the filesystem, so a linked
 *   `.claude/` used to seed `.claude/skills/…/SKILL.md` outside the repository.
 *   The nearest *existing* ancestor is resolved with `realpath`: resolving before
 *   creating anything means the check cannot be defeated by a directory that only
 *   exists outside.
 * - **A hard link at the target itself.** A hard link has no second path to
 *   resolve — it is the same inode under another name — so `realpath` cannot see
 *   it. `lstat` reports `nlink > 1`, which is the only signal available; the
 *   trade-off is that a deliberate in-repository hard link is refused too. The
 *   message says so, and the fix is to replace it with an ordinary file.
 */
function assertWritableInsideRepository(cwd: string, filePath: string): void {
  const root = fs.realpathSync(cwd);
  const shown = path.relative(root, filePath) || filePath;

  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    stat = null;
  }

  if (stat !== null && stat.isSymbolicLink()) {
    throw new Error(
      `${REFUSED}: ${shown} is a symbolic link or junction. Remove the link, or write the ` +
        `skill into the directory it points at yourself, and run again.`
    );
  }
  if (stat !== null && stat.isFile() && stat.nlink > 1) {
    throw new Error(
      `${REFUSED}: ${shown} has ${stat.nlink} hard links, so writing it would also rewrite ` +
        `a file outside the repository. Replace it with an ordinary file and run again.`
    );
  }

  let existing = filePath;
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    missing.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realAncestor = fs.realpathSync(existing);
  const resolved =
    missing.length === 0 ? realAncestor : path.join(realAncestor, ...missing);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `${REFUSED}: ${shown} resolves outside the repository (${resolved}). Move it back ` +
        `inside ${root}, or remove the link, and run again.`
    );
  }
}

function writeIfChanged(
  target: Exclude<SkillTarget, "all">,
  filePath: string,
  content: string
): SkillWrite {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (existing === content) return { target, path: filePath, action: "unchanged" };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return { target, path: filePath, action: existing === null ? "created" : "updated" };
}

/** Reports a section an older release merged into the project's own `AGENTS.md`. */
function legacyAgentsNote(cwd: string): string | null {
  const filePath = path.join(cwd, "AGENTS.md");
  try {
    if (!fs.existsSync(filePath)) return null;
    if (!fs.readFileSync(filePath, "utf8").includes(LEGACY_AGENTS_MARKER)) return null;
  } catch {
    return null;
  }
  return (
    "AGENTS.md still contains the section an earlier version installed (between the " +
    `"${LEGACY_AGENTS_MARKER}" markers). This command no longer edits that file: it is ` +
    "your project's own agent instructions. Delete the block if you do not want it."
  );
}

/**
 * Installs the bundled skill into the registries this repository's agent tool reads.
 *
 * Two locations, and both are *registries keyed by skill name*: Claude Code
 * auto-discovers `.claude/skills/<name>/SKILL.md`, and Cursor reads
 * `.cursor/rules/<name>.mdc`. Because the path carries the skill's name, the file
 * cannot be mistaken for the project's own documentation and two skills cannot
 * collide.
 *
 * It deliberately does **not** write `AGENTS.md`. That file is the project's own
 * agent contract — conventions, build commands, house rules — and this tool has no
 * business writing into it on the user's behalf: creating one that holds only our
 * text misrepresents the repository to every agent that reads it, and merging a
 * section into an existing one edits a tracked file the user then has to review.
 * An agent that wants the skill in `AGENTS.md` can run `codebase-snapshot skill`
 * and paste it; the decision, and the commit, are the repository owner's.
 *
 * Whatever this command *creates* — and only what it creates — is added to
 * `.gitignore` in the same run. These files are a tool's documentation written into
 * someone else's repository; leaving them untracked turns a one-line command into a
 * decision about what to commit.
 */
export function installSkill(cwd: string, target: SkillTarget = "all"): SkillInstallResult {
  const skill = renderSkill();
  const written: SkillWrite[] = [];
  const notes: string[] = [];
  const wanted: Array<Exclude<SkillTarget, "all">> =
    target === "all" ? ["claude", "cursor"] : [target];

  for (const item of wanted) assertWritableInsideRepository(cwd, targetPath(cwd, item));

  // The ignore file is written in this run too, so it needs the same proof. Doing it
  // in the same pre-flight loop keeps the "all or nothing" property: a linked
  // `.gitignore` that points outside the repository refuses before anything is created.
  const createsSomething = wanted.some((item) => !fs.existsSync(targetPath(cwd, item)));
  if (createsSomething) {
    assertWritableInsideRepository(cwd, path.join(cwd, ".gitignore"));
  }

  for (const item of wanted) {
    written.push(writeIfChanged(item, targetPath(cwd, item), skill));
  }

  const created = written
    .filter((item) => item.action === "created")
    .map((item) => gitignorePath(cwd, item.path));
  const ignore = appendGitignoreEntries(cwd, created);
  if (ignore.note !== null) notes.push(ignore.note);

  const legacy = legacyAgentsNote(cwd);
  if (legacy !== null) notes.push(legacy);

  return { cwd, written, gitignored: ignore.added, notes };
}

/** True when the target name is one this command understands. */
export function isSkillTarget(value: string): value is SkillTarget {
  return (SKILL_TARGETS as string[]).includes(value);
}
