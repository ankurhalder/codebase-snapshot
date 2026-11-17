# Delta packs

```bash
codebase-snapshot generate --delta ./snapshot --out-dir ./snapshot-delta
```

A delta pack is the snapshot you would want for "what changed?" — the files that changed since a
base snapshot, plus the files that import them, and nothing else. The rest are accounted for rather
than dropped.

## What it does

1. Reads the base `manifest.json` (a directory or the file itself).
2. Hashes the current tree as usual and compares **content hashes**, not mtimes.
3. Keeps: added files, changed files, and the **one-hop importers** of those files.
4. Drops: unchanged files. Each goes into `skipped[]` with reason `unchanged` and into
   `delta.unchanged`, so the accounting rule still holds — nothing disappears without a record.
5. Records the comparison in the manifest:

```json
"delta": {
  "base": { "path": "/repo/snapshot/manifest.json", "fingerprint": "…", "generatedAt": "…" },
  "added": ["src/new.ts"],
  "changed": ["src/user.ts"],
  "removed": ["src/gone.ts"],
  "unchanged": ["package.json", "src/unrelated.ts"]
}
```

The brief (`PROMPT.md`) states the delta at the top, with the counts and the note that unchanged
files are not in the parts — so a model reading it cannot describe them from memory.

## Why it matters

A full snapshot of a large repository is mostly text the reader already has. A delta is small
enough to send on every turn, and it carries the two things a change review actually needs: the
new bytes and the callers that might break.

## Limits, stated

| Limit | Value | Why |
| :--- | :--- | :--- |
| Base format | a manifest from this tool | The shape is checked; a foreign JSON is refused with the reason. |
| Importer closure | one hop | The same rule as `--with-dependents`; deeper closure is a graph query, not a pack. |
| Removed files | listed, not shown | The bytes are gone; the manifest can only say which paths disappeared. |
| Unchanged files | listed in `delta.unchanged` and `skipped[]` | Dropping them silently would break the accounting contract. |

A delta against a base from a different repository is not an error: nothing matches, so every file
is "added". The base fingerprint is recorded, and comparing it with the current one is the reader's
job.
