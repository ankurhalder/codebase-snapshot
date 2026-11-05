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
import { classifyRequest, createSession, negotiateLegacyVersion } from "./era.js";
import type { SessionState } from "./era.js";
import { applyDefaults, validateArguments } from "./schema.js";
import type {
  McpPrompt,
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

  function handleNotification(method: string): void {
    // `notifications/initialized` and `notifications/cancelled` are the only ones we expect, and
    // neither changes what we send: the first confirms a handshake we already completed, the
    // second asks us to abandon a request we answer synchronously.
    if (method === METHOD.initialized && session.era === "legacy") session.ready = true;
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
    session.era = "modern";
    session.ready = true;
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

    const problems = validateArguments(tool.inputSchema, rawArguments);
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

    const args = applyDefaults(tool.inputSchema, rawArguments);
    let outcome: ToolOutcome;
    try {
      outcome = await tool.handler(args, options.context);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.context.log(`mcp: tool ${tool.name} failed: ${detail}`);
      return ok(
        id,
        { content: [{ type: "text", text: `${tool.name} failed: ${detail}` }], isError: true },
        modern
      );
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
    const contents = await options.resources.read(uri, options.context);
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

    if (!session.ready) {
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
      return errorResponse(null, ERROR_CODES.parseError, "Message is not a JSON object.");
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

    if (!isRequest) {
      // Era commitment happens even for a notification: `notifications/initialized` is the moment a
      // legacy client finishes its handshake, and refusing to learn that would leave it gated.
      if (decision.kind === "era" && session.era === null) {
        session.era = decision.era;
        session.protocolVersion = decision.version;
      }
      handleNotification(method);
      return null;
    }

    const id = requestIdOf(message);
    if (id === null) {
      return errorResponse(null, ERROR_CODES.invalidRequest, 'A request "id" must be a string or a number.');
    }
    if (decision.kind === "error") {
      return errorResponse(id, decision.code, decision.message, decision.data);
    }
    if (session.era === null) {
      session.era = decision.era;
      session.protocolVersion = decision.version;
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
