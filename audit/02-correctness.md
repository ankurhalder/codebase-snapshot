# 02 — Correctness Audit: partitioner / index / validator / config / generators / ast

Auditor: correctness-auditor. Scope: `src/partitioner/*`, `src/index.ts`, `src/validator/validate.ts`,
`src/config.ts`, `src/scanner/files.ts`, `src/generator/{tree,navigation,monolith}.ts`, `src/ast/*`.
Out of scope (owned elsewhere): secret patterns/redaction, build tooling.

Environment: Windows, Node **v24.12.0**, `dist/` built from this `src/` at 00:41 (verified `dist/index.js`
contains the audited code paths). Every PoC imports the shipped build (`../../dist/index.js`) except
`collectFiles`, which is not re-exported and was therefore imported from `src/scanner/files.ts` via Node 24
type-stripping (same code that `dist` contains). Fixtures are created in `os.tmpdir()` and deleted afterwards.
No file outside `audit/poc/` was modified.

Reproduce everything with:

```
node audit/poc/correctness-bytesize.mjs            # A, B
node audit/poc/correctness-hash-drift.mjs          # C
node audit/poc/correctness-manifest-totals.mjs     # D, E, F, dead indexes
node audit/poc/correctness-config-win.mjs          # G
node audit/poc/correctness-rules.mjs               # H
node audit/poc/correctness-collect.mjs             # I, J
node audit/poc/correctness-dataloss.mjs            # K
node audit/poc/correctness-validate.mjs            # L
node audit/poc/correctness-artifacts.mjs           # M, N, R
node audit/poc/correctness-ast-tree-preview.mjs    # O, P, Q
```

---

## 0. Verdict on the 18 pre-formed claims

| Claim | Verdict |
| :--- | :--- |
| A byteSize self-referential ⇒ `bytes` ≠ real file size | **FALSE** — always exactly equal (proof in §20) |
| B `maxPartBytes` not enforced | **TRUE**, but not for the stated CRLF reason (CRLF errs *safe*). Real trigger: an unsplittable oversized section |
| C utf8-string hash vs raw-Buffer hash | **TRUE** (invalid UTF-8 only; lone `\r` does *not* drift) |
| D `summary-only` without truncation + `fullFiles`/`summaryOnlyFiles` misreport | **TRUE** |
| E `totalContentBytes = totalSizeBytes` | **TRUE**. `warningCount = secret findings` is true but self-consistent (not a bug) |
| F `validation.status` hardcoded, `generator.script` fake | **TRUE** |
| G `file://C:\…` breaks config loading on Windows | **FALSE on Node ≥18** — Node normalises it. Real residuals exist (§15) |
| H `"src/app/**"` matches `src/apple`, excludes are substrings | **TRUE / TRUE** |
| I `git ls-files` quoting breaks non-ASCII paths | **TRUE** |
| J walk skips symlinks / infinite recursion | **TRUE for skipping**, **FALSE for recursion** (symlinks are never followed, so no cycle) |
| K destructive non-atomic write + EXDEV | **TRUE** — proven three ways, including **deleting the repository itself** |
| L validate ignores parts/budgets/git + crashes on missing keys | **TRUE** |
| M navigation anchors are all dead | **TRUE** (0/3 anchors resolve) |
| N monolith fixed 3-backtick fence | **TRUE** (chunker is adaptive, monolith is not) |
| O `localeCompare` non-determinism + unbounded tree | TRUE but **low severity** (no hash depends on it) |
| P `includedLines` arithmetic / empty-file conventions | Partially true — every count is off by one for newline-terminated files |
| Q ts-parser: double parse, `.mts`, anonymous default, `export *`, routeHandlers, ScriptKind, hangs | Mixed: `.mts`/`.cts`, anonymous default, `export *`, routeHandlers inconsistency = **TRUE**; `setParentNodes` cost = **FALSE (unmeasurable)**; `TSX` on plain `.js/.ts` = **FALSE**; "one deeply nested file kills the whole run" = **TRUE (new)** |
| R empty repo divide-by-zero | **FALSE** — no NaN, no division, coherent (empty) output |

---

## 1. CRITICAL — `generateSnapshot` destroys existing output before it can replace it; `outDir: "."` deletes the repository

**Severity: Critical (silent data loss).** `src/index.ts:383-386` (with `295-300`).

```ts
if (fs.existsSync(finalOutDir)) fs.rmSync(finalOutDir, { recursive: true, force: true }); // 383-385
fs.renameSync(targetTmpDir, finalOutDir);                                                 // 386
```

The old output is deleted *before* the rename can fail, and `outDir`/`tmpDir` are joined onto `cwd`
(`path.join(cwd, outDir)`), so any config mistake that nests them destroys more than the snapshot.

**Repro** `node audit/poc/correctness-dataloss.mjs`. Three real (non-simulated) variants:

```
=== K1: outDir '.' ===
  before: [ 'README.md', 'src' ]
  generate threw: ENOENT: no such file or directory, rename '...\k1\.snapshot-tmp' -> '...\k1'
  after: <fixture directory itself is GONE>

=== K2: tmpDir nested inside outDir (outDir='out', tmpDir='out/.tmp') ===
  previous snapshot present: true
  generate threw: ENOENT: ... rename '...\k2\out\.tmp' -> '...\k2\out'
  previous snapshot still present: false | out/ now: <gone>

=== K3: outDir traverses a junction onto another volume (C: -> D:) ===
  previous snapshot at D: D:\cs-exdev-csFGa8\snapshot | manifest exists: true
  generate threw: EXDEV: cross-device link not permitted, rename '...\k3\snapshot.tmp' -> '...\k3\mnt\snapshot'
  previous manifest on D: still present: false
  stray tmp dir left behind on C:: true ["manifest.json","parts",...]
  bare fs.renameSync(C:\... -> D:\...) => EXDEV: cross-device link not permitted
```

* K1: `outDir: "."` → `rmSync(cwd)` wipes the whole repository (src, README, .git if present) and *then*
  throws, because the tmp dir it wants to rename was inside the directory it just deleted.
* K2: `tmpDir` nested under `outDir` is a self-destruct; one plausible config value apart from the defaults.
* K3: EXDEV **is** reachable — not from a bare absolute `outDir` (which `path.join` mangles into a child path),
  but whenever an *ancestor* component of `outDir` is a junction/mount point onto another volume. The previous
  snapshot on D: is deleted, the rename fails, and the fresh snapshot is stranded in `snapshot.tmp` on C:.
* Any other rename failure (AV/EDR holding a handle on Windows, ENOSPC, crash between the two calls) has the
  same shape: **old snapshot gone, new snapshot not in place.**

**Impact**: total loss of the previous snapshot; catastrophic loss of the working tree for `outDir: "."`.

**Fix (minimal)**: (1) refuse `outDir` that is `cwd`, an ancestor of `cwd`, or equal to/containing `tmpDir`;
(2) swap atomically instead of delete-then-rename: `renameSync(outDir, outDir + ".old")` → `renameSync(tmp, outDir)`
→ `rmSync(outDir + ".old")`, rolling back on failure; (3) on `EXDEV`, fall back to a copy (`fs.cpSync(tmp, out, {recursive:true})`)
before removing `tmp`.

---

## 2. HIGH — every file with a non-ASCII name is silently dropped from the snapshot

**Severity: High (coverage loss in any repo with non-ASCII paths; affects the shipped product's core promise).**
`src/scanner/files.ts:58-71` (and the misleading reason at `src/index.ts:78-81`).

`git ls-files` (no `-z`) C-quotes unusual paths; the parser then does `.trim()`, splits on `\n`, and rewrites
`\` → `/`, corrupting the quoted escapes into path segments.

**Repro** `node audit/poc/correctness-collect.mjs` (real `git init` fixture):

```
raw `git ls-files --cached --others --exclude-standard` output:
"src/ascii.ts\n\"src/caf\\303\\251.ts\"\nsrc/with space.ts\n\"src/\\303\\274mlaut-ok.ts\"\n\"src/\\346\\227\\245\\346\\234\\254\\350\\252\\236.ts\"\n"
collectFiles() output:
  "\"src/caf/303/251.ts\""                existsOnDisk=false
  "\"src//303/274mlaut-ok.ts\""           existsOnDisk=false
  "src/ascii.ts"                          existsOnDisk=true
  "src/with space.ts"                     existsOnDisk=true
manifest files: ["src/ascii.ts","src/with space.ts"]
manifest skipped: [{"path":"\"src/caf/303/251.ts\"","reason":"read-error"}, ...]
```

3 of 5 files are lost; `café.ts`, `ümlaut-ok.ts`, `日本語.ts` all become `read-error` records with a
mangled name that never existed on disk. Spaces survive (git does not quote them); non-ASCII does not.

**Impact**: silent, unreported omission of source files; `validate` cannot notice (it uses the same collector);
the `skipped[].reason` blames the file, not the tool.

**Fix**: `git ls-files -z --cached --others --exclude-standard` and `stdout.split("\0")`; delete the
`.replace(/\\/g,"/")` normalisation (git already emits `/`). One-line change, no behaviour risk.

---

## 3. HIGH — integrity hash is computed over different data in `generate` and `validate` ⇒ permanent phantom drift

**Severity: High (the integrity feature can never pass for such files).**
`src/index.ts:100-103` hashes the **utf8-decoded string**; `src/validator/validate.ts:66-69` hashes the **raw Buffer**.

**Repro** `node audit/poc/correctness-hash-drift.mjs`:

```
src/latin1-e9.ts: rawBytes=25 hashRaw=d2e1cf0fa33f hashOfDecodedString=b093c867e802 lossy=true
src/raw-ff.bin.txt: rawBytes=8 hashRaw=607b7798397a hashOfDecodedString=0a6c32771a44 lossy=true
src/lone-cr.ts:  rawBytes=5 hashRaw=2f2291ad568e hashOfDecodedString=2f2291ad568e lossy=false
manifest: src/latin1-e9.ts manifest=b093c867e802 diskRaw=d2e1cf0fa33f equal=false
validate #1 => valid:false, hashMismatches: ["src/latin1-e9.ts","src/raw-ff.bin.txt"]
validate #2 after a second generate (no source edits): valid:false  ("2 file(s) have been modified")
  snapshotHash==hash(string)=true ; diskHash==hash(buffer)=true
fingerprint stable across regenerations: true
```

The claim's `lone \r` half is **wrong**: `"\r"` re-encodes to `0x0D`, so lone-CR and BOM files are unaffected.
Only invalid UTF-8 (latin-1 bytes, `0xFF 0xFE`, truncated multi-byte sequences, binary-ish text) disagrees.
Such files are not binary-filtered (no NUL in the first 8 KB), so they *are* usually included.

**Impact**: `generate` → `validate` fails immediately; regenerating cannot clear it (the mismatch is
structural, not drift). Users learn to ignore `validate`, which defeats its purpose.

**Fix**: one read, one hash domain — `const buf = fs.readFileSync(absPath); const hash = sha256(buf); const rawContent = buf.toString("utf8");`
in `index.ts`, keeping `validate.ts` as-is.

---

## 4. HIGH — `maxPartBytes` is not an enforced bound: one part reached **13.5×** the configured budget

**Severity: High (the byte budget is the product's central guarantee; exceeding it degrades or overflows the
consumer's context window).** `src/partitioner/chunker.ts:32-43` and `50-51`.

The flush decision (`current.bytes + s.byteSize + 24_000 + n*160 > maxPartBytes`) is skipped when the chunk is
empty, so a single file section larger than the budget is emitted whole. Truncation cannot save it because
`truncatePreview` truncates by **lines**, and minified/generated files are one line.

**Repro** `node audit/poc/correctness-bytesize.mjs`:

```
[B1] budget=100000 => part-001.md files=1 actualBytes=500451 withinBudget=false overBy=400451
[B3] fixture: src/vendor.min.js = 4,160,000 B, single line, no NUL bytes
  manifest.counts={"totalFiles":2,...,"partsCount":2,"largeFileCount":1,"truncatedPreviewCount":0}
  part-002.md reportedBytes=4160812 fileStatBytes=4160812 budget=307200 ratio=13.54x
  part-001.md (control) reportedBytes=805
```

`maxPartBytes = 307200` requested, 4.16 MB emitted, `truncatedPreviewCount = 0`.

Secondary defect — the header reserve is a guess and is off by 26× in the other direction:
`actualHeader=1579B` for 109 files (≈14 B/file) vs `reservedHeader=41440B` (160 B/file + the 24 000 B constant),
so with a 100 KB budget **45 % of the allotted budget is unused**
(`400 tiny files => 4 parts, total unused budget=178145 B`). At the default 300 KB budget the 24 KB constant
alone wastes 8 % of every part ⇒ more parts than necessary for the same content.

The stated CRLF mechanism is **not** a cause of overshoot: `.replace(/\r\n/g,"\n")` happens after counting, so
the emitted part is *smaller* than accounted (`sourceBytes=120000 … shrinkageFromNormalization=20000`). It is a
real count/emit mismatch, but it errs on the safe side; the mismatch worth fixing is the reserve guess.

**Fix**: (1) hard-split any single rendered section that exceeds `maxPartBytes` — at minimum byte-truncate the
content and mark `isPreviewTruncated` (truncate by bytes, not lines); (2) compute the header length exactly
(render the section list with a placeholder, then compute), or reserve a small constant and flush on the real
header size; (3) normalise CRLF once, before accounting.

---

## 5. HIGH — `validateSnapshot` throws an uncaught `TypeError` on a manifest without `files`/`skipped`

**Severity: High (crashes the documented `validate` CLI/API on malformed or older manifests).**
`src/validator/validate.ts:40-45` — no schema guard, while `manifestPresent:true` is reported for any JSON.

**Repro** `node audit/poc/correctness-validate.mjs`:

```
manifest without `files`  => THREW TypeError: manifest.files is not iterable
manifest without `skipped` => THREW TypeError: Cannot read properties of undefined (reading 'map')
```

`src/cli.ts:141-155` does not wrap the call, so `codebase-snapshot validate` exits with a raw stack trace
instead of "❌ Snapshot validation failed with drift".

**Fix**: validate the shape first (`Array.isArray(manifest.files) && Array.isArray(manifest.skipped)`, plus
`schemaVersion`), and return the existing `{valid:false, errors:[...]}` shape on failure.

---

## 6. MEDIUM — `validate` is a file-hash checker only: emitted parts, budgets, git state and totals are never checked

**Severity: Medium (false "valid" verdicts; the field that is supposed to carry this is hardcoded, see §10).**
`src/validator/validate.ts:56-97`.

**Repro** `node audit/poc/correctness-validate.mjs`:

```
deleted part-001.md                => {"valid":true}
replaced part-001.md with garbage  => {"valid":true}
validate with maxPartBytes=1000 (manifest says 307200) => valid=true
manifest.budgets tampered to 1/1   => valid=true
branch changed to feature-branch   => valid=true (manifest.git.branch = main)
new commit reached                 => valid=true
totals/counts tampered (totalFiles=999, totalContentBytes=1) => valid=true
snapshot generated with excludePatterns=['src/'] => manifest.files=[]
   validate with default config => valid:false, missingInSnapshot:["src/a.ts","src/b.ts","src/binaryish.dat"]
   validate with the snapshot's own excludes => valid:true
```

`parts[].sha256`, `parts[].bytes`, `partCount`, `fileCount`, `layersCovered` are all recorded but never
re-verified — the snapshot's primary artefacts (`parts/*.md`) can be missing or corrupted with a green check.

**Fix**: (a) record the effective config (`budgets`, `excludePatterns`, `git.commit/branch`) in the manifest and
compare it on validate; (b) verify each `parts/*.md` against its `bytes`+`sha256`; (c) verify
`Σ parts[].fileCount === totals.includedFiles` and `manifest.files[].part` ∈ `parts[].filename`.

---

## 7. MEDIUM — `inclusionMode` says `summary-only` for files whose full content is emitted; `fullFiles`/`summaryOnlyFiles` misreport

**Severity: Medium (manifest is the machine-readable contract for agents; it lies about what is in the parts).**
`src/index.ts:123-124,170,222-223`, consumed by `src/partitioner/chunker.ts:154`.

**Repro** `node audit/poc/correctness-manifest-totals.mjs` (`largeFileBytes: 500`):

```
src/five-lines.ts: sizeBytes=1610 isLarge=true isPreviewTruncated=false inclusionMode=summary-only includedLines=6/6
heading used for that file: "Bounded Preview" ; contains last line v4? true ; contains omission marker? false
totals.fullFiles=2 totals.summaryOnlyFiles=1 counts.largeFileCount=1 counts.truncatedPreviewCount=0
```

`inclusionMode` is derived from `stat.size > largeFileBytes`, not from `preview.isTruncated`, so a file whose
preview was **not** truncated is labelled `summary-only` and rendered under `#### Bounded Preview` while the
complete body is present. `totals.fullFiles` (files − largeFileCount) under-reports full payloads and
`summaryOnlyFiles` over-reports previews.

**Fix**: `inclusionMode: isPreviewTruncated ? "summary-only" : "full"`; derive
`fullFiles = files.filter(f => !f.isPreviewTruncated).length` and `summaryOnlyFiles = truncatedPreviewCount`.

---

## 8. MEDIUM — every file link in `reports/navigation.md` is a dead anchor

**Severity: Medium (the report exists to be navigated by agents/humans; 100 % of its file links are broken).**
`src/generator/navigation.ts:41-42` + `src/partitioner/chunker.ts:176-177` vs `chunker.ts:143`.

`anchorForPath` → `path.toLowerCase().replace(/[^a-z0-9_-]+/g,"-")`, but parts emit plain headings
`### FILE: <path>` and never emit those anchors (or any `<a id>`/`{#id}`).

**Repro** `node audit/poc/correctness-artifacts.mjs`:

```
navigation links: [{"part":"part-001.md","anchor":"readme-md"},
                   {"part":"part-001.md","anchor":"src-app-route-ts"},
                   {"part":"part-001.md","anchor":"src-index-ts"}]
headings in parts: ["FILE: README.md","FILE: src/app/route.ts","FILE: src/index.ts"]
anchors that exist literally in any part file: 0
anchors matching the GitHub slug of an emitted heading: 0 of 3
```

Also note `anchorForPath` is not injective: `src/a-b.ts` and `src/a/b.ts` both map to `src-a-b-ts`.

**Fix**: emit the anchor in the part — `<a id="${anchorForPath(p)}"></a>` immediately before `### FILE: …`
(or link to `#file-srcapproutets`, the heading's GitHub slug).

---

## 9. MEDIUM — `monolith.ts` uses a fixed 3-backtick fence ⇒ any file containing ``` breaks the monolith

**Severity: Medium (layout/instruction injection in the "full codebase" artefact; chunker already solves it).**
`src/generator/monolith.ts:30-32` vs `src/partitioner/chunker.ts:139,164-168`.

**Repro** `node audit/poc/correctness-artifacts.mjs` (fixture `docs.md` contains a fenced block and a line
`INJECTED HEADING: …`):

```
  ## File: docs.md
  ```markdown
  # Docs

  ```js
  const x = 1;
  ```

  INJECTED HEADING: this text is now outside the fence
  ```
lines starting with ``` in full-codebase.md: 6 (2 files => expected 4 if balanced)
chunker's fence for the same file: "````" (adaptive, > max backtick run in content)
```

The code block closes at the *inner* fence, so every following line is parsed as document markup — the same
file rendered through `parts/` uses a 4-backtick fence and stays inside its block.

**Fix**: export `fenceForContent` from `chunker.ts` and use it in `monolith.ts`.

---

## 10. MEDIUM — `manifest.validation.status` is the literal `"passed"`, and `generator.script` points at a file that does not exist

**Severity: Medium (a hardcoded "integrity passed" claim in the machine-readable artefact).**
`src/index.ts:232-235` and `200`; the `"failed"` member of the union (`src/types.ts:156-159`) is never assigned
anywhere (`grep -n "failed" src` → only the type at `types.ts:157` and the CLI message at `cli.ts:149`).

**Repro** `node audit/poc/correctness-manifest-totals.mjs`:

```
manifest.validation={"status":"passed","errors":[]}
manifest.generator.script="scripts/generate_codebase_snapshot.ts" existsOnDisk=false
after editing a source file: validateSnapshot.valid=false errors=["1 file(s) have been modified since the snapshot was generated."]
manifest.json on disk still says validation.status="passed" while validateSnapshot says valid=false
```

`scripts/` does not exist in this repo (`Test-Path scripts` → `False`), and it is not in `package.json#files`.

**Impact**: consumers that trust `manifest.validation.status` (instead of re-running `validate`) get a
guarantee that was never computed.

**Fix**: run the same integrity checks at the end of `generateSnapshot` and set the field from the result, or
delete the field; drop `generator.script` (or derive `version` from `package.json` at build time).

---

## 11. MEDIUM — one deeply-nested JS/TS file aborts the whole snapshot with an uncaught `RangeError`

**Severity: Medium (single-file DoS of the entire run; no per-file isolation).**
`src/ast/ts-parser.ts:129` (recursive `ts.forEachChild` walk) called unguarded from `src/index.ts:143-151`.

**Repro** `node audit/poc/correctness-ast-tree-preview.mjs`:

```
 1000 nested parens => ok in 1 ms (parser ok)
 5000 nested parens => THREW RangeError: Maximum call stack size exceeded (parser THREW RangeError)
 5000 '&&' operands => THREW RangeError: Maximum call stack size exceeded (parser ok)
20000 '&&' operands => THREW RangeError: Maximum call stack size exceeded (parser ok)
generateSnapshot on a deeply-nested file: THREW RangeError: Maximum call stack size exceeded
unterminated template / unterminated block comment / NUL char / 100k char single line => ok
```

Attribution matters: for 5 000 nested parentheses **TypeScript's own parser** throws; for a 5 000-term
`a && b && …` chain the parser succeeds and **our recursive `visit`** throws. Either way the exception escapes
`generateSnapshot`, so a single generated/minified file (all of them are `.js`, which is summarised) costs the
entire snapshot. `isBinaryFile` does not filter it (no NUL bytes).

**Fix**: wrap the per-file summary in `try/catch` (fall back to `summary: undefined` and push a
`warnings`/`skipped`-style record), and optionally guard recursion depth in `visit`.

---

## 12. MEDIUM — `matchRule` and `excludePatterns` do not implement the globs they advertise (the README example is wrong)

**Severity: Medium (silent misclassification / silent file loss from documented configuration).**
`src/config.ts:114-132` (`"…/**"` → `slice(0,-3)` + `startsWith`) and `src/scanner/files.ts:102-104`
(`file.includes(pattern)`). The README ships exactly these strings: `{ name: "app", match: "src/app/**" }`.

**Repro** `node audit/poc/correctness-rules.mjs`:

```
=== H1: matchRule('src/app/**') ===
  src/app/route.ts             layer=app
  src/apple/pie.ts             layer=app        <-- not under src/app/
  src/application/server.ts    layer=app        <-- not under src/app/
  src/app2/x.ts                layer=app        <-- not under src/app/
  layers histogram: {"other":4,"app":4}

=== H2: excludePatterns:['test'] ===
  test/a.ts        kept=false
  attest/words.ts  kept=false   <-- deleted by "test"
  contest/entry.ts kept=false   <-- deleted by "test"

=== H3: string rule 'src/app' (includes) ===
  src/apple/pie.ts layer=apple-ish
```

`slice(0,-3)` of `"src/app/**"` is `"src/app"` — the trailing `/` is eaten with the `**`, so the prefix has no
path boundary. And `excludePatterns` cannot express a glob at all (`"*.lock"` never matches).

**Fix**: for `"x/**"` use `filePath === prefix || filePath.startsWith(prefix + "/")` with `prefix = matcher.slice(0,-3)`;
for excludes either implement a real matcher (`**`, `*`, `?`) or rename/document the field as a substring filter.

---

## 13. MEDIUM — `manifest.indexes` is mostly hardcoded empty even though the data was collected

**Severity: Medium (README tells consumers to use the manifest's "precise dependency and AST symbol maps";
three of five indexes are always empty).** `src/index.ts:265-267`.

**Repro** `node audit/poc/correctness-manifest-totals.mjs`:

```
indexes.imports={"byFile":[],"centralFiles":[]}
indexes.directives=[]
indexes.features=[]
but files[src/app.ts].summary.imports=["./a","node:fs"] summary.directives=["use client"]
indexes.routes=[]   (kind "route" only exists in the nextjs preset; the default preset never produces it)
```

`indexes.routes`/`components`/`handlers` are derived from per-file kinds and work only under the Next.js preset;
`imports`, `directives`, `features` are literals.

**Fix**: populate `imports.byFile` and `directives` from `summary.imports`/`summary.directives` (the data is
already computed), or remove the keys so consumers don't trust empty arrays.

---

## 14. LOW — `totals.totalContentBytes` reports source bytes, not emitted content bytes

**Severity: Low (misleading metric; nothing downstream branches on it).** `src/index.ts:226`.

**Repro** `node audit/poc/correctness-manifest-totals.mjs`:

```
totals.totalSourceBytes=1762 totals.totalContentBytes=1762 (equal? true)
src/creds.ts on disk=62B ; secret line 40B -> redaction marker 61B
measured emitted body bytes across parts/*.md=3517
```

The two fields are the same expression, so one of them is always wrong; after redaction/truncation the real
emitted volume differs by ~2× here and by 13× in §4's minified case.
`totals.warningCount === warnings.length === secretFindingCount` is **consistent** — I do not consider it a bug,
only a naming choice.

**Fix**: accumulate `Buffer.byteLength` of the rendered sections per part (or of `part.markdown` minus header)
and store that; drop `totalSourceBytes` or keep both clearly named.

---

## 15. LOW — config loading: the Windows `file://` concern is **not** a bug, but errors are swallowed and two path shapes still break

**Severity: Low.** `src/config.ts:23-43`.

Direct test of the exact expression (`node audit/poc/correctness-config-win.mjs`):

```
[esm-js] import("file://C:\Users\...\esm-js\snapshot.config.js")  => imported OK
[cjs-js] => imported OK   [mjs] => OK   [cjs] => OK   [ts] => OK (Node 24 type stripping)
[json]   => ERR_IMPORT_ATTRIBUTE_MISSING (but the .json branch uses readFileSync+JSON.parse, so unreachable)
end-to-end .ts config: wrote to from-config: true | maxPartBytes=12345   (config honoured)
```

Node's WHATWG URL parser treats `\` as `/` for `file:` and hoists a drive letter into the path, so
`file://C:\x` resolves to `file:///C:/x`. The claim is **false** on this runtime.

What is real:
* `catch { continue; }` (lines 40-42) swallows *every* failure, including a syntax error or a missing dependency
  in a user's config → the config is silently ignored. Demonstrated by the mangled-path cases below, and by the
  fact that `loadConfigFile` returns `null` with no message on any error.
* URL metacharacters in the **path** still break the naive concatenation (string, not `pathToFileURL`):
  `dirName="hash#dir"` → `ERR_MODULE_NOT_FOUND …\hash` → `loadConfigFile => null (silently ignored)`;
  `dirName="percent%41dir"` → resolves `%41` → `…\percentAdir\snapshot.config.js` → `null`.
* `snapshot.config.ts` — the format `init` writes and the README documents (README:84-116) — only loads natively
  from Node **22.6+/23.6+** (type stripping). `package.json` says `engines.node >= 18.0.0`; on Node 18/20 the
  import fails with `ERR_UNKNOWN_FILE_EXTENSION` and is **silently ignored** (inferred — only Node 24.12 is
  installed here, so I could not execute it; the mechanism is the swallow above).
* Related API footgun found while testing: `loadConfigFile(dir)` + `resolveConfig(cfg)` ignores `dir` —
  `resolveConfig` falls back to `process.cwd()` (`config.ts:63`), so the natural library flow silently generates
  into the *caller's* cwd. Observed: `resolveConfig(loaded).cwd => C:\...\codebase-snapshot` for a config loaded
  from a temp dir (my first PoC run wrote stray output into the repo because of this).

**Fix**: `await import(pathToFileURL(fullPath).href)`; keep the try/catch but `console.warn` (and record) the
reason; either drop `.ts` from `CONFIG_FILENAMES` or gate it on the Node version and say so in the README;
make `resolveConfig` default `cwd` to the config's directory rather than `process.cwd()`.

---

## 16. LOW — the no-git fallback silently omits symlinked files and directories (and records nothing)

**Severity: Low (git is normally present; when it is not, content disappears without a trace).**
`src/scanner/files.ts:110-139` — only `entry.isDirectory()` and `entry.isFile()` are handled; a symlink/junction
is neither, so it falls through with no `skipped` record.

**Repro** `node audit/poc/correctness-collect.mjs`:

```
junction created (link-dir -> ../outside-dir) ; file symlink SKIPPED (EPERM) - not permitted without admin/dev-mode
readdir types: link-dir(isDir=false,isFile=false,isSymlink=true) | real-dir(isDir=true,isFile=false,isSymlink=false)
files reachable through the junction, confirmed directly: ["hidden.ts"]
collectFiles(noGit) = ["real-dir/inner.ts","real-file.ts"]
manifest files = ["real-dir/inner.ts","real-file.ts"] ; skipped = []
```

File symlinks could not be created in this environment (needs admin/developer mode), so *that* half is inferred;
it hits the identical `else if (entry.isFile())` branch. Conversely, **infinite recursion is not possible**:
symlinks are never followed, so no cycle can form; the "no depth cap" concern is theoretical (a real, physically
deep tree would hit the JS stack long before a user could create it).

**Fix**: `else if (entry.isSymbolicLink()) { const st = fs.statSync(fullPath); … }` and either follow with a
visited-realpath set, or push a `skipped` record (`reason:"symlink"`) so omission is visible.

---

## 17. LOW — line counting is off by one for every newline-terminated file, with two contradictory conventions

**Severity: Low (cosmetic/wrong metrics, but present in every manifest and in the truncation message).**
`src/index.ts:105,173` and `src/partitioner/preview.ts:13-16,25-40`.

**Repro** `node audit/poc/correctness-ast-tree-preview.mjs`:

```
empty                     split().length=1 truncatePreview.originalLines=1   (index.ts would record 0)
two lines + trailing NL   split().length=3 originalLines=3 includedLines=3   (really 2 lines)
single newline            split().length=2
400-line file             originalLines=401 includedLines=121
                          marker="... [281 lines omitted: ...] ..."  (really 280)
manifest: src/two.ts sizeBytes=40 lines=3 | src/onlynl.ts lines=2 | src/empty.ts lines=0
```

`includedLines = head+tail+1` does match the emitted text (the marker is a line), so that part is fine; the
inconsistency is that `originalLines`/`lines` over-count by one per file (⇒ `totals.totalLines` inflated) while
empty files get 0 in `index.ts` but 1 in `preview.ts`.

**Fix**: one helper, e.g. `const countLines = (s:string) => s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0);`
used by `index.ts`, `preview.ts` and `chunker.ts:104`.

---

## 18. LOW — `tree.ts`: locale-dependent ordering, no size cap, and file/dir name conflation

**Severity: Low.** `src/generator/tree.ts:19-42`.

**Repro** `node audit/poc/correctness-ast-tree-preview.mjs`:

```
code-unit sort : ["Banana.ts","Z.ts","a.ts","apple.ts","b.ts","zebra.ts","Ärger.ts","ä.ts"]
en-US collation: ["a.ts","ä.ts","apple.ts","Ärger.ts","b.ts","Banana.ts","Z.ts","zebra.ts"]
sv-SE collation: ["a.ts","apple.ts","b.ts","Banana.ts","Z.ts","zebra.ts","ä.ts","Ärger.ts"]
en-US === sv-SE ? false
generateProjectTree(20000 paths) => 779 KB in 42 ms; no size cap (index.ts writes it twice: reports/ and root)
name collision (file 'a' + dir 'a/b.ts'): [".","└── a","    └── b.ts"]
```

`localeCompare` uses the machine's default locale, so the same commit produces different `project-tree.md`
ordering on different machines. Honest severity: **low** — no hash covers the tree and nothing consumes the
order; the concrete costs are diff noise and 2× write of an uncapped file. The name-collision case means the
tree cannot distinguish a file from a directory (no marker) and silently merges `a` (file) with `a/` (dir).

**Fix**: `a < b ? -1 : a > b ? 1 : 0` (or `new Intl.Collator("en",{numeric:true})` with an explicit locale);
append `/` to directory names; truncate the tree above N entries with an "… M more" line.

---

## 19. LOW — `ts-parser` coverage gaps (`inclusion`-relevant but not correctness-critical)

**Severity: Low.** `src/ast/ts-parser.ts`.

**Repro** `node audit/poc/correctness-ast-tree-preview.mjs`:

```
a.ts  imports:["./x"] exports:["DELETE","POST"] functions:["GET","POST"]
      routeHandlers:["DELETE","GET","POST"] variables:["DELETE","PATCH","putHandler"]
b.mts summary=NONE      c.cts summary=NONE      d.ts summary={imports:["./v"],exports:["r"]}
setParentNodes=false median=14.3 ms | setParentNodes=true median=14.3 ms (156 KB input, n=5)
```

* `.mts`/`.cts` are never summarised (`index.ts:143-151` lists only `.ts/.tsx/.js/.jsx/.mjs/.cjs`).
* `export default function () {}` produces no `functions`/`exports` entry (anonymous declaration skipped at `ts-parser.ts:79`).
* `export * from "./star"` is invisible: `ExportDeclaration` without a named clause is dropped (`67-73`) and the
  module specifier is not recorded as an import.
* `routeHandlers` is inconsistent: a **non-exported** `function GET(){}` is recorded (line 83, no export check)
  while a non-exported `const PATCH = …` is not (line 121 is inside `if (exported)`), so
  `indexes.routes[].methods` contains false positives for Next.js route files.
* **False alarms in the original claim**: `setParentNodes:true` costs nothing measurable here (14.3 vs 14.3 ms
  median), the file is parsed **once** per run, and `ScriptKind.TSX` is only used for `.tsx`/`.jsx` — plain
  `.js/.ts` get `ScriptKind.TS`. (The only residual: JSX inside a `.js` file is parsed as TS and yields error
  nodes, which degrades but does not break summarisation.)

**Fix**: add `.mts`/`.cts` (and `.mjs`/`.cjs` equivalents) to both the extension list and `isJsx` logic; record
`"default"` for anonymous default exports; for `export *` push the specifier into `imports` (and mark re-exports);
apply the export check uniformly (move routeHandler detection inside `if (exported)` or outside the variable
branch); use `ScriptKind.JSX` for `.js`/`.mjs` when the content contains `<`.

---

## 20. Informational — claims I could not sustain

* **A (self-referential `bytes`)**: false. The 3-iteration loop always ends with
  `byteSize = Buffer.byteLength(content)` for the *same* `content` that is written to disk, because the last
  assignment happens after the final render. Verified at every digit boundary and end-to-end:

  ```
  bodyBytes 10/1000/9990/99990/999998/3000000 => delta 0 in all cases
  multi-part (4 parts, 40 files)             => delta 0
  end-to-end part-002.md reportedBytes=4160812 fileStatBytes=4160812
  ```

  The loop is redundant (3 renders + 3 `byteLength` per part) but not incorrect. No oscillation exists:
  `bytes` always equals the byte length of the emitted `part-XXX.md`.
* **B (CRLF causes overshoot)**: the normalisation/count ordering is real but errs safe — the part is *smaller*
  than accounted (20 000 bytes smaller in the fixture). See §4 for the genuine overshoot.
* **G (`file://C:\…` invalid)**: false on Node ≥18 (proven working). See §15 for what is actually broken.
* **J (infinite recursion)**: impossible — symlinks are never followed. Only the omission is real (§16).
* **R (empty repo)**: no divide-by-zero, no `NaN`/`undefined` anywhere; `parts: []`, README/navigation/audit
  render empty tables, `project-tree.md` is `"# Project Tree\n\n```text\n.\n```\n"`, and `validate` returns
  `valid:true`. The only nit: an empty snapshot is reported as "complete" and "valid", and `artifacts.fullJson`
  is still emitted (1 653 B) for a repo with zero files.

---

## 21. Fix order (highest value first)

1. §1 write sequence (data loss) — refuse `outDir: "."`/ancestors/`tmpDir` nesting, swap via `.old`, handle `EXDEV`.
2. §2 `git ls-files -z` — one line, restores every non-ASCII file.
3. §3 single-read single-hash in `generate` — clears permanent phantom drift.
4. §4 split/byte-truncate oversized sections + exact header accounting.
5. §5/§6 validate schema guard, then verify `parts/*.md` and the recorded config/git state.
6. §7/§8/§9/§10 manifest truthfulness + dead anchors + monolith fence (all small, independent edits).
7. §11 per-file `try/catch` around AST summarisation.
8. §12 matcher/exclude semantics (documented config currently misbehaves).
