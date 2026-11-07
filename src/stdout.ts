/**
 * `process.stdout.write`, and the two things that borrow it.
 *
 * Both borrowings are deliberate: `hooks.afterGenerate` is user code that prints, and its output
 * must not land in a `--format json` payload; `setup --format json` runs a whole `generate` in
 * process and merges that command's JSON document into its own. Each needs to see the writes made
 * inside its own async context and only those.
 *
 * They cannot each patch `process.stdout.write` themselves, and the reason is not theoretical:
 *
 * - `setup` patched `write` and restored the function it had captured on entry. A `generate` with
 *   an async hook installed the hook diversion *inside* that window, so the hook's restore ran
 *   after `setup`'s and put back a closure belonging to a capture that had already finished —
 *   every later write in the process was captured into a dead string and silently discarded,
 *   including the JSON document. The hook's own writes meanwhile went straight to the real stdout,
 *   because `setup`'s restore had already overwritten the diversion.
 * - Two overlapping async hooks did the same thing to each other.
 *
 * So there is one router, installed at most once and released by reference counting, and two
 * `AsyncLocalStorage` scopes it consults. A write made inside a hook goes to stderr; a write made
 * inside a capture is captured; everything else is the process's own stdout.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Marks the async context of a `hooks.afterGenerate` call. */
export const hookStdoutScope = new AsyncLocalStorage<true>();

/** Where captured writes go. A store, not a string, so the writer can be swapped per call. */
const captureScope = new AsyncLocalStorage<{ write: (chunk: string) => void }>();

type Write = typeof process.stdout.write;

let installs = 0;
let underlying: Write | null = null;
let router: Write | null = null;

const asText = (chunk: unknown): string =>
  typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");

/** The write callback, wherever it was passed (`write(chunk, cb)` or `write(chunk, enc, cb)`). */
const callbackIn = (rest: unknown[]): ((error?: Error | null) => void) | undefined => {
  for (const argument of rest) {
    if (typeof argument === "function") return argument as (error?: Error | null) => void;
  }
  return undefined;
};

/**
 * Installs the router, or bumps the count if it is already installed.
 *
 * Returns the release. Releasing twice is a no-op rather than a decrement of somebody else's
 * reference, and the original function is restored only when the count reaches zero.
 */
export function installStdoutRouter(): () => void {
  if (installs === 0) {
    underlying = process.stdout.write;
    const realStdout = underlying.bind(process.stdout) as (...args: unknown[]) => boolean;
    const realStderr = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
    router = ((...args: unknown[]): boolean => {
      if (hookStdoutScope.getStore() === true) return realStderr(...args);
      const capture = captureScope.getStore();
      if (capture !== undefined) {
        capture.write(asText(args[0]));
        const callback = callbackIn(args.slice(1));
        if (callback) callback(null);
        return true;
      }
      return realStdout(...args);
    }) as Write;
    process.stdout.write = router;
  }

  installs += 1;
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    installs -= 1;
    if (installs === 0) {
      // Restore only our own router: if something else replaced `write` after us, putting the
      // original back would discard that replacement, and it is not ours to discard.
      if (process.stdout.write === router && underlying !== null) {
        process.stdout.write = underlying;
      }
      underlying = null;
      router = null;
    }
  };
}

/**
 * Runs `fn` with everything it writes to stdout collected into a string.
 *
 * The capture is scoped to `fn`'s async context rather than to a time window, so a hook that is
 * still running when `fn` returns writes to stderr instead of into a buffer nobody reads any more.
 */
export async function runWithStdoutCapture<T>(
  fn: () => Promise<T>
): Promise<{ value: T; text: string }> {
  let text = "";
  const release = installStdoutRouter();
  try {
    const value = await captureScope.run(
      { write: (chunk: string) => void (text += chunk) },
      fn
    );
    return { value, text };
  } finally {
    release();
  }
}
