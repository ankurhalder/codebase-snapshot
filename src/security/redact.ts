import type { SecretFinding, SecretRule, SecretRuleInput } from "../types.js";
import { CREDENTIAL_KEY_TAIL, PEM_BLOCK_PATTERN, PEM_UNTERMINATED_PATTERN } from "./patterns.js";

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
    return checkedPattern(rule, new RegExp(pattern.source, [...flags].join("")), valueGroup);
  }
  if (typeof pattern === "string") {
    try {
      return checkedPattern(
        rule,
        new RegExp(pattern, valueGroup === undefined ? "i" : "id"),
        valueGroup
      );
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
 * Rejects a rule that can match the empty string.
 *
 * A zero-length match still advances `lastIndex` in the scan loop, but with the `u` flag an
 * advance into the middle of a surrogate pair resets the engine and the same empty match is
 * found forever: `/(?:)/gu` against `"😀"` hangs `generate` at 100% CPU with no diagnostic. The
 * runtime has a Unicode-aware advance as a second line of defence; this is the one that names
 * the offending rule at validation time, before a run starts.
 */
function checkedPattern(
  rule: string,
  compiled: RegExp,
  valueGroup: number | undefined
): SecretRule {
  const stateless = new RegExp(compiled.source, compiled.flags.replace(/[gy]/g, ""));
  if (stateless.test("")) {
    throw new Error(
      `Secret rule "${rule}" can match the empty string. Every alternative must require at ` +
        "least one character, or the scan cannot advance past a match."
    );
  }
  return {
    rule,
    pattern: compiled,
    ...(valueGroup === undefined ? {} : { valueGroup }),
  };
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
 * Any line terminator, for counting.
 *
 * `LINE_BREAK` captures so `String.split` keeps the terminators; this one only counts, and it has
 * to recognise all three forms or a CR-only file reports every later line number off by the length
 * of a masked block.
 */
const LINE_TERMINATOR = /\r\n|\n|\r/g;

/**
 * Per-line state shared by the guards, computed at most once per line.
 *
 * `quoteAt[i]` is the quote character open *before* `line[i]`, or 0 when the position is code.
 * The map used to be recomputed from a sliced prefix for every match, which made a line with many
 * assignments quadratic; the comment and command-separator positions had the same problem.
 */
interface LineContext {
  quoteAt?: Uint8Array;
  commentStart?: number;
  commandSeparators?: number[];
}

/**
 * A quote that opens a literal. A quote inside a word is text, not a delimiter.
 *
 * `don't` is the obvious apostrophe case, and the same rule applies to `"`: in
 * `DB_PASSWORD=env"pass!@# # rotate` the quote is a character of an unquoted value, and reading it
 * as an opening delimiter swallowed the trailing comment — the value's mask then covered the
 * comment, which is exactly the over-redaction this pass is supposed to avoid. A backtick is
 * always an opener: `` tag`…` `` is a tagged template.
 */
function isOpeningQuote(line: string, index: number): boolean {
  const code = line.charCodeAt(index);
  if (code === 96) return true;
  if (code !== 34 && code !== 39) return false;
  return index === 0 || !/[A-Za-z0-9]/.test(line[index - 1]);
}

/** Quote state before every character in `line`, with escapes honoured. */
function quoteStates(line: string): Uint8Array {
  const states = new Uint8Array(line.length + 1);
  let quote = 0;
  for (let index = 0; index < line.length; index += 1) {
    states[index] = quote;
    const code = line.charCodeAt(index);
    if (quote === 0) {
      if (isOpeningQuote(line, index)) quote = code;
    } else if (code === 92) {
      // A backslash escapes the next character inside every literal form we track.
      if (index + 1 < line.length) {
        index += 1;
        states[index] = quote;
      }
    } else if (code === quote) {
      quote = 0;
    }
  }
  states[line.length] = quote;
  return states;
}

function quoteStateFor(line: string, context: LineContext): Uint8Array {
  if (context.quoteAt === undefined) context.quoteAt = quoteStates(line);
  return context.quoteAt;
}

/** Quote state at `end`, starting from `quote`. */
function quoteStateAfter(text: string, quote: number, end: number = text.length): number {
  for (let index = 0; index < end; index += 1) {
    const code = text.charCodeAt(index);
    if (quote === 0) {
      if (isOpeningQuote(text, index)) quote = code;
    } else if (code === 92) {
      index += 1;
    } else if (code === quote) {
      quote = 0;
    }
  }
  return quote;
}

/** Start of the first `#` comment on the line, or `line.length`. */
function commentStartFor(line: string, context: LineContext): number {
  if (context.commentStart !== undefined) return context.commentStart;
  const quotes = quoteStateFor(line, context);
  let start = line.length;
  for (let index = 0; index < line.length; index += 1) {
    if (line.charCodeAt(index) !== 35 || quotes[index] !== 0) continue;
    // A `#` is a comment only at the start of a word: `pa#ss` is a value.
    if (index === 0 || /\s/.test(line[index - 1])) {
      start = index;
      break;
    }
  }
  context.commentStart = start;
  return start;
}

/**
 * Positions of shell operators that end an assignment value.
 *
 * `DB_PASSWORD=correct horse battery staple` is a passphrase; `DB_PASSWORD=secret && echo done`
 * is an assignment followed by another command. An operator only counts when whitespace touches
 * it, so `pa&&ss` and `pa;ss` stay one value, and an operator at the very start of the value is
 * part of it (`secret: &&w0rd`).
 */
function commandSeparatorsFor(line: string, context: LineContext): number[] {
  if (context.commandSeparators !== undefined) return context.commandSeparators;
  const quotes = quoteStateFor(line, context);
  const separators: number[] = [];
  for (let index = 0; index < line.length; index += 1) {
    if (quotes[index] !== 0) continue;
    const ch = line[index];
    const spaced =
      (index > 0 && /\s/.test(line[index - 1])) ||
      (index + 1 < line.length && /\s/.test(line[index + 1]));
    if (ch === "&" || ch === "|") {
      if (line[index + 1] === ch) {
        const after = index + 2;
        const doubleSpaced =
          spaced || after >= line.length || /\s/.test(line[after] as string);
        if (doubleSpaced) separators.push(index);
        index += 1;
      } else if (spaced) {
        separators.push(index);
      }
    } else if ((ch === ";" || ch === ">" || ch === "<") && spaced) {
      separators.push(index);
    }
  }
  context.commandSeparators = separators;
  return separators;
}

/** End of the assignment value that starts at `start`, including spaces, minus any comment. */
function lineValueEnd(line: string, start: number, context: LineContext): number {
  const comment = commentStartFor(line, context);
  let end = comment > start ? comment : line.length;
  for (const separator of commandSeparatorsFor(line, context)) {
    if (separator > start && separator < end) {
      end = separator;
      break;
    }
  }
  while (end > start && /\s/.test(line[end - 1] as string)) end -= 1;
  return end;
}

/** True when a quote on the line is preceded by syntax that can own a string value. */
function hasStructuralQuote(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (ch !== '"' && ch !== "'" && ch !== "`") continue;
    if (ch === "'" && index > 0 && /[A-Za-z0-9]/.test(line[index - 1])) continue;
    let backslashes = 0;
    for (let before = index - 1; before >= 0 && line[before] === "\\"; before -= 1) backslashes += 1;
    if (backslashes % 2 === 1) continue;
    let before = index - 1;
    while (before >= 0 && (line[before] === " " || line[before] === "\t")) before -= 1;
    if (before < 0 || "+,=:([{".includes(line[before] as string)) return true;
  }
  return false;
}

/** Masks a PEM line that is not inside a quoted segment, keeping indentation and comment syntax. */
function maskRawPemLine(line: string): string {
  if (line.trim() === "") return line;
  const leading = /^[ \t]*(?:#|\/\/|;)?[ \t]*/.exec(line)?.[0] ?? "";
  let rest = line.slice(leading.length);
  const trailing = /[ \t]*(?:[,;\\+])?[ \t]*$/.exec(rest)?.[0] ?? "";
  rest = rest.slice(0, rest.length - trailing.length);
  return leading + (rest.length > 0 ? PEM_REDACTION_MARKER : "") + trailing;
}

/**
 * Replaces one physical line of a PEM block with a skeleton that keeps the syntax around it.
 *
 * The block used to be replaced by one marker plus blank lines. In an array of quoted lines that
 * removed every intermediate quote and comma, welding the elements into a single string; in a
 * concatenation it removed the `+` operators. Both changed the program the snapshot describes.
 * `initialQuote` is the literal state carried in from the previous line, so a template literal
 * that spans the block closes on the right backtick.
 */
function skeletonisePemLine(
  line: string,
  initialQuote: number
): { text: string; quote: number } {
  const hasQuote = line.includes('"') || line.includes("'") || line.includes("`");
  const structural =
    initialQuote !== 0 ||
    (hasQuote && (hasStructuralQuote(line) || /-----BEGIN|-----END/.test(line)));
  if (!structural) return { text: maskRawPemLine(line), quote: initialQuote };

  let out = "";
  let quote = initialQuote;
  let masking = false;
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (quote === 0) {
      if (isOpeningQuote(line, index)) {
        quote = code;
        masking = false;
      }
      out += line[index];
      continue;
    }
    if (code === 92) {
      // The marker for the run before the escape was already emitted when that run began;
      // emitting another here put two markers inside one quoted segment.
      masking = false;
      out += line[index];
      if (index + 1 < line.length) {
        out += line[index + 1];
        index += 1;
      }
      continue;
    }
    if (code === quote) {
      // The marker was already emitted when the content run began; emitting another here put two
      // markers inside one quoted segment.
      masking = false;
      quote = 0;
      out += line[index];
      continue;
    }
    if (!masking) {
      out += PEM_REDACTION_MARKER;
      masking = true;
    }
  }
  return { text: out, quote };
}

/** Start and end of the physical line(s) touched by `[start, end)` in `text`. */
function lineSpanAt(text: string, start: number, end: number): { start: number; end: number } {
  let lineStart = start;
  while (lineStart > 0 && text[lineStart - 1] !== "\n" && text[lineStart - 1] !== "\r") {
    lineStart -= 1;
  }
  let lineEnd = end;
  while (lineEnd < text.length && text[lineEnd] !== "\n" && text[lineEnd] !== "\r") lineEnd += 1;
  if (lineEnd < text.length) {
    lineEnd += text[lineEnd] === "\r" && text[lineEnd + 1] === "\n" ? 2 : 1;
  }
  return { start: lineStart, end: lineEnd };
}

/**
 * Rewrites the physical line(s) a PEM block touches, leaving everything outside the match alone.
 *
 * Expanding to whole lines is what keeps the boundary syntax intact: the opening quote of a
 * one-line JSON value lives before the `BEGIN` marker, and the closing quote lives after the
 * `END` marker. Processing the full line but substituting only the matched part means a key name
 * or a trailing statement on the same line is not collateral damage.
 */
function redactPemSpan(
  text: string,
  matchStart: number,
  matchEnd: number
): { replacement: string; start: number; end: number } {
  const span = lineSpanAt(text, matchStart, matchEnd);
  const segments = text.slice(span.start, span.end).split(LINE_BREAK);
  let quote = quoteStateAfter(text, 0, matchStart);
  let cursor = span.start;
  for (let index = 0; index < segments.length; index += 2) {
    const line = segments[index];
    const lineStart = cursor;
    const lineEnd = lineStart + line.length;
    cursor =
      lineEnd + (index + 1 < segments.length ? (segments[index + 1] as string).length : 0);
    const from = Math.max(lineStart, matchStart);
    const to = Math.min(lineEnd, matchEnd);
    if (from >= to) continue;
    const localFrom = from - lineStart;
    const localTo = to - lineStart;
    const result = skeletonisePemLine(line.slice(localFrom, localTo), quote);
    segments[index] = line.slice(0, localFrom) + result.text + line.slice(localTo);
    quote = result.quote;
  }
  return { replacement: segments.join(""), start: span.start, end: span.end };
}


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
/**
 * One compiled form per rule, reused across files.
 *
 * `toGlobal` builds a new `RegExp` for every rule on every file, and this runs on every file the
 * repository contains: a 20 000-file scan compiled 31 patterns 20 000 times, 620 000 objects that
 * are identical by construction. The rules are module-level constants and user-supplied rules are
 * stable for the life of a run, so a `WeakMap` keyed on the rule is exact — a rule that is
 * collected takes its compiled form with it.
 */
const COMPILED_RULES = new WeakMap<SecretRule, CompiledRule>();

function compiledRuleFor(rule: SecretRule): CompiledRule {
  let compiled = COMPILED_RULES.get(rule);
  if (compiled === undefined) {
    compiled = {
      rule: rule.rule,
      pattern: toGlobal(rule),
      ...(rule.valueGroup === undefined ? {} : { valueGroup: rule.valueGroup }),
    };
    COMPILED_RULES.set(rule, compiled);
  }
  return compiled;
}

export function scanAndRedactSecrets(
  content: string,
  rules: SecretRule[],
  filePath?: string
): {
  redacted: string;
  findings: SecretFinding[];
} {
  // One finding per line, however many rules matched it. A PEM finding and a per-line finding on
  // the same line are merged too, so the summary the user reads counts lines, not rules.
  const findingsByLine = new Map<number, Set<string>>();
  const recordFinding = (line: number, rulesForLine: Iterable<string>): void => {
    let entry = findingsByLine.get(line);
    if (entry === undefined) {
      entry = new Set<string>();
      findingsByLine.set(line, entry);
    }
    for (const rule of rulesForLine) entry.add(rule);
  };

  // Pass 1 — whole PEM blocks. This must run BEFORE the per-line pass: the
  // per-line rules only see the `BEGIN` header and would remove it, leaving
  // every subsequent body line of a real key behind.
  //
  // The replacement works line by line and keeps the syntax around the key: quotes, commas,
  // concatenation operators, escape sequences and the original terminators. Replacing the whole
  // block with one marker plus blank lines welded the elements of a string array into one string,
  // dropped the `+` operators of a concatenation, and turned a CRLF file's block into bare LFs.
  let redacted = content;
  for (const blockPattern of [PEM_BLOCK_PATTERN, PEM_UNTERMINATED_PATTERN]) {
    blockPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = blockPattern.exec(redacted)) !== null) {
      if (match[0].length === 0) {
        blockPattern.lastIndex = advanceStringIndex(redacted, match.index, blockPattern.unicode);
        continue;
      }
      const matchEnd = match.index + match[0].length;
      const line = (redacted.slice(0, match.index).match(LINE_TERMINATOR) ?? []).length + 1;
      const span = redactPemSpan(redacted, match.index, matchEnd);
      recordFinding(line, ["private-key-block"]);
      redacted = redacted.slice(0, span.start) + span.replacement + redacted.slice(span.end);
      blockPattern.lastIndex = span.start + span.replacement.length;
    }
  }

  // Pass 2 — per-line rules, on segments that exclude the line terminators.
  const compiled: CompiledRule[] = rules.map(compiledRuleFor);

  const segments = redacted.split(LINE_BREAK);
  let lineNumber = 1;

  for (let index = 0; index < segments.length; index += 2) {
    const line = segments[index];

    if (line.length > 0) {
      const spans: Span[] = [];
      const matchedRules = new Set<string>();
      const context: LineContext = {};

      for (const { rule, pattern, valueGroup } of compiled) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          if (match[0].length === 0) {
            pattern.lastIndex = advanceStringIndex(line, match.index, pattern.unicode);
            continue;
          }
          const group =
            valueGroup === undefined
              ? undefined
              : (match as RegExpExecArray & MatchIndices).indices?.[valueGroup];
          // A placeholder is documentation, not a credential.
          const candidate = group
            ? line.slice(group[0], group[1])
            : line.slice(match.index, match.index + match[0].length);
          if (isPlaceholderValue(candidate)) continue;
          // In a source file an unquoted right-hand side is an expression — an identifier, a member
          // access, a ternary branch, an object-literal property. Only text inside a string literal
          // can be a credential literal there.
          if (
            group &&
            isUnquotedValue(line, group[0]) &&
            isSourceCodeFile(filePath) &&
            (quoteStateFor(line, context)[match.index] ?? 0) === 0
          ) {
            continue;
          }
          // A value that begins with a shell reference (`$VAR`, `${VAR:-x}`, `$(cmd)`) is not a
          // literal, and masking a prefix of the expansion swallowed the closing quote of the
          // string it lived in. Skipping it keeps the line parseable; the referenced value is not
          // in this file anyway.
          if (
            group &&
            /^\$[({A-Za-z_]/.test(line.slice(group[0], group[1])) &&
            (isAssignmentFile(filePath) || isUnquotedValue(line, group[0]))
          ) {
            continue;
          }
          // `? "PASS" : "MUTATE"` is a ternary, not an assignment: the rule read the true-branch
          // string as a weak key and the false-branch string as its value.
          if (rule === "credential-assignment-weak" && group) {
            let before = match.index - 1;
            while (before >= 0 && (line[before] === " " || line[before] === "\t")) before -= 1;
            if (before >= 0 && (line[before] === "?" || line[before] === ":")) continue;
            const keyText = line.slice(match.index, group[0]).replace(/["'\s:=]+/g, " ").trim();
            if (
              /^(?:PASS|FAIL)$/i.test(keyText) &&
              /^[A-Z]{2,}$/.test(line.slice(group[0], group[1]))
            ) {
              continue;
            }
          }
          // A constant whose value spells its own name is a symbol table entry, not a
          // credential; masking it would rewrite the meaning of the code it documents.
          if (group && isSelfNamingConstant(line, group[0], group[1])) continue;
          // A quoted span that contains a concatenation is code, not a value. Widening the value
          // class to allow the other quote character (SEC-03) let one literal's closing quote pair
          // with the next literal's opening quote, swallowing ` + secretVar + ` and masking an
          // expression variable in `'export API_KEY="' + secretVar + '"'`. A credential literal
          // never has whitespace around a `+`.
          if (
            group &&
            !isUnquotedValue(line, group[0]) &&
            /["'`]\s*\+\s*|\s*\+\s*["'`]/.test(line.slice(group[0], group[1]))
          ) {
            continue;
          }
          // A tail-matching key that began inside a string literal is text, not an assignment —
          // unless the literal closes between the key and the value.
          if (
            valueGroup !== undefined &&
            startsInsideStringLiteral(line, match.index, group?.[0], context, filePath)
          ) {
            continue;
          }
          // An unquoted value in a declaration is an expression, not a credential literal.
          if (
            group &&
            isUnquotedValue(line, group[0]) &&
            isDeclaredBinding(line, match.index, filePath)
          ) {
            continue;
          }
          // A "quoted value" that is entirely a template interpolation is code, not a literal.
          if (group && isTemplateInterpolation(line, group[0], group[1])) continue;
          // An unquoted value that stops at a character the value alphabet does not contain would
          // be masked up to that character only: the marker, then the rest of the password. Drop
          // the match instead — see TRUNCATING_VALUE_CHARS.
          if (
            group &&
            isUnquotedValue(line, group[0]) &&
            TRUNCATING_VALUE_CHARS.test(line[group[1]] ?? "")
          ) {
            continue;
          }
          // The whole-value fallbacks in \`credential-assignment-unquoted\` (the colon form and the
          // lowercase \`KEY=value\` form) match the value alone with no capture group, so \`group\` is
          // undefined for them. They take symbols a password may contain but an expression also
          // uses (\`pa&ss\`), so only a data or shell file may be masked this way; a URL query
          // parameter or a shell \`$VARIABLE\` reference is not an assignment and keeps its tail.
          if (valueGroup !== undefined && group === undefined) {
            if (!isAssignmentFile(filePath)) continue;
            const assignment = assignmentAround(line, match.index);
            if (
              assignment.form === "=" &&
              (assignment.reference ||
                assignment.key === null ||
                !CREDENTIAL_KEY_TAIL.test(assignment.key))
            ) {
              continue;
            }
          }
          // An opener-led value is a literal in a data file and an expression in source code.
          // Only the data-file reading is a credential; see OPENER_LED_VALUE.
          if (
            group &&
            isUnquotedValue(line, group[0]) &&
            OPENER_LED_VALUE.test(line.slice(group[0], group[1])) &&
            !isAssignmentFile(filePath)
          ) {
            continue;
          }
          // \`&\` ends the token a rule can see, but the credential may continue past it. In a
          // data-file colon form (\`password: pa&ss\`) the rest belongs to the value; in a URL query
          // (\`?access_token=…&scope=read\`) it is the next parameter. Mask the token either way and
          // keep the separator unless this is the colon form — never drop the match, because a
          // dropped match emits the credential in clear (that was the 1.0.0 regression this guard
          // replaces).
          // A generic match sees only part of the value when the rest is symbols its alphabet does
          // not carry (DB_PASSWORD=envpass!@#$%^&*() matched envpass!@#$%^&* and emitted the tail
          // &*() beside the marker). In a data-file assignment whose key names a credential, the
          // value is the whole whitespace-delimited token, so mask that. A URL query parameter or a
          // $VARIABLE reference is not an assignment and is never extended; a match is never
          // dropped, because a dropped match emits the credential in clear.
          if (group && isUnquotedValue(line, group[0])) {
            const assignment = assignmentAround(line, group[0]);
            // A mask must never be followed by a tail of the value. In a data or shell file any
            // mask that lands inside an assignment value (KEY=value or key: value) runs to the end
            // of the whitespace-delimited value, whatever the key is called — the red team's
            // DB_PASSWORD0=envpass!@#$%^&*() left #$%^&*() after the marker because a weaker rule
            // matched the prefix and the key was not a strong name. A URL query parameter, a shell
            // variable reference and a URL value are not extended: ?access_token=abc&expires=3600
            // must keep its tail.
            const wholeValue =
              isAssignmentFile(filePath) &&
              assignment.form !== null &&
              !assignment.reference &&
              !assignment.urlValue;
            if (wholeValue) {
              spans.push({
                start: group[0],
                // A passphrase contains spaces: `DB_PASSWORD=correct horse battery staple` used to
                // stop at the first one and emit the rest beside the marker. Stop at the end of
                // the value, a trailing comment, or a shell operator instead. The rule's own end
                // is not used: the colon form's value pattern includes the spaces before a
                // trailing `# comment`, and masking them welds the comment to the marker.
                end: lineValueEnd(line, group[0], context),
                rule,
              });
              matchedRules.add(rule);
              continue;
            }
          }
          spans.push(
            group
              ? { start: group[0], end: group[1], rule }
              : { start: match.index, end: match.index + match[0].length, rule }
          );
          matchedRules.add(rule);
        }
      }

      // A credential split across a concatenation: `"X-Api-Key=" + "sk_live_…"`. Every rule
      // above sees only the closing quote of the first literal and the opening quote of the
      // second, so the value has no key-shaped neighbour to anchor on and it reaches the
      // artefact in clear. The span covers the value literal only, never the `+` or the quotes.
      for (const span of concatenatedCredentialSpans(line)) {
        spans.push(span);
        matchedRules.add(span.rule);
      }

      if (spans.length > 0) {
        const maskedLine = applySpans(line, spans);
        // Belt and braces for a span that still crosses a literal boundary: if the original line
        // was balanced and the mask made it unbalanced, the mask describes a program that is not
        // the source. Leave the line untouched rather than emit broken code.
        if (!quotesAreBalanced(line) || quotesAreBalanced(maskedLine)) {
          recordFinding(lineNumber, matchedRules);
          segments[index] = maskedLine;
        }
      }
    }

    if (index + 1 < segments.length) lineNumber += 1;
  }

  let finalText = segments.join("");
  // Pass 3 — values a per-line rule cannot see. A YAML block scalar, a value on the following
  // line, and Docker's legacy `ENV KEY VALUE` form all put the credential in the artefact in
  // clear: the key and the value are on different physical lines, or separated by a space the
  // rules read as prose. The pass is format-aware on purpose — the same shape in a source file
  // is an expression, not a value.
  finalText = redactStructuredValues(finalText, filePath, recordFinding);
  finalText = redactDockerfileEnv(finalText, filePath, recordFinding);

  const findings: SecretFinding[] = [...findingsByLine.entries()]
    .sort(([left], [right]) => left - right)
    .map(([line, rulesForLine]) => ({
      rules: [...rulesForLine],
      line,
      path: filePath,
    }));
  return { redacted: finalText, findings };
}

/**
 * The next index a zero-length match may resume from.
 *
 * After an empty match, `lastIndex += 1` is only a safe advance when the pattern is not
 * Unicode-aware. With the `u` flag an index inside a surrogate pair is not a valid position: V8
 * resets `lastIndex` to 0 and reports the same empty match again, so `/(?:)/gu` against `"😀x"`
 * loops at index 0 forever. This is the advance `String.prototype.replace` uses: two code units
 * over a valid pair, one otherwise. A custom rule that can match empty is also refused at config
 * validation; this helper is the runtime half of the same fix.
 */
export function advanceStringIndex(text: string, index: number, unicode: boolean): number {
  if (!unicode) return index + 1;
  const first = text.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff) {
    const second = text.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) return index + 2;
  }
  return index + 1;
}

/** Extensions whose `key: value` is data rather than an expression. */
const STRUCTURED_FILE = /\.(?:json|jsonc|json5|ya?ml|toml|ini|conf|cfg|properties|env|tf|tfvars)$/i;
/** Data files spelled without a useful extension. */
const STRUCTURED_BASENAME =
  /^(?:\.env(?:\.[^/]*)?|docker-compose(?:\.[^/]*)?|compose(?:\.[^/]*)?)$/i;

/** True for a file whose assignments are data, not code. */
function isStructuredFile(filePath: string | undefined): boolean {
  if (filePath === undefined) return false;
  const normalised = filePath.replace(/\\/g, "/");
  if (STRUCTURED_FILE.test(normalised)) return true;
  return STRUCTURED_BASENAME.test(normalised.slice(normalised.lastIndexOf("/") + 1));
}

/** True for a Dockerfile, the only format where `ENV KEY VALUE` is an assignment. */
function isDockerfile(filePath: string | undefined): boolean {
  if (filePath === undefined) return false;
  const normalised = filePath.replace(/\\/g, "/");
  return /^(?:Dockerfile|[^/]*\.dockerfile)$/i.test(
    normalised.slice(normalised.lastIndexOf("/") + 1)
  );
}

/** Replaces one line's non-indented content, keeping its indentation. */
function maskLineContent(line: string): string {
  if (line.trim() === "") return line;
  const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
  return `${indent}${REDACTION_MARKER}`;
}

/**
 * Masks one line of a multi-line value while keeping the file parseable.
 *
 * A quoted scalar keeps its quotes and any trailing separator, so a formatted JSON object is
 * still valid JSON after the masking; an unquoted YAML scalar is replaced whole.
 */
function maskValueLine(line: string): string {
  if (line.trim() === "") return line;
  const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
  const content = line.slice(indent.length);
  const quoted = /^(["'`])(.*)\1([,;]?[ \t]*)$/.exec(content);
  if (quoted !== null) {
    return `${indent}${quoted[1]}${REDACTION_MARKER}${quoted[1]}${quoted[3] ?? ""}`;
  }
  return `${indent}${REDACTION_MARKER}`;
}

/** `key:` or `key=`, optionally quoted, with the rest of the line after the separator. */
const STRUCTURED_KEY = /^([ \t]*)["']?([A-Za-z0-9_$.-]{1,128})["']?[ \t]*([:=])[ \t]*(.*)$/;
/** A YAML block scalar indicator: `|`, `>`, with optional chomping and indentation digits. */
const BLOCK_SCALAR = /^[|>][+-]?\d*[ \t]*(?:#.*)?$/;

/**
 * Masks a YAML block scalar body and a value written on the line after its key.
 *
 * Redaction is otherwise per physical line, so a key with no value on its own line has nothing
 * for a rule to match. Both shapes are ordinary configuration: a certificate or long token in a
 * block scalar, a formatted JSON object whose string sits one line below its key. The pass keeps
 * indentation and the `|`/`>` indicator, so the masked document still parses.
 */
function redactStructuredValues(
  text: string,
  filePath: string | undefined,
  recordFinding: (line: number, rules: Iterable<string>) => void
): string {
  if (!isStructuredFile(filePath)) return text;
  const segments = text.split(LINE_BREAK);

  for (let index = 0; index < segments.length; index += 2) {
    const line = segments[index];
    if (line === undefined || line.length === 0) continue;
    const match = STRUCTURED_KEY.exec(line);
    if (match === null) continue;
    const key = match[2] ?? "";
    if (!CREDENTIAL_KEY_TAIL.test(key)) continue;
    const baseIndent = (match[1] ?? "").length;
    const rest = (match[4] ?? "").trim();

    if (BLOCK_SCALAR.test(rest)) {
      let cursor = index + 2;
      let masked = false;
      while (cursor < segments.length) {
        const body = segments[cursor] ?? "";
        if (body.trim() !== "") {
          const indent = (/^[ \t]*/.exec(body)?.[0] ?? "").length;
          if (indent <= baseIndent) break;
          segments[cursor] = maskLineContent(body);
          masked = true;
        }
        cursor += 2;
      }
      if (masked) recordFinding(index / 2 + 1, ["credential-block-scalar"]);
      continue;
    }

    if (rest !== "") continue;
    let cursor = index + 2;
    while (cursor < segments.length && (segments[cursor] ?? "").trim() === "") cursor += 2;
    const firstValue = segments[cursor];
    if (firstValue === undefined) continue;
    const valueIndent = (/^[ \t]*/.exec(firstValue)?.[0] ?? "").length;
    if (valueIndent <= baseIndent) continue;
    let masked = false;
    while (cursor < segments.length) {
      const body = segments[cursor] ?? "";
      if (body.trim() !== "") {
        const indent = (/^[ \t]*/.exec(body)?.[0] ?? "").length;
        if (indent < valueIndent) break;
        segments[cursor] = maskValueLine(body);
        masked = true;
      }
      cursor += 2;
    }
    if (masked) recordFinding(index / 2 + 1, ["credential-multiline-value"]);
  }

  return segments.join("");
}

/** Docker's legacy space-separated `ENV KEY VALUE`, which the rules read as prose. */
const DOCKERFILE_ENV = /^([ \t]*ENV[ \t]+)([A-Za-z_][A-Za-z0-9_]*)([ \t]+)(\S.*)$/;

/**
 * Masks `ENV API_KEY value` in a Dockerfile.
 *
 * The `KEY=value` spelling is covered by the generic assignment rules; the space-separated form
 * is still valid Docker and was emitted in clear. `ARG` has no space form — `ARG KEY VALUE` is
 * not valid Docker — so only `ENV` is handled, and only in a Dockerfile: in a shell script
 * `env KEY value` is a command.
 */
function redactDockerfileEnv(
  text: string,
  filePath: string | undefined,
  recordFinding: (line: number, rules: Iterable<string>) => void
): string {
  if (!isDockerfile(filePath)) return text;
  const segments = text.split(LINE_BREAK);
  for (let index = 0; index < segments.length; index += 2) {
    const line = segments[index];
    if (line === undefined) continue;
    const match = DOCKERFILE_ENV.exec(line);
    if (match === null) continue;
    if (!CREDENTIAL_KEY_TAIL.test(match[2] ?? "")) continue;
    const value = match[4] ?? "";
    if (value.startsWith("=")) continue;
    segments[index] = `${match[1]}${match[2]}${match[3]}${REDACTION_MARKER}`;
    recordFinding(index / 2 + 1, ["dockerfile-env-secret"]);
  }
  return segments.join("");
}

/**
 * A credential written as `"key=" + "value"` on one line.
 *
 * The first literal ends at the separator and the second is the value, so no rule sees a key
 * beside a value: the match begins on the closing quote of one literal and ends on the opening
 * quote of the next. The reported span is group 4 — the value literal's contents — so the `+` and
 * the quotes that make the expression valid are untouched. A variable after the `+`
 * (`"key=" + secretVar`) is not a literal and is deliberately not matched.
 */
const CONCATENATED_CREDENTIAL = new RegExp(
  "([A-Za-z0-9_$.-]{0,64}(?:password|passwd|passphrase|pwd|api[_-]?key|api[_-]?secret|" +
    "access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret[_-]?key|" +
    "client[_-]?secret|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|" +
    "session[_-]?token|session[_-]?key|secret|token))\\s*=\\s*(?<=[=:]\\s{0,8})([\"'`])\\s*\\+\\s*" +
    "([\"'`])((?:(?!\\3)[^\\\\\\n]|\\\\.){1,512})\\3",
  "gid"
);

/** Spans of concatenated credential values on one line. */
function concatenatedCredentialSpans(line: string): Span[] {
  const spans: Span[] = [];
  CONCATENATED_CREDENTIAL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONCATENATED_CREDENTIAL.exec(line)) !== null) {
    const group = (match as RegExpExecArray & MatchIndices).indices?.[4];
    if (group !== undefined) {
      spans.push({ start: group[0], end: group[1], rule: "credential-concatenation" });
    }
  }
  return spans;
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
 * Characters that mean an unquoted value was **truncated**, not completed.
 *
 * `UNQUOTED_LITERAL` stops at every character outside a credential's alphabet, and its trailing
 * lookahead already rejects the openers (`(`, `[`, `{`): there the value was an expression, and no mask
 * is the right answer. The four characters below are neither part of that alphabet nor a
 * legitimate value boundary, so a match that stops at one masks a prefix and then shows the rest
 * of the password beside the marker — `db_password: [REDACTED]$$w0rdSecr3t` is the recorded
 * failure. A mask that implies coverage it does not have is worse than no mask, so those
 * matches are dropped entirely.
 */
const TRUNCATING_VALUE_CHARS = /[<>|\\]/;

/**
 * A value that begins with an opener is a *literal* in a data file and an *expression* in source.
 *
 * \`password: (hunter2)\` is a credential in YAML; \`opts.token: (value)\` is a program expression,
 * and masking it would edit the code the snapshot is supposed to describe. The pattern requires a
 * closing bracket either way, so the match is always the whole token; this guard decides whether
 * the token is a value at all, from the file it came from.
 */
const OPENER_LED_VALUE = /^[(\\[{]/;

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
  // …but `/` and `+` belong to URLs and file paths as well as to base64 credentials, and walking
  // left through a path masked the path instead of the token: `https://example.com/v1/<key>` was
  // emitted as `https://example.[REDACTED]`, which contradicts "only the matched span is masked".
  // A run that ends against a `.` is a hostname or a filename, and one that ends against a `:` is a
  // scheme; in both cases the token starts after the last `/` of the run and no further left.
  const walked = line.slice(left, start);
  const boundary = left > 0 ? line[left - 1] : "";
  if (walked.includes("/") && (boundary === "." || boundary === ":")) {
    left += walked.lastIndexOf("/") + 1;
  }
  while (right < line.length && TOKEN_CHARS_RIGHT.test(line[right])) right += 1;
  return { start: left, end: right };
}

/**
 * True when the matched credential name is text rather than a key: it begins inside a string
 * literal **and** that literal closes before the value does.
 *
 * Credential names are matched as a **tail** (`dbPassword` matches on `Password`), which is what
 * catches camelCase keys. The same tail matching let `for (const key of ["awsSecret:", "apiKey:"])`
 * be read as an assignment: the match began at `Secret`, inside the string `"awsSecret:"`, so the
 * string's closing quote was taken as the value's opening quote and the next element's opening
 * quote as its closing quote — the emitted line had two list elements welded together.
 *
 * Looking only at the character immediately before the identifier was not enough: a name preceded
 * by a space inside a literal (`"note: awsSecret: …"`) still read as a key. The quote state is
 * therefore taken from a single left-to-right pass over the line, not from a prefix slice per
 * match — the slice was quadratic on a long line.
 *
 * Being inside a literal is not by itself a reason to refuse: a connection string is written into
 * a string, and `const dsn = "password=hunter2;host=db"` and `curl -d "password=hunter2"` were
 * emitted in clear when every literal was refused. What separates them is whether the literal
 * closes between the name and the value. In `"password=hunter2"` it does not — the name and the
 * value are in the same literal, which is what an assignment looks like when it is written inside
 * one. In `` `password: "…"` `` it does: the literal opened before the name closes, and the value
 * belongs to a different one.
 */
function startsInsideStringLiteral(
  line: string,
  matchIndex: number,
  valueStart: number | undefined,
  context: LineContext,
  filePath?: string
): boolean {
  const quote = quoteStateFor(line, context)[matchIndex] ?? 0;
  if (quote === 0) return false;
  // A markdown inline code span is documentation, not code: `\`password: "…"\`` in a sentence is
  // an example, and masking it changes the sentence a reader sees. Only a match that begins
  // *inside* the span is skipped — a fenced block's body lines carry no backtick, so a real
  // credential in one is still masked.
  if (quote === 96 && /\.(?:md|mdx)$/i.test(filePath ?? "")) return true;
  // Without a value span there is nothing to weigh: the match is the credential itself.
  if (valueStart === undefined) return true;
  for (let index = matchIndex; index < valueStart; index += 1) {
    const code = line.charCodeAt(index);
    if (code === 92) {
      index += 1;
    } else if (code === quote) {
      return true;
    }
  }
  return false;
}

/**
 * True when the whole matched "value" is a `${…}` interpolation.
 *
 * A template literal is a string, so `startsInsideStringLiteral` — which only looks for a quote
 * immediately before the identifier — cannot tell `` `… an empty token: "${appliesTo}"` `` from
 * a real assignment. The credential rule then masked the interpolation and emitted
 * `` `… an empty token: "[REDACTED…]"` ``, rewriting a test's assertion message.
 *
 * The test is on the *value*, not on the line: an interpolated value is an expression, and no
 * credential is spelled `${…}`. A mixed value (`"prefix-${x}"`) is still masked, because that
 * shape is not provably prose and rule 3 asks for fail-closed.
 *
 * "Starts with `${` and ends with `}`" was not enough. The shell, Docker Compose and GitHub Actions
 * idiom for a default — `POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-MyProdPassword123!}"` — begins and
 * ends exactly that way and contains a **hardcoded fallback credential**, which this then left in
 * clear text. So did `${process.env.TOKEN ?? "sk_live_…"}` and `${prefix}-real_secret-${suffix}`.
 * The exemption is now only for a value that is *one* interpolation of a plain (dotted) reference:
 * no fallback operator, no second interpolation, no quotes. That is the shape that is provably code.
 */
function isTemplateInterpolation(line: string, start: number, end: number): boolean {
  if (line[start] !== "$" || line[start + 1] !== "{" || line[end - 1] !== "}") {
    return false;
  }
  const inner = line.slice(start + 2, end - 1).trim();
  // `:-`, `:=`, `??`, `||`, a nested `${` and a quote all mean "this is not a plain reference".
  return /^[A-Za-z_$][A-Za-z0-9_$.()[\]]*$/.test(inner);
}

/**
 * True when a quoted "value" is really the **name** it is assigned to.
 *
 * MCP's protocol table maps a field name to its own wire string —
 * `progressToken: "progressToken"` — and this repository's snapshot emitted that
 * line as `progressToken: "[REDACTED…]"`, corrupting the server's own constants.
 * The shape generalises to every symbol table (`headerName: "headerName"`), so it
 * is handled here rather than by enumerating protocol names in a regex.
 *
 * The test is made against the **line**, not the match, because the engine tries
 * every start position: `progressToken` also matches as the bare `Token` tail, and
 * a match-local check would keep that shorter span alive.
 *
 * A lowercase word assigned to itself (`password: "password"`) does not qualify:
 * it is a weak credential, and masking it is the fail-closed behaviour rule 3 asks
 * for. Only a camelCase identifier — one with a capital inside the word, which is
 * how a constant is spelled — is read as a self-reference.
 */
function isSelfNamingConstant(line: string, start: number, end: number): boolean {
  const value = line.slice(start, end);
  if (!/[a-z][A-Z]/.test(value)) return false;
  // Walk left over the separator instead of slicing the prefix: `line.slice(0, start)` allocated
  // a fresh string per match, and a 236 KB line holding 4,000 assignments spent most of its time
  // copying prefixes. The walk is bounded by the value's own length.
  //
  // The order is the reverse of `["'\`]?\s*[:=]\s*["'\`]$`: opening quote, whitespace, separator,
  // whitespace, the key's closing quote.
  let index = start;
  if (index > 0) {
    const openingQuote = line[index - 1];
    if (openingQuote === '"' || openingQuote === "'" || openingQuote === "`") index -= 1;
  }
  while (index > 0 && /\s/.test(line[index - 1])) index -= 1;
  if (index === 0) return false;
  if (line[index - 1] !== ":" && line[index - 1] !== "=") return false;
  index -= 1;
  while (index > 0 && /\s/.test(line[index - 1])) index -= 1;
  if (index > 0) {
    const closingQuote = line[index - 1];
    if (closingQuote === '"' || closingQuote === "'" || closingQuote === "`") index -= 1;
  }
  return line.endsWith(value, index);
}

/**
 * Files whose unquoted right-hand side is code, not a literal.
 *
 * The unquoted rules exist for YAML, compose, INI and shell. In a JavaScript or TypeScript file
 * the same shape is an object-literal property, a ternary branch or a reference —
 * `SEARXNG_SECRET_KEY: optionalString` and `"x-api-key": key` are the program itself. Masking
 * them changes what the file means without changing whether it parses.
 */
const SOURCE_CODE_FILE = /\.(?:[cm]?[jt]sx?)$/i;

function isSourceCodeFile(filePath: string | undefined): boolean {
  return filePath !== undefined && SOURCE_CODE_FILE.test(filePath.replace(/\\/g, "/"));
}

/**
 * Values that are placeholders rather than credentials.
 *
 * `replace-me-with-the-read-tier-key`, `sk-...`, `<fine-grained PAT…>` and `changeme` are
 * documentation: masking them rewrites the sentence a reader is meant to read, and it teaches an
 * agent that the marker means "secret" even where the file says "put your secret here".
 *
 * The test is narrow on purpose. Only a whole value that *is* a conventional placeholder is
 * skipped; a real credential that merely contains the word "example" is still masked, and a
 * three-dot ellipsis inside a value is treated as documentation because no generated credential
 * contains one.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^<[^>]*>?$/,
  /^\.{3,}$/,
  /^(?:x{4,}|X{4,}|\*{3,})$/,
  /^(?:replace|change)[-_ ]?me(?:[-_ ].*)?$/i,
  /^your[-_ ].*$/i,
  /^(?:example|sample)(?:[-_ ].*)?$/i,
];

function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim().replace(/^["'`]+/, "").replace(/["'`]+$/, "");
  if (trimmed.length === 0) return false;
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  return trimmed.includes("...") || /^<[^>]*$/.test(trimmed);
}

/**
 * True when every quote on the line is closed.
 *
 * A mask that starts inside one literal and ends at an inner quote leaves the line syntactically
 * broken — the 0.9.16 report's shell cases produced `CRON_SECRET="[REDACTED]"$ENV_FILE"…"`. The
 * rules above are the fix; this is the belt-and-braces check, applied only when the original line
 * was balanced so a multi-line template literal or an apostrophe in prose cannot trip it.
 */
function quotesAreBalanced(text: string): boolean {
  let single = 0;
  let double = 0;
  let backtick = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"') double += 1;
    else if (char === "'") single += 1;
    else if (char === "`") backtick += 1;
  }
  return double % 2 === 0 && single % 2 === 0 && backtick % 2 === 0;
}

/**
 * True when the matched value is **not** quoted, and therefore may be code rather than data.
 *
 * `dbPassword: "…"` is a literal in every file type. A bare `dbPassword: …` is a literal in
 * `.env`, YAML and compose — the formats the unquoted rules exist for — but an expression in
 * a source file. This only classifies the value; what to do about it is `isDeclaredBinding`.
 */

/** How the value at a match position relates to the text before it. */
interface ValueAssignment {
  /** The separator when the value is a right-hand side, `null` otherwise. */
  form: ":" | "=" | null;
  /** The key text without leading dashes, for the `=` form. */
  key: string | null;
  /** True for a URL query parameter or a shell `$VARIABLE` reference — not an assignment. */
  reference: boolean;
  /** First character of the right-hand side, or -1 when there is no separator. */
  rhsStart: number;
  /** True when the value is a URL (scheme://…): URLs are exempt from tail extension. */
  urlValue: boolean;
}

/**
 * Classifies the text immediately before a value match.
 *
 * The whole-value fallbacks in `credential-assignment-unquoted` match the value alone via a
 * lookbehind, and `redact.ts` decides from this whether the line really is an assignment. The
 * distinctions that matter: `password=pa&ss` in an INI file is an assignment, the
 * `access_token` of `?access_token=abc&expires=3600` is a query parameter and must keep the
 * parameters after it, and `$token=` is a shell reference. Leading dashes are stripped so
 * `--token=value` on a shell command line is still an assignment key.
 *
 * Dots are part of a key here, because properties files spell `db.password=` and a dotted key
 * still ends in a credential word.
 */
function assignmentAround(line: string, valueStart: number): ValueAssignment {
  let index = valueStart;
  while (index > 0 && (line[index - 1] === " " || line[index - 1] === "\t")) index -= 1;
  const separator = index > 0 ? (line[index - 1] as string) : "";
  if (separator !== ":" && separator !== "=") {
    return { form: null, key: null, reference: false, rhsStart: -1, urlValue: false };
  }
  const separatorIndex = index - 1;
  index = separatorIndex;
  while (index > 0 && (line[index - 1] === " " || line[index - 1] === "\t")) index -= 1;
  const keyEnd = index;
  while (index > 0 && /[A-Za-z0-9_$.-]/.test(line[index - 1] as string)) index -= 1;
  const key = line.slice(index, keyEnd).replace(/^-+/, "");
  const before = index > 0 ? (line[index - 1] as string) : "";
  const reference =
    before === "?" || before === "&" || before === "$" || before === '"' || before === "'" || before === "`";
  let rhsStart = separatorIndex + 1;
  while (rhsStart < line.length && (line[rhsStart] === " " || line[rhsStart] === "\t")) rhsStart += 1;
  const urlValue = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(line.slice(rhsStart, tokenEnd(line, rhsStart)));
  return { form: separator === ":" ? ":" : "=", key, reference, rhsStart, urlValue };
}

/**
 * End of the token that starts at \`start\`, stopping at whitespace or a comment marker.
 *
 * Used for the colon-form `&` case: the credential continues past the `&` to the end of the
 * assignment value, and a trailing \`# comment\` still starts a comment.
 */
function tokenEnd(line: string, start: number): number {
  let end = start;
  while (end < line.length && !/\s/.test(line[end] as string)) end += 1;
  return end;
}

function isUnquotedValue(line: string, start: number): boolean {
  const before = start > 0 ? line[start - 1] : "";
  return before !== '"' && before !== "'" && before !== "`";
}

/**
 * Keywords that introduce a binding. Everything after the separator is an initializer.
 *
 * `readonly`/`private`/`static` are included because a class field is a declaration too:
 * `private readonly apiKey = /…/` has the same shape as the module-level constant below. They only
 * mean that in a source file — see {@link isAssignmentFile}.
 *
 * Bare `export` is **not** here. In JavaScript and TypeScript it can never be followed by a name
 * and an `=` — `export foo = 1` does not parse; the keyword always comes first in
 * `export const foo = …`, where `const` is the word immediately before the name and this pattern
 * still matches it. In a shell script or a `.envrc`, though, `export api_key=hunter2` is an
 * ordinary assignment with a literal value, and listing `export` made the guard suppress
 * redaction for exactly the files most likely to hold a credential.
 *
 * Bare `declare` was the same mistake and is now gone for the same reason. `declare api_key=hunter2`
 * is a shell assignment; in TypeScript the keyword cannot introduce an initialised binding on its
 * own (`declare x = 1` does not parse) and the form that can, `declare const x = 1`, is matched
 * through `const` — the word immediately before the name.
 */
const DECLARATION_KEYWORDS =
  /\b(?:const|let|var|readonly|public|private|protected|static|using)\s+$/;

/**
 * Files whose `NAME=value` is an assignment in a *data* format or a shell script.
 *
 * `readonly` and `declare` introduce a binding in TypeScript and an assignment in POSIX sh, bash,
 * zsh and `.envrc` — the same word, opposite meaning — and the file a line came from is the only
 * thing that distinguishes them. In these files nothing is a declaration, so the guard never
 * applies: `readonly api_key=hunter2` was read as a class field and emitted in clear.
 */
const ASSIGNMENT_FILE =
  /\.(?:sh|bash|zsh|ksh|fish|env|ya?ml|toml|ini|conf|cfg|properties|tf|tfvars|service)$/i;
const ASSIGNMENT_BASENAME = /^(?:\.env(?:\.[^/]*)?|\.envrc|\.profile|\.bashrc|\.zshrc|\.bash_profile)$/i;

function isAssignmentFile(filePath: string | undefined): boolean {
  if (filePath === undefined) return false;
  const normalised = filePath.replace(/\\/g, "/");
  if (ASSIGNMENT_FILE.test(normalised)) return true;
  const base = normalised.slice(normalised.lastIndexOf("/") + 1);
  return ASSIGNMENT_BASENAME.test(base);
}

/**
 * How far left of the name a declaration keyword can be.
 *
 * The longest modifier run this recognises is `private static readonly ` (24 characters) plus the
 * keyword itself, so 40 is generous. The window exists so the guard costs the same on a long line
 * as on a short one: matching against `line.slice(0, runStart)` allocated the whole prefix once
 * per match, and a 236 KB line of 4,000 assignments went from under a second to 2.7 s.
 */
const DECLARATION_WINDOW = 40;

/**
 * True when the matched credential name is the target of a **declaration**, not a key.
 *
 * In a data file `NAME=value` the value is a literal. In a source file `const NAME = value`
 * the value is an expression, and masking any part of it edits the program: `const SINGLE_TOKEN
 * = /[^\sA-Za-z0-9_]/g;` was emitted by this tool as
 * `const SINGLE_TOKEN = [REDACTED: …][^\sA-Za-z0-9_]/g;` — the regex was destroyed and the
 * emitted line no longer parses. The same shape reaches `const accessToken = tokens[0]` and
 * `const apiKey = someVariable`, where the "secret" is a reference.
 *
 * The engine retries every start position, so the **tail** of a longer identifier matches too
 * (`TOKEN` inside `SINGLE_TOKEN`). Walking back to the start of the run before looking for the
 * keyword is what makes the guard apply to the tail as well — a check at `match.index` alone
 * would let the shorter match through and corrupt the line anyway.
 */
function isDeclaredBinding(line: string, matchIndex: number, filePath?: string): boolean {
  if (isAssignmentFile(filePath)) return false;
  let runStart = matchIndex;
  while (runStart > 0 && /[A-Za-z0-9_$]/.test(line[runStart - 1])) runStart -= 1;
  const from = Math.max(0, runStart - DECLARATION_WINDOW);
  // A keyword is a whole word, so `\b` refuses `xconst `. When the window begins mid-identifier
  // the `\b` is measured against the window's own edge, which can only misjudge a keyword that
  // starts at the very first window character — a shape that needs an identifier ending in
  // `const` immediately before the credential name, and whose only effect is to leave a literal
  // unmasked.
  return DECLARATION_KEYWORDS.test(line.slice(from, runStart));
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
