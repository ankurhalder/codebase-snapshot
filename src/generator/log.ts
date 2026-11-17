import { spawnSync } from "node:child_process";

// Recent commits, as an artifact: the history the snapshot was built from, bounded and one line
// per commit, with the command that produced it.

export interface LogReport {
  text: string;
  count: number;
}

export function generateLogReport(cwd: string, options: { count?: number; maxBytes?: number } = {}): LogReport | null {
  const count = Math.max(1, Math.min(500, options.count ?? 20));
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const result = spawnSync(
    "git",
    ["log", "-n", String(count), "--date=short", "--pretty=format:%h%x09%ad%x09%s", "--no-color"],
    { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  );
  if (result.status !== 0) return null;
  const body = (result.stdout ?? "").trim();
  if (body === "") return null;
  const lines = body.split("\n");
  const text = [
    "# Recent commits",
    "",
    "The last " + count + " commits, newest first, one line each.",
    "",
    "```text",
    lines.join("\n").slice(0, maxBytes),
    "```",
    "",
  ].join("\n");
  return { text, count: lines.length };
}
