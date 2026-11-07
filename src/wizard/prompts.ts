import * as readline from "node:readline";

/**
 * A minimal, dependency-free prompt toolkit.
 *
 * The package ships exactly one runtime dependency (`typescript`) and that is a
 * selling point, so the wizard cannot pull in `@clack/prompts`. Everything here
 * is built on `node:readline`'s keypress events, which already normalise arrow
 * keys across Windows and POSIX terminals.
 *
 * The rendering and selection logic is exported as pure functions so it can be
 * unit-tested without a real TTY; only the thin IO layer needs one.
 *
 * ## Going back
 *
 * A question that a later answer can invalidate must be reversible. Any prompt
 * given `allowBack` throws {@link PromptBack} when the developer asks to return,
 * and the caller re-runs the previous question with the answers so far intact.
 * Two keys are deliberately different:
 *
 *  - `←` on a list or a text field, `b` on a list. `confirm` uses `←`/`→` for
 *    yes/no, so it takes `b` alone.
 *  - `text` accepts only `←`: `b` there is a character the developer is typing.
 */

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface PromptIO {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

/** Thrown when the developer presses Ctrl+C or Ctrl+D mid-prompt. */
export class PromptCancelled extends Error {
  constructor() {
    super("Prompt cancelled");
    this.name = "PromptCancelled";
  }
}

/** Thrown when the developer asks to return to the previous question. */
export class PromptBack extends Error {
  constructor() {
    super("Prompt back");
    this.name = "PromptBack";
  }
}

export function defaultIO(): PromptIO {
  return { input: process.stdin, output: process.stdout };
}

/** Both ends must be a TTY before anything interactive is attempted. */
export function isInteractive(io: PromptIO): boolean {
  return Boolean(io.input.isTTY && io.output.isTTY);
}

// ---------------------------------------------------------------- pure helpers

/** Wraps around in both directions, so ↑ at the top lands on the last item. */
export function moveSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return ((current + delta) % count + count) % count;
}

export function toggleIndex(selected: ReadonlySet<number>, index: number): Set<number> {
  const next = new Set(selected);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

/**
 * True for the ranges a terminal draws two cells wide.
 *
 * The glyphs this toolkit uses (`◆ ❯ ◻ ←`) are East-Asian *ambiguous* — one cell in a Western
 * monospace font, two in a CJK one — so they stay at one here. {@link Frame.width} keeps two
 * cells of slack for exactly that ambiguity.
 */
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, Kangxi, CJK symbols
    (code >= 0x3041 && code <= 0x33ff) || // kana through CJK compatibility
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff) || // emoji and pictographs
    (code >= 0x20000 && code <= 0x3fffd) // CJK extensions B and beyond
  );
}

const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Cells a line occupies on screen. Escape sequences occupy none. */
export function displayWidth(line: string): number {
  let width = 0;
  for (const character of line.replace(ANSI_PATTERN, "")) {
    width += isWideCodePoint(character.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

/**
 * The leading cells a line spends on layout rather than content: its indent, plus any marker
 * glyphs (`❯ ◻ ◆ ✖`) and the space that follows each.
 *
 * Continuation rows line up with the content, which is what makes a wrapped choice read as one
 * item. It also has to be *stable*: a selected row begins `  ❯ ` and an unselected one `    `, so
 * measuring the indent by whitespace alone gives the two lines different wrap points — the menu
 * then changes height as the cursor moves through it, and a wrapped hint shifts sideways when it
 * is not the one selected.
 */
const GUTTER_PATTERN = /^[ \t]*(?:[❯◆◻◼▏✖][ \t]+)*/;

function wrapOneLine(line: string, limit: number): string[] {
  if (displayWidth(line) <= limit) return [line];
  const gutter = GUTTER_PATTERN.exec(line)?.[0] ?? "";
  const gutterWidth = displayWidth(gutter);
  const continuation = " ".repeat(gutterWidth);
  const rows: string[] = [];
  // The first row keeps the real gutter so the marker stays where it belongs; the rest are blank
  // cells of the same width.
  let prefix = gutter;
  let rest = line.slice(gutter.length).trimEnd();

  while (rest.length > 0) {
    const room = limit - displayWidth(prefix);
    if (room <= 0 || displayWidth(rest) <= room) {
      // A pathological gutter leaves nothing to wrap into; emit the remainder rather than spin.
      rows.push(prefix + rest);
      break;
    }
    // Break at the last space inside the room, or mid-token when a single word is too long.
    // The window is counted in code units, so a double-width character only ever makes it
    // shorter — which wraps a little early and never past the edge.
    let cut = room;
    const space = rest.slice(0, room).lastIndexOf(" ");
    if (space > 0) cut = space;
    const taken = rest.slice(0, cut).trimEnd();
    rows.push(`${prefix}${taken.length > 0 ? taken : rest.slice(0, cut)}`);
    rest = rest.slice(cut).trimStart();
    prefix = continuation;
  }
  return rows;
}

/**
 * Breaks a block so that no row is wider than `limit` cells.
 *
 * A terminal wraps anything wider than itself without saying so, which is the whole reason this
 * exists: a frame that wraps behind the renderer's back is one row taller than it claims to be.
 * See {@link Frame}.
 */
export function wrapLines(text: string, limit: number): string[] {
  const width = Math.max(8, Math.floor(limit));
  const rows: string[] = [];
  for (const line of text.split("\n")) rows.push(...wrapOneLine(line, width));
  return rows;
}

function marker(active: boolean): string {
  return active ? "❯" : " ";
}

function choiceLine<T>(choice: Choice<T>, active: boolean): string {
  const hint = choice.hint ? `  ${choice.hint}` : "";
  return `  ${marker(active)} ${choice.label}${hint}`;
}

/** The footer under a list, naming only the keys this prompt actually accepts. */
function listFooter(base: string, allowBack: boolean): string {
  return allowBack ? `${base} · ← back` : base;
}

export function renderSelect<T>(
  message: string,
  choices: Choice<T>[],
  index: number,
  allowBack = false
): string {
  const lines = [`◆ ${message}`, ""];
  choices.forEach((choice, position) => lines.push(choiceLine(choice, position === index)));
  lines.push("", `  ${listFooter("↑↓ move · enter select", allowBack)}`);
  return lines.join("\n");
}

export function renderMultiSelect<T>(
  message: string,
  choices: Choice<T>[],
  index: number,
  selected: ReadonlySet<number>,
  allowBack = false
): string {
  const lines = [`◆ ${message}`, ""];
  choices.forEach((choice, position) => {
    const box = selected.has(position) ? "◼" : "◻";
    const hint = choice.hint ? `  ${choice.hint}` : "";
    lines.push(`  ${marker(position === index)} ${box} ${choice.label}${hint}`);
  });
  lines.push("", `  ${listFooter("↑↓ move · space toggle · enter confirm", allowBack)}`);
  return lines.join("\n");
}

export function renderConfirm(message: string, value: boolean, allowBack = false): string {
  const footer = allowBack ? "←→ or y/n · enter confirm · b back" : "←→ or y/n · enter confirm";
  return [
    `◆ ${message}`,
    "",
    `  ${marker(value)} Yes`,
    `  ${marker(!value)} No`,
    "",
    `  ${footer}`,
  ].join("\n");
}

export function renderText(message: string, value: string, error?: string, allowBack = false): string {
  const lines = [`◆ ${message}`, "", `  ${value || "▏"}`];
  if (error) lines.push("", `  ✖ ${error}`);
  if (allowBack) lines.push("", "  enter confirm · ← back");
  return lines.join("\n");
}

// -------------------------------------------------------------------- IO layer

interface KeyReader {
  next(): Promise<readline.Key>;
  close(): void;
}

function keyReader(input: NodeJS.ReadStream): KeyReader {
  const queue: readline.Key[] = [];
  const waiters: Array<(key: readline.Key) => void> = [];
  const wasRaw = input.isRaw;

  const onKey = (_text: string, key: readline.Key): void => {
    const waiter = waiters.shift();
    if (waiter) waiter(key);
    else queue.push(key);
  };

  readline.emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  input.on("keypress", onKey);

  return {
    next() {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      input.off("keypress", onKey);
      if (input.isTTY) input.setRawMode(wasRaw ?? false);
      input.pause();
    },
  };
}

/**
 * Redraws a block in place, so the terminal shows one screen per prompt.
 *
 * The height that has to be counted is *screen rows*, not lines. The terminal wraps anything wider
 * than itself silently, so a frame with one over-long line is one row taller than this counts —
 * and moving up one row too few leaves the top of the old frame behind on every keypress. That is
 * what a stack of identical question lines is: a terminal 70-ish columns wide, a hint line 83 cells
 * long, and an erase that undershot by exactly one row. Wrapping to the width we can actually see
 * is what keeps the count true, and the width is re-read on every draw so a window that changed
 * size is measured as it is now rather than as it was.
 */
class Frame {
  private drawn = 0;

  constructor(private readonly output: NodeJS.WriteStream) {}

  draw(text: string): void {
    this.erase();
    const rows = wrapLines(text, this.width());
    this.output.write(`${rows.join("\n")}\n`);
    this.drawn = rows.length;
  }

  erase(): void {
    if (this.drawn > 0) this.output.write(`\u001b[${this.drawn}A\u001b[0J`);
    this.drawn = 0;
  }

  /**
   * The usable width, in cells.
   *
   * Two cells of slack: an ambiguous-width glyph (`◆`, `❯`, `←`) renders two cells in some fonts
   * and one in others, and a row that lands exactly on the last column is the one case a terminal
   * may or may not wrap. Below that, a line cannot reach the edge to begin with.
   */
  private width(): number {
    const columns = this.output.columns;
    if (typeof columns !== "number" || !Number.isFinite(columns) || columns <= 0) return 80;
    return Math.max(8, Math.floor(columns) - 2);
  }
}

function isCancel(key: readline.Key): boolean {
  return (key.ctrl === true && key.name === "c") || (key.ctrl === true && key.name === "d");
}

/** `←` or `b` on a list. */
function isListBack(key: readline.Key, allowBack: boolean): boolean {
  return allowBack && (key.name === "left" || key.name === "b");
}

// --------------------------------------------------------------------- prompts

export async function select<T>(
  io: PromptIO,
  message: string,
  choices: Choice<T>[],
  options: { defaultValue?: T; allowBack?: boolean } = {}
): Promise<T> {
  if (choices.length === 0) throw new Error("select() requires at least one choice.");
  const allowBack = options.allowBack === true;
  const fallbackIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.value === options.defaultValue)
  );

  if (!isInteractive(io)) {
    io.output.write(`${renderSelect(message, choices, fallbackIndex, allowBack)}\n`);
    return choices[fallbackIndex].value;
  }

  const frame = new Frame(io.output);
  const reader = keyReader(io.input);
  let index = fallbackIndex;

  try {
    for (;;) {
      frame.draw(renderSelect(message, choices, index, allowBack));
      const key = await reader.next();
      if (isCancel(key)) throw new PromptCancelled();
      if (isListBack(key, allowBack)) throw new PromptBack();
      if (key.name === "up") index = moveSelection(index, -1, choices.length);
      else if (key.name === "down") index = moveSelection(index, 1, choices.length);
      else if (key.name === "return" || key.name === "enter") {
        frame.erase();
        return choices[index].value;
      } else if (key.name === "j") index = moveSelection(index, 1, choices.length);
      else if (key.name === "k") index = moveSelection(index, -1, choices.length);
    }
  } catch (error) {
    // A question that is being abandoned must not leave its last frame on screen, or the
    // terminal shows a stale menu above the one that is about to be asked.
    frame.erase();
    throw error;
  } finally {
    reader.close();
  }
}

export async function multiSelect<T>(
  io: PromptIO,
  message: string,
  choices: Choice<T>[],
  options: { defaults?: T[]; allowBack?: boolean } = {}
): Promise<T[]> {
  const allowBack = options.allowBack === true;
  const selected = new Set<number>();
  choices.forEach((choice, position) => {
    if (options.defaults?.includes(choice.value)) selected.add(position);
  });

  const result = (): T[] =>
    choices.filter((_, position) => selected.has(position)).map((choice) => choice.value);

  if (!isInteractive(io)) {
    io.output.write(`${renderMultiSelect(message, choices, 0, selected, allowBack)}\n`);
    return result();
  }

  const frame = new Frame(io.output);
  const reader = keyReader(io.input);
  let index = 0;

  try {
    for (;;) {
      frame.draw(renderMultiSelect(message, choices, index, selected, allowBack));
      const key = await reader.next();
      if (isCancel(key)) throw new PromptCancelled();
      if (isListBack(key, allowBack)) throw new PromptBack();
      if (key.name === "up") index = moveSelection(index, -1, choices.length);
      else if (key.name === "down") index = moveSelection(index, 1, choices.length);
      else if (key.name === "space") {
        const next = toggleIndex(selected, index);
        selected.clear();
        for (const position of next) selected.add(position);
      } else if (key.name === "a") {
        if (selected.size === choices.length) selected.clear();
        else choices.forEach((_, position) => selected.add(position));
      } else if (key.name === "return" || key.name === "enter") {
        frame.erase();
        return result();
      }
    }
  } catch (error) {
    frame.erase();
    throw error;
  } finally {
    reader.close();
  }
}

export async function confirm(
  io: PromptIO,
  message: string,
  options: { defaultValue?: boolean; allowBack?: boolean } = {}
): Promise<boolean> {
  const allowBack = options.allowBack === true;
  let value = options.defaultValue ?? true;
  if (!isInteractive(io)) {
    io.output.write(`${renderConfirm(message, value, allowBack)}\n`);
    return value;
  }

  const frame = new Frame(io.output);
  const reader = keyReader(io.input);

  try {
    for (;;) {
      frame.draw(renderConfirm(message, value, allowBack));
      const key = await reader.next();
      if (isCancel(key)) throw new PromptCancelled();
      // `←`/`→` already mean yes/no here, so back is `b` only.
      if (allowBack && key.name === "b") throw new PromptBack();
      if (key.name === "up" || key.name === "left") value = true;
      else if (key.name === "down" || key.name === "right") value = false;
      else if (key.name === "y") value = true;
      else if (key.name === "n") value = false;
      else if (key.name === "return" || key.name === "enter") {
        frame.erase();
        return value;
      }
    }
  } catch (error) {
    frame.erase();
    throw error;
  } finally {
    reader.close();
  }
}

export async function text(
  io: PromptIO,
  message: string,
  options: {
    defaultValue?: string;
    validate?: (value: string) => string | null;
    allowBack?: boolean;
  } = {}
): Promise<string> {
  const allowBack = options.allowBack === true;
  const fallback = options.defaultValue ?? "";
  if (!isInteractive(io)) {
    io.output.write(`${renderText(message, fallback, undefined, allowBack)}\n`);
    return fallback;
  }

  const frame = new Frame(io.output);
  const reader = keyReader(io.input);
  let value = fallback;
  let error: string | undefined;

  try {
    for (;;) {
      frame.draw(renderText(message, value, error, allowBack));
      const key = await reader.next();
      if (isCancel(key)) throw new PromptCancelled();
      // Only `←` here: `b` is a character somebody may be typing into this field.
      if (allowBack && key.name === "left") throw new PromptBack();
      error = undefined;

      if (key.name === "return" || key.name === "enter") {
        const problem = options.validate ? options.validate(value) : null;
        if (problem) {
          error = problem;
          continue;
        }
        frame.erase();
        return value;
      }
      if (key.name === "backspace") {
        value = value.slice(0, -1);
        continue;
      }
      if (key.name === "escape") {
        value = "";
        continue;
      }
      // Printable single characters only: control keys never enter the buffer.
      if (_isPrintable(key)) value += _keyText(key);
    }
  } catch (error_) {
    frame.erase();
    throw error_;
  } finally {
    reader.close();
  }
}

function _isPrintable(key: readline.Key): boolean {
  return typeof key.sequence === "string" && key.sequence.length === 1 && key.sequence >= " ";
}

function _keyText(key: readline.Key): string {
  return key.sequence ?? "";
}
