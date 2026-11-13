/**
 * Assembling and running the stdio server.
 *
 * The loop is deliberately thin: framing lives in `stdio.ts`, meaning lives in `server.ts`, and
 * this file only connects the two and decides when the process is finished. The one piece of
 * judgement here is shutdown — the process must not exit while a request it accepted is still
 * unanswered, or a client sees a closed pipe instead of the answer it asked for.
 */
import { GENERATOR_NAME, GENERATOR_VERSION } from "../version.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { ERROR_CODES, errorResponse, isJsonObject } from "./protocol.js";
import type { JsonRpcId } from "./protocol.js";
import { createMcpServer } from "./server.js";
import type { McpServer } from "./server.js";
import { createLineReader, createWriter } from "./stdio.js";
import { buildPrompts } from "./prompts.js";
import { buildResourceProvider } from "./resources.js";
import { buildTools } from "./tools.js";
import type { ToolContext } from "./types.js";

/** The project's own page. Used as the server identity a client may display. */
const PROJECT_URL = "https://ankurhalder.github.io/codebase-snapshot/";

export interface ServerOptions {
  /** Repository the tools operate on. Also the only directory they may read. */
  cwd: string;
  /** Additional directories callers may name as `root`. Defaults to `cwd` alone. */
  roots?: string[];
  /** Where operational notes go. Never stdout, which carries protocol messages only. */
  log?: (line: string) => void;
}

/** Builds a server with every capability this package implements. */
export function createServer(options: ServerOptions): McpServer {
  const cwd = options.cwd;
  const roots = options.roots && options.roots.length > 0 ? options.roots : [cwd];
  const context: ToolContext = {
    cwd,
    roots,
    log: options.log ?? ((line: string) => process.stderr.write(`${line}\n`)),
  };

  return createMcpServer({
    info: {
      name: GENERATOR_NAME,
      title: "codebase-snapshot",
      version: GENERATOR_VERSION,
      websiteUrl: PROJECT_URL,
    },
    instructions: SERVER_INSTRUCTIONS,
    tools: buildTools(),
    resources: buildResourceProvider(),
    prompts: buildPrompts(),
    context,
  });
}

/**
 * Serves MCP over stdio until the client closes the stream.
 *
 * Writes are serialised through one promise chain: two tool calls finishing together must not
 * interleave half-written lines, and a single response can be large. Reading is not serialised —
 * a slow tool must not stop a cancellation notification from being read — and the process waits
 * for every accepted request to answer before it resolves.
 */
export async function runStdioServer(options: ServerOptions): Promise<number> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const server = createServer(options);
  const writer = createWriter(process.stdout);

  let writeChain: Promise<void> = Promise.resolve();
  const send = (message: unknown): Promise<void> => {
    writeChain = writeChain.then(() => writer.write(message)).catch((error: unknown) => {
      // A failed write means the client is gone; there is nobody left to report it to.
      log(`mcp: could not write a response: ${error instanceof Error ? error.message : String(error)}`);
    });
    return writeChain;
  };

  /**
   * How many requests may run at once.
   *
   * The counter used to bound only shutdown, never admission: every line started immediately,
   * and `snapshot_generate` spawns a worker per request, so ten concurrent calls meant ten workers
   * over one repository and one output directory. Four keeps reads and one generation responsive
   * while a client cannot wedge the server by flooding it.
   */
  const MAX_IN_FLIGHT = 4;

  let inFlight = 0;
  let inputEnded = false;
  let resolveDone: (code: number) => void = () => undefined;
  const finished = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });
  const finishIfIdle = (): void => {
    if (inputEnded && inFlight === 0) resolveDone(0);
  };

  const handleLine = async (line: string): Promise<void> => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      await send(errorResponse(null, ERROR_CODES.parseError, "Message is not valid JSON."));
      return;
    }
    const response = await server.handle(message);
    if (response) await send(response);
  };

  /**
   * Answers a request the server will not admit.
   *
   * A notification has no id and gets no response; a request gets a typed `overloaded` error so
   * the client can retry instead of waiting for an answer that was never going to arrive.
   */
  const rejectOverloaded = (line: string): void => {
    let id: JsonRpcId | null = null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isJsonObject(parsed)) return;
      if (typeof parsed.id === "string" || typeof parsed.id === "number") id = parsed.id;
      else return;
    } catch {
      return;
    }
    void send(
      errorResponse(
        id,
        ERROR_CODES.overloaded,
        `The server is already handling ${MAX_IN_FLIGHT} requests; retry this one when it is free.`
      )
    );
  };

  const stopReading = createLineReader(process.stdin, {
    onOverflow: (bytes) => log(`mcp: discarded an oversized message (${bytes} bytes)`),
    onLine: (line) => {
      if (inFlight >= MAX_IN_FLIGHT) {
        rejectOverloaded(line);
        return;
      }
      inFlight += 1;
      void handleLine(line).finally(() => {
        inFlight -= 1;
        finishIfIdle();
      });
    },
  });

  const onEnd = (): void => {
    inputEnded = true;
    finishIfIdle();
  };
  process.stdin.on("end", onEnd);
  process.stdin.on("close", onEnd);

  log(`mcp: serving ${options.cwd} over stdio`);

  const code = await finished;
  stopReading();
  process.stdin.off("end", onEnd);
  process.stdin.off("close", onEnd);
  await writeChain;
  return code;
}
