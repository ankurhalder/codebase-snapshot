/**
 * Signed manifests: a digest proves the bytes did not change; a signature proves who produced them.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");

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

test("validate reports a signature that no longer matches, not only health", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate", "--sign"], root).code, 0);
  assert.equal(run(["validate"], root).code, 0, "a signed snapshot validates");

  const manifestPath = path.join(root, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.warnings = [...(manifest.warnings ?? []), "edited after signing"];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const validated = run(["validate"], root);
  assert.equal(validated.code, 1, validated.out);
  assert.match(validated.out, /signature: manifest\.json changed after it was signed/);
});

test("health ignores a token-shaped run inside the signature key material", (t) => {
  const root = makeRepo(t);
  assert.equal(run(["generate"], root).code, 0);

  const manifestPath = path.join(root, "snapshot", "manifest.json");
  const bytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(bytes.toString("utf8"));

  // The Azure DevOps token shape is 52 mixed-case alphanumerics; a random ed25519 public key
  // contains such a run often enough to match (about one in forty). Find a real key that does, so
  // the test is deterministic about the false positive it exercises.
  let pair = null;
  let publicKey = "";
  for (let attempt = 0; attempt < 5000 && pair === null; attempt += 1) {
    const candidate = crypto.generateKeyPairSync("ed25519");
    const base64 = crypto.createPublicKey(candidate.privateKey).export({ type: "spki", format: "der" }).toString("base64");
    for (let index = 0; index + 52 <= base64.length; index += 1) {
      const slice = base64.slice(index, index + 52);
      if (/^[A-Za-z0-9]{52}$/.test(slice) && /[a-z]/.test(slice) && /[A-Z]/.test(slice) && /[0-9]/.test(slice)) {
        pair = candidate;
        publicKey = base64;
        break;
      }
    }
  }
  assert.ok(pair !== null, "found a key with a token-shaped run");

  const record = {
    algorithm: "ed25519",
    signedAt: new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    manifestSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    publicKey,
    signature: crypto.sign(null, bytes, pair.privateKey).toString("base64"),
    keyOrigin: "generated",
  };
  fs.writeFileSync(path.join(root, "snapshot", "signature.json"), JSON.stringify(record, null, 2) + "\n");

  const health = run(["health"], root);
  assert.equal(health.code, 0, health.out);
  assert.doesNotMatch(health.out, /secret-shaped value/);

  // The record's other fields are still scanned: a token smuggled into one is a failure. The
  // signature covers the manifest, not this record, so the signature still verifies.
  record.keyOrigin = "glpat-abcdefghijklmnopqrstuvwx";
  fs.writeFileSync(path.join(root, "snapshot", "signature.json"), JSON.stringify(record, null, 2) + "\n");
  const leaked = run(["health"], root);
  assert.equal(leaked.code, 1, leaked.out);
  assert.match(leaked.out, /secret-shaped value: signature\.json/);
});
