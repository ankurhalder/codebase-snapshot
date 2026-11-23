/**
 * Modern Streamable HTTP conformance.
 *
 * These tests exercise the 2026-07-28 request shape through a real HTTP socket: required routing
 * headers, header/body disagreement, cache hints, the modern resource error code, and the fact
 * that a modern request is stateless even when a caller sends an old session id.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { startHttpTransport } from "../dist/mcp.js";

const VERSION = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "modern-http-test", version: "1.0.0" },
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modern-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  return root;
}

async function serve(t, root) {
  const transport = await startHttpTransport({ cwd: root, port: 0, token: null, log: () => {} });
  t.after(() => transport.close());
  return transport;
}

function headers(method, name) {
  return {
    "content-type": "application/json",
    "mcp-protocol-version": VERSION,
    "mcp-method": method,
    ...(name === undefined ? {} : { "mcp-name": name }),
  };
}

function modern(id, method, params = {}, options = {}) {
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: options.meta ?? META },
  };
  return {
    body,
    init: {
      method: "POST",
      headers: {
        ...headers(method, options.name),
        ...(options.version === undefined ? {} : { "mcp-protocol-version": options.version }),
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(body),
    },
  };
}

test("a modern request without server/discover succeeds and carries cache hints", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const request = modern(1, "tools/list");
  const response = await fetch(transport.url, request.init);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("mcp-session-id"), null, "modern requests are stateless");
  const body = await response.json();
  assert.equal(body.result.resultType, "complete");
  assert.equal(body.result.ttlMs, 0);
  assert.equal(body.result.cacheScope, "private");
  assert.ok(body.result.tools.length >= 20);
});

test("every cacheable modern operation carries ttlMs and cacheScope", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);

  const generated = await fetch(
    transport.url,
    modern(10, "tools/call", { name: "snapshot_generate", arguments: {} }, { name: "snapshot_generate" }).init
  );
  assert.equal(generated.status, 200, await generated.clone().text());
  assert.notEqual((await generated.json()).result.isError, true);

  const operations = [
    [11, "tools/list", {}, undefined],
    [12, "prompts/list", {}, undefined],
    [13, "resources/list", {}, undefined],
    [14, "resources/templates/list", {}, undefined],
    [15, "resources/read", { uri: "snapshot://manifest" }, "snapshot://manifest"],
  ];
  for (const [id, method, params, name] of operations) {
    const request = modern(id, method, params, { name });
    const response = await fetch(transport.url, request.init);
    assert.equal(response.status, 200, method + ": " + (await response.clone().text()));
    const result = (await response.json()).result;
    assert.equal(result.resultType, "complete", method);
    assert.equal(result.cacheScope, "private", method);
    assert.equal(result.ttlMs, 0, method);
  }
});

test("the required modern headers are enforced before dispatch", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);

  const cases = [
    {
      label: "missing protocol version",
      request: modern(20, "tools/list", {}, { headers: { "mcp-protocol-version": "" } }),
      code: -32020,
    },
    {
      label: "protocol version mismatch",
      request: modern(21, "tools/list", {}, { version: "2025-11-25" }),
      code: -32020,
    },
    {
      label: "missing method header",
      request: modern(22, "tools/list", {}, { headers: { "mcp-method": "" } }),
      code: -32020,
    },
    {
      label: "wrong method header",
      request: modern(23, "tools/list", {}, { headers: { "mcp-method": "prompts/list" } }),
      code: -32020,
    },
    {
      label: "missing name for tools/call",
      request: modern(24, "tools/call", { name: "snapshot_status", arguments: {} }),
      code: -32020,
    },
    {
      label: "wrong name for tools/call",
      request: modern(25, "tools/call", { name: "snapshot_status", arguments: {} }, { name: "snapshot_read" }),
      code: -32020,
    },
    {
      label: "malformed base64 name",
      request: modern(26, "tools/call", { name: "snapshot_status", arguments: {} }, { name: "=?base64?!!!!?=" }),
      code: -32020,
    },
  ];

  for (const item of cases) {
    // An empty header value is omitted by fetch/undici, so delete it explicitly for that case.
    const init = { ...item.request.init, headers: { ...item.request.init.headers } };
    for (const [key, value] of Object.entries(init.headers)) {
      if (value === "") delete init.headers[key];
    }
    const response = await fetch(transport.url, init);
    assert.equal(response.status, 400, item.label + ": " + (await response.clone().text()));
    const body = await response.json();
    assert.equal(body.error.code, item.code, item.label);
    assert.match(body.error.message, /Header mismatch|missing the required key/i, item.label);
  }
});

test("a base64-encoded Mcp-Name is decoded before comparison", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const encoded = Buffer.from("snapshot_status", "utf8").toString("base64");
  const request = modern(30, "tools/call", { name: "snapshot_status", arguments: {} }, {
    name: "=?base64?" + encoded + "?=",
  });
  const response = await fetch(transport.url, request.init);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.notEqual(body.result.isError, true);
});

test("unsupported versions and unknown methods use their modern HTTP statuses", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);

  const unsupported = modern(40, "tools/list", {}, {
    version: "2027-01-01",
    meta: {
      ...META,
      "io.modelcontextprotocol/protocolVersion": "2027-01-01",
    },
  });
  // The test helper derives Mcp-Method from the body but the version header must also match.
  const unsupportedResponse = await fetch(transport.url, {
    ...unsupported.init,
    headers: { ...unsupported.init.headers, "mcp-protocol-version": "2027-01-01" },
  });
  assert.equal(unsupportedResponse.status, 400);
  const unsupportedBody = await unsupportedResponse.json();
  assert.equal(unsupportedBody.error.code, -32022);
  assert.ok(unsupportedBody.error.data.supported.includes(VERSION));

  const unknown = modern(41, "not/a/method", {});
  const unknownResponse = await fetch(transport.url, unknown.init);
  assert.equal(unknownResponse.status, 404);
  assert.equal((await unknownResponse.json()).error.code, -32601);
});

test("modern resource-not-found is -32602, while legacy remains -32002", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);

  const modernRead = modern(50, "resources/read", { uri: "snapshot://manifest" }, {
    name: "snapshot://manifest",
  });
  const modernResponse = await fetch(transport.url, modernRead.init);
  assert.equal(modernResponse.status, 400);
  const modernBody = await modernResponse.json();
  assert.equal(modernBody.error.code, -32602);

  const legacyInit = await fetch(transport.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 51,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {} },
    }),
  });
  assert.equal(legacyInit.status, 200, await legacyInit.clone().text());
  const session = legacyInit.headers.get("mcp-session-id");
  const legacyRead = await fetch(transport.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": session,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 52,
      method: "resources/read",
      params: { uri: "snapshot://manifest" },
    }),
  });
  assert.equal(legacyRead.status, 200, await legacyRead.clone().text());
  assert.equal((await legacyRead.json()).error.code, -32002);
});

test("CORS preflight permits Mcp-Method and Mcp-Name", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const response = await fetch(transport.url, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:5173",
      "access-control-request-method": "POST",
      "access-control-request-headers": "mcp-method, mcp-name, mcp-protocol-version, authorization",
    },
  });
  assert.equal(response.status, 204);
  const allowed = String(response.headers.get("access-control-allow-headers"));
  for (const name of ["mcp-method", "mcp-name", "mcp-protocol-version", "authorization"]) {
    assert.match(allowed, new RegExp(name, "i"));
  }
});

test("a modern request ignores an old mcp-session-id header", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const request = modern(60, "tools/list", {}, { headers: { "mcp-session-id": "not-a-real-session" } });
  const response = await fetch(transport.url, request.init);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("mcp-session-id"), null);
});
