# Deep sweep — running notes (target: every file read)

## Read line-by-line, in full (ledger)
src/types.ts 712 · src/config.ts 1735 · src/index.ts 3380 · src/partitioner/chunker.ts 956 ·
src/partitioner/preview.ts 124 · src/security/redact.ts 1421 · src/cli.ts 2235 ·
src/mcp/generate-worker.ts 186 · src/version.ts 40 · src/bin.ts 12 · src/define-config.ts 5 ·
package.json · tsconfig.json · tsup.config.js · snapshot.config.ts · .gitignore · .gitattributes
Targeted region: src/scanner/files.ts:1235-1442 (listGitCandidates + collectFiles).

## Verified this sweep
- npm test: 1089 tests, 1081 pass, 0 fail, 8 skipped, 94.4 s. Suite green.
- Build stderr warned that fileURLToPath is unused in dist/index.cjs. RESOLVED: dead import only.
  dist/mcp.cjs:8381 carries the standard esbuild shim (pathToFileURL(__filename)); both builds
  expose the same 8 tools and generateInWorker. No CJS/ESM divergence.
- Redaction corpus, 36 cases (CRLF, PEM, Dockerfile ENV, YAML block scalar, concatenation, query
  strings, dollar-brace defaults, unbalanced quotes): must-mask 28 -> 1 leak; must-not-mask 8 ->
  0 over-redactions. The leak is the fail-open at redact.ts:753 (D11).

## New findings

### D11 — redaction fail-open is silent (Medium; latent)
src/security/redact.ts:748-757. If masking would leave the line quote-unbalanced, the line is
emitted UNCHANGED and recordFinding is never called — the credential is in the artefact and
nothing in reports/audit.md or manifest.totals.redactedLines mentions it.
Reproduced: API_KEY="unbalanced zq7Xk2nvalue in config/app.env -> verbatim, 0 findings.
That is the one path where rule 3 (never leak) and rule 1 (no silent fallback) both fail.
Fix: record the finding and emit a quoted marker, or fail the run.

### D12 — --help loses to a bad --cwd (Low)
src/cli.ts:453-470: the --cwd existence check and the empty-value check run BEFORE the help and
version branches, so `snapshot --help --cwd /nope` exits 2 with a usage error instead of help.

### D13 — generatorOrigin vs nextStepHint disagree on package.json parsing (Low)
src/cli.ts:903 uses raw JSON.parse; src/cli.ts:792 uses stripJsonComments for exactly the BOM
case it documents. A BOM'd package.json makes the banner claim npx/global when the project pins.

### D14 — the summary's "M found" counts directory records as files (Low-Medium)
src/cli.ts:1754 candidates = counts.totalFiles + counts.skippedCount. One .gitignored directory
contributes ONE skip record, so this repo prints 284 included of 294 found for 271 tracked files.
Same defect as totals.candidateFiles (D8). Fix: count only file-shaped skips, or rename the label.

### D15 — a doc comment that contradicts the code beneath it (Low)
src/cli.ts:2207-2211 says the module has no side effects; src/cli.ts:2224 runs main() when
argv[1] is cli.js/cli.cjs. The comment describes the invariant the next block deliberately breaks.

### D6 (extended) — orphaned / stacked / duplicated doc comments, 14 sites
index.ts:671 (two stacked), :800 (markerInventory doc above an interface), :1979 (runAfterGenerate
doc above installHookStdoutRedirect), :3234-3252 (same comment twice, first copy truncated).
chunker.ts:286 + 287-293 + 318-324 (same comment three times), :443 + :451 (both on displayPath).
redact.ts:470-481 + 482-490, :1236-1243 (isUnquotedValue doc above interface ValueAssignment;
the function at :1305 has none).
cli.ts:886-891 + 892-900, :933-942 + 943-951, :1990-1997 + 1998-2004, :2207 + :2213.
Cause is uniform: a function moved and its comment stayed. No lint rule or test can see it.

### D7 (extended) — statements welded onto a brace, 4 sites
config.ts:1539, chunker.ts:360, cli.ts:818, cli.ts:1365.

## Cleared (checked, not defects)
- --split-output / --token-budget / --remote in docs are repomix flags in comparison tables.
- --mode is absent from --help but present in describe (describe is the contract).
- The update check is gated on stdout.isTTY, so a pipe or CI never pays for it.

## Still to read (priority order)
validator/validate.ts 1256 · scanner/files.ts 1297-1672 · scanner/{binary,changed,dependents,language}
1016 · mcp/* except generate-worker (~1800) · security/patterns.ts 641 · wizard/* 1250 · ast/* 2500 ·
generator/* 800 · presets/* 800 · agent/* 1400 · {diff,explain,gitignore,tokenize,terminal,stdout,
update-check} ~1400 · scripts/* 11 · packages/create 4 · .github 12 · docs 22 · tests 116 ·
CHANGELOG · audit/reports/0.9.16-verified-bugs.md

## Read since (append)
src/validator/validate.ts 1255 (full).

### D16 — validate never checks the incomplete[] contract (HIGH)
CONFIRMED EMPIRICALLY. src/validator/validate.ts contains no reference to manifest.incomplete,
counts.incompleteCount, files[].truncationReason or files[].omittedRanges, and
describeManifestShapeProblem (validate.ts:196-364) does not require them either.
A generated 8 KB-budget fixture was then tampered with; every variant below returned EXIT 0
("Snapshot is valid and up to date"):
  T1 incomplete[] deleted, files still carry ranges        -> exit 0
  T2 incomplete[] emptied (counts.incompleteCount stays 1)  -> exit 0
  T3 incomplete[] fabricated for src/nope.ts, count set 42  -> exit 0
  T4 files[].omittedRanges = "not-an-array" + bogus reason  -> exit 0
  T5 ranges/reason removed from a file                      -> exit 0
Consequence: verifyInMemory enforces the invariant at GENERATION time only. The command whose job
is "is this snapshot trustworthy", the command the pre-commit hook gates on, and the JSON a CI
reads, all ignore the one field the 0.10 release added for exactly that purpose. D1 (the off-by-one)
is likewise invisible to validate.
Fix: shape-check incomplete[] (array; each entry's relativePath in files[], reason in the enum,
ranges sorted/in-bounds/integers), reconcile counts.incompleteCount, and cross-check each entry
against the matching files[] record. Also assert includedLines + omittedLines === lines once D1 is
defined.

### Confirmed by reading validate.ts
- totals.candidateFiles is DEFINED as files.length + skipped.length (validate.ts:1020-1024), which
  makes D8/D14 precise: the number is a record count, not a file count, by construction.
- Artifact digests are verified for README/navigation/project-tree/audit/monoliths/SARIF (1123-1180),
  and navigation links are checked for dead targets (1148-1161).
- Path traversal from a manifest is refused in both directions (confineToDirectory, 50-59; used at
  620 and 674).
- Fingerprint is recomputed from the manifest itself (1044-1078), with the pre-0.9.17 formula accepted.

## Read since (append)
src/scanner/files.ts 1-1234 + 1235-1671 (full, 1671 lines).

### D17 — two ownership predicates disagree about legacy generator names (Low-Medium)
src/scanner/files.ts:1030-1037 (isToolOwnedDirectory) requires
  marker.generator === GENERATOR_NAME  and marker.state === complete and Array.isArray(marker.files)
src/index.ts:940 (readOwnershipMarker) accepts isOurGeneratorName(...), which by design also accepts
LEGACY_GENERATOR_NAMES (src/version.ts:34-40, added so snapshots written by the pre-rename package
stay replaceable). So for a directory written by the legacy package name the two answers are:
  assertReplaceable -> ours (replaceable)      collectFiles -> not ours (scan it as source)
A nested/committed snapshot carrying a legacy marker is therefore scanned back INTO the next
snapshot, which is the self-referential-content failure the marker check exists to prevent.
With outDir configured this is masked by toolOwnedPaths (files.ts:1080 returns true for the
reserved prefix before any marker is consulted), so it needs a nested or renamed directory.
Fix: use isOurGeneratorName in isToolOwnedDirectory (it is already exported by version.ts).

### D6 (extended again)
src/scanner/files.ts:321-328 — a doc comment (path-scan rules) with NO declaration beneath it at
all; the gap that follows is the declaration that was removed. files.ts:983-1002 — the
isToolOwnedDirectory doc sits above a second, unrelated comment (1003) and the const it describes
is not there (the function is at 1015 with its own doc). Total orphan/stack sites now 16.

### Confirmed by reading files.ts
- One git subprocess per run (139-211), porcelain=v2 headers, -z, ENOBUFS read as dirty (207-209).
- Sensitive-name deny list normalises Windows trailing-space/dot and strips backup suffixes until
  stable (278-286); template exemption only when the marker is the LAST suffix (311-319).
- Path secrets masked by union-merged spans, rule names collected, no excerpt kept (411-453).
- Globs: brace + class support, out-of-order class is a hard error (513-517); gitignore patterns
  with an invalid class compile to /$^/ instead, matching git's fnmatch (741-801).
- Nested .gitignore layers, deepest opinion wins (841-867), dir-only rules tried against every
  prefix (821-833).
- Walker is iterative (a 2400-level path used to overflow the stack), never follows directory
  links, refuses file links leaving the root, and decides sensitivity on the LINK TARGET (1590-1659).

## Read since (append)
src/mcp/tools.ts 1160 (full).

### D18 — snapshot_read explains a part-budget cut as a head/tail preview (Medium)
src/mcp/tools.ts:1023-1027 prints "Bounded preview: the snapshot holds this file's head and tail
only" whenever the section's inclusion is "preview". But chunker.ts:634 sets inclusionMode
= "preview" for BOTH truncation reasons, and the part header's - Meta: line carries only the mode.
What the tool reads therefore cannot distinguish them:
  - large-file-budget -> head + notice + tail (what the message says),
  - part-budget       -> head + notice, no tail (what the message denies),
  - section-metadata  -> the notice alone, no body at all.
`part.ts` parses inclusion but no reason, so the agent is told the wrong shape exactly where it is
asking why its file looks short. The generator writes truncationReason into the manifest; nothing
in the part is read by this path, and the manifest carries it only per file — which the tool has
already fetched, so the fix is local: read entry.truncationReason and say which cut happened.

### D19 — snapshot_plan runs the generator on the JSON-RPC thread (Low-Medium)
src/mcp/tools.ts:388 calls generateSnapshot(workspace.config, { dryRun: true }) inline, while
snapshot_generate uses generateInWorker (tools.ts:477). generate-worker.ts:1-8 exists precisely
because a synchronous run blocks the stdio server for ~7.5 s on a 3,000-file repository, and a
dry run does the full scan, redaction and parse — only the write is skipped. So the tool documented
as the cheap preview is the one that can make the server look dead, and `ping` is not answered
while it runs. Fix: run the dry run in the worker too.

### D20 — the import graph the MCP reports is not the one the generator used (Low)
index.ts:2194-2207 keeps `skippedSummaryImports` (imports extracted from text for files whose
structural summary was skipped) and feeds it to the --with-dependents closure. buildIndexes
(index.ts:459-525) does NOT: `byFile` is filtered from `isSourceSummary(file.summary)`, so a
previewed or oversize file contributes no edges. Consequences: manifest.indexes.imports,
centralFiles, snapshot_dependents and snapshot_locate's symbol index all omit those files' imports,
while `--with-dependents` used them. Two answers to "what imports this", one of them silent.

### Confirmed by reading tools.ts
- Eight tools in a deliberate order (tools.ts:1148-1160); the only writer is annotated WRITES
  with destructiveHint:false because it replaces only what it wrote.
- Every path argument goes through toRelativePath (177-192), which resolves against the root BEFORE
  testing for absolute, closing an existence oracle that the comment describes.
- Results are byte-capped at 64 KB with truncateToBytes (994-1010) and an unreachable-remainder
  case that says so instead of pretending to page (1002-1008, 1070-1073).
- snapshot_read serves the snapshot, never the working tree, so an excluded .env cannot be read
  back and a redacted credential stays redacted (module doc, 9-15).

## Read since (append)
src/mcp/workspace.ts 405 (full).

### Confirmed by reading workspace.ts — the MCP security boundary
- resolveRoot (95-124): stat, canonicalPath (realpath), then containment against every allowed
  root, case-folded on win32/darwin. A root argument cannot widen what the process reads.
- outDir argument is confined SEPARATELY from the configured outDir (217-240): the config may
  legitimately point one directory up, a prompt may not. resolveThroughExistingAncestor (74-85)
  catches a junction that does not exist yet by resolving the deepest existing ancestor.
- includeSensitiveFiles is deliberately absent from WorkspaceOverrides (138-140, 175-178):
  "a tool that emits .env on request is a secret-exfiltration primitive with a friendly name."
- Each override is validated and a bad value is a tool error, never a silent default (197-254).
- partPathFor (301-331): rejects traversal lexically AND by lstat isFile AND by realpath dirname,
  because MCP clients auto-approve read-only resources and a symlinked part name would otherwise
  read ~/.ssh/id_rsa through snapshot://parts/{n}.
- readManifest (334-400): shape-checked by the same describeManifestShapeProblem the CLI uses,
  cached by mtime+ctime+size (ctime catches same-size overwrite), bounded at 8 entries.

### D21 — a manifest the MCP server cannot serve is still "valid" to validate? (open thread)
workspace.readManifest refuses a manifest describeManifestShapeProblem rejects. validate uses the
same guard. But NEITHER requires `incomplete`, so both accept a 3.0.0 manifest with no completeness
record at all — the same gap as D16, seen from the MCP side. Not yet probed end-to-end over stdio.

## Read since (append)
src/security/patterns.ts 641 (full, 31 rules).

### Confirmed by reading patterns.ts
- Every quantifier is bounded, and the comments record the measured quadratic cases (jwt-token 1.22 s
  for a 200 KB line; env-secret-assignment 5.6 s for 240 KB before bounding).
- Rules are line-oriented; PEM spans lines and lives in redact.ts (616-640).
- Names match as TAILS so dbPassword/apiSecret work; weak names (pass, credentials) only against a
  quoted value >= 8 chars; id-token deliberately excluded as a GitHub Actions permission (45-52).
- The `=` of `===` cannot be an assignment: ASSIGN is `(?<![=!<>])[:=](?!=)` (169).
- `${VAR:-fallback}` masks the FALLBACK only, and `:?` is excluded because that is a shell error
  message, not a value (560-568).
- env-secret-assignment requires an UPPERCASE name because `/i` let `key = fs.realpathSync(...)`
  in this very repository match KEY and mask a call expression (583-594).

### D6 (extended again) — two more orphan sites
src/security/patterns.ts:69-78 — "An unquoted value must be a literal..." documents no declaration
(the next block, 80-100, documents UNQUOTED_MIN_LENGTH, which is at 101).
src/security/patterns.ts:204-222 — the QUOTED_VALUE doc is followed by a second doc (223-240) for
quotedValueFor (241), so the first is attached to nothing. Total orphan/stack sites now 19.

### Cross-check while here
- CREDENTIAL_KEY_TAIL is `(?:STRONG)$` with /i, and is the same test redact.ts uses for
  assignmentAround, so the catalogue and the guards cannot disagree about what a key is.
- valueGroup numbering verified: credential-assignment and credential-assignment-weak use 2
  (group 1 is the delimiter), credential-assignment-unquoted uses 1.

## Read since (append)
src/ast/imports.ts 67 · src/tokenize.ts 76 · src/terminal.ts 114 · src/ast/ts-parser.ts 478 (all full).

### D22 — exportsKind: "esm" is unreachable and the doc says the opposite (Medium)
src/types.ts:46-53 declares exportsKind?: "esm" | "cjs" | "mixed" and documents
  "Absent means the file had no exports at all."
src/ast/ts-parser.ts:452-457 is the ONLY assignment in the tree:
  summary.exportsKind = summary.exports.length > 0 ? "mixed" : "cjs";
grep confirms the string "esm" occurs exactly once in src (the declaration) and no test asserts it
(tests/audit-0-9-16-remaining.test.js:344 asserts "cjs").
Two consequences:
  1. "esm" is a dead union member — no code path can produce it.
  2. Every ESM file WITH exports also leaves exportsKind absent, so the documented reading
     ("absent = no exports") is false for the ordinary case. A manifest consumer that trusts it
     skips the export list of every ES-module file.
Fix: set summary.exportsKind = "esm" when exports exist and none came from CJS, and correct the
doc. One test asserting all three values would have caught it.

### Nit — tokenize.ts doc vs code (Low)
src/tokenize.ts:23 says "a newline costs one", but LINE_BREAK_RUN is /\n+/ and the code adds the
number of RUNS (56), so a blank line costs one token for two newlines. The estimate is documented
as approximate, so this is a wording gap, not a budget bug.

### Confirmed by reading ts-parser.ts
- Explicit stack, not recursion: a long `a && b && ...` chain used to overflow inside the visitor (136-139).
- parseDiagnostics fast path with transpileModule fallback (186-193).
- Destructured exports bound by leaf name; CJS module.exports/exports.* recognised (45-110).
- Dynamic import() and require() count as edges, computed specifiers do not (300-312).
- Route handlers from App Router exports AND Express/Hono/Koa/Fastify registration (313-324, 343-347).
- reactComponents requires JSX or a React base class, not merely a PascalCase name (226-253, 387-395).

## Read since (append)
src/ast/structured.ts 257 · src/ast/skeleton.ts 160 (both full).

### D23 — two independent JSONC readers, one of them exported (Low-Medium)
src/config.ts:333-411 implements stripJsonComments + stripTrailingCommas (private).
src/ast/structured.ts:18-102 implements the same algorithm again; index.ts:3310 exports THIS one as
`stripJsonComments`, and cli.ts:792 (nextStepHint) calls the exported one while config.ts uses its
own. The config loader's comment (config.ts:69-72) exists precisely because a bare JSON.parse once
disagreed with the loader about whether a project was configured. That risk is now duplicated:
a change to one reader (CR-only comments, a new escape rule) silently makes `findConfigFile`/
`nextStepHint` disagree with `loadConfigFileDetailed` about the same package.json.
Fix: delete the private copy and import the shared one; a test asserting both readers agree on a
corpus (BOM, trailing comma, `//` in a string, CR-only) would pin it.

### D6 (extended again) — one more orphan
src/ast/skeleton.ts:31-36 — "Replaces the body of every function-like node, innermost-first, by
text span" sits above the isTsxFileName doc (37-45); the function it describes is
skeletonizeTypeScript at 70. 20 orphan/stack sites now.

### Confirmed by reading structured.ts / skeleton.ts
- Front matter must CLOSE and must look like YAML, else it is a horizontal rule (160-185); a fence
  is tracked with marker AND length, and an info string on the closing line does not close it
  (228-245) — that is what made shell comments inside examples become document headings.
- Skeleton is span-based, not a re-print: bodies are replaced in place so a diff touches only the
  bodies (10-14). Empty bodies are left alone (97-99). Outermost span wins (113-122).
- setParentNodes:false with getStart(sourceFile) so no second parse pass (75-79).

## Read since (append)
src/scanner/language.ts 68 · src/scanner/binary.ts 359 (both full).

### Confirmed by reading binary.ts (the decode contract)
Order is deliberate: BOM, then the NUL/UTF-16 shape test, then UTF-8 validity (218-230) — a UTF-16
file is mostly NUL and NUL is valid UTF-8, so testing validity first would return a NUL-filled
string. Four rejections after that: NUL with no UTF-16 shape; >0.5% control bytes even when the
UTF-8 is valid (249-261); >=32 undecodable bytes AND >=1/3 of the file (280-288, the Brotli case);
otherwise utf-8-lossy with an exact invalidBytes count so the warning can be honest.
isBinaryFile scans to the 8 MB cap and consults the UTF-16 shape before calling a NUL binary,
closes its descriptor in `finally` (the leak is named at 350), and returns false when unreadable.

## Generator batch next: audit, monolith, navigation, readme, sarif, tree.

## Read since (append)
src/generator/tree.ts 106 · monolith.ts 60 · navigation.ts 70 · readme.ts 114 · sarif.ts 154 (full).

### D24 — a line-truncated project tree is never warned about (Low)
src/generator/tree.ts emits two different markers: "[tree truncated at 20000 lines]" (97) and
"[tree truncated at 512 levels]" (99). src/index.ts:2842 detects ONLY the depth form
(/\[tree truncated at (\d+) levels\]/), so a repository whose tree hits the 20,000-line cap gets the
marker in the artifact and no warning in manifest.warnings. The truncation is visible only to a
reader who opens reports/project-tree.md.

### D25 — README silently claims emitted == source when the field is absent (Nit)
src/generator/readme.ts:58 `manifest.totals.emittedLines ?? manifest.counts.totalLines`. For a
pre-0.9.17 manifest the fallback states the source line count as the emitted count, so a snapshot
with previews reports that it emitted every line it read. Optional field, so the fallback is
harmless for current manifests — but it is the one place the README can overstate coverage.

### D26 — SARIF sorts with localeCompare, the one thing the artifact writers avoid (Low-Medium)
src/generator/sarif.ts:122-127 orders results with `localeCompare`. src/generator/tree.ts:7-9 says
explicitly that the tree uses code-unit comparison because localeCompare "sorted differently
depending on the machine's locale/ICU data", and src/terminal.ts:101-111 exists for the same reason
for numbers. Two machines generating the same repository therefore produce different audit.sarif
bytes (case/accent ordering), a different recorded sha256, and a `diff` that reports a change that
is not a change. Fix: compare with < / > like childKeys does.

### Confirmed by reading the generator batch
- monolith JSON embeds the manifest with artifacts.fullJson null plus selfReference (monolith.ts:9-18).
- monolith markdown re-fences each body with fenceForContent and normalises CRLF (25-47).
- navigation escapes link LABELS (brackets, parens, backslash) so a filename cannot become a live
  link, while the anchor stays byte-identical to what the chunker wrote (navigation.ts:5-18, 54-66).
- readme takes ResolvedArtifacts and never links to an artifact that was not written (8-42).
- SARIF rule ids are declaration-ordered for built-ins and name-hashed for custom rules, so an open
  code-scanning alert is not re-pointed by a config change (23-54); no line content is included.

## Read since (append)
src/generator/audit.ts 208 (full).

### D1 propagation — the off-by-one reaches four artifacts, not one
Consumers of FileEntry.includedLines, which counts the synthetic omission notice:
  1. chunker.ts:852-853 compactMetadata -> the `- Meta:` line in every part ("31 lines of 900"),
  2. index.ts:2640-2655 -> incomplete[].includedLines, beside omittedLines,
  3. index.ts:2745 -> totals.emittedLines (sum),
  4. generator/audit.ts:152 -> the "Included Lines" column of every truncated row in
     reports/audit.md, i.e. the artifact an auditor reads.
It now has five readers and every one of them states the inflated number.

### D27 — audit.md's "Cut by" column is wrong for section-metadata and filled for uncut files (Low)
src/generator/audit.ts:150 `cutBy = truncationReason === "part-budget" ? "maxPartBytes" : "largeFileBytes"`.
TruncationReason has THREE members: "section-metadata" (chunker.ts:533, when only the notice survives)
falls into the else and is attributed to largeFileBytes, but the bytes were removed by the part
budget's fixed metadata overhead. Separately, `affected` includes isLarge files that were NOT
truncated (133), so a row can read Status "Full" and still name a setting in "Cut by".

### Cosmetic
audit.ts:147-150: the comment block and `const cutBy` are indented 4 spaces inside a 6-space loop body.

## Read since (append)
src/mcp/index.ts 55 · instructions.ts 24 · uris.ts 20 · types.ts 117 · prompts.ts 64 (all full).

### CORRECTION — F4 was wrong (my tool's fault, not the code's)
F4 claimed src/mcp/run.ts was an orphan module imported by nothing. That is FALSE.
src/mcp/index.ts:22 does `export { createServer, runStdioServer } from "./run.js"`.
My first graph counted only ts.isImportDeclaration and ignored every `export … from` edge, so any
module reached only through a re-export looked orphaned.
Re-analysed with both edge kinds (and with NodeNext `.js` specifiers resolved to `.ts` — the first
re-run of the check silently resolved nothing for the same reason and produced 78 fake orphans):
  orphan modules: NONE
  src/mcp/run.ts inbound edges: 2
  exported symbols never imported by name anywhere in src: 77 (was reported as 139)
The remaining 77 are over-exposure, not dead code: mostly interfaces for the public surface
(JsonRpcRequest, AgentContract, SkeletonResult) and behaviour a module uses internally but also
exports (era.ts isLegacyVersion/isModernVersion/isSupportedVersion, cli.ts watch helpers exercised
by tests through the bundle).
Lesson recorded because it is the same failure mode as the rest of this report: a measurement that
looks authoritative and is wrong because the instrument was.

### Nit — two statements on one line (D7 extended)
src/mcp/index.ts:19 `export type { PartSection, Window } from "./part.js";export { buildPrompts } …`

## Read since (append)
src/mcp/protocol.ts 208 · schema.ts 132 · era.ts 207 · part.ts 221 · stdio.ts 184 · run.ts 167 (all full).

### Confirmed by reading the MCP protocol/transport layer
- Two eras in one file (protocol.ts:1-13): legacy handshake vs modern per-request _meta; era.ts:8-16
  states the rule and why getting it backwards breaks one era while looking correct in the other.
- A modern request with NO _meta after committing to modern gets -32600; one with a partial _meta
  gets -32602; an unsupported version gets -32022 plus data.supported so the client can retry
  (era.ts:125-179).
- Argument validation rejects unknown properties by default (schema.ts:21-26), which is what turns
  `maxPartByte` into a named error instead of a silently ignored option.
- stdio framing: newline-delimited JSON, never pretty-printed (stdio.ts:4-7); the 32 MB cap is
  measured in BYTES on complete lines and on the unterminated remainder, which is the hole a chunk
  carrying a discarded terminator plus the next message's start fell through (114-121, 140-150).
- run.ts admits at most 4 requests at once (88-135): ten concurrent snapshot_generate calls used to
  mean ten workers over one output directory; a request over the limit gets a typed -32001.
  Writes are serialised through one promise chain; reads are not, so a cancellation notification
  is still processed during a slow tool (61-78).

## Read since (append)
src/mcp/server.ts 480 · resources.ts 281 (full). MCP SUBSYSTEM COMPLETE (16/16 modules).

### Confirmed by reading server.ts / resources.ts
- A notification never gets a response, including on failure (server.ts:11-12, 384-393).
- Argument mistakes come back as a tool result with isError, not -32602, because a model can read
  and retry one and cannot read the other (server.ts:175-186).
- `initialize` is refused in the modern era and `ping` is refused there too, each naming
  `server/discover` (server.ts:298-315).
- A batch array is rejected with an explanation rather than -32700, since it parsed fine
  (server.ts:349-361); the session commits to an era even on a notification so a legacy client
  that sends `notifications/initialized` is not left gated (384-390).
- handle() never throws: a dispatcher failure becomes -32603 and the process survives (412-421).
- Resources are all-or-nothing: >512 kB is refused with the size, the limit and the tool to use
  instead (resources.ts:26-59), and a part's own description warns before the read (167-184).
- snapshot://manifest serves manifest.json's exact bytes when present (242), so incomplete[] IS
  reachable through a resource even though no tool mentions it.

## Read since (append)
src/agent/contract.ts 792 (full).

### D29 — describe duplicates three tables that live in config.ts (Low-Medium)
src/agent/contract.ts re-states, by hand:
  fileNames      (664-674)  vs CONFIG_FILENAMES in config.ts:31-39 (+ package.json's snapshot key)
  ARTIFACT_DEFAULTS (126-134) vs DEFAULT_ARTIFACTS in config.ts:853-861
  config.settings (675-703)  vs SnapshotConfig + CONFIG_KEYS
Each is a second copy that can drift, and D3 shows the third already has: `describe` lists
`discovery` but omits `cwd`, `exclude` and `secretRules`, all of which the runtime accepts.
Suggest deriving the file list and the artifact defaults from config.ts the way `presets` and
`artifacts` names already are (653-663), leaving only the prose to maintain.

### Confirmed by reading contract.ts
- The contract documents the completeness fields in TWO places: workflow step 6 (289-296) and
  output.notes (716-718), including truncationReason and omittedRanges. So the documentation side of
  the 0.10 feature is complete; what is missing is validation (D16) and the MCP surface (D18).
- --large-file-bytes default 307200 with 'may not exceed it' (421-426) matches config.ts.
- Workflow step 1 deliberately compares only the MAJOR version, because @latest can lag the release
  (19-26, 246-252) — and says so inline.
- All option defaults match what I read in config.ts: outDir snapshot, tmpDir snapshot.tmp,
  maxPartBytes 307200, previewHeadLines 80, previewTailLines 40, min budget 4096 / 1024 tokens.

## Read since (append)
src/agent/option-scope.ts 231 · src/agent/skill.ts 176 (full).

### Confirmed
- option-scope.ts is the ONE table both consumers read: the parser rejects an out-of-scope flag and
  `describe` renders `appliesTo` from it (option-scope.ts:4-13, cli.ts:568-600).
- `optionAppliesTo` always returns the explicit slash list; the old "all commands" prose read as a
  single command named 'all commands' to a machine (221-230).
- skill.ts is a template, not a shipped file, so `skill`, `skill --install` and the CLI cannot drift
  from the package version (17-25). It documents incomplete[] and summaryOmittedReason (102-119).

## Read since (append)
src/agent/hook.ts 274 · install-skill.ts 194 (full). AGENT SUBSYSTEM COMPLETE (5/5).

### Verified
- PRESETS.length = 25 and contract.presets = 25, so the skill's "the 25 project presets" is correct
  (skill.ts:66). Contract surface: 32 options, 27 config settings, 10 commands.

### Confirmed by reading hook.ts / install-skill.ts
- The pre-commit hook FAILS CLOSED: no manifest -> exit 1 unless CODEBASE_SNAPSHOT_ALLOW_MISSING=1
  (hook.ts:67-79). It guards the manifest, not the directory, because a failed run leaves a
  directory with no snapshot. It runs `npx --no-install` so a commit can never install anything.
- The hook path comes from `git rev-parse --git-path hooks`, the only answer that honours
  core.hooksPath (Husky) and a linked worktree (182-195); a hooks dir outside the repo is refused.
- A .git file is repository-controlled input: a cloned archive could point it anywhere, so only an
  in-repo target or a back-referenced registered worktree is accepted (124-155).
- Someone else's pre-commit is never replaced and there is deliberately no --force (10-15, 239-250).
- skill --install checks the TARGET path for a symlink/junction, for nlink>1 (a hard link cannot be
  detected by realpath), and resolves the nearest existing ancestor before creating anything
  (install-skill.ts:46-106). It writes only .claude/skills/<name>/SKILL.md and .cursor/rules/<name>.mdc,
  never AGENTS.md, and gitignores only what it created (136-189).

### Open thread (verify later)
hook.ts bakes the outDir into the shell guard but the `validate` it runs has no --out-dir:
the guard reads $SNAPSHOT_DIR while validate re-resolves outDir from the project config. They agree
when the config is what named the directory (setupHookOutDir resolves it for the reused-config case),
and can disagree if --out-dir was passed only to the install command. Test with the hook tests when I
read tests/*hook*.

## Read since (append)
src/gitignore.ts 160 · src/stdout.ts 111 (full).

### Confirmed by reading gitignore.ts / stdout.ts
- appendGitignoreEntries round-trips the file's own encoding (BOM-detected UTF-8/16LE/16BE) and
  REFUSES rather than rewriting when the bytes do not survive a decode/encode round trip
  (gitignore.ts:28-70, 116-123) — a UTF-16LE .gitignore used to become binary noise.
- Dedupe canonicalises the spelling git treats as equivalent, so `snapshot`, `/snapshot/` and
  `snapshot/` no longer append a fourth entry on every init (79-85, 134-136).
- Line endings follow the file's own (139-140); a .gitignore that is a directory is a note, not an
  EISDIR abort after the config was already written (112-114).
- stdout.ts has ONE router with reference counting and two AsyncLocalStorage scopes, because two
  independent patches of process.stdout.write restored each other's closures and silently
  discarded every later write, including the JSON document (stdout.ts:9-21).
- The restore only happens when process.stdout.write is still our router, so a later replacement by
  something else is not discarded (80-87).

## Read since (append)
src/scanner/changed.ts 179 · src/scanner/dependents.ts 394 (full). SCANNER COMPLETE (5/5).

### Confirmed by reading changed.ts / dependents.ts
- git output is used VERBATIM: neither trim() nor a backslash rewrite, because a POSIX name may
  begin/end with whitespace and a backslash is legal (changed.ts:33-40).
- `--changed-since` uses `<ref>...HEAD` (merge base), NOT two dots, plus the working tree against
  HEAD plus untracked files (124-148); a ref starting with `-` is refused as flag injection
  (93-100). `--staged` reads bytes from the INDEX via `git cat-file blob :<path>` (72-82).
- One resolver for three callers (generate --with-dependents, explain, validate) so the three
  cannot disagree about the import graph (module doc, 1-12).
- Case folding is a PLATFORM property and never overrides an exact match (66-74) — the folded maps
  used to be consulted on Linux and invented edges node would not follow.
- tsconfig baseUrl/paths read with TypeScript's own API so `extends` and comments behave like the
  compiler (91-146); a malformed tsconfig means no aliases, not a failed snapshot.
- Tombstones (extraPaths) make a deleted module's edge resolvable without pretending it is in the
  snapshot (184-197, 235-241).
- One hop only, tested against the ORIGINAL changed set, because extending it walked the graph
  transitively and made the result depend on file-name sort order (374-393).

## Read since (append)
src/diff.ts 439 (full).

### D30 — the secret-rule "registry" three comments describe does not exist, and diff cannot mask custom rules (Medium)
Evidence from call sites: every module that masks passes the resolved rules —
  explain.ts:155, index.ts:687, generator/audit.ts:25, validator/validate.ts:38/725/812/1188,
  scanner/files.ts:470/474/1421 all pass config.secretRules (or an explicit extraRules).
diff.ts is the ONLY caller that passes none, at three sites: 97, 126, 332.
And three comments assert the opposite:
  config.ts:1416-1419 "Registered so `collectFiles` scans *paths* with the same rules …"
  config.ts:1597-1600 "…every scan reads it through the registry in `scanner/files.ts`."
  diff.ts:328-330   "Default rules plus the rules `resolveConfig` registered apply."
grep finds no registry symbol at all: `pathScanRules(extraRules)` returns DEFAULT_PATH_RULES when
undefined, and nothing registers anything process-wide. The mechanism was replaced by explicit
parameter threading and the comments (and diff) were left behind.
Consequence: `compareManifests(before, after)` takes no config, so it STRUCTURALLY cannot apply a
repository's `secrets.customPatterns`. A path protected only by a custom rule is printed by
`diff` (text and --format json) exactly as `generate` would have masked it. Also affects
describeLayerChanges (97) and describePartChanges (126).
Fix: pass the resolved rules into compareManifests/loadManifest (the CLI already resolved a config
for every other command) and delete the three stale comments.

### Confirmed by reading diff.ts
- PayloadDiff exists because a settings change that repacks identical sources used to print
  "0 changed, N unchanged" (18-28, 156-241).
- Part arrays are compared entry by entry (105-154), independent of `differs`, so a renamed or
  repacked part is visible even when a source edit already turned the payload block on (430-436).
- A manifest with no config digest is reported as "configuration not compared", never as identical
  (201-211, 418-428).
- loadManifest uses the same describeManifestShapeProblem as validate/report/diff (372-381).

## Read since (append)
src/update-check.ts 378 (full).

### CORRECTION — the tool DOES read environment variables
An early scan of mine reported "no env var is read by the tool at all", based on a regex over
`process.env.X`. That was wrong twice over: it also matched only property access, and the two hits
it did find (SECRET, TOKEN) are regex *content* in patterns.ts/redact.ts, not reads.
The real surface:
  CI                                    update-check.ts:189 (anything but ''/false/0 disables the check)
  CODEBASE_SNAPSHOT_NO_UPDATE_CHECK      update-check.ts:184-187
  CODEBASE_SNAPSHOT_ALLOW_MISSING        agent/hook.ts:71-73 -- read by the generated SHELL hook
  TEMP/TMP/TMPDIR                        scripts/test-run.mjs (redirects the scratch root)
  npm_config_* / npm_lifecycle_*         cli.ts:962-970 (filtered for the child install)
No documented env var is missing from that list as far as I have read.

### Confirmed by reading update-check.ts
- One GET, no query string, no telemetry (1-20); never in CI, a pipe, JSON mode, or the MCP server.
- Cache: a known upgrade is trusted a day, "you are current" an hour, a FAILURE an hour (30-48).
- installKind classifies by script path so the notice names the right command for npx / local /
  global installs (58-97).
- The timeout is a WALL CLOCK, not request.setTimeout, because a trickling proxy kept the process
  alive past the deadline (252-286).
- isNewer refuses to announce a prerelease over a stable, and does announce a stable over the
  prerelease of itself (134-154).
- shouldCheck parses --format last-wins like the CLI parser and stops at `--` (197-217), after
  matching the substring 'json' anywhere used to silence the check for `explain package.json`.

## Read since (append)
src/wizard/autopilot.ts 125 · src/wizard/config-template.ts 205 (full).

### Confirmed by reading the template
- The generated config writes 27 top-level keys and is complete for SnapshotConfig except `cwd`
  (correctly absent: it is relative to the file). It ALSO writes `discovery` (config-template.ts:158),
  which is the one key SnapshotConfig does not declare — D3 confirmed from the writer side.
- The plain-object, no-import header is deliberate: `init` usually runs through npx, where the
  package is not installed, so a `defineConfig` import made the generated file unloadable by the
  very next `generate` (64-74). That is also WHY nobody noticed D3: the file is never type-checked.
- Anonymous default export avoided because eslint-config-next reports it (89-94, 200-203).
- DEFAULT_ANSWERS: maxPartBytes 300k AND largeFileBytes 300k (equal is legal; > would be refused).
- planFirstRun order: empty -> refuse(1), autopilot -> setup(false), hasConfig||hasPriorSnapshot ->
  generate, interactive -> setup(true), else refuse(2) (autopilot.ts:83-89).
- hasPriorSnapshot requires isOurGeneratorName, so a directory merely NAMED snapshot cannot silence
  the first-run question (116-125).

### Minor (not recorded as a defect)
config-template.ts:112 hardcodes tmpDir: "snapshot.tmp" and 124-125 hardcode 80/40 preview lines
rather than carrying them in WizardAnswers; no CLI flag sets them, so nothing can be lost today.

## Read since (append)
src/wizard/init.ts 853 (full).

### D31 — init ignores the wrong directory when outDir is not literally "snapshot" (HIGH, reproduced)
src/wizard/init.ts:458 `const GITIGNORE_ENTRIES = ["/snapshot/", "/snapshot.tmp/"]` is a CONSTANT,
while :835 appends it unconditionally and :850 returns `answers.outDir`, which honours --out-dir.
REPRODUCED: `init --yes --out-dir .context` in a git repo wrote outDir: ".context" into
snapshot.config.mjs, appended exactly `/snapshot/` and `/snapshot.tmp/` to .gitignore, and then
`generate` left `git status` reporting `?? .context/`; `git check-ignore .context/manifest.json`
exited 1 (not ignored). The output directory is therefore untracked-and-committable unless the user
happens to pick the default name.
This is the SAME bug class already fixed one layer away: src/agent/hook.ts:40-52 documents that a
hardcoded `snapshot` made a gate that silently never ran for any project with a custom outDir. The
gitignore writer never got the same treatment.
Fix: build the entries from answers.outDir and the resolved tmpDir (`/" + outDir + "/`), keeping the
leading and trailing slash, and add a test that init --out-dir X ignores X.
Note the comment above the constant also shows they thought about anchoring (455-457) — only the
 VALUE is hardcoded, not the anchoring.

### Confirmed by reading init.ts
- Config format choice: .ts only when Node strips types AND the project is ESM; .mjs otherwise, and
  it says which (cli stderr showed `snapshot.config.mjs` for a plain package.json).
- A package.json "snapshot" key blocks writing a config file unless --force, because the file would
  silently take precedence (822-828).
- package.json is rewritten preserving its own indentation and line endings (serializePackageJson),
  and a self-dependency is reported rather than written (404-417).
- Init never adds a dependency when one is already declared (407-419) and reports the range.
- `reuseConfig` is the difference between `init` (refuses) and `setup` (keeps) (51-59).

## Read since (append)
src/wizard/prompts.ts 560 (full). WIZARD COMPLETE (4/4).

### Confirmed by reading prompts.ts
- Pure renderers + a thin IO layer, so the selection logic is unit-testable without a TTY (1-13).
- Frame.erase counts SCREEN ROWS, not lines, and re-reads width on every draw, with two cells of
  slack for ambiguous-width glyphs (306-345) — an over-long hint line was one row taller than
  counted, and every keypress left a stale menu above the new one.
- Wrapping iterates code points and accumulates display width, so a cut lands on a cell boundary
  and never inside a surrogate pair (125-163).
- Non-interactive fallback prints the rendered frame and returns the default, so CI logs show the
  question that was answered for it (372-375, 420-423, 464-467, 507-510).
- A cancelled or backed-out prompt erases its frame in `catch` before rethrowing (395-402, 449-454).
- Reading real work: `text` treats `b` as a character but `←` as back; list prompts accept both
  (21-23, 352-355, 522-523).

### Nit
prompts.ts:535-536 backspace does value.slice(0,-1), i.e. one UTF-16 code unit, so it can split a
surrogate pair typed into a path field. Cosmetic; the field is validated on enter.

## Read since (append)
src/presets/registry.ts 140 · index.ts 16 · evidence.ts 78 · context.ts 391 · helpers.ts 88 ·
default.ts 49 (all full).

### D32 — a THIRD ownership predicate, this one only checks that the file exists (Low)
There are now three answers to "did this tool write this directory":
  1. version.isOurGeneratorName + full marker validation + per-file inventory  (index.ts:724-1254)
  2. files.ts:1030 isToolOwnedDirectory  -- marker parses, generator === GENERATOR_NAME, state
     complete, files[] is an array
  3. presets/context.ts:282 isToolOwnedDirectory -- fs.existsSync(dir/.codebase-snapshot) and nothing
     else, contradicting its own comment at 260-266 ("cannot be decided from a name")
Predicate 3 cannot tell a genuine snapshot from any directory containing a file of that name, so a
repository with such a file loses that subtree from the docs heuristic (markdownCount), which is
exactly the run-to-run instability the comment says it prevents. Predicate 2 is already available
and exported; reuse it.

### Confirmed by reading the preset layer
- Detection is data, ordered by (priority desc, name asc) at module load (registry.ts:54-70); the
  first detector that returns evidence wins, and every detector returns its REASON, not a boolean,
  so the wizard can print `Because next.config.ts` and autopilot is auditable (evidence.ts:3-12).
- An unknown forced preset throws with the shared message instead of falling back to detection
  (registry.ts:100-105); a missing fallback preset is a hard error (112-118).
- buildPresetContext reads the root ONCE and bounds every probe: 64 workspace packages, 256 markdown
  dirs, 4000 markdown files, 100 kB per manifest (context.ts:58-71).
- Workspace globs support pnpm-workspace.yaml's `packages:` block by hand-parsing only `- pattern`
  lines, `!` negations dropped, rather than adding a YAML dependency (164-188).
- markdownCount is 0 whenever the root has package.json, so ordinary repositories pay nothing
  (383-384).

## Read since (append)
src/presets/{shape-presets 90, nextjs 64, vite 52, node 46, js-presets 249, lang-presets 241}.ts
PRESETS COMPLETE (12/12). All 25 recommendedBudget values are "300k".

### D33 — the Django preset uses a prefix matcher with filenames (Low)
lang-presets.ts:29-31:
  layer("urls", "urls.py")
  layer("settings", "settings.py", "settings/")
`layer(name, ...prefixes)` matches filePath.startsWith(prefix) (helpers.ts:4-9), so those two
entries only match a file whose path BEGINS with 'urls.py'/'settings.py' — i.e. the repository root.
`app/urls.py` and `myproject/settings.py` fall through to `other`, although the same file also
defines kind `urlconf`/`settings` via suffixKind, which is the matcher that should have been used.
Fix: suffixLayer exists in helpers.ts and is never imported by any preset; use it here.

### Minor observations, recorded but not defects
- node.ts:35 kind `db` matches p.includes("db"), so `footer-db.ts` and `adbd.ts` qualify.
- node.ts:33 kind `type` matches p.includes("type."), so `prototype.ts` qualifies.
- nextjs/js presets are consistent about ordering route/handler before component, which is what
  makes `app/api/x/route.ts` a route rather than an app component.
- Framework presets require BOTH the framework and a build tool (vue-vite:155-161,
  react-vite:186-192) and report the framework as the reason, not the build tool.

## SRC COMPLETE — 88/88 modules read in full, line by line
types config index cli diff explain gitignore stdout terminal tokenize update-check bin version define-config ·
generator/{audit,monolith,navigation,readme,sarif,tree} · partitioner/{chunker,preview} ·
scanner/{binary,changed,dependents,files,language} · security/{patterns,redact} · validator/validate ·
ast/{imports,skeleton,structured,ts-parser} · ast/profiles/{index,shared,cfamily,dart,dotnet,go,graphql,
jvm,php,protobuf,python,ruby,rust,sfc,sql,swift,terraform} · mcp/{index,instructions,uris,types,prompts,
protocol,schema,era,part,stdio,run,server,resources,tools,workspace,generate-worker} ·
agent/{contract,hook,install-skill,option-scope,skill} · wizard/{autopilot,config-template,init,prompts} ·
presets/{registry,index,evidence,context,helpers,default,shape-presets,nextjs,vite,node,js-presets,lang-presets}

### Read since (append)
ast/profiles/{python 103, go 85, rust 85, jvm 81, dotnet 49, php 47, ruby 55, cfamily 81, sfc 75, swift 80,
dart 82, sql 63, graphql 65, protobuf 60, terraform 85} -- 15 profiles + index/shared.

### D6 (extended again)
src/ast/profiles/swift.ts:4-15 and 16-22 are two stacked doc comments; the first describes the profile,
the second describes MODIFIERS (23). The profile object at 31 has no comment of its own. 21 sites.

### Confirmed by reading the profiles
- Only sfc.ts reports quality "ast" (it hands the <script> block to the real compiler); all 14 others,
  including the SQL/GraphQL/Protobuf ones, report "heuristic" and the manifest says so.
- Profile-specific edge conventions exist so the resolver can tell a path from a package:
  `./` prefix for Ruby require_relative (ruby.ts:20-35), C `#include "x"` (cfamily.ts:33-37),
  Python `from . import models` expands to one edge per name (python.ts:39-48),
  Terraform `module` is an import and `provider:` is prefixed (terraform.ts:56-74).
- Swift exports only public/open (swift.ts:12-14, 48-58); Java needs an explicit modifier
  (jvm.ts:10-12), Kotlin/Scala are public unless hidden.
- Nested customisations that are easy to get wrong are handled: Swift's `class` is NOT consumed as a
  modifier, because doing so made `public final class Cache` parse as a declaration named Cache and
  every type in the language was missed (swift.ts:16-22).
- GraphQL operations land in routeHandlers so "where is this endpoint handled" spans REST and GraphQL
  (graphql.ts:6-9).

## Read since (append)
scripts/{sync-docs 154, assert-exact-spec 37, pack-check 179, readme-lint 88, check-site-links 163,
audit-site 192, seo-rank 214, build-site 693} — 8 of 11 scripts read (lint/test-run/check-workflows
were read in the previous round). scripts/ COMPLETE (11/11).

### D34 — two broken images on the LIVE homepage, and no check can see them (HIGH, reproduced live)
scripts/build-site.mjs:362 localises README images with `source.markdown.split(RAW).join("")`, where
RAW = https://raw.githubusercontent.com/<owner>/<repo>/main/ . A README <img> pointing at
`.../main/docs/assets/favicon.svg` therefore becomes `src="docs/assets/favicon.svg"`.
scripts/build-site.mjs:593-597 copies `docs/assets/*` to `site/assets/*` — NOT to `site/docs/assets/`.
So the rewritten path resolves nowhere.
REPRODUCED against the deployed site (2026-11-16):
  GET https://ankurhalder.github.io/codebase-snapshot/            -> 200
  page contains  src="docs/assets/favicon.svg"  and  src="docs/assets/how-it-works.svg"
  GET .../codebase-snapshot/docs/assets/favicon.svg                -> 404
  GET .../codebase-snapshot/assets/favicon.svg                     -> 200
Two images are dead on the published homepage: the hero logo and the how-it-works diagram.
WHY IT SURVIVED `npm run verify`, which is green:
  - check-site-links.mjs scans href=" only (lines 55, 93) — never src=.
  - audit-site.mjs:129-131 requires an <img> to carry alt, and never resolves its src.
  - audit-site.mjs checks og:image by resolving it to a file (107-108) — the one image check that
    does resolve, and it is the meta tag, not the body.
Fix: rewrite to `assets/` (strip `docs/`), or copy into site/docs/assets as well. Then add a rule

## Read since (append)

## COVERAGE: COMPLETE — every tracked file read or inspected
git ls-files gives 271 tracked files. Coverage:
  src/            88/88   every module, all profiles, mcp/, agent/, wizard/, presets/
  tests/         116/116  every test file including both helpers
  docs/           22/22   15 .md read in full + 7 assets inspected (see below)
  .github/        12/12   every workflow, issue template, dependabot, label config
  scripts/        11/11   every build/verify/lint/test script
  packages/create  4/4    index.mjs, package.json, README.md, LICENSE
  audit/           1/1    reports/0.9.16-verified-bugs.md (2 838 lines)
  root/           17/17   AGENTS, README, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, llms.txt,
                          CHANGELOG (2 932 lines), package.json, tsconfig.json, tsup.config.ts,
                          snapshot.config.ts, .gitignore, .gitattributes, .gitguardian.yaml, LICENSE,
                          seo-log.jsonl (8 records), package-lock.json
Generated output (dist/, site/, snapshot/) is excluded: it is reproducible from the above.

### Asset verification (docs/assets/README.md claims vs bytes)
  apple-touch-icon.png  180x180   claim '180x180'            MATCH
  social-card.png       1200x630  claim '1200x630'           MATCH
  favicon.svg           32x32     claim 'same 32-unit grid'   MATCH
  logo.svg / logo-dark.svg       32x32 both                  MATCH
  social-card.svg       1200x630                            MATCH
  how-it-works.svg      880x380                             consistent with a two-panel contrast
So the asset documentation is accurate -- which is what makes D34's shape precise: the files and
their sizes are right, and only the SITE'S REFERENCE PATH to two of them is wrong.

### Zero-dependency claim verified in the lockfile
package-lock.json: dependencies {typescript: ^5.0.0} and nothing else; devDependencies {@types/node,
marked, tsup}; 103 packages in the tree, all reachable from those devDeps. So AGENTS.md's 'The only
runtime dependency is typescript; keep it that way' is true of the SHIPPED tree, not just the manifest.

### The version history is documented, not inconsistent
CHANGELOG.md:7-12 -- 'This package started its public life as @ankurhalder/codebase-snapshot, which
reached 4.4.1. It moved to the unscoped name and RESTARTED AT 0.9.0 ... 0.9.0 is newer than 4.4.1, not
older.' And seo-log.jsonl records 4.4.1 then 0.9.0 on the same day, which corroborates it.
Consequence worth a Nit: test headers say '4.0.9 regression cover' / '4.1.0' / '4.1.1' and the changelog
has sections under those numbers in the OLD line, so a maintainer cannot map a test header to a 0.9.x
entry without knowing which line it came from.