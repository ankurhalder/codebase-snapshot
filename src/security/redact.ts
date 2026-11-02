import type { SecretFinding, SecretRule } from "../types.js";

export function scanAndRedactSecrets(
  content: string,
  rules: SecretRule[],
  filePath?: string
): {
  redacted: string;
  findings: SecretFinding[];
} {
  const findings: SecretFinding[] = [];
  const lines = content.split("\n");
  const redactedLines = lines.map((line, index) => {
    const hits = rules.filter(({ pattern }) => pattern.test(line));
    if (hits.length === 0) return line;

    for (const hit of hits) {
      findings.push({
        rule: hit.rule,
        line: index + 1,
        snippet: line.trim().slice(0, 120),
        path: filePath,
      });
    }
    return "[REDACTED: potential secret-like value omitted from snapshot]";
  });

  return { redacted: redactedLines.join("\n"), findings };
}
