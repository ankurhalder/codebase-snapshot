import * as fs from "node:fs";
import * as path from "node:path";

import { AGENTS_MARKER_END, AGENTS_MARKER_START, SKILL_NAME, renderSkill } from "./skill.js";

export type SkillTarget = "claude" | "agents" | "cursor" | "all";
export const SKILL_TARGETS: SkillTarget[] = ["claude", "agents", "cursor", "all"];

export interface SkillWrite {
  target: SkillTarget;
  path: string;
  action: "created" | "updated" | "unchanged";
}

export interface SkillInstallResult {
  cwd: string;
  written: SkillWrite[];
}

const REFUSED = "Refusing to install the agent skill";

/** Where each target puts the skill, relative to the repository root. */
function targetPath(cwd: string, target: Exclude<SkillTarget, "all">): string {
  switch (target) {
    case "claude":
      return path.join(cwd, ".claude", "skills", SKILL_NAME, "SKILL.md");
    case "cursor":
      return path.join(cwd, ".cursor", "rules", `${SKILL_NAME}.mdc`);
    case "agents":
      return path.join(cwd, "AGENTS.md");
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
  target: SkillTarget,
  filePath: string,
  content: string
): SkillWrite {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (existing === content) return { target, path: filePath, action: "unchanged" };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return { target, path: filePath, action: existing === null ? "created" : "updated" };
}

/** The marked block as it appears inside `AGENTS.md`. */
function agentsBlock(skill: string): string {
  return [
    AGENTS_MARKER_START,
    "",
    `## ${SKILL_NAME} (${"@ankurhalder/codebase-snapshot"})`,
    "",
    // Drop the YAML frontmatter: inside AGENTS.md it is noise, and the heading
    // above already names the skill.
    skill.replace(/^---[\s\S]*?---\r?\n/, "").trim(),
    "",
    AGENTS_MARKER_END,
    "",
  ].join("\n");
}

interface MarkerSpan {
  start: number;
  end: number;
}

/**
 * Every span of the file that this generator owns: a complete `START … END`
 * section, a stray marker, or an unterminated `START` (the marker alone — the
 * text after it is left alone because it may be the user's own prose).
 */
function ownSpans(existing: string): MarkerSpan[] {
  const marks: Array<{ kind: "start" | "end"; start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < existing.length) {
    const start = existing.indexOf(AGENTS_MARKER_START, cursor);
    const end = existing.indexOf(AGENTS_MARKER_END, cursor);
    if (start === -1 && end === -1) break;
    if (start !== -1 && (end === -1 || start < end)) {
      marks.push({ kind: "start", start, end: start + AGENTS_MARKER_START.length });
      cursor = start + AGENTS_MARKER_START.length;
    } else {
      marks.push({ kind: "end", start: end, end: end + AGENTS_MARKER_END.length });
      cursor = end + AGENTS_MARKER_END.length;
    }
  }

  const spans: MarkerSpan[] = [];
  let open = -1;
  for (const mark of marks) {
    if (mark.kind === "start") {
      if (open === -1) open = mark.start;
    } else if (open !== -1) {
      spans.push({ start: open, end: mark.end });
      open = -1;
    } else {
      // A closer with no opener is our own text too.
      spans.push({ start: mark.start, end: mark.end });
    }
  }
  if (open !== -1) spans.push({ start: open, end: open + AGENTS_MARKER_START.length });
  return spans;
}

/**
 * Merges the skill into `AGENTS.md`, normalising the marked section to exactly
 * one balanced block.
 *
 * Every marker this generator wrote is its own text, so all of them are removed
 * and one block is inserted where the first one was. That makes a hand-edited
 * file self-healing: a missing closer, a duplicated block, a nested
 * `START START END` (which used to leave the file permanently unbalanced) and an
 * inverted pair all end up as a single block, with every byte the user wrote
 * kept. A well-formed file has exactly one span, so it is replaced in place —
 * re-running is byte-identical.
 */
function mergeMarkedSection(existing: string, block: string): string {
  const spans = ownSpans(existing);
  if (spans.length === 0) return `${existing.trimEnd()}\n\n${block}`;

  let stripped = "";
  let from = 0;
  let insertAt = -1;
  for (const span of spans) {
    if (span.start < from) continue;
    stripped += existing.slice(from, span.start);
    if (insertAt === -1) insertAt = stripped.length;
    from = span.end;
  }
  stripped += existing.slice(from);
  return `${stripped.slice(0, insertAt)}${block.trimEnd()}${stripped.slice(insertAt)}`;
}

/**
 * Merges the skill into an existing `AGENTS.md` without disturbing the rest.
 *
 * Re-running replaces only the marked section, and a malformed one is repaired
 * rather than duplicated, so a repository that already documents its own
 * conventions keeps them.
 */
function mergeAgentsFile(cwd: string, skill: string): SkillWrite {
  const filePath = targetPath(cwd, "agents");
  const block = agentsBlock(skill);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;

  const next =
    existing === null ? `# AGENTS.md\n\n${block}` : mergeMarkedSection(existing, block);
  const action =
    existing === null ? "created" : existing === next ? "unchanged" : "updated";
  if (action !== "unchanged") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, next, "utf8");
  }
  return { target: "agents", path: filePath, action };
}

/**
 * Installs the bundled skill so an agent working in this repository finds it
 * without being told the tool exists.
 *
 * Three locations, because agents differ: `AGENTS.md` is read by most tools,
 * `.claude/skills/` is auto-discovered by Claude Code, and `.cursor/rules/` by
 * Cursor. All three are idempotent, and every target is proved to be inside the
 * repository before the first byte is written — a partial install is worse than
 * a refusal.
 */
export function installSkill(cwd: string, target: SkillTarget = "all"): SkillInstallResult {
  const skill = renderSkill();
  const written: SkillWrite[] = [];
  const wanted: Array<Exclude<SkillTarget, "all">> =
    target === "all" ? ["agents", "claude", "cursor"] : [target];

  for (const item of wanted) assertWritableInsideRepository(cwd, targetPath(cwd, item));

  for (const item of wanted) {
    if (item === "agents") {
      written.push(mergeAgentsFile(cwd, skill));
      continue;
    }
    written.push(writeIfChanged(item, targetPath(cwd, item), skill));
  }

  return { cwd, written };
}

/** True when the target name is one this command understands. */
export function isSkillTarget(value: string): value is SkillTarget {
  return (SKILL_TARGETS as string[]).includes(value);
}
