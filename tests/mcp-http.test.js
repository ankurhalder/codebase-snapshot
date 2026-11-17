/**
 * MCP over HTTP: the transport a browser can use.
 *
 * The properties under test are the ones that make it safe to run on a laptop: a token by default,
 * a loopback bind by default, CORS only for loopback origins, a body cap, and a JSON-RPC answer
 * that the stdio server would give.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { startHttpTransport } from "../dist/mcp.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  return root;
}

async function serve(t, root, extra = {}) {
  const transport = await startHttpTransport({ cwd: root, port: 0, log: () => {}, ...extra });
  t.after(() => transport.close());
  return transport;
}

const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, params });

test("a POST carries a JSON-RPC message and the answer comes back", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const response = await fetch(transport.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + transport.token },
    body: JSON.stringify(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} })),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, 1);
  assert.equal(body.result.serverInfo.name, "codebase-snapshot");
});

test("without the token the answer is 401", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const response = await fetch(transport.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rpc(1, "tools/list", {})),
  });
  assert.equal(response.status, 401);
  assert.match(String(response.headers.get("www-authenticate")), /Bearer/);
});

test("--no-auth serves only when the bind is loopback", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root, { token: null });
  const headers = { "content-type": "application/json" };
  const initialized = await fetch(transport.url, {
    method: "POST",
    headers,
    body: JSON.stringify(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} })),
  });
  assert.equal(initialized.status, 200);
  const response = await fetch(transport.url, {
    method: "POST",
    headers,
    body: JSON.stringify(rpc(2, "tools/list", {})),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.result.tools.length >= 10);

  await assert.rejects(
    () => startHttpTransport({ cwd: root, host: "0.0.0.0", token: null, port: 0, log: () => {} }),
    /without a token/
  );
});

test("CORS is granted to loopback origins and refused to others", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const allowed = await fetch(transport.url, {
    method: "OPTIONS",
    headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");

  const refused = await fetch(transport.url, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(refused.status, 403);
});

test("a notification is accepted with 202, and a bad body with 400", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const headers = { "content-type": "application/json", authorization: "Bearer " + transport.token };
  const notification = await fetch(transport.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(notification.status, 202);

  const broken = await fetch(transport.url, { method: "POST", headers, body: "{" });
  assert.equal(broken.status, 400);
  const body = await broken.json();
  assert.equal(body.error.code, -32700);
});

test("healthz reports the server is up", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const response = await fetch(transport.url.replace("/mcp", "/healthz"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.name, "codebase-snapshot");
});
