/**
 * Signed manifests: a digest proves the bytes did not change; a signature proves who produced them.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const BIN = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "dist", "bin.js");

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sign-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"s","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  return root;
}

const run = (args, cwd, env = {}) => {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: result.status, out: (result.stdout ?? "") + (result.stderr ?? "") };
};

test("--sign writes a record that verifies, and health agrees", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate", "--sign"], root).code, 0);
  const record = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "signature.json"), "utf8"));
  assert.equal(record.algorithm, "ed25519");
  assert.equal(record.keyOrigin, "generated");
  assert.match(record.manifestSha256, /^[0-9a-f]{64}$/);

  const health = run(["health"], root);
  assert.equal(health.code, 0, health.out);
  assert.match(health.out, /signature verifies/);
});

test("a tampered manifest fails the signature check", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate", "--sign"], root).code, 0);
  const manifestPath = path.join(root, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.warnings.push("tampered");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const health = run(["health"], root);
  assert.equal(health.code, 1, health.out);
  assert.match(health.out, /changed after it was signed/);
});

test("a configured key signs, and its public half verifies the same bytes", (t) => {
  const root = makeRepo(t);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.equal(run(["generate", "--sign"], root, { SNAPSHOT_SIGNING_KEY: pem }).code, 0);

  const record = JSON.parse(fs.readFileSync(path.join(root, "snapshot", "signature.json"), "utf8"));
  assert.equal(record.keyOrigin, "configured");
  const bytes = fs.readFileSync(path.join(root, "snapshot", "manifest.json"));
  const verified = crypto.verify(
    null,
    bytes,
    publicKey,
    Buffer.from(record.signature, "base64")
  );
  assert.equal(verified, true);
});

test("a snapshot without a signature reports it as a skip, not a failure", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate"], root).code, 0);
  const health = run(["health"], root);
  assert.equal(health.code, 0, health.out);
  assert.match(health.out, /No signature\.json/);
});
