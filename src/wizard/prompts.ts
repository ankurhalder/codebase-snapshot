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

/** Redraws a block in place, so the terminal shows one screen per prompt. */
class Frame {
  private drawn = 0;

  constructor(private readonly output: NodeJS.WriteStream) {}

  draw(text: string): void {
    this.erase();
    this.output.write(`${text}\n`);
    this.drawn = text.split("\n").length;
  }

  erase(): void {
    if (this.drawn > 0) this.output.write(`\u001b[${this.drawn}A\u001b[0J`);
    this.drawn = 0;
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
