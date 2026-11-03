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

/**
 * Merges the skill into an existing `AGENTS.md` without disturbing the rest.
 *
 * Re-running replaces only the marked block, so a repository that already
 * documents its own conventions keeps them.
 */
function mergeAgentsFile(cwd: string, skill: string): SkillWrite {
  const filePath = targetPath(cwd, "agents");
  const block = agentsBlock(skill);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;

  let next: string;
  if (existing === null) {
    next = `# AGENTS.md\n\n${block}`;
  } else if (existing.includes(AGENTS_MARKER_START) && existing.includes(AGENTS_MARKER_END)) {
    const start = existing.indexOf(AGENTS_MARKER_START);
    const end = existing.indexOf(AGENTS_MARKER_END) + AGENTS_MARKER_END.length;
    next = `${existing.slice(0, start)}${block.trimEnd()}${existing.slice(end)}`;
  } else {
    next = `${existing.trimEnd()}\n\n${block}`;
  }

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
 * Cursor. All three are idempotent.
 */
export function installSkill(cwd: string, target: SkillTarget = "all"): SkillInstallResult {
  const skill = renderSkill();
  const written: SkillWrite[] = [];
  const wanted: Array<Exclude<SkillTarget, "all">> =
    target === "all" ? ["agents", "claude", "cursor"] : [target];

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
