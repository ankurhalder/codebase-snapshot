/**
 * A conservative acceptance test for a regular expression supplied by an MCP client.
 *
 * JavaScript has no regex timeout. A handler that compiles `(a+)+$` against part text runs on the
 * main event loop, so one prompt can stop every other client until the process is killed. Running
 * the regex in a worker would be the complete answer, but it would also move every search off the
 * thread that owns the part cache; the patterns this tool advertises are path and text searches,
 * not a general regex engine, so refusing the shapes that make catastrophic backtracking possible
 * is the smaller and more predictable boundary.
 *
 * The checks are deliberately conservative: a pattern with two unbounded quantifiers
 * (`.*foo.*`) is refused even when it might be linear, because 4 MB of adversarial text makes
 * the exception expensive. A caller can narrow the search instead.
 */
const MAX_PATTERN_LENGTH = 256;
/**
 * A bounded quantifier is not automatically cheap: `a{1,10000}` explores 10,000 states per
 * starting position, and chaining a handful of them turns that into a polynomial that a long line
 * can make effectively unbounded. The ceiling is deliberately far below the previous 10,000.
 */
const MAX_QUANTIFIER_REPEAT = 200;
/**
 * Every atom can carry one repetition, and a second one is already enough to build a two-level
 * backtracking stack. Beyond two, the pattern is a denial-of-service attempt rather than a search.
 */
const MAX_REPETITIONS = 2;
/**
 * The product of bounded repetition widths. Two independent `{1,200}` atoms can still explore
 * 40,000 states per starting position, which a long line turns into a quadratic freeze even though
 * neither quantifier alone is unreasonable. The product is the budget that catches that chain.
 */
const MAX_REPETITION_PRODUCT = 1_000;

/** Returns a human-readable reason the pattern is refused, or null when it may be compiled. */
export function unsafeRegExpReason(source: string): string | null {
  if (source.length === 0) return null;
  if (source.length > MAX_PATTERN_LENGTH) {
    return `the pattern is longer than ${MAX_PATTERN_LENGTH} characters`;
  }

  let inClass = false;
  let unbounded = 0;
  let repetitions = 0;
  let repetitionProduct = 1;
  const groups: Array<{ quantified: boolean; alternation: boolean }> = [];

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "(") {
      groups.push({ quantified: false, alternation: false });
      continue;
    }
    if (char === ")") {
      const group = groups.pop();
      if (group === undefined) continue;
      if (isQuantifiedAt(source, index + 1)) {
        if (group.quantified || group.alternation) {
          return "a quantified group contains another quantifier or an alternation";
        }
        group.quantified = true;
      } else if (isOptionalQuantifierAt(source, index + 1)) {
        // `(a?)+` is still a nested quantifier even though the inner one is optional. Mark the
        // group so a repeating outer quantifier sees it; an optional outer quantifier alone is
        // safe and must not be rejected.
        group.quantified = true;
      }
      // A child's flags belong to every enclosing group. Without this, `((.|.))+` looked like
      // an unquantified outer group holding a harmless inner one, and the outer `+` passed.
      const parent = groups[groups.length - 1];
      if (parent !== undefined) {
        parent.quantified = parent.quantified || group.quantified;
        parent.alternation = parent.alternation || group.alternation;
      }
      continue;
    }
    if (char === "|") {
      const group = groups[groups.length - 1];
      if (group !== undefined) group.alternation = true;
      continue;
    }
    if (char === "?") {
      // `?` is also the first character of `(?:...)`, `(?=...)` and `(?<name>...)`; those are
      // group syntax, not optional quantifiers. A lazy `+?` / `*?` / `??` is not an extra atom.
      const previous = source[index - 1];
      if (previous !== "(" && previous !== "?" && previous !== "*" && previous !== "+" && previous !== "}") {
        const group = groups[groups.length - 1];
        if (group !== undefined) group.quantified = true;
      }
      continue;
    }
    if (char === "*" || char === "+") {
      unbounded += 1;
      repetitions += 1;
      if (repetitions > MAX_REPETITIONS) {
        return "the pattern chains more repeating quantifiers than the search budget can evaluate safely";
      }
      const group = groups[groups.length - 1];
      if (group !== undefined) group.quantified = true;
      continue;
    }
    if (char === "{") {
      const close = source.indexOf("}", index + 1);
      if (close === -1) continue;
      const body = source.slice(index + 1, close);
      const match = /^(\d+)(?:,(\d*))?$/.exec(body);
      if (match === null) {
        // JavaScript without the `u` flag parses an invalid `{...}` as literal characters. The
        // previous `index = close` skipped every token inside the braces, so `{z|(.+)+!|}`
        // was accepted wholesale and then compiled with its catastrophic inner expression intact.
        // Treat the brace as a literal and keep scanning the interior.
        continue;
      }
      const min = Number(match[1]);
      const max = match[2] === undefined ? min : match[2] === "" ? Infinity : Number(match[2]);
      if (max > MAX_QUANTIFIER_REPEAT) {
        return "a repetition bound is larger than the search budget can evaluate safely";
      }
      if (max === Infinity) unbounded += 1;
      if (max > 1) {
        repetitions += 1;
        if (repetitions > MAX_REPETITIONS) {
          return "the pattern chains more repeating quantifiers than the search budget can evaluate safely";
        }
        repetitionProduct *= Number.isFinite(max) ? max : 1;
        if (repetitionProduct > MAX_REPETITION_PRODUCT) {
          return "the pattern's bounded repetition widths multiply beyond the search budget";
        }
      }
      const group = groups[groups.length - 1];
      if (group !== undefined) group.quantified = true;
      index = close;
    }
  }

  if (unbounded > 1) {
    return "the pattern has more than one unbounded repetition";
  }
  return null;
}

/** True when `source[start]` starts a `?` or a `{0,1}`-style optional quantifier. */
function isOptionalQuantifierAt(source: string, start: number): boolean {
  if (source[start] === "?") return true;
  if (source[start] !== "{") return false;
  const close = source.indexOf("}", start + 1);
  if (close === -1) return false;
  const body = source.slice(start + 1, close);
  const match = /^(\d+)(?:,(\d*))?$/.exec(body);
  if (match === null) return false;
  const minimum = Number(match[1]);
  if (match[2] === undefined) return minimum <= 1;
  const maximum = match[2] === "" ? Infinity : Number(match[2]);
  return maximum <= 1;
}

/** True when `source[start]` starts a quantifier that can repeat more than once. */
function isQuantifiedAt(source: string, start: number): boolean {
  const char = source[start];
  if (char === "*" || char === "+") return true;
  if (char !== "{") return false;
  const close = source.indexOf("}", start + 1);
  if (close === -1) return false;
  const body = source.slice(start + 1, close);
  const match = /^(\d+)(?:,(\d*))?$/.exec(body);
  if (match === null) return false;
  if (match[2] === undefined) return Number(match[1]) > 1;
  if (match[2] === "") return true;
  return Number(match[2]) > 1;
}
