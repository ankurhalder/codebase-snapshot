/**
 * The protocol dispatcher: one function that turns a parsed message into zero or one response.
 *
 * Everything here is transport-agnostic. The stdio binding in `stdio.ts` supplies lines, `cli.ts`
 * supplies streams, and tests supply plain objects — the same dispatch serves all three, which is
 * the property the MCP specification describes when it says protocol semantics are identical on
 * every transport.
 *
 * Two rules are worth stating because they are easy to get subtly wrong:
 *
 *  - **A notification never gets a response**, not even an error. JSON-RPC forbids it, and a
 *    client that receives one for `notifications/initialized` treats the connection as broken.
 *  - **`handle` never throws.** A handler failure becomes a tool-level error the model can read
 *    and act on; a dispatcher failure becomes `-32603`. An uncaught exception here would kill the
 *    child process the client is talking to, and the client would report a mysterious EOF.
 */
import {
  ERROR_CODES,
  METHOD,
  SUPPORTED_PROTOCOL_VERSIONS,
  errorResponse,
  isJsonObject,
  successResponse,
} from "./protocol.js";
import type { JsonObject, JsonRpcId, JsonRpcResponse } from "./protocol.js";
import { classifyRequest, createSession, inspectModernMeta, negotiateLegacyVersion } from "./era.js";
import type { SessionState } from "./era.js";
import { ResourceNotFoundError, ResourceTooLargeError } from "./resources.js";
import { applyDefaults, coerceNumericStrings, validateArguments } from "./schema.js";
import type {
  McpPrompt,
  McpResourceContents,
  McpServerInfo,
  McpTool,
  PromptMessage,
  ResourceProvider,
  ToolContext,
  ToolOutcome,
} from "./types.js";

export interface McpServerOptions {
  info: McpServerInfo;
  instructions: string;
  tools: McpTool[];
  resources: ResourceProvider;
  prompts: McpPrompt[];
  context: ToolContext;
  /** Writes a JSON-RPC notification. Present on transports that can carry one mid-call. */
  notify?: (message: JsonObject) => void;
}

export interface McpServer {
  /** Handles one already-parsed message. Returns null when no response is due. */
  handle(message: unknown): Promise<JsonRpcResponse | null>;
  /** Exposed for tests and for `mcp --list`, which prints the negotiation table. */
  readonly session: SessionState;
}

/** Server capabilities, identical in both eras apart from where they are reported. */
function capabilities(): JsonObject {
  return {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: { listChanged: false },
  };
}

/** Reads the request id, or null when the message carries none we can answer. */
function requestIdOf(message: JsonObject): JsonRpcId | null {
  const raw = message.id;
  return typeof raw === "string" || typeof raw === "number" ? raw : null;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const session = createSession();
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));
  const promptsByName = new Map(options.prompts.map((prompt) => [prompt.name, prompt]));

  const identity = (): JsonObject => ({
    name: options.info.name,
    title: options.info.title,
    version: options.info.version,
    websiteUrl: options.info.websiteUrl,
  });

  const ok = (id: JsonRpcId | null, result: JsonObject, modern: boolean): JsonRpcResponse =>
    successResponse(id, result, modern, options.info);

  /** Cancellations registered by the running call, keyed by the request id a client quotes. */
  const cancellations = new Map<JsonRpcId, () => void>();

  function handleNotification(method: string, params: JsonObject | undefined): void {
    // `notifications/initialized` and `notifications/cancelled` are the only ones we expect. The
    // first confirms a handshake; the second is a request to stop, and it now reaches a tool that
    // asked to be told (a generate terminates its worker instead of running to completion).
    if (method === METHOD.initialized && session.era === "legacy") session.ready = true;
    if (method === "notifications/cancelled") {
      const requestId = params?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        const cancel = cancellations.get(requestId);
        if (cancel !== undefined) {
          cancellations.delete(requestId);
          cancel();
        }
      }
    }
  }

  function initialize(id: JsonRpcId, params: JsonObject | undefined): JsonRpcResponse {
    const negotiation = negotiateLegacyVersion(params?.protocolVersion);
    session.era = "legacy";
    session.protocolVersion = negotiation.version;
    session.ready = true;
    options.context.log(
      negotiation.matched
        ? `mcp: client initialized with protocol ${negotiation.version}`
        : `mcp: client asked for an unsupported version and was offered ${negotiation.version}`
    );
    // Legacy responses carry no `resultType`: the field belongs to the modern revision, and an
    // older client has no schema entry for it.
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiation.version,
        capabilities: capabilities(),
        serverInfo: identity(),
        instructions: options.instructions,
      },
    };
  }

  function discover(id: JsonRpcId): JsonRpcResponse {
    // Do not commit the era here. A `server/discover` without `_meta` is the documented
    // backward-compatibility probe a legacy client may send before its `initialize`; committing
    // modern made that initialize fail with "This request has no _meta". The dispatch path commits
    // only when the request itself is decisive.
    //
    // Always the modern shape, even when a legacy client is the one probing: `server/discover`
    // exists only in the revision that defines `resultType`, so omitting it would make the answer
    // unusable to the only client that could ask for it.
    return ok(
      id,
      {
        supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        capabilities: capabilities(),
        instructions: options.instructions,
        // The capability set depends on which repository the server was started for, so the answer
        // may be cached only by the client that asked, and not at all after this response.
        cacheScope: "private",
        ttlMs: 0,
      },
      true
    );
  }

  function listTools(id: JsonRpcId, modern: boolean): JsonRpcResponse {
    const tools = options.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      annotations: tool.annotations,
      _meta: { "codebase-snapshot/cost": tool.cost },
    }));
    return ok(id, { tools }, modern);
  }

  async function callTool(
    id: JsonRpcId,
    modern: boolean,
    params: JsonObject | undefined
  ): Promise<JsonRpcResponse> {
    const name = params?.name;
    if (typeof name !== "string") {
      return errorResponse(id, ERROR_CODES.invalidParams, 'tools/call requires a "name" string.');
    }
    const tool = toolsByName.get(name);
    if (!tool) {
      const known = [...toolsByName.keys()].sort().join(", ");
      return errorResponse(id, ERROR_CODES.invalidParams, `Unknown tool "${name}". Available: ${known}.`);
    }

    const rawArguments = params?.arguments ?? {};
    if (!isJsonObject(rawArguments)) {
      return errorResponse(id, ERROR_CODES.invalidParams, '"arguments" must be a JSON object.');
    }

    // Some clients serialise every argument as a string; a digit string for a numeric field is
    // the same value, so it is normalised before validation rather than rejected after it.
    const supplied = coerceNumericStrings(tool.inputSchema, rawArguments);
    const problems = validateArguments(tool.inputSchema, supplied);
    if (problems.length > 0) {
      // Argument mistakes are reported as a tool error rather than a protocol error: the model can
      // read the message and retry, where `-32602` reaches the user as an opaque failure.
      return ok(
        id,
        {
          content: [{ type: "text", text: `Invalid arguments for ${tool.name}:\n- ${problems.join("\n- ")}` }],
          isError: true,
        },
        modern
      );
    }

    const args = applyDefaults(tool.inputSchema, supplied);
    // Progress is opt-in per call: the client names a token, and every notification quotes it back.
    const meta = params?._meta;
    const progressToken =
      isJsonObject(meta) && (typeof meta.progressToken === "string" || typeof meta.progressToken === "number")
        ? meta.progressToken
        : undefined;
    const callContext: ToolContext = {
      ...options.context,
      // Always offered, so a long tool can be stopped whether or not the client asked for progress.
      onCancel: (cancel) => {
        cancellations.set(id, cancel);
      },
      ...(progressToken === undefined || options.notify === undefined
        ? {}
        : {
            notify: (event: { message: string; progress?: number; total?: number }) => {
              const progress: JsonObject = {
                progressToken,
                progress: event.progress ?? 0,
                ...(event.total === undefined ? {} : { total: event.total }),
                message: event.message,
              };
              options.notify?.({ jsonrpc: "2.0", method: "notifications/progress", params: progress });
            },
          }),
    };
    let outcome: ToolOutcome;
    try {
      outcome = await tool.handler(args, callContext);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.context.log(`mcp: tool ${tool.name} failed: ${detail}`);
      return ok(
        id,
        { content: [{ type: "text", text: `${tool.name} failed: ${detail}` }], isError: true },
        modern
      );
    } finally {
      // A cancelled call leaves nothing behind for a later cancellation to reach.
      cancellations.delete(id);
    }

    return ok(
      id,
      {
        content: [{ type: "text", text: outcome.text }],
        ...(outcome.structured ? { structuredContent: outcome.structured } : {}),
        ...(outcome.isError ? { isError: true } : {}),
      },
      modern
    );
  }

  async function listResources(id: JsonRpcId, modern: boolean): Promise<JsonRpcResponse> {
    const resources = await options.resources.list(options.context);
    return ok(id, { resources }, modern);
  }

  async function readResource(
    id: JsonRpcId,
    modern: boolean,
    params: JsonObject | undefined
  ): Promise<JsonRpcResponse> {
    const uri = params?.uri;
    if (typeof uri !== "string") {
      return errorResponse(id, ERROR_CODES.invalidParams, 'resources/read requires a "uri" string.');
    }
    let contents: McpResourceContents | null;
    try {
      contents = await options.resources.read(uri, options.context);
    } catch (error) {
      // A resource that exists but cannot be returned whole is an error the client can act on.
      // Truncating it instead would hand a model half a JSON document or half a part, which is
      // worse than a refusal because nothing downstream can tell the difference.
      if (error instanceof ResourceNotFoundError) {
        return errorResponse(id, ERROR_CODES.resourceNotFound, error.message, { uri: error.uri });
      }
      if (error instanceof ResourceTooLargeError) {
        options.context.log(
          `mcp: refused ${error.uri} (${error.bytes} bytes, limit ${error.limit}); ` +
            "returning it would truncate it"
        );
        return errorResponse(id, ERROR_CODES.resourceTooLarge, error.message, {
          uri: error.uri,
          bytes: error.bytes,
          limit: error.limit,
        });
      }
      throw error;
    }
    if (!contents) {
      return errorResponse(id, ERROR_CODES.invalidParams, `Unknown resource "${uri}".`);
    }
    return ok(id, { contents: [contents] }, modern);
  }

  function listPrompts(id: JsonRpcId, modern: boolean): JsonRpcResponse {
    const prompts = options.prompts.map((prompt) => ({
      name: prompt.name,
      ...(prompt.title ? { title: prompt.title } : {}),
      description: prompt.description,
      arguments: prompt.arguments,
    }));
    return ok(id, { prompts }, modern);
  }

  function getPrompt(
    id: JsonRpcId,
    modern: boolean,
    params: JsonObject | undefined
  ): JsonRpcResponse {
    const name = params?.name;
    if (typeof name !== "string") {
      return errorResponse(id, ERROR_CODES.invalidParams, 'prompts/get requires a "name" string.');
    }
    const prompt = promptsByName.get(name);
    if (!prompt) {
      const known = [...promptsByName.keys()].sort().join(", ");
      return errorResponse(id, ERROR_CODES.invalidParams, `Unknown prompt "${name}". Available: ${known}.`);
    }
    const rawArguments = params?.arguments ?? {};
    if (!isJsonObject(rawArguments)) {
      return errorResponse(id, ERROR_CODES.invalidParams, '"arguments" must be a JSON object.');
    }
    // `prompts/list` marks these required, and a client that skips one used to receive the prompt
    // with its subject missing — "Review a change" with no change. A required argument that is
    // absent is refused here, where the request is, rather than in the model reading the prompt.
    const missing = (prompt.arguments ?? []).filter((argument) => {
      if (argument.required !== true) return false;
      const value = rawArguments[argument.name];
      return typeof value !== "string" || value.trim() === "";
    });
    if (missing.length > 0) {
      return errorResponse(
        id,
        ERROR_CODES.invalidParams,
        'Prompt "' + name + '" requires the ' +
          missing.map((argument) => '"' + argument.name + '"').join(", ") +
          " argument(s): " + missing.map((argument) => argument.description).join(" ")
      );
    }
    const built = prompt.build(rawArguments);
    const messages: PromptMessage[] = built.messages.map((message) => ({
      role: message.role,
      content: { type: "text", text: message.content.text },
    }));
    return ok(id, { description: built.description, messages }, modern);
  }

  async function route(
    name: string,
    id: JsonRpcId,
    modern: boolean,
    params: JsonObject | undefined
  ): Promise<JsonRpcResponse> {
    // Methods that identify the era, or that the modern revision deleted, are answered before the
    // initialization gate: a client must be able to discover what it is talking to.
    switch (name) {
      case METHOD.initialize:
        return modern
          ? errorResponse(
              id,
              ERROR_CODES.methodNotFound,
              '"initialize" does not exist in this protocol revision; call "server/discover".'
            )
          : initialize(id, params);
      case METHOD.discover:
        return discover(id);
      case METHOD.ping:
        return modern
          ? errorResponse(
              id,
              ERROR_CODES.methodNotFound,
              '"ping" was removed in this protocol revision; call "server/discover".'
            )
          : ok(id, {}, modern);
      default:
        break;
    }

    // The modern era has no handshake: a request is complete when it carries valid _meta, and
    // `server/discover` is optional. Gating it on `ready` made a stateless modern client's first
    // `tools/list` fail with instructions to call a method that does not exist in its revision.
    if (!modern && !session.ready) {
      return errorResponse(
        id,
        ERROR_CODES.invalidRequest,
        'This connection has not been initialized. Send "initialize" first.'
      );
    }

    switch (name) {
      case METHOD.toolsList:
        return listTools(id, modern);
      case METHOD.toolsCall:
        return callTool(id, modern, params);
      case METHOD.resourcesList:
        return listResources(id, modern);
      case METHOD.resourcesRead:
        return readResource(id, modern, params);
      case METHOD.resourceTemplatesList:
        return ok(id, { resourceTemplates: options.resources.templates() }, modern);
      case METHOD.promptsList:
        return listPrompts(id, modern);
      case METHOD.promptsGet:
        return getPrompt(id, modern, params);
      default:
        return errorResponse(id, ERROR_CODES.methodNotFound, `Unknown method "${name}".`);
    }
  }

  async function dispatch(message: unknown): Promise<JsonRpcResponse | null> {
    if (!isJsonObject(message)) {
      // A parsed value that is not an object is a valid JSON value, so it is not a *parse* error:
      // -32700 belongs to the transport, which rejects text that is not JSON before this runs. An
      // array is a batch, and none of the revisions this server speaks define batching (it was
      // removed before the oldest supported revision, 2025-06-18); anything else is not a request.
      return errorResponse(
        null,
        ERROR_CODES.invalidRequest,
        Array.isArray(message)
          ? "Batch requests are not supported: send one JSON-RPC message per line."
          : "Message is not a JSON object."
      );
    }
    const isRequest = Object.prototype.hasOwnProperty.call(message, "id");
    const method = message.method;
    const params = message.params;

    if (message.jsonrpc !== "2.0" && isRequest) {
      return errorResponse(requestIdOf(message), ERROR_CODES.invalidRequest, 'Message must carry "jsonrpc": "2.0".');
    }
    if (typeof method !== "string" || method.length === 0) {
      return isRequest
        ? errorResponse(requestIdOf(message), ERROR_CODES.invalidRequest, 'Message must carry a "method" string.')
        : null;
    }
    if (params !== undefined && !isJsonObject(params)) {
      return isRequest
        ? errorResponse(requestIdOf(message), ERROR_CODES.invalidRequest, '"params" must be a JSON object when present.')
        : null;
    }
    const named = params as JsonObject | undefined;

    const decision = classifyRequest(method, named, session);
    const modern = decision.kind === "era" ? decision.era === "modern" : session.era === "modern";

    /**
     * Whether this message is decisive enough to commit the connection's era.
     *
     * A pre-initialize ping or notification is not: a modern client is allowed to send one before
     * its first `_meta` request, and committing "legacy" there stranded every later modern
     * request behind the initialize gate. A `server/discover` without `_meta` is likewise only a
     * probe. The decisive events are `initialize`, `notifications/initialized`, and a request
     * carrying valid modern `_meta`.
     */
    const commitsEra = (): boolean => {
      if (decision.kind !== "era") return false;
      if (method === METHOD.initialize) return true;
      if (method === METHOD.initialized) return true;
      return decision.era === "modern" && inspectModernMeta(named).kind === "present";
    };

    if (!isRequest) {
      // A notification with valid modern `_meta` is a complete stateless message; subsequent
      // modern requests must not be told to initialize on a connection that never had a handshake.
      if (decision.kind === "era" && commitsEra() && session.era === null) {
        session.era = decision.era;
        session.protocolVersion = decision.version;
        if (decision.era === "modern") session.ready = true;
      }
      handleNotification(method, named);
      return null;
    }

    const id = requestIdOf(message);
    if (id === null) {
      return errorResponse(null, ERROR_CODES.invalidRequest, 'A request "id" must be a string or a number.');
    }
    if (decision.kind === "error") {
      return errorResponse(id, decision.code, decision.message, decision.data);
    }
    if (decision.kind === "era" && session.era === null && commitsEra()) {
      session.era = decision.era;
      session.protocolVersion = decision.version;
      if (decision.era === "modern") session.ready = true;
    }

    return route(method, id, modern, named);
  }

  return {
    session,
    async handle(message: unknown): Promise<JsonRpcResponse | null> {
      try {
        return await dispatch(message);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        options.context.log(`mcp: internal error: ${detail}`);
        const id = isJsonObject(message) ? requestIdOf(message) : null;
        return errorResponse(id, ERROR_CODES.internalError, "Internal server error.");
      }
    },
  };
}
