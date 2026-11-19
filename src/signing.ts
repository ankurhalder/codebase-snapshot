import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Signed manifests.
 *
 * A snapshot is an artefact that travels: into a chat, an attachment, a review, another machine. A
 * digest proves the bytes did not change in transit only if the digest itself is trusted. An Ed25519
 * signature over the manifest gives a reader two things a hash cannot: who produced it, and that the
 * manifest they are reading is the one that was signed.
 *
 * The key comes from `SNAPSHOT_SIGNING_KEY` (a PEM private key) when set, so a team can publish the
 * matching public key once and every snapshot is verifiable. With no key configured, a fresh key is
 * generated and its public half is written beside the signature — trust on first use, stated as
 * exactly that in the file.
 */

export interface SignatureRecord {
  algorithm: "ed25519";
  signedAt: string;
  fingerprint: string;
  manifestSha256: string;
  publicKey: string;
  signature: string;
  /** "configured" when a key was supplied, "generated" for trust on first use. */
  keyOrigin: "configured" | "generated";
}

export const SIGNATURE_FILE = "signature.json";

export function loadSigningKey(environment: NodeJS.ProcessEnv = process.env): crypto.KeyObject | null {
  const pem = environment.SNAPSHOT_SIGNING_KEY;
  if (pem === undefined || pem.trim() === "") return null;
  return crypto.createPrivateKey({ key: pem, format: "pem" });
}

/**
 * Signs the exact bytes of `manifest.json`.
 *
 * The signature covers the manifest, and the manifest covers every part and artefact by digest, so
 * one signature transitively covers the snapshot — as long as the caller verifies it against the
 * manifest they are reading.
 */
export function signManifest(
  manifestPath: string,
  options: { key?: crypto.KeyObject | null; signedAt?: string } = {}
): SignatureRecord {
  const bytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(bytes.toString("utf8")) as { fingerprint?: unknown };
  if (typeof manifest.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(manifest.fingerprint)) {
    throw new Error("refusing to sign: the manifest has no valid fingerprint");
  }
  const configured = options.key ?? null;
  const key = configured ?? crypto.generateKeyPairSync("ed25519").privateKey;
  const publicKey = crypto.createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
  const signature = crypto.sign(null, bytes, key).toString("base64");
  return {
    algorithm: "ed25519",
    signedAt: options.signedAt ?? new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    manifestSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    publicKey,
    signature,
    keyOrigin: configured === null ? "generated" : "configured",
  };
}

export function writeSignature(snapshotDir: string, record: SignatureRecord): string {
  const target = path.join(snapshotDir, SIGNATURE_FILE);
  fs.writeFileSync(target, JSON.stringify(record, null, 2) + "\n", "utf8");
  return target;
}

export type VerifyOutcome =
  | { ok: true; record: SignatureRecord }
  | { ok: false; reason: string };

/**
 * Verifies `signature.json` against the manifest it names.
 *
 * Three failures are distinguished because they mean different things: no signature, a signature
 * that no longer matches the manifest (tampering), and a signature record that is malformed.
 */
export function verifySnapshotSignature(snapshotDir: string): VerifyOutcome {
  const signaturePath = path.join(snapshotDir, SIGNATURE_FILE);
  const manifestPath = path.join(snapshotDir, "manifest.json");
  if (!fs.existsSync(signaturePath)) return { ok: false, reason: "no signature.json in this snapshot" };
  let record: SignatureRecord;
  try {
    record = JSON.parse(fs.readFileSync(signaturePath, "utf8")) as SignatureRecord;
  } catch (error) {
    return { ok: false, reason: "signature.json is not JSON: " + (error as Error).message };
  }
  if (record.algorithm !== "ed25519" || typeof record.signature !== "string" || typeof record.publicKey !== "string") {
    return { ok: false, reason: "signature.json is not an ed25519 record" };
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(manifestPath);
  } catch {
    return { ok: false, reason: "the signed manifest is missing" };
  }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== record.manifestSha256) {
    return { ok: false, reason: "manifest.json changed after it was signed" };
  }
  // The fingerprint is not covered by the Ed25519 signature over the manifest bytes, but it is
  // inside those bytes. A record naming a different fingerprint is therefore a metadata mismatch,
  // not a valid signature with an altered label.
  let signedFingerprint: unknown;
  try {
    signedFingerprint = (JSON.parse(bytes.toString("utf8")) as { fingerprint?: unknown }).fingerprint;
  } catch {
    return { ok: false, reason: "the signed manifest is not JSON" };
  }
  if (typeof record.fingerprint !== "string" || record.fingerprint !== signedFingerprint) {
    return { ok: false, reason: "signature.json names a different fingerprint than the manifest" };
  }
  let verified = false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(record.publicKey, "base64"), format: "der", type: "spki" });
    verified = crypto.verify(null, bytes, key, Buffer.from(record.signature, "base64"));
  } catch (error) {
    return { ok: false, reason: "the signature could not be checked: " + (error as Error).message };
  }
  return verified ? { ok: true, record } : { ok: false, reason: "the signature does not match the manifest" };
}
