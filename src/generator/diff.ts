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
  // `diff.noprefix=true` changes every header to `diff --git foo bar`; `core.quotepath` defaults
  // to true and C-quotes a non-ASCII path as `"a/caf\303\251/.env"`. The old parser understood
  // neither, returned no paths, and therefore emitted the .env body as "not sensitive".
  const result = spawnSync(
    "git",
    ["-c", "core.quotepath=false", "-c", "diff.noprefix=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) return { ok: false, out: (result.stderr ?? "").trim() };
  return { ok: true, out: result.stdout ?? "" };
}

export function isGitRepository(cwd: string): boolean {
  return runGit(cwd, ["rev-parse", "--is-inside-work-tree"]).out.trim() === "true";
}

/** Decodes git's C-style quoted path, including octal UTF-8 bytes. */
function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  let out = "";
  let bytes: number[] = [];
  const flushBytes = (): void => {
    if (bytes.length === 0) return;
    out += Buffer.from(bytes).toString("utf8");
    bytes = [];
  };
  const escapes: Record<string, string> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    '"': '"',
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (char !== "\\") {
      flushBytes();
      out += char;
      continue;
    }
    const next = body[index + 1];
    if (next === undefined) {
      flushBytes();
      out += "\\";
      break;
    }
    index += 1;
    if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(body[index + 1] ?? "")) {
        index += 1;
        octal += body[index];
      }
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      continue;
    }
    flushBytes();
    out += escapes[next] ?? next;
  }
  flushBytes();
  return out;
}

/** Reads one whitespace-delimited git path token, quoted or bare. */
function takeGitPath(value: string): { token: string; rest: string } | null {
  if (value.length === 0) return null;
  if (value.startsWith('"')) {
    let index = 1;
    while (index < value.length) {
      if (value[index] === "\\") {
        index += 2;
        continue;
      }
      if (value[index] === '"') {
        return { token: value.slice(0, index + 1), rest: value.slice(index + 1).replace(/^ /, "") };
      }
      index += 1;
    }
    return null;
  }
  const space = value.indexOf(" ");
  if (space === -1) return { token: value, rest: "" };
  return { token: value.slice(0, space), rest: value.slice(space + 1) };
}

function pathFromGitToken(token: string, prefix: "a/" | "b/"): string | null {
  const unquoted = unquoteGitPath(token);
  if (unquoted === "/dev/null") return null;
  if (!unquoted.startsWith(prefix)) return null;
  return unquoted.slice(prefix.length);
}

/** The paths a single git diff section names, with git's a/ and b/ prefixes removed. */
function diffSectionPaths(body: string): string[] {
  const paths = new Set<string>();
  for (const line of body.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const first = takeGitPath(line.slice("diff --git ".length));
      if (first === null) continue;
      const second = takeGitPath(first.rest);
      if (second === null) continue;
      const left = pathFromGitToken(first.token, "a/");
      const right = pathFromGitToken(second.token, "b/");
      if (left !== null) paths.add(left);
      if (right !== null) paths.add(right);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const token = takeGitPath(line.slice(4));
      if (token === null) continue;
      const path = pathFromGitToken(token.token, "b/");
      if (path !== null) paths.add(path);
      continue;
    }
    if (line.startsWith("--- ")) {
      const token = takeGitPath(line.slice(4));
      if (token === null) continue;
      const path = pathFromGitToken(token.token, "a/");
      if (path !== null) paths.add(path);
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
  let omittedUnparseable = 0;

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
      // Fail closed. A section whose header this parser cannot attribute to a path is not
      // evidence that the path was safe; it is evidence that the filter did not run.
      if (paths.length === 0) {
        omittedUnparseable += 1;
        continue;
      }
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
      // Redact before truncating, using the diffed file's own extension: YAML, INI, shell and
      // Dockerfile rules are selected by file type. Truncating first split a credential at the
      // boundary and left its prefix unredacted.
      const sourcePath = paths[0] ?? "reports/diff.md";
      const redactedSection = scanAndRedactSecrets(
        rawSection,
        options.secretRules ?? [],
        sourcePath
      ).redacted;
      const chunk = truncateToBytes(redactedSection, remaining);
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
    ...(omittedUnparseable > 0
      ? [
          "> " + omittedUnparseable + " file section(s) omitted: their diff header could not be attributed to a path, so the sensitive-path filter could not run.",
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
