import { spawnSync } from "node:child_process";
import { isSensitivePath } from "../scanner/files.js";
import { truncateToBytes } from "../partitioner/preview.js";
import { scanAndRedactSecrets } from "../security/redact.js";
import type { SecretRule } from "../types.js";

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

/** The paths a single git diff section names, with git's a/ and b/ prefixes removed. */
function diffSectionPaths(body: string): string[] {
  const paths = new Set<string>();
  for (const line of body.split("\n")) {
    const plus = /^\+\+\+ b\/(.*)$/.exec(line);
    if (plus !== null) paths.add(plus[1]);
    const minus = /^--- a\/(.*)$/.exec(line);
    if (minus !== null) paths.add(minus[1]);
    const header = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
    if (header !== null) {
      paths.add(header[1]);
      paths.add(header[2]);
    }
  }
  return [...paths];
}

export function generateDiffReport(
  cwd: string,
  options: {
    maxBytes?: number;
    secretRules?: readonly SecretRule[];
    /** Paths the snapshot would not carry, so a report cannot reproduce them either. */
    excluded?: (relativePath: string) => boolean;
  } = {}
): DiffReport | null {
  if (!isGitRepository(cwd)) return null;
  const maxBytes = options.maxBytes ?? 200 * 1024;
  const sections: string[] = [];
  let truncated = false;
  let omittedSensitive = 0;

  const commands: Array<[string, string[]]> = [
    ["Unstaged", ["diff", "--no-color"]],
    ["Staged", ["diff", "--cached", "--no-color"]],
  ];
  for (const [title, args] of commands) {
    const result = runGit(cwd, args);
    if (!result.ok || result.out.trim() === "") continue;
    // One section per file. Filtering whole sections (rather than redacting a path) is the only
    // way a tracked .env can be kept out of the report: the diff body is the secret.
    const rawSections = result.out.split(/(?=^diff --git )/m).filter((section) => section.length > 0);
    for (const rawSection of rawSections) {
      const paths = diffSectionPaths(rawSection);
      const blocked =
        paths.some((path) => isSensitivePath(path) || options.excluded?.(path) === true);
      if (blocked) {
        omittedSensitive += 1;
        continue;
      }
      const used = Buffer.byteLength(sections.join(""), "utf8");
      const remaining = Math.max(0, maxBytes - used);
      if (remaining === 0) {
        truncated = true;
        break;
      }
      const chunk = truncateToBytes(rawSection, remaining);
      if (chunk.isTruncated) truncated = true;
      sections.push(
        "## " + title + " changes\n\nRun: git " + args.join(" ") + "\n\n" +
          "```diff\n" + chunk.content + "\n```"
      );
      if (chunk.isTruncated) break;
    }
  }

  if (sections.length === 0) return null;
  const paths = new Set<string>();
  for (const section of sections) for (const path of diffSectionPaths(section)) paths.add(path);
  const joined = [
    "# Uncommitted changes",
    "",
    "Generated from the repository at the moment the snapshot was written. Untracked files are not",
    "in a diff until they are added; this artifact says what git reports, not what git ignores.",
    "",
    ...(omittedSensitive > 0
      ? [
          "> " + omittedSensitive + " file section(s) omitted: their path is credential-bearing or excluded from the snapshot.",
          "",
        ]
      : []),
    ...sections,
    ...(truncated ? ["", "> Truncated at " + maxBytes + " bytes. Run git diff for the rest."] : []),
    "",
  ].join("\n");
  // Redaction runs over the assembled report, not only over the files the snapshot carries:
  // staged credentials, a token in a commit-adjacent line and custom rules all reach this file.
  const text = scanAndRedactSecrets(joined, options.secretRules ?? [], "reports/diff.md").redacted;
  return { text, bytes: Buffer.byteLength(text, "utf8"), truncated, paths: [...paths].sort() };
}
