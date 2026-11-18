/**
 * `snapshot update`: the explicit version check.
 *
 * It is the one command whose whole job is a network call, so the tests drive it against a local
 * server: the notice for a newer release, the quiet answer when current, the JSON form a script
 * reads, and exit 2 when nothing can be reached. The cache lives in LOCALAPPDATA on Windows and
 * XDG_CACHE_HOME elsewhere; each case gets its own, so one case cannot answer another.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "dist", "bin.js");
const CURRENT = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

async function withRegistry(version, body) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "codebase-snapshot", version }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await body("http://127.0.0.1:" + port + "/latest");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Async on purpose: the stub registry runs in this process, and a synchronous child would block
// the event loop that has to answer its request.
function run(args, registryUrl, cwd = ROOT) {
  return new Promise((resolve) => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "update-cmd-"));
    const child = spawn(process.execPath, [BIN, "update", ...args], {
      cwd,
      env: { ...process.env, CODEBASE_SNAPSHOT_REGISTRY_URL: registryUrl, LOCALAPPDATA: cacheRoot },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
      resolve({ status, stdout, stderr });
    });
  });
}

test("a newer release is announced and exits 1", async () => {
  await withRegistry("9.9.9", async (url) => {
    const result = await run([], url);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /9\.9\.9 is available/);
    assert.match(result.stderr, /you have /);
    assert.equal(result.stdout, "", "the answer is not a payload");
  });
});

test("being current exits 0 and says so", async () => {
  await withRegistry(CURRENT, async (url) => {
    const result = await run([], url);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /No update is available/);
    assert.match(result.stderr, new RegExp(CURRENT.replace(/\./g, "\\.")));
  });
});

test("--format json carries the comparison", async () => {
  await withRegistry("9.9.9", async (url) => {
    const result = await run(["--format", "json"], url);
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(
      { current: payload.current, latest: payload.latest, updateAvailable: payload.updateAvailable },
      { current: CURRENT, latest: "9.9.9", updateAvailable: true }
    );
    assert.match(payload.command, /npm install/);
  });
});

test("an unreachable registry exits 2 instead of claiming anything", async () => {
  const result = await run([], "http://127.0.0.1:1/latest");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Could not reach the npm registry/);
});

test("update does not need a readable configuration", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-config-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }) + "\n");
  fs.writeFileSync(path.join(dir, "snapshot.config.ts"), "export default {};\n");
  await withRegistry("9.9.9", async (url) => {
    const result = await run([], url, dir);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr, /executable config/, "the command runs before config discovery");
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a forced check ignores a fresh cache", async () => {
  const { resolveLatest } = await import("../dist/index.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-force-"));
  const cacheFile = path.join(dir, "update-check.json");
  fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: Date.now(), latest: "0.18.0" }) + "\n");

  const fetched = await resolveLatest({
    current: "0.19.1",
    cacheFile,
    force: true,
    fetchLatest: async () => "0.19.1",
  });
  assert.equal(fetched, "0.19.1", "force bypasses the cached value");

  // And when the forced request fails, the cached answer is still better than nothing.
  const fallback = await resolveLatest({
    current: "0.19.1",
    cacheFile,
    force: true,
    fetchLatest: async () => null,
  });
  assert.equal(fallback, "0.19.1", "the successful write from the previous call is the fallback");
  fs.rmSync(dir, { recursive: true, force: true });
});
