/**
 * The stdio transport: one JSON-RPC message per line, UTF-8, nothing else on the stream.
 *
 * MCP's stdio binding is newline-delimited JSON, not LSP's `Content-Length` framing, and the
 * server MUST NOT write anything to stdout that is not a valid message. `JSON.stringify` escapes
 * newlines inside strings, so serialising a message can never produce a second line — the writer
 * deliberately does not pretty-print, because `JSON.stringify(value, null, 2)` would.
 *
 * Framing is separated from parsing on purpose: this module hands raw lines to its caller and the
 * server decides what a bad line means (a `-32700` response), which keeps the line splitting
 * testable without a running server.
 */
import type { Readable, Writable } from "node:stream";

/**
 * Largest single message this transport will buffer.
 *
 * A line with no newline grows the buffer until the process runs out of memory, so an oversized
 * message is discarded rather than accepted: the snapshot itself is never this large, and a
 * client that streams more than this is not sending a message.
 */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;

export interface MessageWriter {
  /** Serialises one message onto the stream. Rejects if the stream reports a write error. */
  write(value: unknown): Promise<void>;
}

/**
 * Creates a writer that emits exactly one line per message.
 *
 * Writes are awaited through the stream's callback rather than fire-and-forget: a tool result can
 * be tens of kilobytes, and queueing several without backpressure interleaves them with the next
 * response on a slow pipe.
 */
export function createWriter(output: Writable): MessageWriter {
  return {
    write(value: unknown): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        output.write(`${JSON.stringify(value)}\n`, (error?: Error | null) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

export interface LineReaderOptions {
  /** Called for every complete, non-empty line, with the trailing CR already removed. */
  onLine: (line: string) => void;
  /** Called when one line exceeds {@link MAX_LINE_BYTES}; the line is discarded. */
  onOverflow?: (bytes: number) => void;
}

/**
 * Reads newline-delimited lines from `input` until it ends.
 *
 * Three details are what make this work against real clients rather than against our own tests:
 * a chunk boundary can fall anywhere inside a line (including inside a multi-byte character,
 * which `setEncoding` handles); a Windows client may terminate lines with CRLF; and the final
 * line may arrive without a newline before the stream ends.
 *
 * Returns a function that removes the listeners, so a caller can shut a transport down without
 * racing a late `end` event.
 */
export function createLineReader(input: Readable, options: LineReaderOptions): () => void {
  let buffer = "";
  let discarding = false;
  let discardedBytes = 0;

  const deliver = (line: string): void => {
    if (discarding) {
      discarding = false;
      discardedBytes = 0;
      return;
    }
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    // Blank lines are not messages. Some clients pad with them after a shutdown notification.
    if (trimmed.trim().length === 0) return;
    options.onLine(trimmed);
  };

  const drain = (): void => {
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      deliver(line);
      index = buffer.indexOf("\n");
    }
  };

  const onData = (chunk: string): void => {
    if (discarding) {
      // Still inside the oversized line: look for its terminator and drop everything up to it.
      const index = chunk.indexOf("\n");
      if (index < 0) {
        discardedBytes += chunk.length;
        return;
      }
      buffer = chunk.slice(index + 1);
      deliver("");
      drain();
      return;
    }

    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES && buffer.indexOf("\n") < 0) {
      discarding = true;
      discardedBytes = buffer.length;
      buffer = "";
      options.onOverflow?.(discardedBytes);
      return;
    }
    drain();
  };

  const onEnd = (): void => {
    if (buffer.length > 0) {
      const rest = buffer;
      buffer = "";
      deliver(rest);
    }
  };

  input.setEncoding("utf8");
  input.on("data", onData);
  input.on("end", onEnd);

  return () => {
    input.off("data", onData);
    input.off("end", onEnd);
  };
}
