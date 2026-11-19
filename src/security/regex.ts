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
const MAX_QUANTIFIER_REPEAT = 10_000;

/** Returns a human-readable reason the pattern is refused, or null when it may be compiled. */
export function unsafeRegExpReason(source: string): string | null {
  if (source.length === 0) return null;
  if (source.length > MAX_PATTERN_LENGTH) {
    return `the pattern is longer than ${MAX_PATTERN_LENGTH} characters`;
  }

  let inClass = false;
  let unbounded = 0;
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
      const next = source[index + 1];
      if (next === "*" || next === "+" || (next === "{" && isUnboundedBrace(source, index + 1))) {
        if (group.quantified || group.alternation) {
          return "a quantified group contains another quantifier or an alternation";
        }
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
        index = close;
        continue;
      }
      const max = match[2] === undefined ? Number(match[1]) : match[2] === "" ? Infinity : Number(match[2]);
      if (max > MAX_QUANTIFIER_REPEAT) {
        return "a repetition bound is larger than the search budget can evaluate safely";
      }
      if (max === Infinity) unbounded += 1;
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

/** True when the brace at `start` is an open-ended `{n,}` quantifier. */
function isUnboundedBrace(source: string, start: number): boolean {
  const close = source.indexOf("}", start + 1);
  if (close === -1) return false;
  const body = source.slice(start + 1, close);
  return /^\d+,$/.test(body);
}
