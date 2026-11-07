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
 * Any line terminator, for counting.
 *
 * `LINE_BREAK` captures so `String.split` keeps the terminators; this one only counts, and it has
 * to recognise all three forms or a CR-only file reports every later line number off by the length
 * of a masked block.
 */
const LINE_TERMINATOR = /\r\n|\n|\r/g;


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
  const findings: SecretFinding[] = [];

  // Pass 1 — whole PEM blocks. This must run BEFORE the per-line pass: the
  // per-line rules only see the `BEGIN` header and would remove it, leaving
  // every subsequent body line of a real key behind.
  // The replacement preserves the block's line count so line numbers reported
  // by pass 2 stay accurate. "Line count" means every terminator the block
  // contained, not just `\n`: a CR-only file (old-Mac endings, which `decodeText`
  // passes through) matched a whole block and replaced it with a marker carrying
  // *no* line breaks, so every line number after the key was wrong.
  let redacted = content;
  for (const blockPattern of [PEM_BLOCK_PATTERN, PEM_UNTERMINATED_PATTERN]) {
    blockPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = blockPattern.exec(redacted)) !== null) {
      if (match[0].length === 0) {
        blockPattern.lastIndex += 1;
        continue;
      }
      const before = redacted.slice(0, match.index);
      const line = (before.match(LINE_TERMINATOR) ?? []).length + 1;
      const newlines = (match[0].match(LINE_TERMINATOR) ?? []).length;
      findings.push({ rules: ["private-key-block"], line, path: filePath });
      redacted =
        before +
        PEM_REDACTION_MARKER +
        "\n".repeat(newlines) +
        redacted.slice(match.index + match[0].length);
      blockPattern.lastIndex = match.index + PEM_REDACTION_MARKER.length + newlines;
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
          // A constant whose value spells its own name is a symbol table entry, not a
          // credential; masking it would rewrite the meaning of the code it documents.
          if (group && isSelfNamingConstant(line, group[0], group[1])) continue;
          // A tail-matching key that began inside a string literal is text, not an assignment —
          // unless the literal closes between the key and the value.
          if (valueGroup !== undefined && startsInsideStringLiteral(line, match.index, group?.[0])) {
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
          spans.push(
            group
              ? { start: group[0], end: group[1], rule }
              : { start: match.index, end: match.index + match[0].length, rule }
          );
          matchedRules.add(rule);
        }
      }

      if (spans.length > 0) {
        // One finding per line, however many rules matched it. Pushing one per rule made a single
        // `AUTH_TOKEN=<value>` line count twice in the summary the user reads.
        findings.push({ rules: [...matchedRules], line: lineNumber, path: filePath });
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
 * True when the match started in the middle of an identifier that sits inside a
 * string literal.
 *
 * Credential names are matched as a **tail** (`dbPassword` matches on
 * `Password`), which is what catches camelCase keys. The same tail matching let
 * `for (const key of ["awsSecret:", "apiKey:"])` be read as an assignment: the
 * match began at `Secret`, inside the string `"awsSecret:"`, so the string's
 * closing quote was taken as the value's opening quote and the next element's
 * opening quote as its closing quote — the emitted line had two list elements
 * welded together with a marker between them. A regex lookbehind cannot see back
 * to the start of the identifier, so the check is made against the line here.
 *
 * A properly quoted key (`"dbPassword": "…"`, which is a real assignment) starts
 * at the quote, so its run begins there and the preceding character is not a
 * quote; only a match that began *inside* a literal is rejected.
 */
/**
 * True when the matched credential name is text rather than a key: it begins inside a string
 * literal **and** that literal closes before the value does.
 *
 * `["awsSecret:", "apiKey:"]` is a list of key *names*, and a documentation line that shows
 * `password: "${DB_PASSWORD:-hunter2}"` inside a code span is showing an assignment. Both put the
 * name immediately after an opening quote — the list because the element is a string, the code
 * span because Markdown opens it with a backtick — so the quote is evidence that the name belongs
 * to the surrounding text.
 *
 * That test alone also discarded every credential written into a string, and a connection string
 * is written into a string: `const dsn = "password=hunter2;host=db"` and
 * `curl -d "password=hunter2"` were emitted in clear. What separates them is whether a quote sits
 * between the name and the value. In `"password=hunter2"` there is none — the name and the value
 * are in the same literal, which is what an assignment looks like when it is written inside one.
 * In `` `password: "…"` `` there is: the literal opened before the name closes, and the value
 * belongs to a different one.
 */
function startsInsideStringLiteral(
  line: string,
  matchIndex: number,
  valueStart?: number
): boolean {
  let runStart = matchIndex;
  while (runStart > 0 && /[A-Za-z0-9_-]/.test(line[runStart - 1])) runStart -= 1;
  const before = runStart > 0 ? line[runStart - 1] : "";
  if (before !== '"' && before !== "'" && before !== "`") return false;
  // Without a value span there is nothing to weigh: the match is the credential itself.
  if (valueStart === undefined) return true;
  return /["'`]/.test(line.slice(matchIndex, valueStart));
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
 * True when the matched value is **not** quoted, and therefore may be code rather than data.
 *
 * `dbPassword: "…"` is a literal in every file type. A bare `dbPassword: …` is a literal in
 * `.env`, YAML and compose — the formats the unquoted rules exist for — but an expression in
 * a source file. This only classifies the value; what to do about it is `isDeclaredBinding`.
 */
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
