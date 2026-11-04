# Snapshot output

A run writes one directory (default `./snapshot`) that is meant to be handed to a model as
context. It is self-describing: `manifest.json` indexes everything the parts contain and
explains everything they omit.

## Layout

```
snapshot/
├── .codebase-snapshot          ownership marker (see Safety)
├── README.md                   human summary of this snapshot
├── manifest.json               machine index: files, parts, config, hashes, skips
├── parts/
│   ├── part-001.md             the code, grouped and size-budgeted
│   ├── part-002.md
│   └── …
└── reports/
    ├── project-tree.md         directory tree of included files
    ├── navigation.md           links between layers, kinds and parts
    └── audit.md                secrets, large files, parse diagnostics, git state
```

With `--include-monolith` you also get `full-codebase.json` and `full-codebase.md` — the
whole repository in one file. They are off by default because they grow without bound;
`--max-monolith-bytes` skips them when they would exceed a size you set.

`full-codebase.json` embeds its own `files[]` array, and its `includedBytes` / `includedLines`
describe the monolith's raw content — the file as it was read — so they differ from the same
fields in `manifest.json` for the same file. `manifest.json` reports what the part emitted
(CRLF normalised, the trailing newline not counted); the monolith reports the content it
embedded. Compare a file's fields within one artifact, not across the two.

Every artifact can be turned off. `--skip-artifacts parts` omits the parts,
`--only-artifacts manifest` writes nothing but the manifest, and `config.artifacts` does the
same persistently. The ownership marker is always written.

## Parts

Each `part-NNN.md` holds whole files under the byte budget (`maxPartBytes`, default 300 KB).
A file larger than the budget is not split mid-file: it is emitted as a head/tail preview and
marked as truncated. Each file section is tagged with its layer, kind, language and a
structural summary (imports, exports, classes, functions) so a reader can navigate without
opening every file.

Parts are packed in a stable order, so the same input produces the same content — which is
what makes `manifest.fingerprint` meaningful.

Two runs over unchanged input are **not** byte-identical everywhere, and the difference is
deliberate bookkeeping rather than content. `manifest.json`, the snapshot's `README.md`,
`reports/audit.md` and `.codebase-snapshot` differ on every run — they carry a timestamp, and the
marker also carries a fresh run id and pid. `parts/*.md`, `reports/navigation.md` and
`reports/project-tree.md` are **byte-identical** across runs, and `manifest.fingerprint` is stable.
So: diff the parts, the navigation index or the tree to see whether the *content* changed, and
diff the manifest only when you need to know that a run happened.

## Manifest

`manifest.json` is the index and the contract between runs. Top-level keys:

| Key | Contents |
| :--- | :--- |
| `schemaVersion` | Manifest format version (`3.0.0`). |
| `generatedAt` | ISO timestamp of the run. |
| `generator` | `{ name, version }` of the tool that wrote it. |
| `git` | `{ branch, commit, isDirty }`. `branch` falls back to the configured branch on a detached HEAD and outside a repository; `commit` is `"unknown"` and `isDirty` is `false` when git cannot report. A `false` there means "not known to be dirty", not "clean tree" — check `commit` to tell the two apart. |
| `budgets` | The effective byte limits for the run: `{ maxPartBytes, largeFileBytes }`. The per-layer overrides live at `config.budgets`, which is `{ default, byLayer }`. |
| `config` | The resolved configuration actually used (preset, artifacts, sizing, scoping). |
| `counts` | `{ totalFiles, totalSizeBytes, totalLines, partsCount, skippedCount, largeFileCount, truncatedPreviewCount }`. |
| `totals` | Bookkeeping: `{ candidateFiles, includedFiles, fullFiles, previewFiles, skippedFiles, totalSourceBytes, totalContentBytes, partCount, warningCount, redactedLines }`. `redactedLines` counts the lines whose values were masked — one per line, not one per matching rule — and is what the summary's `Redacted:` line prints. |
| `fingerprint` | Stable hash of the snapshot content. Two runs over unchanged input produce the same value. |
| `validation` | `{ status: "passed" \| "failed", errors: [] }` for the run's own integrity check. |
| `artifacts` | The optional monolith files: `{ fullJson, fullMarkdown }`. Each value is `null` when that file was not written, otherwise `{ byteSize, sha256 }`. The object itself is always present. |
| `layers`, `kinds` | File counts per layer and per kind. |
| `indexes` | Cross-references: `routes`, `components`, `handlers`, `features`, `imports`, `directives`. |
| `parts` | One entry per part (below). |
| `files` | One entry per included file (below). |
| `skipped` | One entry per excluded file (below). |
| `warnings` | Non-fatal observations that may change how you read the snapshot — a disabled artifact, a file too large to parse, a transcoded file, a throwing `hooks.afterGenerate`. Masked values are **not** warnings: they are counted in `totals.redactedLines` and listed per line in `reports/audit.md`. |

### `parts[]`

```json
{
  "index": 1,
  "filename": "part-001.md",
  "byteSize": 1432,
  "sha256": "3472b9edcd504403f2416606e4222f326ec207d7916bf928ade4ec7de1406d2d",
  "lines": 91,
  "fileCount": 2,
  "layersCovered": ["root", "src"],
  "includedFiles": [
    { "relativePath": "package.json", "sourceBytes": 35, "includedBytes": 35, "lines": 1, "layer": "root", "kind": "data" },
    { "relativePath": "src/math.ts", "sourceBytes": 63, "includedBytes": 63, "lines": 3, "layer": "src", "kind": "other" }
  ]
}
```

`byteSize` and `sha256` are what `validate` checks against the file on disk. Both are full
values — the hash is the whole 64-character digest, never elided.

### `files[]`

```json
{
  "relativePath": "src/math.ts",
  "sizeBytes": 63,
  "lines": 3,
  "hashSha256": "aa229260647049a42a0446f48f1b34f19657921b7a0a27a41c0b2a294a25c919",
  "part": "part-001.md",
  "layer": "src",
  "kind": "other",
  "language": "typescript",
  "inclusionMode": "full",
  "isLarge": false,
  "isPreviewTruncated": false,
  "originalLines": 3,
  "includedLines": 3,
  "includedBytes": 63,
  "summary": {
    "directives": [], "imports": [], "exports": ["add"], "reExports": [],
    "functions": ["add"], "classes": [], "interfaces": [], "types": [],
    "enums": [], "variables": [], "reactComponents": [], "hooks": [],
    "routeHandlers": []
  },
  "summaryQuality": "ast"
}
```

- `isLarge` is a fact about the file: it is bigger than `largeFileBytes` (default 200 KB).
  A large file is emitted as a head/tail excerpt rather than inlined whole.
- `isPreviewTruncated` is a fact about what was written: the body in this snapshot is **not**
  the whole file, because lines were dropped.
- `inclusionMode` is `preview` exactly when `isPreviewTruncated` is `true`, and there are two
  routes to it:
  - **Over `largeFileBytes`** — the head/tail excerpt drops the middle, so
    `isLarge: true`, `isPreviewTruncated: true`. If the head and tail happen to cover every
    line, nothing is dropped and the entry stays `isLarge: true`, `inclusionMode: "full"`.
  - **Under `largeFileBytes` but too big for its part** — the partitioner byte-truncates the
    section to keep the part inside its budget, so `isLarge: false`,
    `isPreviewTruncated: true`. This is the one that surprises people: the file is not "large"
    by the configured threshold, yet its body is incomplete.
- Only `isPreviewTruncated` tells you content is missing; `isLarge` alone does not.
- `hashSha256` is the hash of the source file on disk — `validate` recomputes it to detect
  drift. It is the full 64-character digest.
- `encoding` is present **only** when the file is not plain UTF-8; its absence means clean UTF-8.
  `utf-16le` and `utf-16be` mean the file was transcoded to UTF-8 before it was emitted, so a
  UTF-16 source file is readable in the parts instead of vanishing as "binary". `utf-8-lossy`
  means the file is not valid UTF-8 at all: its undecodable byte spans became `U+FFFD`, the count
  is reported in `warnings`, and the file is kept rather than dropped. The hash still covers the
  raw bytes, so a lossy file validates as current — `encoding` is how you learn that the body you
  are reading is not byte-exact.
- `summary` and `summaryQuality` are **conditional**. Both keys are present for a language
  with an analyser and both are absent for a shapeless one — a `.gitignore`, a `.txt`. Treat a
  missing `summary` as "no structural information", not as an empty one. A file larger than
  2 MB gets no summary at all: parsing it costs more memory than the file itself, and its body is
  a head/tail preview at that size anyway. `manifest.warnings` names those files.
- `summary` has one of three shapes. Code files get the thirteen keys above (`directives`,
  `imports`, `exports`, `reExports`, `functions`, `classes`, `interfaces`, `types`, `enums`,
  `variables`, `reactComponents`, `hooks`, `routeHandlers`), plus `parseErrors` when the parser
  reported syntax errors. JSON gets `{ shape, itemCount, keys, sampleKeys }` and Markdown gets
  `{ headings, frontmatterKeys }` — a shape description rather than a code summary.
- `summaryOmitted: true` means the file's summary was dropped because the summary alone would
  not fit the part budget. The entry then has `summaryQuality` but no `summary`, and the
  file's body is still emitted in full. It is only ever present when `true`.
- `summaryQuality` is `ast` (parsed by the TypeScript compiler), `structural` (JSON or
  Markdown shape) or `heuristic` (pattern-matched). It tells you how much to trust the
  summary: `heuristic` means a line scan, not a parse.
- The summary block is written **as-is** into the part, so a control or bidi character that
  appears in a source file can appear inside the fenced JSON too — the same reason the file
  body is emitted raw. Names are escaped where a path is *displayed* (part headers, the tree,
  navigation, audit, `explain`), but the two raw regions — the summary fence and the body —
  reproduce the repository's bytes. Treat the whole part as untrusted data, not just the body.

Querying this array is usually faster and cheaper than re-reading the parts.

### `skipped[]`

```json
{ "path": ".env", "reason": "sensitive-file", "detail": "credential-bearing file; enable includeSensitiveFiles to emit it" }
```

Reasons, and what each one means:

| `reason` | The file was dropped because |
| :--- | :--- |
| `excluded` | It matched your own `excludePatterns`, or fell outside a non-empty `include` allow-list. |
| `default-ignore` | A built-in rule caught it, the preset's ecosystem ignores did (`node_modules`, `__pycache__`, `target`, …), or it sat inside an output directory. |
| `sensitive-file` | Its name is credential-bearing (`.env`, `*.pem`, `.npmrc`, …). |
| `sensitive-path` | The path itself matched a secret rule. The file is skipped and the path is masked in every artifact. |
| `binary` | It is not text: it holds a NUL byte outside a UTF-16 stream, or more than 1% control characters (a 4 KB blob of `0x07` is valid UTF-8 but is not text). `detail` carries the size and, when there is one to give, the reason: the control-byte count (`Size: 13 B; 5 control byte(s)`), or the offset of a NUL found past the 8 MB head scan (`Size: 9000010 B; NUL byte at offset 9000000`). A NUL inside the head scan is caught by the cheap extension-and-prefix check, so its `detail` is the size alone. |
| `symlink` | It is a link, and links are not followed. A directory link names its target in `detail`. |
| `outside-root` | It is a link whose target resolves outside the scanned root. |
| `gitignore` | A `.gitignore` excluded it, in a scan that is not reading git's index. |
| `read-error` | It could not be read. |
| `not-file` | It is a directory, socket or FIFO. A directory that belongs to another repository is reported as `nested-repository` instead. |
| `nested-repository` | It is a nested checkout or a submodule: a directory whose contents are tracked by a different repository, so they are not part of this codebase. |

Every path the scanner discovers is recorded — nothing is dropped silently, in either discovery
mode. Inside a git repository the candidate list comes from git, which applies `.gitignore`
before the scanner runs; the ignored paths are then listed separately and recorded here too, so
a `.gitignore`d file or directory appears in `skipped[]` with reason `gitignore` whether or not
git is present.

`explain` reports two further reasons that never appear here, because they describe a path
rather than a decision about a candidate file: `missing` (nothing exists at that path) and
`not-discovered` (the path exists but was never a candidate — inside `node_modules`, for
example). See [Troubleshooting](troubleshooting.md#a-file-is-missing-from-the-snapshot).

**Ignored trees are recorded at two granularities**, which is why `explain` can answer
`not-discovered` for a directory you can see in `skipped[]`. A *built-in* ignore
(`node_modules`, `dist`, `.next`, …) is recorded once, as the directory itself, and its contents
are never enumerated — `explain node_modules/pkg/i.js` inherits that record and says
`default-ignore`. A *preset ecosystem* ignore (`__pycache__`, `target`, `vendor`, …) is recorded
per file, so `explain app/__pycache__` — the directory — finds no record of its own and answers
`not-discovered`, while `explain app/__pycache__/mod.pyc` says `default-ignore`. Neither is an
omission: the directory and its files are all accounted for, just not at the same level.

## Safety

- **Sensitive files are excluded by default.** `.env`, `*.pem`, `*.key`, `.npmrc`, `.netrc`,
  `.git-credentials`, `id_rsa`, `.kube/config`, `*.tfstate` and similar are skipped and
  listed in `skipped[]`. `--include-sensitive-files` opts in.
- **Secret-shaped strings are redacted** inside ordinary source files. Only the matched span
  is masked, never the whole line, and no excerpt of a matched line is written to any
  artifact.
- **The output directory is owned by the tool.** Each run writes `.codebase-snapshot` into it
  first, then swaps the new snapshot in atomically. A previous snapshot survives until the
  replacement is complete.
- **The tool refuses to replace a directory it did not write.** Pointing `--out-dir` at
  `src/` is refused with exit `1` and the directory is left untouched — a mistyped output
  path cannot delete source code. Empty directories, directories that hold nothing but
  `.DS_Store`, and directories holding a complete snapshot this build wrote are accepted.
  A `.gitkeep` or `.gitignore` inside the directory is not accepted, because the generator never
  writes either into an output directory: a directory that holds one is somebody's data, so the
  run refuses instead of deleting it.
- **Ownership is the marker, not a filename.** `.codebase-snapshot` is a JSON record carrying
  this generator's name and `version`, the marker's `schemaVersion`, a `createdAt` timestamp,
  a `pid`, a per-snapshot `id`, the run `state` (`staging` while it is being written, `complete`
  once it is whole), the `manifestSha256` digest of the manifest it shipped, and `entries` — the
  inventory of everything it wrote. `pid` is what lets a later run tell a crashed run's staging
  directory and lock from a live one. A zero-byte marker, a marker that is not JSON, a marker
  written by 3.0.0 (no `id`), a bare `manifest.json`, and a directory with files you added
  after the run are all refused.
  See [Troubleshooting](troubleshooting.md#refusing-to-replace-outdir-).

The marker also makes hook-written artifacts safe: the entries a `hooks.afterGenerate` adds to
the output are recorded in the marker, so they do not make the next run refuse the directory.

## Committing the snapshot

Usually you do not. Add the output directory to `.gitignore` — `codebase-snapshot init` does
it for you. If you do commit snapshots (for example, to diff context across releases),
`manifest.json` is the file that matters: it is compact and `diff` can compare two of them.
