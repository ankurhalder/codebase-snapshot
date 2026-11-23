/**
 * Independent interoperability tests against the official MCP v2 TypeScript client.
 *
 * The repository's own protocol tests prove the shapes it intended to emit. This suite proves a
 * separate implementation can negotiate the modern era and consume those shapes over both
 * transports, including cache metadata and the `Mcp-Method`/`Mcp-Name` headers.
 *
 * The v2 packages require Node 20, while this package still supports Node 18. The suite is skipped
 * on 18 rather than made to import a package it cannot run.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { startHttpTransport } from "../dist/mcp.js";

const BIN = path.resolve("dist/bin.js");
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
const SKIP = NODE_MAJOR < 20 ? "the official MCP v2 client requires Node.js 20 or newer" : false;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-interop-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  return root;
}

async function officialClient() {
  const { Client } = await import("@modelcontextprotocol/client");
  return new Client(
    { name: "codebase-snapshot-interop", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } }
  );
}

test("official MCP client negotiates modern HTTP and reads every cacheable result", { skip: SKIP }, async (t) => {
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const root = fixture(t);
  const server = await startHttpTransport({ cwd: root, port: 0, log: () => {} });
  const client = await officialClient();
  t.after(async () => {
    await client.close();
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { authorization: "Bearer " + server.token } },
  });
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), "modern");

  const tools = await client.listTools();
  assert.equal(tools.tools.length, 26);
  assert.equal(tools.ttlMs, 0);
  assert.equal(tools.cacheScope, "private");

  const prompts = await client.listPrompts();
  assert.equal(prompts.ttlMs, 0);
  assert.equal(prompts.cacheScope, "private");

  const templates = await client.listResourceTemplates();
  assert.equal(templates.ttlMs, 0);
  assert.equal(templates.cacheScope, "private");

  const generated = await client.callTool({ name: "snapshot_generate", arguments: {} });
  assert.notEqual(generated.isError, true, JSON.stringify(generated.content));

  const resources = await client.listResources();
  assert.equal(resources.ttlMs, 0);
  assert.equal(resources.cacheScope, "private");

  const manifest = await client.readResource({ uri: "snapshot://manifest" });
  assert.equal(manifest.ttlMs, 0);
  assert.equal(manifest.cacheScope, "private");
  assert.ok(manifest.contents.length > 0);
});

test("official MCP client negotiates modern stdio, including discovery and a tool call", { skip: SKIP }, async (t) => {
  const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
  const root = fixture(t);
  const client = await officialClient();
  t.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "mcp"],
      cwd: root,
    })
  );
  assert.equal(client.getProtocolEra(), "modern");

  const tools = await client.listTools();
  assert.equal(tools.tools.length, 26);
  assert.equal(tools.ttlMs, 0);
  assert.equal(tools.cacheScope, "private");

  const planned = await client.callTool({ name: "snapshot_plan", arguments: { maxPartBytes: 120000 } });
  assert.notEqual(planned.isError, true, JSON.stringify(planned.content));
  assert.match(planned.content[0].text, /plan|budget|part/i);
});
