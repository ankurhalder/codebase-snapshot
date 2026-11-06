/**
 * Protocol-layer tests: framing, era detection, negotiation and dispatch.
 *
 * These run against the built package, like the rest of the suite. The shapes asserted here are
 * taken from the published schemas for revisions 2025-11-25 and 2026-07-28 — for example
 * `DiscoverResult` requires `supportedVersions`, `cacheScope` and `ttlMs`, and an unsupported
 * modern version must produce `-32022` with a `supported` list, not a generic `-32602`.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  ERROR_CODES,
  classifyRequest,
  coerceNumericStrings,
  createLineReader,
  createMcpServer,
  createSession,
  createWriter,
  negotiateLegacyVersion,
  validateArguments,
} from "../dist/mcp.js";

const MODERN_VERSION = "2026-07-28";

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
};

/** Drains a string stream of newline-delimited JSON back into objects. */
async function readAll(chunks) {
  const input = new PassThrough();
  const lines = [];
  const overflows = [];
  createLineReader(input, {
    onLine: (line) => lines.push(line),
    onOverflow: (bytes) => overflows.push(bytes),
  });
  const ended = new Promise((resolve) => input.on("end", () => setImmediate(resolve)));
  for (const chunk of chunks) input.write(chunk);
  input.end();
  await ended;
  return { lines, overflows };
}

function makeServer() {
  const calls = [];
  const logs = [];
  const tools = [
    {
      name: "echo",
      title: "Echo",
      description: "Echoes its argument the requested number of times.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1 },
          count: { type: "integer", default: 1, minimum: 1 },
        },
        required: ["text"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async handler(args) {
        calls.push(args);
        return { text: String(args.text).repeat(args.count), structured: { text: String(args.text) } };
      },
    },
    {
      name: "boom",
      title: "Boom",
      description: "Always fails.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async handler() {
        throw new Error("kaboom");
      },
    },
  ];
  const resources = {
    async list() {
      return [
        {
          uri: "snapshot://manifest",
          name: "manifest",
          description: "The manifest.",
          mimeType: "application/json",
        },
      ];
    },
    templates() {
      return [
        {
          uriTemplate: "snapshot://parts/{index}",
          name: "part",
          description: "One part.",
          mimeType: "text/markdown",
        },
      ];
    },
    async read(uri) {
      return uri === "snapshot://manifest"
        ? { uri, mimeType: "application/json", text: '{"ok":true}' }
        : null;
    },
  };
  const prompts = [
    {
      name: "orient",
      description: "Map the repository before reading it.",
      arguments: [],
      build() {
        return {
          description: "Orientation",
          messages: [{ role: "user", content: { type: "text", text: "map it" } }],
        };
      },
    },
  ];

  const server = createMcpServer({
    info: {
      name: "codebase-snapshot",
      title: "codebase-snapshot",
      version: "0.9.4",
      websiteUrl: "https://example.test/codebase-snapshot/",
    },
    instructions: "test instructions",
    tools,
    resources,
    prompts,
    context: { cwd: process.cwd(), roots: [process.cwd()], log: (line) => logs.push(line) },
  });
  return { server, calls, logs };
}

async function initializeLegacy(server, version = "2025-11-25") {
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });
  await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
  return response;
}

function modernCall(server, id, method, params = {}) {
  return server.handle({
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: MODERN_META },
  });
}

test("framing: one JSON message per line", async (t) => {
  await t.test("splits several messages arriving in one chunk", async () => {
    const { lines } = await readAll(['{"a":1}\n{"b":2}\n{"c":3}\n']);
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  await t.test("reassembles a message split across chunks", async () => {
    const { lines } = await readAll(['{"method":"tools/li', 'st","id":7}\n']);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { method: "tools/list", id: 7 });
  });

  await t.test("strips the CR of a CRLF client", async () => {
    const { lines } = await readAll(['{"a":1}\r\n{"b":2}\r\n']);
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  });

  await t.test("ignores blank lines", async () => {
    const { lines } = await readAll(['\n\n{"a":1}\n   \n']);
    assert.deepEqual(lines, ['{"a":1}']);
  });

  await t.test("delivers a final line that has no trailing newline", async () => {
    const { lines } = await readAll(['{"a":1}']);
    assert.deepEqual(lines, ['{"a":1}']);
  });

  await t.test("keeps a multi-byte character split across chunk boundaries", async () => {
    const message = Buffer.from('{"emoji":"✅"}\n', "utf8");
    const cut = message.indexOf(0xe2) + 1;
    const { lines } = await readAll([message.subarray(0, cut), message.subarray(cut)]);
    assert.deepEqual(JSON.parse(lines[0]), { emoji: "✅" });
  });

  await t.test("writer emits exactly one line and never pretty-prints", async () => {
    const output = new PassThrough();
    const chunks = [];
    output.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
    const writer = createWriter(output);
    await writer.write({ jsonrpc: "2.0", id: 1, result: { text: "line one\nline two" } });
    const text = chunks.join("");
    assert.equal(text.split("\n").length, 2, "one message plus the terminator");
    assert.ok(text.endsWith("\n"));
    assert.deepEqual(JSON.parse(text), {
      jsonrpc: "2.0",
      id: 1,
      result: { text: "line one\nline two" },
    });
  });
});

test("legacy negotiation", async (t) => {
  await t.test("echoes a revision it speaks", () => {
    assert.deepEqual(negotiateLegacyVersion("2025-06-18"), {
      version: "2025-06-18",
      matched: true,
    });
  });

  await t.test("negotiates down instead of failing", () => {
    const negotiation = negotiateLegacyVersion("1999-01-01");
    assert.equal(negotiation.matched, false);
    assert.equal(negotiation.version, "2025-11-25");
  });
});

test("era detection", async (t) => {
  await t.test("initialize is the legacy era", () => {
    const decision = classifyRequest("initialize", undefined, createSession());
    assert.equal(decision.kind, "era");
    assert.equal(decision.era, "legacy");
  });

  await t.test("modern _meta selects the modern era", () => {
    const decision = classifyRequest("tools/list", { _meta: MODERN_META }, createSession());
    assert.equal(decision.kind, "era");
    assert.equal(decision.era, "modern");
    assert.equal(decision.version, MODERN_VERSION);
  });

  await t.test("a discover probe with no _meta is modern", () => {
    const decision = classifyRequest("server/discover", undefined, createSession());
    assert.equal(decision.kind, "era");
    assert.equal(decision.era, "modern");
  });

  await t.test("a request with no _meta is a legacy client that skipped the handshake", () => {
    const decision = classifyRequest("tools/list", undefined, createSession());
    assert.equal(decision.kind, "era");
    assert.equal(decision.era, "legacy");
  });

  await t.test("incomplete _meta is a modern client making a mistake, not a legacy one", () => {
    const decision = classifyRequest(
      "tools/list",
      { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION } },
      createSession()
    );
    assert.equal(decision.kind, "error");
    assert.equal(decision.code, ERROR_CODES.invalidParams);
  });
});

test("legacy session", async (t) => {
  await t.test("initialize answers the legacy shape with no resultType", async () => {
    const { server } = makeServer();
    const response = await initializeLegacy(server);
    assert.equal(response.result.protocolVersion, "2025-11-25");
    assert.equal(response.result.instructions, "test instructions");
    assert.deepEqual(response.result.serverInfo, {
      name: "codebase-snapshot",
      title: "codebase-snapshot",
      version: "0.9.4",
      websiteUrl: "https://example.test/codebase-snapshot/",
    });
    assert.equal(response.result.capabilities.tools.listChanged, false);
    assert.ok(!("resultType" in response.result), "resultType belongs to the modern revision");
  });

  await t.test("rejects a request before initialization", async () => {
    const { server } = makeServer();
    const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(response.error.code, ERROR_CODES.invalidRequest);
    assert.match(response.error.message, /initialize/);
  });

  await t.test("answers ping before initialization", async () => {
    const { server } = makeServer();
    const response = await server.handle({ jsonrpc: "2.0", id: 3, method: "ping" });
    assert.deepEqual(response.result, {});
  });

  await t.test("lists tools with schemas and annotations", async () => {
    const { server } = makeServer();
    await initializeLegacy(server);
    const response = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    const echo = response.result.tools.find((tool) => tool.name === "echo");
    assert.equal(echo.inputSchema.type, "object");
    assert.deepEqual(echo.inputSchema.required, ["text"]);
    assert.equal(echo.annotations.readOnlyHint, true);
    assert.ok(echo.outputSchema, "a tool that declares an output schema keeps it");
  });

  await t.test("calls a tool, applies defaults and returns structured content", async () => {
    const { server, calls } = makeServer();
    await initializeLegacy(server);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "ab" } },
    });
    assert.deepEqual(calls[0], { text: "ab", count: 1 }, "the schema default was applied");
    assert.equal(response.result.content[0].text, "ab");
    assert.deepEqual(response.result.structuredContent, { text: "ab" });
    assert.ok(!response.result.isError);
  });

  await t.test("reports bad arguments as a tool error the model can read", async () => {
    const { server } = makeServer();
    await initializeLegacy(server);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "x", maxPartByte: 5 } },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /unknown argument "maxPartByte"/);
  });

  await t.test("unknown tools and methods are protocol errors", async () => {
    const { server } = makeServer();
    await initializeLegacy(server);
    const unknownTool = await server.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    assert.equal(unknownTool.error.code, ERROR_CODES.invalidParams);

    const unknownMethod = await server.handle({ jsonrpc: "2.0", id: 8, method: "tools/nope" });
    assert.equal(unknownMethod.error.code, ERROR_CODES.methodNotFound);
  });

  await t.test("a throwing handler becomes a tool error, not a dead server", async () => {
    const { server, logs } = makeServer();
    await initializeLegacy(server);
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "boom", arguments: {} },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /kaboom/);
    assert.ok(logs.some((line) => line.includes("boom")));
  });

  await t.test("resources list, read and reject an unknown URI", async () => {
    const { server } = makeServer();
    await initializeLegacy(server);
    const list = await server.handle({ jsonrpc: "2.0", id: 10, method: "resources/list" });
    assert.equal(list.result.resources[0].uri, "snapshot://manifest");

    const templates = await server.handle({
      jsonrpc: "2.0",
      id: 11,
      method: "resources/templates/list",
    });
    assert.equal(templates.result.resourceTemplates[0].uriTemplate, "snapshot://parts/{index}");

    const read = await server.handle({
      jsonrpc: "2.0",
      id: 12,
      method: "resources/read",
      params: { uri: "snapshot://manifest" },
    });
    assert.equal(read.result.contents[0].text, '{"ok":true}');

    const missing = await server.handle({
      jsonrpc: "2.0",
      id: 13,
      method: "resources/read",
      params: { uri: "snapshot://nope" },
    });
    assert.equal(missing.error.code, ERROR_CODES.invalidParams);
  });

  await t.test("prompts list and get", async () => {
    const { server } = makeServer();
    await initializeLegacy(server);
    const list = await server.handle({ jsonrpc: "2.0", id: 14, method: "prompts/list" });
    assert.equal(list.result.prompts[0].name, "orient");

    const got = await server.handle({
      jsonrpc: "2.0",
      id: 15,
      method: "prompts/get",
      params: { name: "orient" },
    });
    assert.equal(got.result.messages[0].content.text, "map it");
  });

  await t.test("a notification is never answered", async () => {
    const { server } = makeServer();
    const response = await server.handle({ jsonrpc: "2.0", method: "notifications/whatever" });
    assert.equal(response, null);
  });

  await t.test("rejects a non-object message and a wrong jsonrpc field", async () => {
    const { server } = makeServer();
    const notObject = await server.handle(42);
    assert.equal(notObject.error.code, ERROR_CODES.parseError);

    const wrongVersion = await server.handle({ jsonrpc: "1.0", id: 16, method: "ping" });
    assert.equal(wrongVersion.error.code, ERROR_CODES.invalidRequest);
  });

  await t.test("echoes a string id unchanged", async () => {
    const { server } = makeServer();
    const response = await server.handle({ jsonrpc: "2.0", id: "abc-1", method: "ping" });
    assert.equal(response.id, "abc-1");
  });
});

test("modern session", async (t) => {
  await t.test("discover returns every required field", async () => {
    const { server } = makeServer();
    const response = await server.handle({ jsonrpc: "2.0", id: 20, method: "server/discover" });
    const result = response.result;
    assert.equal(result.resultType, "complete");
    assert.deepEqual(result.supportedVersions, ["2026-07-28", "2025-11-25", "2025-06-18"]);
    assert.equal(result.cacheScope, "private");
    assert.equal(result.ttlMs, 0);
    assert.ok(result.capabilities.tools);
    assert.equal(result.instructions, "test instructions");
    assert.deepEqual(result._meta["io.modelcontextprotocol/serverInfo"], {
      name: "codebase-snapshot",
      version: "0.9.4",
      title: "codebase-snapshot",
    });
  });

  await t.test("every result carries resultType and server identity", async () => {
    const { server } = makeServer();
    await server.handle({ jsonrpc: "2.0", id: 21, method: "server/discover" });
    const response = await modernCall(server, 22, "tools/list");
    assert.equal(response.result.resultType, "complete");
    assert.ok(response.result._meta["io.modelcontextprotocol/serverInfo"]);
  });

  await t.test("initialize and ping no longer exist", async () => {
    const { server } = makeServer();
    await server.handle({ jsonrpc: "2.0", id: 23, method: "server/discover" });

    const initialize = await modernCall(server, 24, "initialize");
    assert.equal(initialize.error.code, ERROR_CODES.methodNotFound);
    assert.match(initialize.error.message, /server\/discover/);

    const ping = await modernCall(server, 25, "ping");
    assert.equal(ping.error.code, ERROR_CODES.methodNotFound);
  });

  await t.test("an unsupported version reports -32022 with the supported list", async () => {
    const { server } = makeServer();
    await server.handle({ jsonrpc: "2.0", id: 26, method: "server/discover" });
    const response = await modernCall(server, 27, "tools/list");
    assert.equal(response.result.resultType, "complete");

    const bad = await server.handle({
      jsonrpc: "2.0",
      id: 28,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2027-01-01",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    assert.equal(bad.error.code, ERROR_CODES.unsupportedProtocolVersion);
    assert.equal(bad.error.code, -32022);
    assert.equal(bad.error.data.requested, "2027-01-01");
    assert.ok(bad.error.data.supported.includes("2026-07-28"));
  });

  await t.test("a modern request that drops _meta is rejected, not downgraded", async () => {
    const { server } = makeServer();
    await server.handle({ jsonrpc: "2.0", id: 29, method: "server/discover" });
    const response = await server.handle({ jsonrpc: "2.0", id: 30, method: "tools/list" });
    assert.equal(response.error.code, ERROR_CODES.invalidRequest);
    assert.match(response.error.message, /_meta/);
  });

  await t.test("tools work identically in the modern era", async () => {
    const { server } = makeServer();
    await server.handle({ jsonrpc: "2.0", id: 31, method: "server/discover" });
    const response = await modernCall(server, 32, "tools/call", {
      name: "echo",
      arguments: { text: "x", count: 3 },
    });
    assert.equal(response.result.content[0].text, "xxx");
    assert.equal(response.result.resultType, "complete");
  });
});

test("argument validation", async (t) => {
  const schema = {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["fast", "slow"] },
      size: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["mode"],
    additionalProperties: false,
  };

  await t.test("accepts a valid object", () => {
    assert.deepEqual(validateArguments(schema, { mode: "fast", size: 3 }), []);
  });

  await t.test("names a missing required argument", () => {
    assert.match(validateArguments(schema, {})[0], /missing required argument "mode"/);
  });

  await t.test("names an unknown argument instead of ignoring it", () => {
    assert.match(validateArguments(schema, { mode: "fast", nope: 1 })[0], /unknown argument "nope"/);
  });

  await t.test("enforces enum, integer and range", () => {
    assert.match(validateArguments(schema, { mode: "medium" })[0], /must be one of/);
    assert.match(validateArguments(schema, { mode: "fast", size: 1.5 })[0], /must be an integer/);
    assert.match(validateArguments(schema, { mode: "fast", size: 99 })[0], /<= 10/);
  });

  await t.test("accepts a numeric argument that arrived as a digit string", () => {
    const coerced = coerceNumericStrings(schema, { mode: "fast", size: "3" });
    assert.equal(coerced.size, 3);
    assert.deepEqual(validateArguments(schema, coerced), []);
  });

  await t.test("still rejects a string that is not a number", () => {
    const coerced = coerceNumericStrings(schema, { mode: "fast", size: "ten" });
    assert.equal(coerced.size, "ten", "an unparseable string is left for validation to reject");
    assert.match(validateArguments(schema, coerced)[0], /must be a number/);
  });

  await t.test("a numeric string for an integer field is still checked as one", () => {
    const coerced = coerceNumericStrings(schema, { mode: "fast", size: "1.5" });
    assert.match(validateArguments(schema, coerced)[0], /must be an integer/);
  });

  await t.test("leaves fields the schema declares as strings alone", () => {
    const budgetSchema = {
      type: "object",
      properties: { maxPartBytes: { type: "string" } },
      additionalProperties: false,
    };
    const coerced = coerceNumericStrings(budgetSchema, { maxPartBytes: "307200" });
    assert.equal(coerced.maxPartBytes, "307200", "a byte budget keeps its human spelling");
  });
});
