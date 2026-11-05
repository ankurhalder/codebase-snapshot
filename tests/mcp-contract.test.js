/**
 * The contract must not lie about the server.
 *
 * One side of every comparison here comes from the CLI binary (`describe --format json`), the
 * other from a live server session built by the library. They are different code paths over the
 * same objects, so a tool the server serves but the contract never mentions — or a flag the parser
 * accepts on `mcp` that the contract claims applies elsewhere — fails here rather than in a
 * client.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "../dist/mcp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function describeContract() {
  const stdout = execFileSync(process.execPath, ["dist/bin.js", "describe", "--format", "json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

async function liveSession(root = ROOT) {
  const server = createServer({ cwd: root, log: () => {} });
  await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {} },
  });
  await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });

  const call = async (id, method, params) => {
    const response = await server.handle({ jsonrpc: "2.0", id, method, params });
    assert.ok(response && response.result, `${method} returned a result`);
    return response.result;
  };

  return {
    server,
    tools: (await call(2, "tools/list")).tools,
    prompts: (await call(3, "prompts/list")).prompts,
    resources: (await call(4, "resources/list")).resources,
    templates: (await call(5, "resources/templates/list")).resourceTemplates,
  };
}

test("every tool the server serves is in the contract, with the same schema", async () => {
  const contract = describeContract();
  const live = await liveSession();

  assert.deepEqual(
    live.tools.map((tool) => tool.name),
    contract.mcp.tools.map((tool) => tool.name),
    "the contract lists the tools in the order the server serves them"
  );

  for (const tool of live.tools) {
    const described = contract.mcp.tools.find((candidate) => candidate.name === tool.name);
    assert.ok(described, `${tool.name} is described`);
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties),
      described.parameters,
      `${tool.name}: contract parameters match the served schema`
    );
    assert.deepEqual(
      tool.inputSchema.required ?? [],
      described.required,
      `${tool.name}: required arguments match`
    );
    assert.equal(tool.annotations.readOnlyHint, described.readOnly, `${tool.name}: hints match`);
    assert.equal(tool.description, described.summary, `${tool.name}: description matches`);
  }
});

test("prompts, resources and templates are described exactly as served", async () => {
  const contract = describeContract();
  const live = await liveSession();

  assert.deepEqual(
    live.prompts.map((prompt) => prompt.name),
    contract.mcp.prompts.map((prompt) => prompt.name)
  );
  assert.deepEqual(
    live.templates.map((template) => template.uriTemplate),
    contract.mcp.resourceTemplates
  );

  const servedUris = new Set(live.resources.map((resource) => resource.uri));
  for (const uri of contract.mcp.resources) {
    assert.ok(servedUris.has(uri), `${uri} is described in the contract and served`);
  }
});

test("the advertised protocol versions match the contract", async () => {
  const contract = describeContract();
  const { server } = await liveSession(ROOT);
  const discovered = await server.handle({ jsonrpc: "2.0", id: 9, method: "server/discover" });
  const expected = [...contract.mcp.protocolVersions.modern, ...contract.mcp.protocolVersions.legacy];
  assert.deepEqual(discovered.result.supportedVersions, expected);
  assert.equal(discovered.result.resultType, "complete");
});

test("the mcp command is documented, and --cwd is scoped to it", () => {
  const contract = describeContract();

  const command = contract.commands.find((entry) => entry.name === "mcp");
  assert.ok(command, "mcp is a documented command");
  assert.deepEqual(command.exits, [0, 2]);

  const cwd = contract.options.find((option) => option.flag === "--cwd");
  assert.match(cwd.appliesTo, /(?:^|\/)mcp(?:\/|$)/, "--cwd applies to mcp");

  // --format has no meaning on a JSON-RPC stream, so the contract must not claim it does.
  const format = contract.options.find((option) => option.flag === "--format");
  assert.doesNotMatch(format.appliesTo, /(?:^|\/)mcp(?:\/|$)/);
});

test("mcp refuses a flag it does not apply", () => {
  let failed = false;
  try {
    execFileSync(process.execPath, ["dist/bin.js", "mcp", "--format", "json"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    failed = true;
    assert.equal(error.status, 2, "a flag outside the command's scope is a usage error");
    assert.match(String(error.stderr), /--format does not apply/);
  }
  assert.ok(failed, "mcp --format must fail rather than start a server");
});
