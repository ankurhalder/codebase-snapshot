import { spawnSync } from "node:child_process";
import { truncateToBytes } from "../partitioner/preview.js";
import { scanAndRedactSecrets } from "../security/redact.js";
import { fenceForText } from "../partitioner/chunker.js";
import type { SecretRule } from "../types.js";

// Recent commits, as an artifact: the history the snapshot was built from, bounded and one line
// per commit, with the command that produced it.

export interface LogReport {
  text: string;
  count: number;
}

export function generateLogReport(
  cwd: string,
  options: { count?: number; maxBytes?: number; secretRules?: readonly SecretRule[] } = {}
): LogReport | null {
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
  // Commit subjects are author-controlled text and routinely carry tokens in incident commits.
  // PROMPT.md masked them while this report wrote them raw, so the same run produced one safe
  // artifact and one leak. Redact before truncating: truncation must never cut a marker in half.
  const redacted = scanAndRedactSecrets(body, options.secretRules ?? [], "reports/log.md").redacted;
  const joined = truncateToBytes(redacted, maxBytes).content;
  const fence = fenceForText(joined, 3);
  const text = [
    "# Recent commits",
    "",
    "The last " + count + " commits, newest first, one line each.",
    "",
    fence + "text",
    joined,
    fence,
    "",
  ].join("\n");
  return { text, count: lines.length };
}
