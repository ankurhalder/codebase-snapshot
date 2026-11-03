import type { SecretFinding, SecretRule, SecretRuleInput } from "../types.js";
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
  /** Capture group holding the secret; the rest of the match is kept. */
  valueGroup?: number;
}

/** `RegExpExecArray` with the `d`-flag indices we rely on for `valueGroup`. */
interface MatchIndices {
  indices?: Array<[number, number] | undefined>;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (value instanceof RegExp) return value.toString();
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
  return `a ${typeof value}`;
}

function compilePattern(
  rule: string,
  pattern: RegExp | string,
  valueGroup: number | undefined
): SecretRule {
  if (pattern instanceof RegExp) {
    // `g`/`y` carry a stateful `lastIndex`; reusing such a regex across lines
    // silently skipped every other match and recorded no finding for the lines
    // it skipped. `d` is added on demand so `valueGroup` can be resolved.
    const flags = new Set(pattern.flags.replace(/[gy]/g, "").split(""));
    if (valueGroup !== undefined) flags.add("d");
    return {
      rule,
      pattern: new RegExp(pattern.source, [...flags].join("")),
      ...(valueGroup === undefined ? {} : { valueGroup }),
    };
  }
  if (typeof pattern === "string") {
    try {
      return {
        rule,
        pattern: new RegExp(pattern, valueGroup === undefined ? "i" : "id"),
        ...(valueGroup === undefined ? {} : { valueGroup }),
      };
    } catch (err) {
      throw new Error(
        `Invalid regular expression for secret rule "${rule}": ${(err as Error).message}`
      );
    }
  }
  throw new Error(
    `Secret rule "${rule}" has a pattern that is neither a RegExp nor a string (received ${describeValue(pattern)}).`
  );
}

/**
 * Compiles caller-supplied rules into a safe, non-stateful form.
 *
 * Three shapes are accepted, because the documentation, the `init` template and
 * hand-written configs all use different ones:
 *
 * - a bare `RegExp` — `customPatterns: [/ghp_[A-Za-z0-9]{36}/]`,
 * - a bare string — the only form a JSON config can express,
 * - `{ rule, pattern }` — the named form the wizard writes.
 *
 * A bare entry is named `custom-<n>` (1-based, position in the array) so audit
 * findings stay attributable. Everything else is a hard error that names the
 * index and the expected shape: a silently ignored rule is a silently leaked
 * credential.
 */
export function compileSecretRules(rules: readonly SecretRuleInput[]): SecretRule[] {
  if (!Array.isArray(rules)) {
    throw new Error(
      `secrets.customPatterns must be an array of secret rules (received ${describeValue(rules)}).`
    );
  }

  let generated = 0;

  return rules.map((entry, index) => {
    const where = `secrets.customPatterns[${index}]`;

    if (entry instanceof RegExp) {
      generated += 1;
      return compilePattern(`custom-${generated}`, entry, undefined);
    }
    if (typeof entry === "string") {
      generated += 1;
      return compilePattern(`custom-${generated}`, entry, undefined);
    }
    if (typeof entry === "object" && entry !== null) {
      const candidate = entry as {
        rule?: unknown;
        pattern?: unknown;
        valueGroup?: unknown;
      };
      if (typeof candidate.rule !== "string" || candidate.rule.trim() === "") {
        throw new Error(
          `${where} is missing \`rule\` (received keys: ${Object.keys(candidate).join(", ") || "none"}). ` +
            `A named rule is { rule: "corp-token", pattern: /CORP-[A-Z0-9]{8}/ }, or pass the RegExp itself.`
        );
      }
      const valueGroup = candidate.valueGroup;
      if (valueGroup !== undefined) {
        if (typeof valueGroup !== "number" || !Number.isInteger(valueGroup) || valueGroup < 0) {
          throw new Error(
            `${where}.valueGroup must be a non-negative integer capture-group index (received ${describeValue(valueGroup)}).`
          );
        }
      }
      if (candidate.pattern === undefined) {
        throw new Error(
          `${where} (rule "${candidate.rule}") is missing \`pattern\`. Expected { rule, pattern: RegExp | string }.`
        );
      }
      return compilePattern(
        candidate.rule,
        candidate.pattern as RegExp | string,
        valueGroup as number | undefined
      );
    }

    throw new Error(
      `${where} must be a RegExp, a string, or { rule, pattern } (received ${describeValue(entry)}).`
    );
  });
}

function toGlobal(rule: SecretRule): RegExp {
  const flags = new Set(rule.pattern.flags.replace(/[gy]/g, "").split(""));
  flags.add("g");
  if (rule.valueGroup !== undefined) flags.add("d");
  return new RegExp(rule.pattern.source, [...flags].join(""));
}

/**
 * Line terminators are kept as separate segments so redaction can neither lose
 * a CRLF pair nor let the `\r` defeat a `$`-anchored rule.
 *
 * Splitting on "\n" alone left a trailing `\r` on every line of a Windows
 * checkout, and `env-secret-assignment` (the only rule for unquoted
 * `NAME=value`) ends in `$`, so it never fired: a CRLF file emitted its secrets
 * in clear while the byte-identical LF twin was redacted.
 */
const LINE_BREAK = /(\r\n|\n|\r)/;

/**
 * Redacts secrets from `content`.
 *
 * - Replaces only the matched span, so unrelated code sharing the line survives
 *   (the previous implementation discarded the whole line).
 * - When a rule declares `valueGroup`, only that capture group is masked, so
 *   `dbPassword: "…"` keeps its key and stays parseable.
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

  // Pass 2 — per-line rules, on segments that exclude the line terminators.
  const compiled: CompiledRule[] = rules.map((rule) => ({
    rule: rule.rule,
    pattern: toGlobal(rule),
    ...(rule.valueGroup === undefined ? {} : { valueGroup: rule.valueGroup }),
  }));

  const segments = redacted.split(LINE_BREAK);
  let lineNumber = 1;

  for (let index = 0; index < segments.length; index += 2) {
    const line = segments[index];

    if (line.length > 0) {
      const spans: Span[] = [];
      const matchedRules = new Set<string>();

      for (const { rule, pattern, valueGroup } of compiled) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          if (match[0].length === 0) {
            pattern.lastIndex += 1;
            continue;
          }
          const group =
            valueGroup === undefined
              ? undefined
              : (match as RegExpExecArray & MatchIndices).indices?.[valueGroup];
          spans.push(
            group
              ? { start: group[0], end: group[1], rule }
              : { start: match.index, end: match.index + match[0].length, rule }
          );
          matchedRules.add(rule);
        }
      }

      if (spans.length > 0) {
        for (const rule of matchedRules) {
          findings.push({ rule, line: lineNumber, path: filePath });
        }
        segments[index] = applySpans(line, spans);
      }
    }

    if (index + 1 < segments.length) lineNumber += 1;
  }

  return { redacted: segments.join(""), findings };
}

/**
 * Characters that continue a token on the left of a span.
 *
 * `=` is deliberately absent: it joins a name to its value in `NAME=value`, and
 * expanding across it would swallow `DB_PASSWORD`, which is readable context the
 * snapshot needs. `+`, `/` and `-` are present because credentials are base64
 * and kebab-case; they never join two identifiers on their own.
 */
const TOKEN_CHARS_LEFT = /[A-Za-z0-9_+/-]/;
/** Tokens may *end* with base64 padding, so the right side includes `=`. */
const TOKEN_CHARS_RIGHT = /[A-Za-z0-9_+/=-]/;

/**
 * Widens a span over the whole token it belongs to.
 *
 * A rule that matches a *prefix* of a credential leaves the rest of the token
 * masked-but-unmatched: `npm_[A-Za-z0-9]{36}` matches 40 of 43 characters, and
 * the three-character remainder was emitted next to the marker. Extending every
 * span to its token boundary closes that class for every rule, present and
 * future, instead of special-casing each pair of rules that overlap.
 */
function expandOverToken(line: string, start: number, end: number): { start: number; end: number } {
  let left = start;
  let right = end;
  while (left > 0 && TOKEN_CHARS_LEFT.test(line[left - 1])) left -= 1;
  while (right < line.length && TOKEN_CHARS_RIGHT.test(line[right])) right += 1;
  return { start: left, end: right };
}

/**
 * Replaces non-overlapping spans with the redaction marker.
 *
 * Each span is first widened to its token boundaries and overlapping spans are
 * then merged into one marker covering their **union**. Masking only the first
 * span let a shorter match win and leave a fragment behind: `"npm_abc…678stu"`
 * was emitted as `"[REDACTED…]stu"`.
 */
function applySpans(line: string, spans: Span[]): string {
  const ordered = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number }> = [];
  for (const span of ordered) {
    const clampedStart = Math.max(0, Math.min(span.start, line.length));
    const clampedEnd = Math.max(clampedStart, Math.min(span.end, line.length));
    const { start, end } = expandOverToken(line, clampedStart, clampedEnd);
    const last = merged[merged.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }

  let out = "";
  let cursor = 0;
  for (const span of merged) {
    out += line.slice(cursor, span.start);
    out += REDACTION_MARKER;
    cursor = span.end;
  }
  out += line.slice(cursor);
  return out;
}
