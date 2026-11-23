import assert from "node:assert/strict";
import http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import {
  DEFAULT_SECRET_PATTERNS,
  collectFiles,
  generateSnapshot,
  globToRegExp,
  parseRemoteSource,
  resolveConfig,
  scanAndRedactSecrets,
  startWebServer,
} from "../dist/index.js";
import { buildAgentContract } from "../dist/cli.js";
import { buildTools, createServer, startHttpTransport } from "../dist/mcp.js";
import { makeTempDir } from "./helpers/temp.js";

function makeRepo(t, files = {}) {
  const dir = makeTempDir(t, "verdict-0-20-12-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

async function transportFor(t, dir) {
  const transport = await startHttpTransport({ cwd: dir, port: 0, token: "t", log: () => {} });
  t.after(() => transport.close());
  return transport;
}

test("an empty JSON-RPC batch is rejected and charged to the rate window", async (t) => {
  const dir = makeRepo(t, { "index.ts": "export const x = 1;\n" });
  const transport = await transportFor(t, dir);
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const statuses = [];
  let body = "";
  for (let i = 0; i < 61; i += 1) {
    const response = await fetch(transport.url, { method: "POST", headers, body: "[]" });
    statuses.push(response.status);
    if (i === 0) body = await response.text();
  }
  assert.equal(statuses.slice(0, 60).every((status) => status === 400), true, "each empty batch is invalid, not accepted");
  assert.equal(statuses[60], 429, "the 61st envelope is rate-limited");
  assert.match(body, /-32600/, "JSON-RPC Invalid Request, not a silent 202");
});

test("malformed JSON is charged before parsing", async (t) => {
  const dir = makeRepo(t, { "index.ts": "export const x = 1;\n" });
  const transport = await transportFor(t, dir);
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const statuses = [];
  for (let i = 0; i < 61; i += 1) {
    const response = await fetch(transport.url, { method: "POST", headers, body: "{bad" });
    statuses.push(response.status);
  }
  assert.equal(statuses.slice(0, 60).every((status) => status === 400), true);
  assert.equal(statuses[60], 429, "malformed bodies cannot bypass the limiter");
});

test("an oversized MCP body receives a 413 before the socket closes", async (t) => {
  const dir = makeRepo(t, { "index.ts": "export const x = 1;\n" });
  const transport = await transportFor(t, dir);
  const total = 2 * 1024 * 1024 + 4096;
  const result = await new Promise((resolve) => {
    const request = http.request(transport.url, {
      method: "POST",
      headers: {
        authorization: "Bearer t",
        "content-type": "application/json",
        "content-length": String(total),
      },
    });
    request.on("response", (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", (error) => resolve({ error: error.code || error.message }));
    let sent = 0;
    const pump = () => {
      if (sent >= total) { request.end(); return; }
      const size = Math.min(64 * 1024, total - sent);
      sent += size;
      request.write(Buffer.alloc(size, 0x78), () => setImmediate(pump));
    };
    pump();
  });
  assert.equal(result.status, 413, "the client sees the documented status: " + JSON.stringify(result));
});

test("walk discovery honours a double-star .gitignore rule", (t) => {
  const dir = makeRepo(t, {
    ".gitignore": "**/a/**/b/*\n",
    "README.md": "# test\n",
    "x/a/y/b/secret.txt": "top-secret-content\n",
  });
  const result = collectFiles(dir, { discovery: "walk" });
  assert.equal(result.files.some((entry) => entry.replace(/\\/g, "/").endsWith("x/a/y/b/secret.txt")), false);
  assert.equal(result.skipped.some((entry) => entry.path.replace(/\\/g, "/").endsWith("x/a/y/b/secret.txt")), true);
});

test("a double-star chain is accepted and a brace product is rejected", () => {
  assert.doesNotThrow(() => globToRegExp("**/a/**/b/*"));
  const pattern = "{a,aa,aaa,aaaa,aaaaa}".repeat(7) + "{a,aa,aaa,aaaa}!\n";
  assert.throws(() => globToRegExp(pattern), /32 brace alternatives/);
});

test("IPv6 literals parse as remote sources", () => {
  const loopback = parseRemoteSource("https://[::1]/a/b", { allowPrivate: true });
  assert.equal(loopback.ok, true);
  assert.equal(loopback.source.host, "[::1]");
  const publicAddress = parseRemoteSource("https://[2606:4700:4700::1111]/a/b", {});
  assert.equal(publicAddress.ok, true);
  const privateRefusal = parseRemoteSource("https://[::1]/a/b", {});
  assert.equal(privateRefusal.ok, false);
  assert.match(privateRefusal.message, /private address/);
});

test("the describe contract reports real artifact defaults and option types", () => {
  const contract = buildAgentContract();
  const artifacts = Object.fromEntries(contract.artifacts.map((artifact) => [artifact.name, artifact.default]));
  assert.equal(artifacts.diff, false);
  assert.equal(artifacts.log, false);
  assert.equal(artifacts.tokenTree, false);
  const slots = contract.options.find((option) => option.flag === "--attachment-slots");
  assert.equal(slots.type, "number");
  assert.equal(slots.default, 10);
  const parts = contract.options.find((option) => option.flag === "--max-parts");
  assert.equal(parts.type, "number");
  assert.equal(parts.default, null);
  const skip = contract.options.find((option) => option.flag === "--skip-artifacts");
  for (const name of ["prompt", "diff", "log", "tokenTree"]) assert.match(skip.summary, new RegExp(name));
});

test("only snapshot_generate is writable among the 26 tools", () => {
  const tools = buildTools();
  assert.equal(tools.length, 26);
  assert.equal(tools.filter((tool) => tool.annotations.readOnlyHint === false).map((tool) => tool.name).join(","), "snapshot_generate");
});

test("Dockerfile ENV continuations are masked without hiding variables or placeholders", () => {
  const text = [
    "FROM alpine",
    "ENV API_SECRET \\",
    "  supersecret123456",
    "ENV REF_SECRET \\",
    "  $RUNTIME_SECRET",
    "ENV PLACEHOLDER_SECRET \\",
    "  replace-me-with-real-key",
    "ENV DB_PASSWORD=\\",
    "  containersecret987654",
    "",
  ].join("\n");
  const first = scanAndRedactSecrets(text, DEFAULT_SECRET_PATTERNS, "Containerfile");
  assert.doesNotMatch(first.redacted, /supersecret123456/);
  assert.doesNotMatch(first.redacted, /containersecret987654/);
  assert.match(first.redacted, /\$RUNTIME_SECRET/);
  assert.match(first.redacted, /replace-me-with-real-key/);
  const second = scanAndRedactSecrets(first.redacted, DEFAULT_SECRET_PATTERNS, "Containerfile");
  assert.equal(second.redacted, first.redacted, "health re-scans the emitted text");
});

test("serve answers 404 for a missing local source and 403 for an escape", async (t) => {
  const dir = makeRepo(t, { "index.ts": "export const x = 1;\n" });
  const server = await startWebServer({ cwd: dir, port: 0, token: "t", log: () => {} });
  t.after(() => server.close());
  const headers = { authorization: "Bearer t", "content-type": "application/json" };
  const missing = await fetch(server.url + "api/generate", { method: "POST", headers, body: JSON.stringify({ source: "nonexistent-subdir" }) });
  assert.equal(missing.status, 404);
  const escape = await fetch(server.url + "api/generate", { method: "POST", headers, body: JSON.stringify({ source: "../outside-dir" }) });
  assert.equal(escape.status, 403);
});

test("snapshot_read refuses a part above the content-tool memory cap", async (t) => {
  const dir = makeRepo(t, { "src/a.ts": "export const x = 1;\n" });
  generateSnapshot(resolveConfig({ outDir: "snapshot" }, {}, dir));
  const part = path.join(dir, "snapshot", "parts", "part-001.md");
  fs.writeFileSync(part, "x".repeat(17 * 1024 * 1024));
  const server = createServer({ cwd: dir, log: () => {} });
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const read = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "snapshot_read", arguments: { path: "src/a.ts" } } });
  assert.equal(read.result.isError, true);
  assert.match(read.result.content[0].text, /larger than/);
  const context = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "snapshot_context", arguments: { files: ["src/a.ts"] } } });
  assert.match(context.result.content[0].text, /larger than/);
});
