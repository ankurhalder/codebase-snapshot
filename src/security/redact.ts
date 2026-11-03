import type { SecretFinding, SecretRule } from "../types.js";
import { PEM_BLOCK_PATTERN, PEM_UNTERMINATED_PATTERN } from "./patterns.js";

export const REDACTION_MARKER =
  "[REDACTED: potential secret-like value omitted from snapshot]";
export const PEM_REDACTION_MARKER =
  "[REDACTED: private key block omitted from snapshot]";

/** Sorts and merges overlapping match spans so a value is masked exactly once. */
interface Span {
  start: number;
  end: number;
  rule: string;
}

interface CompiledRule {
  rule: string;
  /** Always global, never sticky; `lastIndex` is reset before every line. */
  pattern: RegExp;
}

/**
 * Compiles caller-supplied rules into a safe, non-stateful form.
 *
 * Accepts a `pattern` given as a string (the only thing a JSON config can
 * express) and strips the `g`/`y` flags, whose `lastIndex` is stateful: reusing
 * a `/g` regex across lines silently skipped every other match and recorded no
 * finding for the lines it skipped.
 */
export function compileSecretRules(
  rules: Array<{ rule: string; pattern: RegExp | string }>
): SecretRule[] {
  return rules.map((rule) => {
    if (rule.pattern instanceof RegExp) {
      return {
        rule: rule.rule,
        pattern: new RegExp(rule.pattern.source, rule.pattern.flags.replace(/[gy]/g, "")),
      };
    }
    if (typeof rule.pattern === "string") {
      try {
        return { rule: rule.rule, pattern: new RegExp(rule.pattern, "i") };
      } catch (err) {
        throw new Error(
          `Invalid regular expression for secret rule "${rule.rule}": ${
            (err as Error).message
          }`
        );
      }
    }
    throw new Error(
      `Secret rule "${String((rule as { rule: string }).rule)}" has a pattern that is neither a RegExp nor a string.`
    );
  });
}

function toGlobal(pattern: RegExp): RegExp {
  const flags = pattern.flags.replace(/[gy]/g, "");
  return new RegExp(pattern.source, `${flags}g`);
}

/**
 * Redacts secrets from `content`.
 *
 * - Replaces only the matched span, so unrelated code sharing the line survives
 *   (the previous implementation discarded the whole line).
 * - Masks PEM private-key blocks as a unit; per-line rules can only see the
 *   `BEGIN` header, which left every body line of a real key in the output.
 * - Records `{ rule, line, path }` only. No excerpt of the source is retained,
 *   because that excerpt was being written verbatim into `reports/audit.md`.
 */
export function scanAndRedactSecrets(
  content: string,
  rules: SecretRule[],
  filePath?: string
): {
  redacted: string;
  findings: SecretFinding[];
} {
  const findings: SecretFinding[] = [];

  // Pass 1 — whole PEM blocks. This must run BEFORE the per-line pass: the
  // per-line rules only see the `BEGIN` header and would remove it, leaving
  // every subsequent body line of a real key behind.
  // The replacement preserves the block's line count so line numbers reported
  // by pass 2 stay accurate.
  let redacted = content;
  for (const blockPattern of [PEM_BLOCK_PATTERN, PEM_UNTERMINATED_PATTERN]) {
    blockPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = blockPattern.exec(redacted)) !== null) {
      if (match[0].length === 0) {
        blockPattern.lastIndex += 1;
        continue;
      }
      const line = redacted.slice(0, match.index).split("\n").length;
      const newlines = (match[0].match(/\n/g) ?? []).length;
      findings.push({ rule: "private-key-block", line, path: filePath });
      redacted =
        redacted.slice(0, match.index) +
        PEM_REDACTION_MARKER +
        "\n".repeat(newlines) +
        redacted.slice(match.index + match[0].length);
      blockPattern.lastIndex = match.index + PEM_REDACTION_MARKER.length + newlines;
    }
  }

  // Pass 2 — per-line rules.
  const compiled: CompiledRule[] = rules.map((rule) => ({
    rule: rule.rule,
    pattern: toGlobal(rule.pattern),
  }));

  const lines = redacted.split("\n");
  const redactedLines = lines.map((line, index) => {
    if (line.length === 0) return line;

    const spans: Span[] = [];
    const matchedRules = new Set<string>();

    for (const { rule, pattern } of compiled) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        if (match[0].length === 0) {
          pattern.lastIndex += 1;
          continue;
        }
        spans.push({ start: match.index, end: match.index + match[0].length, rule });
        matchedRules.add(rule);
      }
    }

    if (spans.length === 0) return line;

    for (const rule of matchedRules) {
      findings.push({ rule, line: index + 1, path: filePath });
    }

    return applySpans(line, spans);
  });

  return { redacted: redactedLines.join("\n"), findings };
}

/** Replaces non-overlapping spans with the redaction marker. */
function applySpans(line: string, spans: Span[]): string {
  const ordered = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let cursor = 0;

  for (const span of ordered) {
    if (span.end <= cursor) continue; // fully contained in an earlier span
    const start = Math.max(span.start, cursor);
    out += line.slice(cursor, start);
    out += REDACTION_MARKER;
    cursor = Math.min(span.end, line.length);
  }
  out += line.slice(cursor);
  return out;
}
