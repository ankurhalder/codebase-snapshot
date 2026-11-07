import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { fetchLatestVersion, generateSnapshotAsync, isNewer, resolveConfig } from "../dist/index.js";

/**
 * Process-level bookkeeping: the stdout diversion, the update check's deadline, and the version
 * comparison that decides whether to nag at all.
 *
 * These are the parts of the tool a repository never sees, which is why they went wrong quietly —
 * a leaked `process.stdout.write` wrapper and an update check that can hang are both invisible
 * until somebody measures the host process.
 */

function makeRepo(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const configWithHook = (root, hook) =>
  resolveConfig(
    { cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", hooks: { afterGenerate: hook } },
    {},
    root
  );

test("two overlapping async hooks leave process.stdout.write exactly as they found it", async (t) => {
  // Each `runAfterGenerate` used to install its own wrapper and restore it only if
  // `process.stdout.write` was still that call's own — false for whichever hook finished first.
  // The second then restored the *captured* value, which was the first call's wrapper, so the
  // process was left with a permanent wrapper holding both scopes alive.
  const originalWrite = process.stdout.write;
  assert.equal(process.stdout.write, originalWrite, "nothing is installed to begin with");

  const rootA = makeRepo(t, "hook-a");
  const rootB = makeRepo(t, "hook-b");
  const slow = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  };

  await Promise.all([
    generateSnapshotAsync(configWithHook(rootA, slow)),
    generateSnapshotAsync(configWithHook(rootB, slow)),
  ]);

  assert.equal(
    process.stdout.write,
    originalWrite,
    "both hooks are done, so the diversion must be gone"
  );
  assert.equal(process.stdout.write.name, originalWrite.name, "and it is the original function");
});

test("an update check has a wall-clock deadline, not an idle-socket one", async (t) => {
  // `request.setTimeout` resets on every chunk, so a proxy that sends one byte per second keeps the
  // CLI alive indefinitely. The deadline is absolute now.
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    // Trickle: never ends, and every write resets an *idle* timeout.
    const ticker = setInterval(() => {
      if (!response.writableEnded) response.write(" ");
    }, 40);
    ticker.unref();
    request.on("close", () => clearInterval(ticker));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/latest`;

  const started = Date.now();
  const result = await fetchLatestVersion(url, 250);
  const elapsed = Date.now() - started;

  assert.equal(result, null, "a trickling response is a failed check, not a version");
  assert.ok(elapsed < 3000, `the deadline held: ${elapsed} ms`);
});

test("a fast, well-formed response is still read", async (t) => {
  // The deadline must not cost the answer it was guarding.
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: "9.9.9" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.equal(await fetchLatestVersion(`http://127.0.0.1:${address.port}/latest`, 2000), "9.9.9");
});

test("a prerelease is never offered as an upgrade, and a release beats its prerelease", () => {
  // Prerelease tags were stripped before comparing, so `0.9.13-alpha.1` outranked `0.9.12` and was
  // recommended to everyone on a stable release — and `0.9.12` looked no newer than
  // `0.9.12-beta.1`, so somebody running a beta was never told the release existed.
  assert.equal(isNewer("0.9.13-alpha.1", "0.9.12"), false, "do not advertise an unstable build");
  assert.equal(isNewer("1.0.0-rc.1", "0.9.12"), false);
  assert.equal(isNewer("0.9.12", "0.9.12-beta.1"), true, "the release is newer than its beta");
  assert.equal(isNewer("0.9.13", "0.9.12-beta.1"), true);

  // The ordinary cases are unchanged.
  assert.equal(isNewer("0.9.6", "0.9.5"), true);
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("0.9.5", "0.9.5"), false);
  assert.equal(isNewer("0.9.5-beta.1", "0.9.5"), false);
  assert.equal(isNewer("v0.9.6", "0.9.5"), true);
  // Build metadata is not precedence, and two prereleases of one core are not worth a notice.
  assert.equal(isNewer("0.9.13+build.5", "0.9.12"), true);
  assert.equal(isNewer("0.9.13-alpha.2", "0.9.13-alpha.1"), false);
});
