# Signed snapshots

```bash
codebase-snapshot generate --sign
SNAPSHOT_SIGNING_KEY="$(cat team-key.pem)" codebase-snapshot generate --sign
```

A digest proves the bytes did not change in transit only if the digest itself is trusted. A
signature over the manifest proves two more things: who produced the snapshot, and that the
manifest you are reading is the one that was signed.

## What is signed

The exact bytes of `manifest.json`. The manifest records a digest for every part and every
artifact, so one signature transitively covers the whole snapshot — provided the verifier checks it
against the manifest they are actually reading.

```json
{
  "algorithm": "ed25519",
  "signedAt": "2026-11-18T04:44:12.812Z",
  "fingerprint": "9f2c…",
  "manifestSha256": "…",
  "publicKey": "MCowBQYDK2VwAyEA…",
  "signature": "…",
  "keyOrigin": "configured"
}
```

## The key

| Where | Behaviour |
| :--- | :--- |
| `SNAPSHOT_SIGNING_KEY` (PEM) | `keyOrigin: "configured"`. Publish the public half; every snapshot from the team verifies against it. |
| No key | A fresh Ed25519 key is generated, `keyOrigin: "generated"`, and its public half goes in the record. That is trust on first use, and the field says so — it proves the manifest was not changed after signing, not who signed it. |

The private key never reaches the manifest, the brief or any report. The record carries only the
public half.

## Verifying

Both `snapshot validate` and `snapshot health` verify the signature when `signature.json`
exists. `validate` reports it as an error (`signature: manifest.json changed after it was signed.`)
and exits 1; `health` reports it as a critical check with the same reason:

- **critical failure** when the manifest changed after signing, the record is malformed, or the
  signature does not match;
- **skip** (not a failure) when there is no signature, because most snapshots are not signed and
  absence is not tampering.

```text
✅ The manifest signature verifies
   signed 2026-11-18T04:44:12.812Z (key: configured, 9f2c5a1b7d3e)
```

## What it does not do

- It does not sign the parts individually; the manifest's digests do that, and signing every part
  would only make the record larger.
- It does not manage keys. Generation, rotation and distribution are the caller's problem, and the
  tool says so rather than pretending a key store exists.
- It does not verify the signer's identity. A signature proves possession of a key; which key is
  trusted is a decision the reader makes.
