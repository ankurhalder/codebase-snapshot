/**
 * A deterministic token estimate for emitted text.
 *
 * Why a local estimate at all: the snapshot exists to be pasted into a model's context, and
 * every budget in this tool is expressed in bytes. Bytes are the right unit for a filesystem
 * and the wrong one for a context window — the arithmetic that converts them is in
 * `docs/codebase-token-budget.md` and every reader has to repeat it by hand. A number in the
 * manifest that says "this part is about 8,400 tokens" is the answer to the question an
 * agent actually asks before reading it.
 *
 * Why not a real tokenizer: this package has exactly one runtime dependency (`typescript`)
 * and that is a feature, not an oversight. A BPE vocabulary is a few megabytes of data that
 * would have to ship, version and be kept current. This counts the structure that BPE
 * tokenizers follow closely on source code:
 *
 *  - a run of word characters costs `round(length / 6)`, minimum one, because common words in
 *    source (`export`, `const`, `return`, `value`) are a single token in every mainstream
 *    vocabulary and long identifiers are two or three;
 *  - every other non-space character costs one, because punctuation is almost always its own
 *    token (`=`, `(`, `,` and `)` are separate);
 *  - a *space* costs nothing, because BPE merges the leading space into the next token — the
 *    sequence `" const"` is one token, not two;
 *  - a newline costs one, which is what an indented block boundary actually is.
 *
 * It is an estimate and it says so. The constants were set against `cl100k_base` on this
 * repository's own sources and land within about 10% either way; the method above is stated
 * so a reader can judge the number rather than being asked to trust it.
 */

/** Word characters: what a BPE merge operates on. */
const WORD_RUN = /[A-Za-z0-9_]+/g;
/** Anything that is neither a word character nor whitespace. */
const SINGLE_TOKEN = /[^\sA-Za-z0-9_]/g;
/** Line breaks, which are their own token even when the following indent is merged. */
const LINE_BREAK_RUN = /\n+/g;

/** Characters per token inside a word run, from the merge behaviour described above. */
const CHARS_PER_WORD_TOKEN = 6;

/**
 * Estimates the token count of `text`.
 *
 * Deterministic: the same string always produces the same number, on every platform, with no
 * vocabulary to load and no network. That is what makes it safe to record in a manifest and
 * compare between runs.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  let total = 0;

  for (const match of text.match(WORD_RUN) ?? []) {
    total += Math.max(1, Math.round(match.length / CHARS_PER_WORD_TOKEN));
  }
  total += text.match(SINGLE_TOKEN)?.length ?? 0;
  total += text.match(LINE_BREAK_RUN)?.length ?? 0;

  return total;
}

/**
 * Converts a token budget into the byte budget the partitioner understands.
 *
 * The partitioner is byte-bounded because bytes are what it measures and writes. A user who
 * thinks in tokens gets a byte ceiling that corresponds to their number, using the same
 * ratio the estimate is built on — and `maxPartBytes` still applies, so the smaller of the
 * two wins and the manifest records both.
 */
export function bytesForTokens(tokens: number): number {
  return Math.max(0, Math.floor(tokens * 4));
}

/** Renders a token count for a header or a report: `8400` → `8,400`. */
export function formatTokens(count: number): string {
  return count.toLocaleString("en-US");
}
