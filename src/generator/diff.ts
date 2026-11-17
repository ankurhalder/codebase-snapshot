import { spawnSync } from "node:child_process";

// The uncommitted diff, as an artifact.
//
// A snapshot describes the tree on disk; a reviewer also needs to know what changed since the last
// commit. This is the one artifact not derived from the files the snapshot carries, so it names the
// git command that produced it, and it is bounded: a larger diff is truncated with a note.

export interface DiffReport {
  text: string;
  bytes: number;
  truncated: boolean;
  paths: string[];
}

function runGit(cwd: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return { ok: false, out: (result.stderr ?? "").trim() };
  return { ok: true, out: result.stdout ?? "" };
}

export function isGitRepository(cwd: string): boolean {
  return runGit(cwd, ["rev-parse", "--is-inside-work-tree"]).out.trim() === "true";
}

export function generateDiffReport(cwd: string, options: { maxBytes?: number } = {}): DiffReport | null {
  if (!isGitRepository(cwd)) return null;
  const maxBytes = options.maxBytes ?? 200 * 1024;
  const sections: string[] = [];
  let bytes = 0;
  let truncated = false;

  const commands: Array<[string, string[]]> = [
    ["Unstaged", ["diff", "--no-color"]],
    ["Staged", ["diff", "--cached", "--no-color"]],
  ];
  for (const [title, args] of commands) {
    const result = runGit(cwd, args);
    if (!result.ok || result.out.trim() === "") continue;
    const body = result.out;
    bytes += Buffer.byteLength(body, "utf8");
    const used = Buffer.byteLength(sections.join(""), "utf8");
    const remaining = Math.max(0, maxBytes - used);
    const chunk = Buffer.byteLength(body, "utf8") > remaining ? body.slice(0, remaining) : body;
    if (chunk.length < body.length) truncated = true;
    sections.push("## " + title + " changes\n\nRun: git " + args.join(" ") + "\n\n```diff\n" + chunk + "\n```");
  }

  if (sections.length === 0) return null;
  const paths = new Set<string>();
  for (const match of sections.join("\n").matchAll(/^\+\+\+ b\/(.+)$/gm)) paths.add(match[1]);
  const text = [
    "# Uncommitted changes",
    "",
    "Generated from the repository at the moment the snapshot was written. Untracked files are not",
    "in a diff until they are added; this artifact says what git reports, not what git ignores.",
    "",
    ...sections,
    ...(truncated ? ["", "> Truncated at " + maxBytes + " bytes. Run git diff for the rest."] : []),
    "",
  ].join("\n");
  return { text, bytes, truncated, paths: [...paths].sort() };
}
