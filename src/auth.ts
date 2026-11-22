/**
 * Reads a Bearer token from an Authorization header.
 *
 * The obvious regular expression (^Bearer\s+(.+)$) is linearithmic on a header made of many
 * tabs, because \s+ and .+ can each consume the same characters while the engine backtracks one
 * separator at a time. HTTP header values are attacker-controlled, so the scheme and separator are
 * parsed with indexes instead: one pass, no backtracking, and the same whitespace (space or tab)
 * the old expression accepted.
 */
export function parseBearerToken(header: string | undefined): string | null {
  if (typeof header !== "string") return null;

  const scheme = "bearer";
  if (header.length <= scheme.length) return null;
  if (header.slice(0, scheme.length).toLowerCase() !== scheme) return null;

  let index = scheme.length;
  if (header[index] !== " " && header[index] !== "\t") return null;
  while (index < header.length && (header[index] === " " || header[index] === "\t")) index += 1;

  const token = header.slice(index).trim();
  return token.length > 0 ? token : null;
}
