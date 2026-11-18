# Health: an audit of the snapshot itself

`validate` answers one question: has the code moved since this snapshot was generated? That is
necessary and not sufficient. Before a snapshot is pasted into a model you want to know four more
things, and `snapshot health` answers them:

```bash
npx codebase-snapshot health                # the snapshot in ./snapshot
npx codebase-snapshot health --strict       # exit 2 when a critical check fails
npx codebase-snapshot health --format json  # the report, for a dashboard
```

## What it checks

| Check | Id | Severity | What it proves |
| :--- | :--- | :--- | :--- |
| Manifest present and well-formed | `manifest` | critical | The file parses and has the snapshot shape. |
| Every part on disk | `parts.present` | critical | Every part the manifest names exists. |
| Every part matches its size and hash | `parts.hashes` | critical | The bytes on disk are the bytes recorded. |
| Every file in exactly one part | `parts.accounting` | critical | No file was silently dropped from the layout. |
| Every recorded artifact present and unchanged | `artifacts` | critical | `README.md`, `PROMPT.md`, reports and monoliths still match their digests. |
| Nothing unexpected in the directory | `artifacts.extra` | warning | No stale file from an earlier run is sitting in the payload. |
| No unmasked secret in any artifact | `secrets.artifacts` | critical | Every written text file is re-scanned with the secret rules; a signature record is scanned without its random key material. |
| No value from an excluded sensitive file appears | `secrets.skipped` | critical | Values from `.env`, keys and similar files are compared byte-for-byte against the artifacts. |
| No host path or machine identity | `pii.paths` | warning | `/home/…`, `/Users/…`, `C:\Users\…` and the repository's absolute path are searched for. |
| The manifest signature verifies | `signature` | critical | When `signature.json` exists: the manifest bytes match `manifestSha256` and the Ed25519 signature checks out. |
| The counts equal the data | `bookkeeping` | critical | `totalFiles`, `partsCount`, `skippedCount`, `totalContentBytes` and the per-layer counts are recomputed from the arrays. |
| Every file body matches the accounting | `pipeline.bodies` | critical | Each part section's bytes and lines equal the file's `includedBytes` and `includedLines`. |
| Every pack holds exactly the manifest's files | `pipeline.monolith` | critical | When `full-codebase.json`, `.xml` or `.md` is recorded, its file set is compared both ways. |
| A member matches its workspace index | `workspace.index` | warning | Fingerprint and file count equal `WORKSPACE.json`, and a member whose source directory is gone warns. |
| Token estimate is plausible | `tokens.count` | warning | The recorded estimate is compared with one recomputed from the parts. |
| Every part honours the published budget | `tokens.budget` | warning | A part larger than the ceiling the manifest advertises is reported. |
| Every excluded path has a reason | `skips` | critical | `skipped[]` is complete and the totals agree. |
| The snapshot still describes the repository | `freshness` | warning | HEAD is compared with the recorded commit. |

## Reading the result

```text
🩺 Snapshot health: 100/100
   15 passed, 0 warning(s), 0 failed, 1 skipped
```

A **failed** check (critical) means the snapshot is not safe to hand to a model as it stands; the
command exits 1, or 2 with `--strict`. A **warning** is a judgement call: a host path is not a
secret, but you may not want it in the payload either.

The score starts at 100; each failure costs 25 and each warning 5, with a floor of zero. It is a
summary, not a substitute for the checks — the report always lists every one.

### A member whose source is gone

`health --all-members` audits the written member snapshots. If a member's source directory has
been deleted since the workspace was generated, the snapshot is still intact but no longer
describes that workspace: the audit warns, names the missing path and says to regenerate.
Before this it scored 100/100 for a member nobody could refresh.

### The JSON pack against the manifest

When the run wrote `full-codebase.json`, the audit parses it and compares its file set with
`manifest.files` in both directions. The artifact digest proves the pack is the file the manifest
recorded; it does not prove the manifest recorded a pack holding every file. An entry removed and
the digest updated would otherwise be invisible.

### The counts against the data

A manifest edited to claim more files, parts, skips or content bytes than it holds used to pass
every check: each part hashed correctly, the artifacts were present, and the numbers a summary
quotes were never compared with the arrays they summarise. The audit now recomputes
`counts.totalFiles`, `counts.partsCount`, `counts.skippedCount`, `totals.totalContentBytes` and the
per-layer counts from the manifest's own arrays; any disagreement is a critical failure naming the
field and both numbers.

### Every body against the accounting

The manifest says how many bytes and lines each file contributed. The audit now checks that
claim against the part: each section is parsed out (by anchor, not by heading) and its body must
match `includedBytes` and `includedLines` exactly. A truncated body, a missing section or a
hand-edited part that still hashes correctly fails the audit, because the manifest would be
describing a file the reader does not receive.

### A member of a workspace

When a snapshot sits beside a `WORKSPACE.json`, the audit compares that member's record with the
snapshot: fingerprint and file count must agree. A workspace index that describes a different
snapshot than the one beside it is a warning, not a failure — the member itself is intact — and
`--strict` makes it exit 1.

## A workspace, all at once

`health --all-members` reads `WORKSPACE.json` and audits every snapshot a `--workspace` run wrote,
printing one row per member. The combined score is the **weakest member**, because a workspace is
only as trustworthy as its worst part; a missing member snapshot is an error row, not a skip.

```bash
codebase-snapshot health --all-members --cwd /repo
```

`--format json` returns the members with their counts and failed check ids.

## What it never does

- It does not regenerate, repair or delete anything. The report is evidence; evidence that mutates
  is not evidence.
- It never prints a secret it found. Findings name the artifact and the line count, never the value.
- It does not need the network. Everything it compares is on disk.

## In the MCP server

`snapshot_health` returns the same report as structured output, so an agent can call it before
trusting a snapshot it was handed:

```json
{ "score": 100, "counts": { "pass": 15, "warn": 0, "fail": 0, "skip": 1 }, "checks": [ … ] }
```

The cheap subset — manifest, parts, artifacts, skips — also runs inside `validate`, so a normal
drift check catches structural dishonesty without paying for the leak scan on every CI run.
