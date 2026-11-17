/**
 * snapshot serve: the page, the API it calls, and the MCP endpoint, on one port.
 *
 * The page itself is served unauthenticated (it is HTML); everything that reads or writes a
 * repository requires the token. That split is what the first test pins.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { startWebServer } from "../dist/index.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "serve-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "repo", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "repo", "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "repo", "src", "a.ts"), "export const a = 1;\n");
  return root;
}

async function serve(t, root) {
  const server = await startWebServer({ cwd: root, port: 0, log: () => {} });
  t.after(() => server.close());
  return server;
}

const auth = (server, extra = {}) => ({ authorization: "Bearer " + server.token, ...extra });

test("the page is served without a token; the API is not", async (t) => {
  const root = fixture(t);
  const server = await serve(t, root);

  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /codebase-snapshot/);
  assert.equal(html.includes(server.token), false, "the page never carries the token");

  const denied = await fetch(server.url + "api/snapshot", { headers: {} });
  assert.equal(denied.status, 401);
});

test("generate, preview and download from the API", async (t) => {
  const root = fixture(t);
  const server = await serve(t, root);
  const repo = path.join(root, "repo");

  const generated = await fetch(server.url + "api/generate", {
    method: "POST",
    headers: auth(server, { "content-type": "application/json" }),
    body: JSON.stringify({ source: repo }),
  });
  assert.equal(generated.status, 200, await generated.clone().text());
  const summary = await generated.json();
  assert.ok(summary.files >= 2);
  assert.ok(summary.parts >= 1);
  assert.match(summary.fingerprint, /^[0-9a-f]{64}$/);

  const snapshot = await fetch(server.url + "api/snapshot?path=" + encodeURIComponent(path.join(repo, "snapshot")), {
    headers: auth(server),
  });
  assert.equal(snapshot.status, 200);
  const info = await snapshot.json();
  assert.match(info.prompt, /## The job/);
  assert.ok(info.files.length >= 2);

  const zip = await fetch(server.url + "api/snapshot.zip?path=" + encodeURIComponent(path.join(repo, "snapshot")), {
    headers: auth(server),
  });
  assert.equal(zip.status, 200);
  const bytes = Buffer.from(await zip.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, "a zip local header");
  assert.match(String(zip.headers.get("content-type")), /application\/zip/);
});

test("a remote URL is refused with what is missing, not a fetch", async (t) => {
  const root = fixture(t);
  const server = await serve(t, root);
  const response = await fetch(server.url + "api/generate", {
    method: "POST",
    headers: auth(server, { "content-type": "application/json" }),
    body: JSON.stringify({ source: "https://github.com/owner/repo" }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /not enabled in this build/);
});

test("the MCP endpoint answers with the same token", async (t) => {
  const root = fixture(t);
  const server = await serve(t, root);
  const initialize = await fetch(server.url + "mcp", {
    method: "POST",
    headers: auth(server, { "content-type": "application/json" }),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }),
  });
  assert.equal(initialize.status, 200);
  const body = await initialize.json();
  assert.equal(body.result.serverInfo.name, "codebase-snapshot");
});

test("an unknown path is a 404, not a stack trace", async (t) => {
  const root = fixture(t);
  const server = await serve(t, root);
  const response = await fetch(server.url + "api/snapshot?path=" + encodeURIComponent(path.join(root, "nope")), {
    headers: auth(server),
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.match(body.error, /manifest/);
});
