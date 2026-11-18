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

test("the legacy SSE endpoint hands out a session and answers on the stream", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const controller = new AbortController();
  t.after(() => controller.abort());

  const stream = await fetch(transport.url.replace("/mcp", "/sse") + "?token=" + transport.token, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  assert.match(String(stream.headers.get("content-type")), /text\/event-stream/);

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const nextEvent = async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed");
      buffer += decoder.decode(value, { stream: true });
      const end = buffer.indexOf("\n\n");
      if (end !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        return event;
      }
    }
  };

  const endpoint = await nextEvent();
  assert.match(endpoint, /event: endpoint/);
  const messagePath = /data: (\S+)/.exec(endpoint)[1];

  const posted = await fetch(transport.url.replace("/mcp", "") + messagePath, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + transport.token },
    body: JSON.stringify(rpc(7, "initialize", { protocolVersion: "2024-11-05", capabilities: {} })),
  });
  assert.equal(posted.status, 202);

  const answer = await nextEvent();
  assert.match(answer, /event: message/);
  const payload = JSON.parse(/data: (.+)/.exec(answer)[1]);
  assert.equal(payload.id, 7);
  assert.equal(payload.result.serverInfo.name, "codebase-snapshot");
});

test("the SSE endpoint requires the token", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const response = await fetch(transport.url.replace("/mcp", "/sse"));
  assert.equal(response.status, 401);
});

test("an unknown SSE session is a 404", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const response = await fetch(transport.url.replace("/mcp", "/messages?sessionId=nope"), {
    method: "POST",
    headers: { authorization: "Bearer " + transport.token, "content-type": "application/json" },
    body: JSON.stringify(rpc(1, "tools/list", {})),
  });
  assert.equal(response.status, 404);
});

test("healthz reports the build that answers, without a token", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const url = new URL(transport.url);
  const response = await fetch(url.origin + "/healthz");
  assert.equal(response.status, 200, "liveness must not need the token");
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.name, "codebase-snapshot");
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
  assert.ok(body.tools >= 20);
  assert.equal(typeof body.uptimeSeconds, "number");
});

test("metrics reports counters in Prometheus format", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const url = new URL(transport.url);

  // One refused origin and one normal request, so both counters have a value to prove.
  await fetch(url.origin + "/healthz", { headers: { origin: "https://evil.example" } });
  await fetch(url.origin + "/healthz");

  const response = await fetch(url.origin + "/metrics");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  const text = await response.text();
  assert.match(text, /^# TYPE snapshot_requests_total counter$/m);
  assert.match(text, /^snapshot_requests_total [1-9]\d*$/m);
  assert.match(text, /^snapshot_requests_refused_total [1-9]\d*$/m);
  assert.match(text, /^snapshot_tools \d+$/m);
  assert.match(text, /^snapshot_uptime_seconds \d+$/m);
  assert.match(text, /snapshot_requests_by_method_total\{method="GET"\} \d+/);
  assert.doesNotMatch(text, /healthz|5000|token/i, "no request path or credential is a metric label");
});

test("/metrics counts every refusal and the rate limit it applies", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const metricsUrl = transport.url.replace(/\/mcp$/, "") + "/metrics";
  const rpc = (id, method) => JSON.stringify({ jsonrpc: "2.0", id, method });
  const auth = { authorization: "Bearer " + transport.token, "content-type": "application/json" };

  const unauthorized = await fetch(transport.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rpc(1, "ping"),
  });
  assert.equal(unauthorized.status, 401);
  const crossOrigin = await fetch(transport.url, {
    method: "POST",
    headers: { ...auth, origin: "https://evil.example" },
    body: rpc(2, "ping"),
  });
  assert.equal(crossOrigin.status, 403);
  const wrongMethod = await fetch(transport.url, { method: "DELETE", headers: auth });
  assert.equal(wrongMethod.status, 405);

  let limited = 0;
  for (let index = 0; index < 90; index += 1) {
    const response = await fetch(transport.url, { method: "POST", headers: auth, body: rpc(100 + index, "ping") });
    if (response.status === 429) limited += 1;
  }
  assert.ok(limited > 0, "the rate limit applies");

  const text = await (await fetch(metricsUrl)).text();
  assert.match(text, /snapshot_requests_refused_total 3\n/, "the 401, 403 and 405 are all refusals");
  assert.match(text, /snapshot_requests_rate_limited_total \d+\n/);
  const rateLimited = Number(/snapshot_requests_rate_limited_total (\d+)/.exec(text)[1]);
  assert.equal(rateLimited, limited, "the counter matches the 429 responses");
  assert.match(text, /snapshot_tools 26\n/);
  assert.match(text, /snapshot_requests_by_method_total\{method="DELETE"\} 1\n/);
});

test("the SSE message endpoint accepts the token in the query", async (t) => {
  const root = fixture(t);
  const transport = await serve(t, root);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const rootUrl = transport.url.replace("/mcp", "");

  const stream = await fetch(rootUrl + "/sse?token=" + transport.token, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const nextEvent = async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed");
      buffer += decoder.decode(value, { stream: true });
      const end = buffer.indexOf("\n\n");
      if (end !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        return event;
      }
    }
  };
  const messagePath = /data: (\S+)/.exec(await nextEvent())[1];

  // No Authorization header: a client that only has EventSource can still drive the session.
  const posted = await fetch(rootUrl + messagePath + "&token=" + transport.token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rpc(9, "initialize", { protocolVersion: "2025-06-18", capabilities: {} })),
  });
  assert.equal(posted.status, 202);
  const answer = JSON.parse(/data: (.+)/.exec(await nextEvent())[1]);
  assert.equal(answer.id, 9);
  assert.equal(answer.result.protocolVersion, "2025-06-18", "a supported version is echoed");

  const anonymous = await fetch(rootUrl + messagePath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rpc(10, "ping", {})),
  });
  assert.equal(anonymous.status, 401, "without the header or the query token the POST is refused");
});
