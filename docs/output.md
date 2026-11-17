# Snapshot output

A run writes one directory (default `./snapshot`) that is meant to be handed to a model as
context. It is self-describing: `manifest.json` indexes everything the parts contain and
explains everything they omit.

## Layout

```
snapshot/
├── .codebase-snapshot          ownership marker (see Safety)
├── README.md                   human summary of this snapshot
├── PROMPT.md                   the instruction sheet to paste with it
├── manifest.json               machine index: files, parts, config, hashes, skips
├── parts/
│   ├── part-001.md             the code, grouped and size-budgeted
│   ├── part-002.md
│   └── …
└── reports/
    ├── project-tree.md         directory tree of included files
    ├── navigation.md           links between layers, kinds and parts
    ├── audit.md                secrets, large files, parse diagnostics, git state
    ├── diff.md                 uncommitted changes (--include-diffs)
    ├── log.md                  recent commits (--include-logs <n>)
    └── tokens.md               per-file token estimates (--token-tree)
```

With `--include-monolith` you also get `full-codebase.json` and `full-codebase.md` — the
whole repository in one file. `--pack xml` writes `full-codebase.xml` instead, one `<file>` element
per source with the body in CDATA; `--pack single` and `--pack json` write just the other one. They are off by default because they grow without bound;
`--max-monolith-bytes` skips them when they would exceed a size you set.

`full-codebase.json` embeds its own `files[]` array, and its `includedBytes` / `includedLines`
describe the monolith's raw content — the file as it was read — so they differ from the same
fields in `manifest.json` for the same file. `manifest.json` reports what the part emitted
(CRLF normalised, the trailing newline not counted); the monolith reports the content it
embedded. Compare a file's fields within one artifact, not across the two.

"CRLF normalised" covers all three line endings a file can have. A CR-only file — an old Mac file,
or anything written by a tool that predates LF on that platform — is written to a part with LF too,
and its `lines` count is the real one: the preview budget and the line counts used to split on `\n`
alone, so such a file was one line, `largeFileBytes` never applied, and the whole file went into a
part with its carriage returns intact.

The manifest embedded in `full-codebase.json` is otherwise identical to `manifest.json` with one
impossible field: a file cannot record its own sha256, so `artifacts.fullJson` is `null` in the
embedded copy and a `selfReference` sentence points at `manifest.json`, which carries the real
`byteSize` and `sha256` for that file.

## PROMPT.md

The one artifact written for the model rather than for you, and the only one that is a *brief*
rather than an index. Paste it with the payload. It has three parts:

**The brief** — what to do and how to be believed, in the order it is rendered:

- **The job**: `audit` finds what is still wrong or will break; `review` says what a change breaks;
  `explain` says how a subsystem works. The method is the reader's, and an honest account of
  coverage is owed in return. A narrower task in the closing slot wins, and the standard still
  applies to it.
- **Stakes** — when the owner brief supplies them.
- **What you have**: the artifacts that were actually written, and what each one is for.
- **What this is**: the `package.json` description, the first README paragraph and the two most
  recent release headings, labelled as the project's own claims rather than evidence.
- **The system**, from the manifest: layers and their file counts, the modules with the most
  importers (so a reader knows what a change reaches), entry points by convention, the routes,
  handlers and components the index found — or a plain statement that none were recorded, so a
  model does not go looking for a surface that is not there — the largest files, and the share of
  bytes that is tests.
- **What came before**: the last ten commits — subject and body — labelled as claims rather than
  evidence, with the instruction to verify a recorded fix holds instead of rediscovering it. When
  git cannot be read the section says so; it is never invented.
- **The bar**: quoted lines, the state that reaches them, why the apparent guard does not stop it;
  no style findings, no invented findings, a clean surface proven by quoting the guard.
- **Coverage**: paths found, included and skipped with reasons, partial files with their missing
  line ranges, redactions, and "everything unseen is unread, never clean".
- **What a useful answer contains**: the shape of a report that can be checked, opened by the
  snapshot's fingerprint and closed by `Needed but not received:`.
- **Calibration**: the classes of defect that do not crash — a guard at one call site and not its
  twin, a budget shorter than the work it guards, a success flag that means the call returned.
- **Owner notes**: any heading in the brief the merge did not recognise, kept verbatim.

**The owner half** — when `brief` is configured (see [configuration](configuration.md#the-brief-what-only-you-can-write)),
the five judgement sections come from that file instead of the generic prose: what is at stake, the
system in the owner's words (with the measured facts still following under "What the index
records"), the history the owner has lived through, the bar this team applies, and the calibration
examples from its own incidents. Each is marked as written by the project owner.

**The apparatus** — this run only:

- the fingerprint to quote back, the timestamp, the commit, whether the tree was dirty, and the
  validation status with the warning that it describes the run and not the tree now;
- every part by name, and every file not present in full with its reason and missing ranges;
- the delivery arithmetic below.

Everything factual is rendered from the manifest and the repository, so the brief cannot describe
a different run. It only names artifacts that were actually written: `--skip-artifacts
parts,audit` produces a brief that does not tell a model to read parts, and says the per-file
redaction detail is unavailable rather than pointing at a file that is not there.

It also does the arithmetic of sending it. Hosted chats take a fixed number of files — 10 is the
common cap — and every part is one file, so a 12-part snapshot cannot be delivered whole. The
`## Attaching this` section states which files fit, what to leave behind, and the `--max-part-bytes`
value that would merge the parts into a number the destination accepts. The instructions themselves
are pasted as text, so they cost no attachment slot.

It only names artifacts that were actually written: `--skip-artifacts parts,audit` produces a
prompt that does not tell a model to read parts, and says the per-file redaction detail is
unavailable rather than pointing at a file that is not there. Its digest is recorded under
`artifacts.prompt`, so editing it by hand makes `validate` fail — a prompt that names a previous
run's parts is worse than no prompt, because it reads as current.

Every artifact can be turned off. `--skip-artifacts parts` omits the parts,
`--only-artifacts manifest` writes nothing but the manifest, and `config.artifacts` does the
same persistently. The ownership marker is always written.

## Parts

Each `part-NNN.md` holds whole files under the byte budget (`maxPartBytes`, default 300 KB).
A file is never split mid-file, and a complete file is never cut down just to make the part fit:
`largeFileBytes` defaults to the part budget and may not exceed it, so a file too big for a part
is also over the threshold, and the preview below applies.

A file above `largeFileBytes` is emitted as a head/tail excerpt with an omission marker naming
the ceiling that removed it. The excerpt is normally well under the budget; when it is not —
very long lines, or a small per-layer budget — it is cut again and the marker names the part
budget that did it: `--max-part-bytes 4096` writes `... [347 lines omitted: part budget 4096
B] ...`. The line count describes the whole file, not the cut.

Either way the manifest records the file in `incomplete[]` with the reason and the missing line
ranges, so a marker buried on line 1 300 of a part is not the only notification.

Each file section is an anchor, a `### FILE:` heading, and **one** metadata line:

```text
<a id="src-math-ts-1a2b3c4d"></a>
### FILE: src/math.ts

- Meta: src/other | typescript | full | 3 lines (63 B)
- Summary Quality: ast
```

The four fields are `layer/kind`, language, inclusion mode and size. The inclusion mode is `full`,
`preview` or `signatures`, and the line count reads `40 of 300 lines` when the body holds less than
the source. What a part deliberately does **not** print is the per-file SHA-256 and the structural
summary of a full file: the digest is in `manifest.json` where a machine reads it, and the summary
would repeat the code that follows it by three lines. On a 234-file repository that was about
32 000 tokens of pure duplication. A `preview` or a `signatures` file keeps its structural summary,
because there the body is not the file.

A file above `largeFileBytes` is a preview, and a preview section is a window like any other:
`snapshot_read` states `Lines 1–40 of 300` for it too, so a reader always knows where it is.

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
| `budgets` | The effective byte limits for the run: `{ maxPartBytes, largeFileBytes }`. The per-layer overrides live at `config.budgets`, which is `{ default, byLayer }`. With the experimental `maxParts`, `maxPartBytes` here is the budget the run grew to and `config.maxPartBytes` keeps the configured ceiling. |
| `config` | The resolved configuration actually used (preset, artifacts, sizing, scoping). |
| `counts` | `{ totalFiles, totalSizeBytes, totalLines, partsCount, skippedCount, largeFileCount, truncatedPreviewCount, incompleteCount }`. |
| `totals` | Bookkeeping: `{ candidateFiles, includedFiles, fullFiles, previewFiles, skippedFiles, totalSourceBytes, totalContentBytes, sourceLines, emittedLines, estimatedTokens, partCount, warningCount, redactedLines }`. `sourceLines` is the source line count before previews and part budgets; `emittedLines` is what the parts actually carry. `redactedLines` counts the lines whose values were masked — one per line, not one per matching rule — and is what the summary's `Redacted:` line prints. |
| `fingerprint` | Stable hash of the snapshot content **and** the settings that shaped it. Two runs over unchanged input and unchanged settings produce the same value; changing the budget, a preset, a layer rule or the secret rules moves it, because the parts move too. It is recomputed by `validate` from `files[]` and `config.digest`, so an edited file list cannot keep the recorded value — and because the partitioner may change a file's `inclusionMode` after the fingerprint is taken, the mode is not part of the hash. |
| `validation` | `{ status: "passed" \| "failed", errors: [] }` for the run's own integrity check. |
| `artifacts` | A digest of every artifact the run wrote: `readme`, `prompt`, `navigation`, `projectTree`, `audit`, `fullJson`, `fullMarkdown` and `sarif` when present, each `{ byteSize, sha256 }`. `validate` requires each recorded file to exist and match, so deleting the README or the navigation index is a failure rather than a silent omission. Monolith entries are `null` when the file was not written; a key absent for an older manifest is not drift. |
| `layers`, `kinds` | File counts per layer and per kind. |
| `indexes` | Cross-references: `routes`, `components`, `handlers`, `features`, `imports`, `directives`. `imports.byFile` holds one entry per file whose import edges are known — including a previewed or oversized file, whose specifiers are still extracted because they are what makes it a dependent. Such an entry has `exportsOmitted: true`: its `exports` list was never read, and an empty array there would claim "no exports". |
| `parts` | One entry per part (below). |
| `files` | One entry per included file (below). |
| `skipped` | One entry per excluded file (below). Every scanned path appears in `files` or here: the generator asserts it, so a file cannot vanish between the two. |
| `incomplete` | One entry per included file whose body is **not the whole file**: `{ relativePath, part, reason, omittedRanges, omittedLines, includedLines, lines }`. `reason` is `large-file-budget`, `part-budget` or `section-metadata`; `omittedRanges` are 1-based inclusive line ranges that are missing or partial. Empty is the normal case and is written as an empty array — a consumer asks "was anything lost?" without reading four hundred file entries. |
| `warnings` | Non-fatal observations that may change how you read the snapshot — a disabled artifact, a file too large to parse, a transcoded file, a throwing `hooks.afterGenerate`. Masked values are **not** warnings: they are counted in `totals.redactedLines` and listed per line in `reports/audit.md`. |

### `parts[]`

```json
{
  "index": 1,
  "filename": "part-001.md",
  "byteSize": 1432,
  "estimatedTokens": 402,
  "budgetBytes": 307200,
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

`estimatedTokens` is an **estimate**, and the method is stated rather than hidden: a run of word
characters costs `round(length / 6)` (minimum one), every other non-space character costs one, a
space costs nothing because it merges into the next token, and a newline costs one. It lands
within about 10% of a `cl100k_base` count on ordinary source. The same number appears in the
part's own header as `- Estimated Tokens: ~N`; the estimate is taken on the part before that line
is added, so the two always agree.

`budgetBytes` is the ceiling this part was partitioned against. With per-layer budgets a snapshot
has several at once, and "within budget" cannot be answered without knowing which one applied —
`validate` checks each part against its own.

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

- `isLarge` is a fact about the file: it is bigger than `largeFileBytes`, which defaults to
  `maxPartBytes` and may not exceed it. A large file is emitted as a head/tail excerpt rather
  than inlined whole.
- `isPreviewTruncated` is a fact about what was written: the body in this snapshot is **not**
  the whole file, because lines were dropped.
- `includedLines` counts the lines of the fenced block: content lines after CRLF normalisation
  and without a trailing empty element, **plus the omission notice when one is written**. An
  empty file therefore records `0` while the fence shows one empty line, and a file ending in a
  blank line records one fewer than a reader counts. A preview records head + tail + the notice
  line — the block as written. It is not a count of surviving source content, which is why
  `includedLines + omittedLines` is one more than `lines` for a preview and never a sum a reader
  should reconcile.
- `inclusionMode` is `preview` exactly when `isPreviewTruncated` is `true`. There used to be two
  routes to it, and the second — a file *under* `largeFileBytes` but too big for its part, cut
  by the partitioner with `isLarge: false` — is what made the manifest unreadable: it looked
  like a preview chosen by policy while 57 % of the file was gone. That configuration is now a
  hard error (`largeFileBytes` above `maxPartBytes`), so `preview` now means one thing: the file
  is over the threshold and cannot be emitted whole.
  - The head/tail excerpt drops the middle, so `isLarge: true`, `isPreviewTruncated: true`. If
    the head and tail happen to cover every line, nothing is dropped and the entry stays
    `isLarge: true`, `inclusionMode: "full"`.
  - A preview that is still too large for its part is cut again, and `truncationReason` becomes
    `part-budget` instead of `large-file-budget`.
- `truncationReason` says which rule produced the omission: `large-file-budget`, `part-budget`
  or `section-metadata`. It is present exactly when something was dropped.
- `omittedRanges` are the 1-based, inclusive source lines that are missing or partial. A byte
  cut can end inside a line, and that line is named rather than the list staying empty.
- The same facts are collected in the manifest's top-level `incomplete[]`, which is what to ask
  when the question is "was anything left out?" rather than "what is in this file?".
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
  `imports` covers `import` declarations, named and star re-exports, `require("…")`, `import("…")`
  and `import x = require("…")`; a computed specifier is an expression and is not recorded, because
  a wrong edge in the import graph is worse than a missing one. The JSON reader follows JSONC —
  comments, trailing commas and a BOM — and reports `invalid-json` only for a file that still does
  not parse. `headings` skips headings inside fenced code and inside YAML front matter, and a
  document that *opens* with a `---` horizontal rule keeps its headings: the block has to look like
  YAML before it counts as front matter.
- `summaryOmitted: true` means a summary was not emitted for a size reason, and
  `summaryOmittedReason` says which: `oversize` (the file is too large to parse), `preview` (the
  body is a head/tail excerpt, so a whole-file summary would describe lines the snapshot does not
  contain) or `part-budget` (the summary alone would not fit the part). The entry then has no
  `summary`. It is only ever present when `true`.
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
  `.DS_Store`, and a complete snapshot whose recorded evidence still matches the directory are
  accepted.
  A `.gitkeep` or `.gitignore` inside the directory is not accepted, because the generator never
  writes either into an output directory: a directory that holds one is somebody's data, so the
  run refuses instead of deleting it.
- **Ownership is the marker, not a filename.** `.codebase-snapshot` is a JSON record carrying
  this generator's name and `version`, the marker's `schemaVersion`, a `createdAt` timestamp,
  a `pid`, a per-snapshot `id`, the run `state` (`staging` while it is being written, `complete`
  once it is whole), the `manifestSha256` digest of the manifest it shipped when one was written,
  `entries` — every path it wrote, directories included — and `files`, the digest inventory that
  turns a filename into evidence. `pid` is what lets a later run tell a crashed run's staging
  directory and lock from a live one.
  See [Troubleshooting](troubleshooting.md#refusing-to-replace-outdir-).

The record has this shape:

```text
generator, version, schemaVersion, createdAt, state, id, pid
manifestSha256            sha256 of manifest.json, when one was written
entries[]                 every path written, directories included
files[]                   { path, bytes, sha256 } for every regular file written
```

The marker cannot record its own digest, and Finder's `.DS_Store` is ignored by the ownership
check: a marker that carries `files` is verified file by file, so every other regular file in the
directory must appear with its recorded byte length and sha256, every recorded path must still
exist, and every entry in the directory must be one the run recorded. A marker written before
`files` existed is accepted on its `manifestSha256` instead, provided `manifest.json` is there and
the digest matches — that keeps an upgraded user's snapshot replaceable, while a legacy snapshot
generated with the manifest artifact disabled cannot prove itself and has to be removed once.

Refused: a zero-byte marker, a marker that is not JSON, is not an object or whose `files`
inventory is malformed, a marker naming another generator or an unknown `schemaVersion`, one with
no snapshot `id` or run `state`, one that
records no contents, a bare `manifest.json` with no marker, a directory holding a path the marker
did not record, and a recorded file whose byte length or sha256 no longer matches. A hand-written
marker whose recorded digests do not match the directory is therefore not evidence: passing the
check means reproducing the digests of a completed run, not copying a filename.

The marker also makes hook-written artifacts safe: the entries a `hooks.afterGenerate` adds to
the output are recorded in the marker, so they do not make the next run refuse the directory.

## Committing the snapshot

Usually you do not. Add the output directory to `.gitignore` — `codebase-snapshot init` does
it for you. If you do commit snapshots (for example, to diff context across releases),
`manifest.json` is the file that matters: it is compact and `diff` can compare two of them.
