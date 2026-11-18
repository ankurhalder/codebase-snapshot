# Health: an audit of the snapshot itself

`validate` answers one question: has the code moved since this snapshot was generated? That is
necessary and not sufficient. Before a snapshot is pasted into a model you want to know whether it
is internally honest, and `snapshot health` answers that:

```bash
npx codebase-snapshot health                # the snapshot in ./snapshot
npx codebase-snapshot health --strict       # exit 2 when a critical check fails
npx codebase-snapshot health --format json  # the report, for a dashboard
npx codebase-snapshot health --deep         # also replay every full body from the source
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
| The manifest signature verifies | `signature` | critical | When `signature.json` exists: the manifest bytes match `manifestSha256` and the Ed25519 signature checks out. |
| The counts equal the data | `bookkeeping` | critical | `totalFiles`, `partsCount`, `skippedCount`, `totalContentBytes` and the per-layer counts are recomputed from the arrays. |
| Every summary claim appears in the body | `summary.truth` | critical | Every export, function, class, import, route, JSON key and markdown heading a summary names is present in the part that holds the file. |
| The reports quote this run | `report.truth` | critical | The counts, sizes, part table, coverage line, redaction count and fingerprint in `README.md` and `PROMPT.md` equal the manifest. |
| Every index entry names a file | `indexes.consistent` | critical | Routes, components, handlers, import edges, central files and directives all point at a path in `files[]`, in the part the manifest records. |
| Every file body matches the accounting | `pipeline.bodies` | critical | Each part section's bytes and lines equal the file's `includedBytes` and `includedLines`. |
| Every section sits where the manifest says | `markdown.structure` | critical | Section order, headings, inclusion mode, line count and part header numbers match `manifest.parts[]`. |
| Every pack holds exactly the manifest's files | `pipeline.monolith` | critical | When `full-codebase.json`, `.xml` or `.md` is recorded, its file set is compared both ways. |
| Every pack body is the part body | `packs.bodies` | critical | For full files, the bytes in the pack equal the bytes in the part; previews and signatures are whole-file by design. |
| Every full body replays from the source | `fidelity.bodies` | critical | With `--deep`: each full body is rebuilt from the bytes on disk (redaction allowed) and compared. Skipped without `--deep`. |
| A member matches its workspace index | `workspace.index` | warning | Fingerprint and file count equal `WORKSPACE.json`, and a member whose source directory is gone warns. |
| No unmasked secret in any artifact | `secrets.artifacts` | critical | Every written text file is re-scanned with the secret rules; a signature record is scanned without its random key material. |
| No value from an excluded sensitive file appears | `secrets.skipped` | critical | Values from `.env`, keys and similar files are compared byte-for-byte against the artifacts. |
| No host path or machine identity | `pii.paths` | warning | `/home/…`, `/Users/…`, `C:\Users\…` and the repository's absolute path are searched for. |
| Token estimate is plausible | `tokens.count` | warning | The recorded estimate is compared with one recomputed from the parts. |
| The parts fit a context window | `tokens.fit` | warning | How many parts fit 32k, 128k and 200k tokens; the largest part and the largest single file are named. |
| Every part honours the published budget | `tokens.budget` | warning | A part larger than the ceiling the manifest advertises is reported. |
| Every excluded path has a reason | `skips` | critical | `skipped[]` is complete and the totals agree. |
| The snapshot still describes the repository | `freshness` | warning | HEAD is compared with the recorded commit. |

## Reading the result

```text
🩺 Snapshot health: 100/100
   21 passed, 0 warning(s), 0 failed, 1 skipped
```

A **failed** check (critical) means the snapshot is not safe to hand to a model as it stands; the
command exits 1, or 2 with `--strict`. A **warning** is a judgement call: a host path is not a
secret, but you may not want it in the payload either.

The score starts at 100; each failure costs 25 and each warning 5, with a floor of zero. It is a
summary, not a substitute for the checks — the report always lists every one.

### Every summary claim against the body

A summary is generated from a separate parse. That is what makes it useful and what makes it able
to lie: an export can be renamed by a parser change, a stale manifest can keep a symbol the file no
longer has, and a masked name can disappear from the body. `summary.truth` checks every claim the
manifest records — imports, exports, functions, classes, interfaces, types, enums, variables,
components, hooks, route paths, JSON keys and markdown headings — against the part that carries the
file. Redacted claims are skipped, and a failing claim is named by path and field, never by value.

### The reports quote this run

`README.md` and `PROMPT.md` restate the manifest in prose. A report copied from an earlier run, or
generated before the manifest was updated, describes a different snapshot while its digest still
proves the bytes are unchanged. `report.truth` parses the figures the current writer emits — file,
line, part and skip counts, the part table, the coverage sentence, the partial-file count, the
redaction count, the layer tally, the fingerprint, branch, commit and validation state — and
compares each with the manifest. A shape it does not recognise is not a failure; it is not counted.

### Every section where the manifest says

A part hash proves the bytes are the recorded bytes, not that the file body is under the right
heading. `markdown.structure` checks each part's own header (part number, file count, fingerprint,
token estimate), the number of sections against `part.fileCount`, the order of anchors against
`part.includedFiles`, every heading against the file's display path, and every `- Meta:` inclusion
and line count against the manifest entry. A duplicated, extra or misplaced section fails the audit.

### Every pack body against its part

The JSON, XML and markdown packs are a second copy of the same payload. Membership is checked by
`pipeline.monolith`; `packs.bodies` compares the bytes. For `full` and `comments-stripped` files the
pack body is normalised the way the part was and compared exactly. A preview's or skeleton's pack
deliberately carries the redacted whole file, so those bodies are counted as by-design rather than
compared.

### Every index entry names a file

`manifest.indexes` is what the MCP tools answer from: routes, components, handlers, import edges,
central files and directives. An entry that names a path outside `files[]`, records a different
`part`, or lists the same import file twice is a promise the reader cannot keep.
`indexes.consistent` checks every entry against the file map, including the part the file ended up
in.

### The parts against a context window

`tokens.fit` reports the largest part, the largest single file and how many parts fit a 32k, 128k
or 200k window. A part within the byte budget can still be unusable in a smaller window; this is
the number that says so, and it warns rather than fails because the destination is the user's
choice.

### The deep replay

The cheap checks compare the snapshot with its own manifest. They cannot see a generator that read
the source incorrectly and then recorded the wrong bytes consistently. `--deep` closes that gap:
for every `full` file whose bytes still match the recorded `hashSha256`, it decodes the file again,
applies the emitted-body normalisation, and compares the result with the part. The only difference
allowed is a redaction marker replacing a span; a line that differs any other way is reported by
path and line number.

A file that has changed on disk since generation is not replayed — that is `validate`'s question,
and blaming the generator for a later edit would be the wrong finding. The check is off by default
because it re-reads the whole repository; on a large monorepo it costs one full read.

### A member whose source is gone

`health --all-members` audits the written member snapshots. If a member's source directory has
been deleted since the workspace was generated, the snapshot is still intact but no longer
describes that workspace: the audit warns, names the missing path and says to regenerate.
Before this it scored 100/100 for a member nobody could refresh.

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
  is not evidence. `--deep` reads the repository; it still writes nothing.
- It never prints a secret it found. Findings name the artifact and the line count, never the value.
- It does not need the network. Everything it compares is on disk.

## In the MCP server

`snapshot_health` returns the same report as structured output, so an agent can call it before
trusting a snapshot it was handed. Pass `deep: true` for the source replay:

```json
{ "score": 100, "counts": { "pass": 21, "warn": 0, "fail": 0, "skip": 1 }, "checks": [ … ] }
```

The cheap subset — manifest, parts, artifacts, skips — also runs inside `validate`, so a normal
drift check catches structural dishonesty without paying for the leak scan on every CI run.
