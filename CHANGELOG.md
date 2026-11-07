# Changelog

All notable changes to `codebase-snapshot`.

---

## A note on version numbers

This package started its public life as `@ankurhalder/codebase-snapshot`, which reached 4.4.1. It
moved to the unscoped name and **restarted at 0.9.0**, so the numbers below are not a continuation of
the old line — `0.9.0` is newer than `4.4.1`, not older. 1.0.0 is reserved for when the CLI surface
is settled.

Two versions exist on the registry that are not releases, and both are deprecated:

| Version | What it is |
| :-- | :-- |
| `codebase-snapshot@4.5.0` | Published for about an hour under the new name before the scheme was reset to 0.9.0. Withdrawn, never the supported version. |
| `codebase-snapshot@0.0.0-stage` | npm's own staging placeholder, created automatically during the first publish of the name. Not a release. |

Deleting them requires account-level rights that the release pipeline does not have, so they are
deprecated with an explanatory message instead. `latest` has pointed at 0.9.0 since it existed.

---

## 0.9.13

A fourth audit, this time of the seams: places where two code paths answer the same question with
different rules, and places where a command accepts something it does not apply. Every item below
has a test that fails without it, except one — the per-layer budget overflow, which I could not
reproduce and which is called out honestly at the end.

### A scoped snapshot could expire and still validate

`validate` re-resolves the recorded changed-files scope and checks that every file it *skipped* as
`unchanged` is still outside that scope. It never asked the mirror question. So:

```bash
git add src/a.ts
codebase-snapshot generate --staged     # snapshot holds src/a.ts
git reset HEAD src/a.ts                 # same bytes on disk, nothing staged
codebase-snapshot validate --staged     # said: "Snapshot is valid and up to date"
```

The file on disk is byte-identical, so the hash comparison passed — and the scope the snapshot was
taken over had silently become empty. A file that is in the snapshot and would not be if it were
generated now is drift, and it is now reported, with `--with-dependents` still allowing for the
one-hop importer exception.

### A part name in `manifest.json` could reach any file on the host

`validate` has confined part filenames since 0.9.9, but the **MCP server** resolved
`parts[].filename` with a bare `path.resolve`, in `snapshot_read` and in the `snapshot://parts/{n}`
resource. A repository under review could commit a manifest naming `../../../.env`, and a client
would read it — resource reads are auto-approved as read-only. A part name is bare by construction,
so `describeManifestShapeProblem` now requires one, which makes all five readers (`validate`,
`report`, `diff`, `snapshot_read`, the resource) refuse the same manifest for the same stated
reason.

`snapshot_explain` had the mirror problem. `toRelativePath` resolved *after* its "is it absolute?"
test and `normalizeTarget` returned anything starting with `..` unchanged, so `../other-repo/.env`
was joined to the root and passed to `existsSync`: one read-only, auto-approved call per probe, for
any path on the machine. Out-of-root targets now answer `outside-root` without touching the
filesystem. A file named `..foo.ts` is no longer mistaken for a traversal.

### Four credentials that looked like code

- `password: "${DB_PASSWORD:-hunter2}"` — the shell and Compose idiom for a **default** — was
  exempted as "an interpolation" because it starts with `${` and ends with `}`. So was
  `${prefix}-real_secret-${suffix}` and any value with a `??` fallback. Only a value that is one
  interpolation of a plain (optionally dotted) reference is exempt now; anything else in the braces
  settles it the other way.
- `export api_key=hunter2` — bare `export` was in `DECLARATION_KEYWORDS`, so a shell assignment was
  read as a JavaScript binding whose initializer is an expression. `export` can never be followed by
  a bare assignment in JS or TS (`export foo = 1` does not parse), so the word only ever suppressed
  redaction for the files most likely to hold a secret.
- An **indented, unterminated** private key — `privateKey: |` in YAML, or an indented template
  literal — leaked every body line. The rule required base64 at column 0 and knew nothing about the
  RFC 1421 header lines (`Proc-Type`, `DEK-Info`) that an encrypted key puts after the marker.
- A masked key block in a **CR-only** file swallowed its line breaks, because pass 1 counted `\n`
  only, so every reported line number after it was wrong.

`.github/workflows/deprecate.yml` and `unpublish.yml` interpolated `${{ inputs.… }}` straight into
`run:` in jobs that carry `NPM_TOKEN`. GitHub expands an expression into the script *before* bash
parses it, so a dispatch input of `"; curl … $NODE_AUTH_TOKEN #` ran as a command. Inputs now arrive
through `env:` and are referenced quoted.

### Two enumerations, two answers

The same repository produced different snapshots depending on `--discovery`, which is the one
property a reproducible snapshot tool cannot have:

- A tracked **file symlink** was dropped as `symlink` in `git` mode — the loop tested
  `depth <= parts.length`, which includes the candidate itself — and emitted as a file by the walk.
- A **broken** symlink was `symlink` in `git` mode, because `targetReal` started at the link's own
  path and so always compared as "inside the root". It is `read-error`, or `outside-root` when its
  written target leaves the tree, in both modes now.

The output directory's crash leftovers had the same shape: the backup and partial-swap directories
were recognised by the hardcoded prefix `snapshot.backup-`. With `outDir: ".context"` an interrupted
run left `.context.backup-<pid>-<ts>` — a copy of the previous snapshot — to be scanned back in as
user source. The names now come from the resolved output and staging directories. `--watch` also
matched only `.backup-`, and only the directory itself, so an event for `part-001.md` *inside* a
`.partial-` copy was treated as a source edit: on a cross-device swap that is an infinite
regeneration loop.

### The index described files that were not there

- `summarizeMarkdown` called a leading `---` a front-matter block if *any* later line was `---`,
  so a document opening with a horizontal rule and using another as a section divider lost every
  heading between them. The block must now also *be* YAML — a heading, a fence or prose means the
  `---` was a rule. `...` closes a YAML document as well as `---`.
- The JSONC reader in `src/ast/structured.ts` ended a `//` comment only at `\n` and never removed a
  trailing comma, so a `.jsonc` or an editor-reformatted `tsconfig.json` summarised as
  `invalid-json` with no keys. Both are JSONC rather than extensions of it.
- `summarizeTypeScriptSource` looked at `ImportDeclaration` and `ExportDeclaration` and nothing
  else, so `require("./x")`, `import("./x")` and `import fs = require("fs")` produced no import
  edge. A CommonJS project had no import graph at all, and `--with-dependents` had nothing to walk.
  `export { a } from "./x"` was not recorded as a re-export either.

### Flags that were accepted and not applied

- `--only-artifacts audit` in a project whose config says `artifacts: { audit: false }` disabled the
  other six and left audit off too: nothing written, exit 0. The flag was forwarded only as its
  complement, and a suppression list cannot switch anything on.
- `findConfigFile` parsed `package.json` with bare `JSON.parse` while the loader used the JSONC
  reader, so a BOM or a trailing comma made the two disagree about whether the project was
  configured. And `"snapshot": []` counted as this tool's configuration, which skipped the setup
  question entirely.
- `--skeleton` covered `.ts`, `.tsx`, `.mts` and `.cts` while `ts.createSourceFile` parses `.js`,
  `.jsx`, `.mjs` and `.cjs` natively — so the files most repositories are made of were the ones it
  could not compress, and `.d.ts` files, which have no bodies, were the ones it did parse.
- Over MCP, `WorkspaceOverrides` accepted only `maxPartBytes` and `outDir`. `snapshot_validate`
  re-derives the configuration and compares digests, so a `--skeleton` snapshot could not be
  validated at all. `maxPartTokens`, `skeleton`, `sarif`, `changedSince`, `staged` and
  `withDependents` are now accepted by `snapshot_plan`, `snapshot_generate`, `snapshot_validate`
  and `snapshot_explain` — schema and application coming from one definition, so a tool cannot
  advertise a flag it would ignore.
- `npm create codebase-snapshot -- --preset=nextjs` ignored the preset: the shim parsed `argv` with
  `indexOf`, which finds nothing for `--flag=value`, treats a missing value as "not given", and
  ignores `--forse` entirely. `node:util.parseArgs` in strict mode now rejects all three by name.

### Configuration answers that disagreed with each other

- `loadConfigFileDetailed` did not attach `CONFIG_DIR_SYMBOL` — only `loadConfigFile` did — so
  `resolveConfig((await loadConfigFileDetailed(dir)).config)` scanned `process.cwd()`.
- `normalizeResolvedConfig` re-derived `artifacts` with `includeMonolith` as the default, so
  `{ ...resolved, includeMonolith: true }` produced a config claiming `includeMonolith: true`
  beside `artifacts.monolith: false`, and `generate` — which reads the map — wrote no monolith.
- `configDigest` hashed `budgets` with `JSON.stringify`, which preserves insertion order, so
  `{ docs, api }` and `{ api, docs }` produced different digests and `validate` reported drift for
  a snapshot nobody changed.

### Cost

- `pathScanRules` returned `[...DEFAULT_SECRET_PATTERNS, ...extraRules]` although
  `config.secretRules` already begins with those patterns: every file path, skip record and AST
  summary string ran all 30 built-in rules twice. `disableDefaultPatterns` also had no effect on
  paths while it worked on content.
- `globToRegExp` and `matchGitignorePattern` compiled a fresh `RegExp` per call — over a million per
  run on a 20 000-file repository with 55 patterns. Both are cached by pattern. A malformed
  character class no longer escapes as a raw `SyntaxError`: a `.gitignore` range like `[z-a]`
  matches nothing (which is what git's own `fnmatch` does), while the same range in a configured
  glob is reported as the configuration mistake it is, naming the pattern.
- `generateSnapshotAsync` resolved the configuration twice, and `validate` in the CLI re-read and
  re-parsed `manifest.json` to re-run a shape check the validator had already run.
- `pendingHooks` was drained only by `generateSnapshotAsync`, so a synchronous caller left one
  settled promise per output directory for the life of the process.

### Lifecycle

- Each `hooks.afterGenerate` installed its own `process.stdout.write` wrapper and restored it only
  if the current write was still its own. With two overlapping async hooks the first to finish never
  restored, and the second put the first one's wrapper back — permanently. There is now one scope
  and one wrapper, released by reference counting.
- The update check used `request.setTimeout`, an *idle socket* timeout that resets on every chunk:
  a trickling proxy kept the CLI alive indefinitely. It has a wall-clock deadline now, `.unref()`d
  so a pending check never holds the process open. And `isNewer` stripped prerelease tags before
  comparing, so `0.9.13-alpha.1` was recommended to everyone on a stable release and a stable
  release was never announced to anyone on a beta.

### Smaller

- `wrapOneLine` measured `room` in terminal cells and cut with `String.prototype.slice`, which
  counts UTF-16 code units. CJK text produced rows twice as wide as the frame believed, and a
  surrogate pair could be cut in half. The cut advances by code point now.
- Part numbering is decided **before** rendering, in one pass over every budget bucket, instead of
  partitioning each budget and re-numbering the merged set afterwards.

### What I could not reproduce

The audit reported that per-layer budgets caused parts to overflow their budget by seven to twenty
bytes when `renumberParts` rewrote their headers, and were then hard-clipped into a broken document.
**I could not make that happen.** I swept file sizes against a two-budget configuration and again
with six layers and eight kinds whose names are 180 characters long, and no part ever came out over
its budget, with or without the clamp. The arithmetic explains why: `partitionFiles` reserves about
2.2 kB of header room up front and shrinks sections to `budget - reserve`, so a rendered part sits
roughly 1.4 kB below its ceiling, and the header growth being reported is fourteen bytes.

The mechanism was removed anyway — the numbering pass now happens before rendering, so a fitted part
cannot be rewritten — but the claim was not verified, and this changelog will not pretend it was.
The four tests added with it pass on the previous build too; they pin the invariants the refactor
must not break rather than reproducing a defect.

## 0.9.12

A third audit, this time of what the snapshot *costs* as well as what it gets wrong. Two of the
defects were circular — `validate` demanded a flag it refused to accept — and one of them meant a
config file could not turn a setting on at all. Every item below has a test that fails without it.

### The parts were 32 000 tokens of duplicated metadata

Each file section carried nine metadata bullets and, for a TS/JSON/Markdown file, a
pretty-printed JSON summary of code that followed three lines later. On this repository — 234
files — that was **195 619 bytes, about 32 600 tokens, 12 % of the snapshot**, spent on a
`SHA-256:` line per file and on listing every variable and export immediately above the code that
declares it.

A section is now an anchor, a heading and one line:

```text
- Meta: src/other | typescript | full | 3 lines (63 B)
```

- The per-file `SHA-256` is **gone from the parts** and stays in `manifest.json`, which is the file
  a machine reads. `snapshot_read` used to fall back to it when a path was too long for the
  heading; it now matches the `<a id>` anchor, which is a digest of the exact `relativePath` and was
  already there — exact even for the 300-character paths the heading caps.
- The structural summary is **not printed for a `full` file**: `manifest.json` keeps it, and
  `preview` and `signatures` sections keep it, because there the body is not the file. A one-line
  string summary survives either way.
- `- Content Fingerprint:` stays in the part header (~22 tokens per part), which anchors an answer
  to a verifiable state of the repository.

Nothing else about the format moved, so `snapshot_read` and both structural parsers still read it.

### `validate` refused the flag its own comparison needed

`manifest.config.digest` hashes `skeleton`, `sarif`, `maxPartTokens`, `changedSince`, `staged` and
`withDependents`, and `validate` compared that digest — but `COMMAND_OPTION_SCOPE` allowed those six
flags on `generate` only. So a snapshot generated with `--skeleton`:

1. failed `validate` with "the settings differ from the ones this snapshot was generated with", and
2. failed `validate --skeleton` with "`--skeleton` does not apply to validate".

There was no way to validate it. `validate` now accepts all six, `explain` accepts the three that
decide its answer, and `report` accepts none: it reads the manifest and prints what is there, so a
generation setting would change nothing.

### A config file could not turn these four settings on

`parseArgs` returned `skeleton: values.skeleton === true`, so a run that did not pass the flag sent
**`false`** — and `resolveConfig` reads these as `cliOptions.x ?? config.x`, where `false` is an
explicit override. `skeleton: true` in `snapshot.config.ts` was silently turned off by every run
that did not repeat the flag on the command line. The same applied to `staged`, `withDependents`
and `sarif`. All four are now `undefined` when the flag is absent.

### `explain` and `validate` ignored `--with-dependents`

The generator widened a changed-files scope by one hop of importers; both readers compared the raw
path set. A file that was **in** the snapshot because it imported something that changed was
explained as `included: false, reason: "unchanged"`, and `validate` called the snapshot current
while a file it should contain was missing from it. The import graph moved to
`src/scanner/dependents.ts` so all three apply one rule, and `validate` now re-parses a recorded
`unchanged` skip only when the manifest says the run used `--with-dependents`.

### `setup` wrote a config its own snapshot did not match

`setup --discovery walk --large-file-bytes 100000` forwarded both flags to the generation it runs
and wrote the defaults into the config beside it, so a brand-new project's one-command setup
finished with a snapshot that `validate` immediately called drifted — three configuration
mismatches on the first run. `--max-part-tokens`, `--skeleton` and `--sarif` are now accepted by
`setup` too, and every one of them is written into the generated config as well as forwarded.

### Redaction that corrupted what it protected

Three shapes were found in this repository's own snapshot, where the tool rewrote its own
documentation and tests:

- **Prose.** `credential-assignment-unquoted` masked any word after `secret: ` or `token: `, so
  `indistinguishable from a secret: a` became `…from a secret: [REDACTED…]`. An unquoted value in a
  line-oriented format never continues after a space (`PASSWORD: hunter2` ends the line; `secret: a
  value` is a sentence), and a one-character bare value is not a credential. Quoted values keep
  their one-character floor — quotes are evidence somebody meant to write a value.
- **Template literals.** `` `… an empty token: "${appliesTo}"` `` had the interpolation masked,
  because `startsInsideStringLiteral` only looks at the character before the identifier. A value
  that is entirely `${…}` is an expression, so it is not masked.
- **Doubly-escaped quotes.** `JSON.parse('{"password": "p@\\"ssw0rdINVENTED"}')` — how every
  fixture that embeds JSON is written — emitted `"[REDACTED…]"ssw0rdINVENTED"`: a fragment of the
  credential in clear and a line that no longer parses. A quote after `\\` that is followed by a
  value character is an escaped quote in a deeper literal, and the value now runs to the real close.

### An async `afterGenerate` hook's files were not recorded

The hook is documented as the way to write your own artifact into the snapshot directory, and that
directory is only replaceable while `.codebase-snapshot` accounts for every file in it. Only the
*rejection* path re-shipped the marker, so an async hook that succeeded left its file unrecorded
and the next `generate` refused the directory as foreign. The marker is now re-shipped when the
hook settles either way, and only while it still records this run — the lock is released when
`generateSnapshot` returns, so a slow hook can outlive the snapshot it belongs to.
`generateSnapshotAsync` now awaits the hook, so a caller of the async API gets control back when
the snapshot is actually finished.

### Smaller fixes

- **`getGitInfo` used Node's 1 MB `maxBuffer`** where every sibling call passed 32 or 50 MB. On a
  repository with enough dirty entries, `git status` overflowed, threw, and the `catch` returned
  `isDirty: false` — reporting the dirtiest possible tree as clean. The limit is raised and shared,
  and an overflow now reports `isDirty: true`, because a buffer that large only fills when there is
  a great deal to report. All three git invocations use `execFileSync` instead of a shell string.
- **`.gitignore` character classes** were escaped as literals, so `*.[oa]`, `[Tt]humbs.db` and
  `log[0-9].txt` matched nothing in `--discovery walk` while working in `git` mode.
- **A layer or kind rule** was glob-translated only when it contained `*` or `?`, so
  `src/{api,web}/index.ts` fell through to a substring search and classified nothing; and a plain
  pattern like `test` used `String.includes`, so it matched `src/contest/a.ts`. Both now go through
  `matchesExclude`, which is the single implementation of "does this pattern select this path".
- **`export { handler as GET }`** and `export { GET } from "./handlers"` recorded the export but no
  route method, so those App Router routes had no `methods` in `manifest.indexes.routes`.
  `export default () => <div />` recorded no component for the same reason.
- **The last-resort clip** reserved room for its own truncation marker but not for the token count
  rewritten afterwards, so a part clipped to exactly its budget came back over it. `rehashPart` also
  estimated tokens from text that still carried the *old* number, unlike every other part.
- **Seven MCP tools ignored `outDir`**, so a snapshot generated into a custom directory could be
  written by `snapshot_generate` and inspected by nothing.
- **`snapshot_read`** replaced the line range with the preview note instead of adding to it, so a
  window into a preview came back with no `Lines X–Y of Z` at all; `signatures` was treated as a
  full file.
- **Every published file ended with a `sourceMappingURL`** pointing at a `.map` that
  `package.json#files` deliberately does not ship. The build no longer emits them.
- **`--watch` crashed on Node 18 on Linux**, where `fs.watch(cwd, { recursive: true })` does not
  exist before Node 20.13. The package declares `engines: >=18`, and the run wrote a snapshot,
  printed "Watching for changes", and *then* threw `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. It is now
  refused up front, with exit `2` and a message naming the version that works — and before anything
  is written. A watcher that cannot start for any other reason (`ENOSPC`, the Linux inotify limit)
  reports it as a message instead of a stack trace, and the snapshot it already wrote stays valid.
  Found by the release's own Node 18 job: 0.9.10 and 0.9.11 never ran one.

---

## 0.9.11

A second audit, run against 0.9.10's own output, found that several defects the previous release
believed it had fixed were still reachable, that the changed-files scope was applied one layer too
late, and that this repository's documentation had been quietly corrupted. Every item below is
fixed with a test that fails without it.

### The redactor was still editing the program

`credential-assignment-unquoted` exists for `.env`, YAML and compose files, where everything after
`NAME=` is a literal. In a source file the same shape is an **expression**. The bug is visible in
the 0.9.10 snapshot itself, in `parts/part-005.md`:

```
const SINGLE_TOKEN = [REDACTED: potential secret-like value omitted from snapshot][^\sA-Za-z0-9_]/g;
```

The regex literal's opening `/` was a legal match for `UNQUOTED_LITERAL`, so the pattern was
deleted and the line no longer parses — data loss in the artifact whose whole purpose is to
describe the code. Three changes close the class rather than the instance:

- an unquoted value must **begin** with a word character, so `/`, `+`, `-` and `%` can only
  continue one;
- a value followed by `[`, `{` or `(` is refused, because `const accessToken = tokens[0]` is a
  reference;
- a value that sits in a **declaration** is never a literal. `const`, `let`, `var`, `readonly`,
  `private`, `protected`, `static`, `declare`, `export` and `using` are recognised, walking back to
  the start of the identifier so the tail match (`TOKEN` inside `SINGLE_TOKEN`) is covered too.

The guard is bounded to a 40-character window: an unbounded version made a 236 KB line with 4,000
assignments cost 2.7 s, which the existing quadratic-scan test caught.

### A changed-files scope was applied after the scan instead of before it

`--changed-since` and `--staged` read, decoded, secret-scanned and TypeScript-parsed every file in
the repository and then threw all but a handful away. Because every aggregate was bumped inside
that scan, the snapshot inherited the repository's numbers:

- **`validate` failed on every scoped snapshot.** Unchanged files are recorded in `skipped[]` with
  reason `unchanged`, and `validate` then asked `wouldNowBeIncluded` about them — a question that
  only answers "is this text?" — so every unchanged source file was reported as `new file:` and
  the exit code was 1.
- **`manifest.layers`, `manifest.kinds`, `counts.largeFileCount`, `totals.redactedLines`** and the
  encoding/preview/parse warnings all described files the snapshot did not contain. A two-file
  snapshot reported the layer distribution and the secret count of the whole repository.
- **`explain` ignored the scope entirely** and answered `included: true` for exactly the files
  `generate` was skipping.

The scope is now resolved once, before the scan, and applied to the candidate list whenever
`--with-dependents` is not in play. The dependents case still has to scan first — it needs every
file's imports — so it narrows afterwards and recomputes the counts, the findings and the warnings
from what survived.

### `--with-dependents` walked the import graph transitively

The closure tested `keep.has(resolved)` while adding to `keep`, so `a.ts` changed pulled in
`b.ts` (which imports it) and then `c.ts` (which imports `b.ts`). Whether a two-hop file was
included depended on whether its name sorted after `b.ts`: the same repository produced different
snapshots depending on file names. The test is now made against the changed set, which makes the
closure exactly one hop.

### Root-anchored `.gitignore` rules never matched in `walk` mode

`readGitignoreRules` keeps the leading `/`, and the matcher it was handed compares against a path
with no leading slash — so `/build` could not equal `build`, could not prefix `build/x`, and could
not appear between two slashes. `/secret-notes.txt` silently kept its file in the snapshot.

The same delegation made the opposite mistake one segment down: gitignore(5) anchors a pattern
containing a non-trailing `/` to the directory holding the `.gitignore`, so `doc/frotz` ignores the
top-level one only, while `matchesExclude` matched `a/doc/frotz` as well. Both are fixed by using
the gitignore matcher (which already implemented `anchored || body.includes("/")`) for every rule
rather than only for rules containing a backslash. `matchesExclude` is left to configuration
excludes, where "match at any depth" is the documented behaviour.

### Spreading a resolved config with a new `maxPartBytes` changed nothing

`{ ...resolved, maxPartBytes: 64 * 1024 }` still satisfies `isResolvedConfig`, and
`normalizeResolvedConfig` kept the **old** `budgets` object. The partitioner reads
`budgets.default`, so the run produced 300 KB parts and the manifest recorded the 64 KB that was
ignored. `normalizeResolvedConfig` now normalises `budgets` against `maxPartBytes`, capping
per-layer budgets rather than replacing them.

A related inconsistency is fixed too: a config that sets only `budgets: { default: "100k" }`
recorded `maxPartBytes: 300k`, so one snapshot described two different budgets.

### Smaller fixes

- **The MCP worker URL was built with string interpolation.** `file://${path}` turns a Windows path
  into `file://C:/…` whose *host* is the drive letter, reads a `#` as a fragment and a `%` as an
  escape. It uses `pathToFileURL` now, through an exported `workerEntry()`.
- **`--sarif` and the monolith disagreed.** The log was rendered in the write phase, so
  `full-codebase.json` embedded a manifest with no `artifacts.sarif` while `manifest.json` had one.
  The log is rendered before the monolith is serialised.
- **`validate` never checked `reports/audit.sarif`** against its recorded digest. It does now: a
  security report uploaded to a third party is exactly the artifact that must be verified.
- **`--sarif` was missing from `configDigest`**, so two runs that write different directories
  compared equal.
- **`--skip-artifacts … --sarif` claimed nothing was written** while writing `reports/audit.sarif`.
- **SARIF rule ids were positional.** They were handed out by position in the sorted set of rule
  names a run happened to use, so adding one custom rule that sorts before the built-ins
  (`acme-key` does) shifted every built-in id by one and re-pointed every open alert. Built-in
  rules now take a fixed id from their declaration order and custom rules get an id hashed from
  their own name. This renumbers the built-ins once, relative to 0.9.10, and never again.
- **`generate --watch` generated twice on startup** — `runCommand` generated, then the loop
  generated again before any file changed.
- **`--watch` froze `outDir`/`tmpDir` at startup.** After the config moved them, the watcher saw
  its own output as user content and regenerated without end.
- **The pre-commit hook hardcoded `snapshot/`**, so a project with `outDir: ".context"` got a hook
  that printed "no snapshot found, skipping" and exited 0 on every commit — a gate that never ran.
  The directory is baked in at install time, and the guard tests `manifest.json` rather than the
  directory (a directory left by a failed run exists but holds no snapshot).
- **`--max-part-tokens 200` was silently raised** to the 1024-token floor. It is a usage error
  now, and the message talks about tokens rather than bytes.
- **The MCP line cap was bypassed** by an oversized line that arrived complete with its terminator,
  because the guard required the buffer to hold no `\n` at all. The cap now applies to every
  complete line.
- **`snapshot_locate` searched only half the summary.** `variables` (where a `const`, a Python
  constant, a Go `var`, a Rust `mod`, a C `#define` and a Terraform `variable` all land),
  `directives`, `frontmatterKeys` and JSON `keys` are searched too.
- **`snapshot_read` printed `Lines 1–0 of 1` for an empty file** and returned the *last* line when
  `fromLine` was past the end. Both are stated instead.
- **`.TSX` was parsed as `ScriptKind.TS`** — `isSkeletonizable` lowered the name and
  `skeletonizeTypeScript` did not.
- **Markdown summaries:** an unclosed `---` at line 0 swallowed every heading, a shorter fence
  inside a longer one closed it early, and a closing fence with an info string was accepted. All
  three follow CommonMark now.
- **Destructured exports were invisible.** `export const { a, b } = obj` and
  `export const [first] = pair` declare real exports and were dropped by an
  `isIdentifier` check.
- **`rehashPart` left `estimatedTokens` at its pre-clip value** after `enforceBudget` cut a part,
  and the part's own header kept stating the old number. Both are recomputed.
- **`setup --preset <unknown>` exited 1** where `init` exits 2, because the parse-time check was
  written for `init` only.
- **`describe` omitted all seven 0.9.10 flags and six config keys.** `describe` is the contract an
  agent reads instead of the docs, so this is the failure that matters most: the options simply did
  not exist as far as a machine consumer was concerned. A test now compares `CLI_OPTIONS` and
  `CONFIG_KEYS` against the contract in both directions.
- **`--changed-since` was passed to git as a positional revision.** A ref beginning with `-` is now
  refused before git sees it, and `--` separates revisions from paths.
- **`--skeleton --include-monolith` labelled a body-stripped file `inclusionMode: "full"`.** The
  monolith now keeps the full redacted body, so the label is true.

### Documentation and repository hygiene

- **Three sentences had letters eaten by interpreted escapes**: `\v` in "Validate", `\r` in
  "reports/", `\a` in "audit.md". A test now fails on any control byte in any tracked text file.
- **Four documents claimed the MCP server serves seven tools.** It serves eight. The count is now
  compared against the live tool list.
- **`publish:create` could not run.** `npm publish packages/create` is parsed by npm as the GitHub
  shorthand `ssh://git@github.com/packages/create.git` and fails with exit 128; it names
  `./packages/create`.
- **`check-site-links` accepted a sibling directory.** `resolved.startsWith(SITE)` is true for
  `../site-other`; the check requires the path separator.

---

## 0.9.10

An audit of this codebase, run against its own snapshot, found twenty defects, six performance
problems and seven missing capabilities. This release is all of them: every defect, every
performance problem and every capability named in that audit is in the tree, with a test that
fails without it.

### Redaction was corrupting the code it exists to preserve

The worst defects were in the secret scanner, and the evidence was in this repository's own
snapshot. Four false-positive classes rewrote valid statements:

- `[:=]` matched the first `=` of `===`, and the unquoted-value rules then read the remaining `==`
  as a credential. `clause.token === ts.SyntaxKind…` shipped as `clause.token =[REDACTED…]`, and so
  did `if (token === "--")`.
- `env-secret-assignment` carried `/i`, so an indented reassignment matched: `key =
  fs.realpathSync(stagingRoot)` was emitted with the call masked.
- Credential names are matched as a *tail* — that is what catches `dbPassword` — so a name inside a
  string literal matched, and the string's closing quote was taken as the value's opening quote.
  `["awsSecret:", "apiKey:"]` came out with two list elements welded together.
- `progressToken: "progressToken"` was masked as a credential. A camelCase value that spells its
  own key is a symbol-table entry, not a secret.

Reserved words are no longer credential literals either: `token = await refreshToken(client)` was
emitted as `token = [REDACTED] refreshToken(client)`.

### Scanning no longer depends on state outside the tree

- A `.gitignore` rule naming a nested directory (`public/build/`) never matched in `walk` mode: the
  candidate was reduced to its first path segment, which cannot equal a two-segment rule. The same
  bug dropped a regular *file* named `build` for a `build/` rule.
- How files are enumerated was held in a module-level variable written by `resolveConfig`, so two
  scans in one process could disagree, and the second inherited the first one's mode.
- `validate` did not exclude the tool's own output directory, so it counted `snapshot/` as files
  missing from the snapshot and reported a correct snapshot as drifting.
- `findSecretInPath` compiled thirty-plus `RegExp` objects per call, and it runs on every path and
  every string in every summary.
- `getGitInfo` spawns one `git status` instead of three `git` processes.

### The config digest now covers what decides a snapshot

Layer and kind *names* were hashed, not their matchers, so moving a layer from `src/api/**` to
`src/v2/**` produced an identical digest and `validate` said "valid and up to date" for a snapshot
whose files had all been reclassified. A rule's `flags` and `valueGroup` were missing too, and so
was `discovery`. `package.json`'s `"snapshot"` object now gets the unknown-key guard every other
config file already had, and `secretRules` is accepted in a config file as it already was in code.

### `setup` stops dropping the flags it was given

`setup` builds the inner `generate` command line by hand, and five settings were never copied into
it, so the run reported one configuration and generated with another. It also refused
`--discovery`, `--large-file-bytes`, `--max-monolith-bytes` and `--include-monolith` outright.
`--only-artifacts monolith` enabled *nothing*: it turns the six default artifacts off and relied on
the monolith switch to turn the seventh on, and neither `init` nor `setup` passed that switch along.

### Part budgets say what they enforce

- Every part records the budget it was built for. With per-layer budgets, verification compared
  each part with the *largest* budget in the run, so a part twice over its own layer budget passed.
- `renumberParts` rewrites headers, so the byte bound is re-applied after renumbering.
- A body cut twice reported only the second cut: a 1,000-line file reduced to a preview and then to
  ten lines said "11 lines omitted", because the count came from the preview instead of the file.
- Every part states its size in **tokens**, and `--max-part-tokens 32k` sets a ceiling a context
  window can be measured against. The estimate's method is documented, not hidden.

### Crash-proof locks, byte-accurate reads

- A run killed between creating its lock file and writing its pid leaves a zero-byte lock that
  named nobody, so `lockOwnerIsGone` answered "not gone" forever and every later run refused to
  start until the file was deleted by hand. Age is now the fallback evidence.
- `snapshot_read` truncated to its byte limit by slicing UTF-16 code units, returning up to three
  times the limit for multibyte text and able to split a surrogate pair.
- `snapshot_locate` could not find a symbol a file does not export — most of the code in most files
  — and could not find a Markdown heading at all. Layer and kind matched by exact equality while
  every other category used a substring.
- `findSection` compared a heading with the manifest's raw path, which differ once the heading has
  been capped or escaped; such a file became unreadable whenever another file shared its content.
- A watch loop had no `error` listener on `fs.watch`, so an `EPERM` or an inotify limit killed the
  process instead of being reported.
- The update check skipped itself when any argument contained "json", so `explain package.json`
  never asked.

### Fewer syscalls

`generate` read every included file twice — a chunked NUL scan, then a full read and a second scan
of the same bytes. Below the 8 MB scan cap the decode is the complete check on bytes that had to be
read anyway, so the pre-scan is kept only above it. `explain` and `validate` had the same double
read.

### New structure for six more languages

Swift, Dart, SQL, GraphQL, Protobuf and Terraform now have profiles. `src/scanner/language.ts`
already knew four of those extensions by name and no profile claimed them, so a repository in one of
those languages got a list of files and no idea what was inside them.

### The site keeps its own links

`README.md` writes absolute GitHub URLs so the same text works on npmjs.com; the site builder only
rewrote *relative* links, so a reader on the docs site who clicked a guide link on the homepage was
handed back to GitHub. In-repo links to published pages are rewritten now; other repositories and
files the site does not publish are left alone.

### Also

- `configDigest`, `classifyLayer`, `classifyKind`, `displayPath`, `lockPathFor`, `estimateTokens`,
  `findSecretInPath` and `getGitInfo` are exported.
- `manifest.config` records `maxMonolithBytes` and `maxPartTokens`.
- `scripts/sync-docs.mjs` propagates `package.json#version` to `src/version.ts` and
  `packages/create/package.json`, so a release cannot drift by forgetting a file. `--check` covers
  them.
- `scripts/pack-check.mjs` requires the MCP build outputs, and the three wizard test files share one
  fake-TTY harness.

### `snapshot_dependents`: the import graph, in both directions

`manifest.indexes.imports` already held enough to answer "what uses this file" —
`byFile` records every specifier, `centralFiles` ranks the most-imported files — but nothing
an agent could ask. So the one question that decides what to read next, *what breaks if I
change this?*, was answered by reading parts until the picture appeared.

The eighth MCP tool takes a path and a direction and returns both edge sets with the part each
neighbour lives in, plus the specifiers that resolve to nothing inside the snapshot
(`node:fs`, a package name) rather than silently dropping them. Resolution runs through the
generator's own `buildImportResolver`, so the tool and `centralFiles` cannot describe different
graphs — a test asserts the counts agree.

### `--install-hook` gates commits on `validate`

`docs/stale-context-is-your-bug.md` argues a snapshot is only trustworthy when something gates
on it, and `validate` is that gate — but wiring it into `.git/hooks` was thirty seconds of
manual work, which is the step a project skips. `init --install-hook` and `setup --install-hook`
write `.git/hooks/pre-commit`, which refuses a commit whose snapshot is stale and never installs
anything while doing it.

A `pre-commit` this tool did not write is left byte-for-byte alone, and the output names the line
to add instead: there is deliberately no flag to force the overwrite. A `.git` that is a *file*
(a worktree or submodule) is followed to the real git directory rather than failing with
`ENOTDIR`.

### `--changed-since` and `--staged`: review packs the diff

Reviewing a pull request with a model is the case this exists for: the diff is small, the
repository is not, and packing all of it costs a context window to answer a question about four
files.

`--changed-since <ref>` is the working tree against that ref — committed, staged and unstaged
changes all count, because all three are what a reviewer is looking at — **plus untracked
files**, which `git diff` never lists and which are exactly what a new feature starts with.
`--staged` is the index against `HEAD`, and `--with-dependents` adds the one-hop importers,
which is the context needed to change a file safely rather than merely the file that moved.

Files outside the scope are recorded in `skipped[]` with a new reason, `unchanged` —
deliberately not `excluded`, which means the user's own glob rejected the path. Every failure is
loud: an unknown ref, a directory that is not a git repository, and `--with-dependents` without
a scope are all errors naming the way out, because a ref typo that produced an empty snapshot
would read as "this change touched nothing".

### `--skeleton`: signatures instead of bodies

`docs/vs-repomix.md` concedes that a compression mode beats byte budgeting for a repository too
large to fit at all. This is that mode, built on the compiler that is already the one runtime
dependency: each function, method, constructor, accessor and arrow body becomes `{ /* ... */ }`
in place.

The rewrite is span-based rather than a `ts.createPrinter()` re-print, and that is the whole
feature — a printer normalises quotes, blank lines and comment positions, so a skeleton would
differ from its source everywhere instead of only where bodies were removed. Affected entries
carry `inclusionMode: "signatures"`, and the structural summary still describes the whole file.

### `--sarif`: the findings a CI gate can read

`reports/audit.md` tells a human what was masked, and nothing could *gate* on it: a CI job that
wanted to fail a build over a leaked key had to scrape markdown. `--sarif` writes
`reports/audit.sarif` in SARIF 2.1.0, which is what GitHub Code Scanning reads.

The artefact is deliberately austere: path, line, level and rule — and **never the value**,
because it is meant to be uploaded to a third party and a second copy of a secret in someone
else's retention policy is a new problem rather than a report on the old one. Rule ids are
stable across runs so an alert is not orphaned, and each result carries a
`partialFingerprint` so Code Scanning keeps an alert open instead of closing and reopening it
on every run.

### `snapshot_generate` runs off the JSON-RPC thread

The 0.9.4 measurement stands: a synchronous generate blocks the stdio server for about 7.5
seconds on a 3,000-file repository. In that window the process cannot answer `ping` or
acknowledge `notifications/cancelled`, and a client with a socket timeout reports a working tool
call as a dead server.

The work moves to a worker thread. A resolved config cannot cross a thread boundary —
`layers[].match` may be a function and `hooks.afterGenerate` always is — so the worker loads
the config file and applies the same CLI options the calling thread did, rather than receiving
values that would all look like explicit overrides. A worker that fails to start, exits without
posting, or throws is reported as a tool failure naming the reason; there is no quiet retry on the
calling thread, because that would hide exactly the condition this exists to avoid.

One consequence is documented rather than discovered: `hooks.afterGenerate` does not run for a
generation started from MCP, only for a CLI `generate`.

---

## 0.9.9

### `snapshot -version` now answers the question it was asked

Reported from a real terminal, by someone trying to find out which version they had:

```
> snapshot -version
❌ Unknown option '-e'. To specify a positional argument starting with a '-', place it at the
   end of the command after '--', as in '-- "-e"'
```

That message came from `node:util.parseArgs`, which reads `-version` as the short-flag cluster
`-v -e -r -s -i -o -n` and objects to the third character. It names something the caller never
typed, and it buries the actual mistake — one dash where two belong — which is exactly the
information a usage error exists to give.

Every token of that shape is now caught before the parser sees it and answered as a spelling
problem:

```
❌ Unknown option '-version'. Options start with two dashes — did you mean '--version'?
```

`-cwd`, `-help`, `-format` and `-dry-run` get the same treatment with their own long form
suggested. A token that is not an option at all (`-frobnicate`) is told to go after `--` instead of
being pointed at a `--frobnicate` that does not exist, and a cluster of short flags that *are* real
(`-vh`) still works.

### The update notice suggests the command that fits this copy

It said `npm install -g codebase-snapshot` to everybody, which is wrong for two of the three ways
people run this. `setup` deliberately adds the package as a **devDependency**, where `-g` installs a
second global copy that shadows the pinned one; an `npx` invocation is a cache entry that the next
`@latest` run replaces by itself.

The suggested command is now derived from the path Node is running: `-g` for a global install,
`npm install codebase-snapshot@latest` for a dependency of the project being worked in (npm rewrites
the entry where it already is, so a devDependency stays one), and `npx -y codebase-snapshot@latest`
for npx. The classification is `_npx` in the path for the cache, and `node_modules` under the
working directory for a local dependency — evidence rather than a guess.

## 0.9.8

### A wrapped menu no longer changes height under the cursor

Found while checking 0.9.7, by rendering it at 48 columns. The wrapping added there made a frame
the height it claimed to be, but the wrap point was measured from a line's leading whitespace — and
a selected row starts `  ❯ ` while an unselected one starts `    `. So the same hint wrapped one
word differently depending on whether the cursor was on it, and at some widths the whole menu grew
a row as you moved through it.

Continuation rows now line up with the *content*: the marker gutter is measured rather than guessed,
which keeps the wrap stable — and puts a wrapped hint under the label instead of two columns past
it, which reads better at any width.

`tests/wizard-frame.test.js` now also asserts that five repaints of the same menu are all the same
height, at 48 columns: the width where it used to flicker.

## 0.9.7

### The setup menu stops eating its own screen

Reported with a screenshot from a terminal about 70 columns wide: every keypress on `snapshot`'s
first question added another `◆ How should I set this up?` line, until 28 of them were piled above
the live menu.

The wizard repaints a prompt in place by moving the cursor up by the height of the last frame it
drew — and it counted that height in *lines*, while a terminal lays out *rows*. The recommended
answer carries the hint `node-lib · config · npm scripts · install · generate`, which makes that
line 83 cells wide. In a narrow terminal the terminal wrapped it into two rows itself, so the frame
was one row taller than the erase believed, and moving up one row short left the top of the old
frame behind. Every keypress. Notice that the leftover was always exactly one line: the question.

Frames are now wrapped to the visible width before they are drawn, so the height that is counted is
the height that is shown. Continuation lines keep their indent, a token longer than the line breaks
rather than overflowing it, and the width is re-read on every draw so a window that changed size is
measured as it is now rather than as it was. Two cells of slack are left for `◆ ❯ ◻ ←`, which some
fonts draw double-width.

No existing test could have caught this: every one of them pinned `columns` to 120, where nothing
wraps and the two counts agree. `tests/wizard-frame.test.js` drives the real wizard at 70, 60 and 50
columns, replays the escape sequences through a small terminal simulator, and asserts that the
screen shows one question rather than one per keypress. Putting the old arithmetic back turns three
of its seven tests red.

### Install pins in the docs are now maintained, not remembered

`docs/mcp.md` told clients to run `codebase-snapshot@0.9.6` in four places that have to change at
every release, and a comment marker cannot live inside a JSON fence. `sync-docs` now rewrites any
`codebase-snapshot@x.y.z` pin and the `Added devDependency:` examples by shape, so the next release
cannot leave a copy-pasteable snippet pointing at an old version. `@latest` is untouched.

## 0.9.6

### It tells you when it is out of date

The tool's claim is that you can prove a thing is current, so it now asks that about itself. After
a command finishes, if a newer release is published, it says so on stderr:

```
↑ codebase-snapshot 0.9.6 is available — you have 0.9.5.
  npm install -g codebase-snapshot
```

The constraints matter more than the feature, because this is a network call in a tool people run
in CI and behind firewalls:

- **One GET, no identifier.** `registry.npmjs.org/codebase-snapshot/latest` and nothing else. The
  registry learns that some machine ran this version; there is no telemetry, query string or install
  id.
- **It never runs where it costs something.** Not when stdout is not a terminal, not in CI, not in
  any `--format json` invocation, and never in `mcp` — the server still makes no outbound
  connections at all, which `docs/mcp.md` promises.
- **It cannot break a command.** A 1.2 s cap, every failure returns null, and a cold cache is a miss
  rather than an error. The request starts before the command and is awaited after it, so on real
  work it overlaps entirely and adds no wall time.
- **One request per machine per day.** A 24 h cache holds the answer; a *failed* check is remembered
  for one hour, so a single blip neither hides a release for a day nor retries on every run.
- **Off if you want.** `--no-update-check` or `CODEBASE_SNAPSHOT_NO_UPDATE_CHECK=1`.

### A tool argument that arrived as a string is no longer rejected

Reported from a real client session: the same `snapshot_read` call worked through one code path and
failed through another because the client serialised `fromLine` as `"1"`. A digit string is the same
value in a different spelling, and the caller cannot fix what their client did — so numeric fields
now accept it.

This is not a loosening of validation: only fields the schema declares as numbers are converted, only
strings that parse to a finite number are converted, and `"ten"` still fails with the type message.
`"1.5"` for an integer field still fails too.

### Also

- `--no-update-check` is scoped to the commands that can show the notice; it is not accepted by
  `describe`, `skill` or `mcp`, whose scope would make it a flag that does nothing.
- The `describe` contract gained the option, and the contract-diff test keeps it in step with the
  parser.

## 0.9.5

### Every question in the wizard is reversible

The first run asked five questions and accepted one answer each. Reaching the part-size question and
changing your mind meant killing the process and starting again — and at the review screen,
answering **No** to "Write this and continue?" threw the same cancellation Ctrl+C does, so "that is
not what I meant" ended the run instead of correcting it.

- **`←` goes back** on any list or text field, `b` on any list or confirmation. Each footer names
  the keys that question actually accepts: `text` takes `←` alone (`b` there is a character you are
  typing) and `confirm` takes `b` alone (`←`/`→` already mean yes/no).
- **Back is a step, not a restart.** The five questions are now steps — scope → part size →
  artifacts → credentials → review. Going back re-asks the previous one with your earlier answer
  still selected, and back from the first step returns to *"How should I set this up?"* rather than
  out of the wizard.
- **`No` at the review steps back.** It used to abort. Ctrl+C is still how you say stop.
- **Answers are rebuilt, not mutated.** Re-entering the scope step clears the globs it added, so
  choosing "skip tests", going back, and choosing "everything" no longer leaves `**/*.test.*` in
  the written config.

Four new tests drive real keypress events through a fake TTY, alongside the four that already
covered the forward path.

### A clean first run

Setup printed a Node `DEP0190` deprecation warning after installing dependencies: `spawnSync` was
given an args array *and* `shell: true`, which Node deprecated because the arguments are
concatenated rather than escaped. The Windows path now hands the shell one pre-formed command
string — both halves are fixed literals from `detectPackageManager` — and every other platform
spawns with no shell at all.

### Still untested here

The MCP server has not been run against a real client. Its protocol is exercised against the built
binary, but a client's own configuration, timeouts and approval prompts are theirs. That is the next
thing to check, not something this release proves.

## 0.9.4

### The snapshot is now something an agent can ask for

`codebase-snapshot mcp` serves the repository over the Model Context Protocol on stdio. Seven
tools, each answering one question an agent actually asks, and nothing that only looks useful:

| Tool | Question |
| :-- | :-- |
| `snapshot_status` | Is there a snapshot here, and what does it cover? |
| `snapshot_plan` | What *would* a generate at this budget include, and what would it drop? |
| `snapshot_generate` | Build it. The only tool that writes. |
| `snapshot_validate` | Is the context I was given still current? |
| `snapshot_locate` | Which part holds this symbol, route or file? |
| `snapshot_read` | Give me this window of this file. |
| `snapshot_explain` | Why is this path missing? |

Six are marked `readOnlyHint`, so clients can run them without a prompt; `snapshot_generate` is the
only one that asks.

### Both protocol eras, because they are not the same protocol

Revision `2026-07-28` removed the `initialize` handshake: requests carry their protocol version and
client capabilities in `_meta`, `server/discover` is mandatory, every result carries `resultType`,
and `ping` no longer exists. Every client shipping today speaks the older handshake. The server
answers whichever arrives first and never mixes them.

The eras also disagree about an unsupported version, and getting it backwards breaks one while
looking correct in the other: **legacy negotiates down** (the server answers with a revision it does
speak), **modern rejects with `-32022`** and lists what it supports so the client can retry. Both
paths have their own tests.

### Zero dependencies, including the protocol

`@modelcontextprotocol/sdk` is 4.5 MB unpacked with Express, Hono, Ajv, JOSE and Zod behind it. The
transport here is newline-delimited JSON-RPC in about 400 readable lines, which keeps the package's
single-dependency property intact and means the whole server can be audited in one sitting.

### Reads come from the snapshot, never from the working tree

`snapshot_read` extracts a file's section from the emitted part. That is why an excluded `.env`
cannot be read back, a redacted credential stays redacted, and a large file returns the bounded
preview the snapshot actually contains. The test asserts the strongest available property: the
secret value appears in no artifact the server serves.

### The contract does not lie about the server either

`describe --format json` gained an `mcp` block — tools, arguments, prompts, resources, protocol
versions — generated from the same objects the server serves. A test opens a live session, calls
`tools/list`, and compares it against the CLI's output, so a tool that exists on one side and not the
other fails the build.

### Known limitation, measured rather than assumed

Generation is synchronous. On this repository a `generate` takes **1.1 s**; on a synthetic
3,000-file tree it takes **7.5 s**, during which the server answers nothing else. That is under every
client's request timeout and well under a real monorepo's worth of files, so 0.9.4 runs it inline.
The number is in the docs, and a worker thread is the next change if reports come back that clients
time out.

### Ships alongside

- The README was cut from 2,311 to 1,814 tokens (measured by `readme-lint`, which counts URLs and
  code blocks too). The narrative lost about a third of its length; the command table, the preset
  names and the links stayed, because they are what a reader scans for.
- A `codebase-snapshot/mcp` subpath so another tool can mount the server in-process.
- `snapshot://` resources: the manifest, each part, the three reports, the contract and the skill,
  plus `snapshot://parts/{index}` as a template.
- Two prompts, `orient` and `keep-current`, both about order of operations rather than features.
- `--cwd` is the only directory the server may read; a `root` argument can name a sub-directory of
  it and nothing outside. `includeSensitiveFiles` is deliberately not a tool argument.

It does not install packages, write a config file, speak HTTP, or fetch a remote repository.

## 0.9.3

### The project now says what it is

Everything here already worked; none of it was visible. The pitch was "turn a repository into
an LLM-ready snapshot", which is the pitch every packer uses, so the one thing that is actually
ours — you can check the result — was buried in the fourth bullet of the second section.

The line is now **a snapshot you can prove is current**, and the mark is a frame closing on a
fingerprint. Both are consequences of the same idea rather than decoration: the artefact is
bounded, it is identifiable, and it can be compared later.

- **README**: a centred hero with the mark and the line, five badges, one command, and a
  diagram that draws the argument — a dump that was silently truncated beside a snapshot with a
  manifest and a validator. Nav links under the fold; the CLI reference moved to the site.
- **Brand assets** in `docs/assets/`: mark in light and dark ink, a favicon that carries its own
  plate so it survives both colour schemes, an iOS touch icon, and a 1200×630 social card. The
  design tokens and the reason each variant exists are written down beside them.
- **Two new pages**, both about problems we can name precisely: [stale LLM context is a
  bug](docs/stale-context-is-your-bug.md) and [how many tokens a codebase
  is](docs/codebase-token-budget.md).

### The site stopped being invisible when shared

Measured before the fix: twelve pages, every one declaring `twitter:card=summary_large_image`
with **no `og:image` at all** — so every share on X, LinkedIn, Reddit, Slack or Discord rendered
as a blank card — and no favicon anywhere.

- `og:image`, `og:image:alt`, dimensions, `og:site_name`, `twitter:image`, an author, a theme
  colour and a favicon set on every page.
- Titles rewritten query-first instead of `<heading> — codebase-snapshot`, which spent the part
  of a result a reader actually scans on a brand nobody is searching for yet.
- Descriptions written by hand at 90–165 characters; they used to be the page's first sentence
  cut mid-word at 158.
- JSON-LD gains `BreadcrumbList` everywhere, `author` on every node, `sameAs` to npm and the
  author's site, and an `image`.
- `llms-full.txt`: every page in one file, one fetch for a crawler that wants the corpus.
- The author's own site is now linked from every page (`rel="author"`), so the project hangs off
  a person rather than a repository.

### Two gates, because these defects survive builds

`npm run verify` now fails if either is violated:

- **`scripts/audit-site.mjs`** — title and description lengths, canonical identity, `og:image`
  present *and* the file it names exists at 1200×630, twitter card, exactly one `<h1>`, alt text
  on every image, parseable JSON-LD with a breadcrumb, favicon, sitemap coverage, and no page
  that renders `undefined`.
- **`scripts/readme-lint.mjs`** — a hero in the first lines, at least five badges, in-page
  navigation, alt text, and every relative link resolving to a real file.

### `snapshot` is the command now, and a first run sets the project up

*(Prepared as 0.9.2, which was never published — everything in it ships here.)*

Installing globally used to give `codebase-snapshot` plus a `snap` alias — a word that
collides with Ubuntu's snapd and with an npm package of the same name. `snap` is gone and
**`snapshot`** replaces it, pointing at the same file. The long name stays the canonical one, and
the bare word is what a global install puts on `PATH`.

The bare command is no longer a synonym for `generate`. In a project with no configuration it now
recognises the project, says **what it keyed on** — `Detected nextjs` / `Because next.config.ts` —
and offers the recommended setup in one keystroke: config, `.gitignore`, npm scripts,
devDependency, install, generate. Or it walks through every setting, with each question starting
on its answer, so pressing enter through the lot is the recommended setup spelled out. When
nothing matches, it lists the manifests it looked for and asks which preset is closest.

A project that already has a config, or that this tool generated before, skips all of it and just
generates — nobody is walked through setup twice.

**A first run never guesses.** With no terminal and no `--autopilot`, it exits `2` and names the
three ways forward instead of generating with defaults nobody chose.

```bash
snapshot                    # guided first run, then generate
snapshot --autopilot        # same, no questions
npx codebase-snapshot       # same, from a project dependency
```

### New: `--autopilot`

The whole setup with no prompts, from the default command: detect the preset, write the config and
`.gitignore`, add the npm scripts and devDependency, install with the project's own package
manager, then generate. It keeps an existing config, `--no-install` skips the install, and it
refuses an empty directory (there is nothing to snapshot and nothing to install into).

`--autopilot` and `setup` are one implementation with two entry points, so they cannot drift.
`--autopilot --no-config` is a usage error: one writes a config, the other promises to ignore one.

### Detection reports its evidence

`detect()` returns the signal that fired instead of a boolean, so every preset can say why it
matched — a filename, a dependency, a manifest line — and the setup prints it. A detection you
cannot check is a detection you have to take on faith. The fallback preset is now explicit
(`fallback: true`) rather than a detector that always returns true, which is what makes "I could
not tell what this is" a state the tool can be in and report.

### Other

- `naming the command still means exactly that`: `snapshot generate` runs on the documented
  defaults and writes nothing but the snapshot, as it always has.
- The wizard's part-size question now starts on the preset's recommended budget instead of a fixed
  120 KB, so a Next.js project no longer silently gets a third of the budget it was detected for.
- `describe` and the bundled skill state the non-interactive rule, the two bin names, and that
  `--autopilot` is the unattended path.

---
## 0.9.1

### The documentation now derives its version from `package.json`

A documented version is a promise about the release, and every one of them was hand-written — so they
rotted silently at each bump. The README still described a `0.x` line whose numbers appeared nowhere
in it, `SECURITY.md` advertised **"4.x supported"** on a project whose latest release was 0.9.0, and
both `setup` examples printed `4.4.0` and `4.1.1` as the dependency the command adds.

Versions now live in exactly one place, and `scripts/sync-docs.mjs` writes them into the documentation:

- Prose carries marked spans — `<!--@majorMinor-->0.9<!--/@majorMinor-->` — which GitHub renders as
  the value and hides as a comment.
- Code-block examples are matched by shape instead, because inside a fence an HTML comment is literal
  text and the marker syntax would leak into the page.
- `npm run verify` fails when anything is out of step, and `npm run site` and `prepack` both sync
  first, so the docs site and the published README cannot contradict the package they describe.

Changelog history is deliberately excluded. It records what happened at each version, and rewriting a
past entry would falsify that record rather than maintain it.

### Other corrections in this pass

- `SECURITY.md` supported versions: 0.9.x, with a sentence explaining why 0.9.0 is newer than 4.4.1.
- The README states the pre-1.0 contract once, in wording that does not go stale.
- The changelog opens with a note on the version numbering, so the registry's three versions are not
  a mystery to anyone reading them.
- The `v4.5.0` release and git tag were deleted; that version no longer exists on npm.

---
## 0.9.0

### The package is now `codebase-snapshot`, unscoped

**Breaking:** published as `codebase-snapshot` rather than `@ankurhalder/codebase-snapshot`.

The old name is **deprecated, not unpublished**, so existing instructions keep working:

```bash
npx @ankurhalder/codebase-snapshot generate   # still resolves, now prints a deprecation notice
npx codebase-snapshot generate                # the supported name from 0.9.0
```

Why: npm's search index ranks on text match rather than downloads — a package with a few thousand
weekly downloads outranks one with a hundred million when the query matches its name better — so a
name that *is* the phrase people search is the strongest free signal available. Doing this at
version 0.9.0 with no dependents costs one migration; doing it after documentation, articles and
tutorials all point at the scoped name costs far more.

The rename is not cosmetic. The package name is written into every ownership marker and every
manifest, and the output-directory guard compares it exactly, so renaming it naively would have made
**every snapshot written by 1.0–4.4.x unrecognisable to its own tool** — the tool would have refused
to update its own output. Ownership now accepts the legacy spelling and rewrites it to the current
name on the next run, so an existing snapshot keeps working and is upgraded in place.

### Metadata and discoverability

- `keywords` went from 9 to 20, chosen by measured position rather than intuition — phrases like
  `codebase-to-prompt` and `repo-to-llm` that describe how people actually ask for this.
- The `description` now contains the word "codebase" and names the clients people search for.
- The README's 16 relative links became absolute. On npmjs.com — the most-linked page the package
  has — every documentation link was resolving to a 404.
- The README states build provenance, which the release pipeline has been producing since 4.0.0
  without ever mentioning.

### Documentation site

The docs now have a crawlable home at <https://ankurhalder.github.io/codebase-snapshot/>, generated from
`README.md` and `docs/` in this repository, with a sitemap, its own `robots.txt`, an `llms.txt` at
the site root and a Markdown twin per page. GitHub's `robots.txt` blocks directory-tree and raw-file
paths and publishes no repository sitemap, so `docs/` had no crawlable entry point before this.

The GitHub wiki is closed. The same prose was being maintained in the wiki, `docs/` and the README
with no canonical copy; `Home.md` is now a single pointer and the other pages are one-line stubs so
inbound links keep resolving.

### New guides

- [Feeding a codebase to ChatGPT, Claude or Cursor](docs/how-to-feed-a-repo-to-claude.md)
- [Budgeting LLM context](docs/how-to-context-budget.md)
- Comparisons with [repomix](docs/vs-repomix.md), [gitingest](docs/vs-gitingest.md) and
  [code2prompt](docs/vs-code2prompt.md), each stating where the alternative is the better choice

### Tooling

- `npm run seo-rank` measures this package's position in npm and GitHub search for a fixed query
  set, appends to `seo-log.jsonl`, and `--check` fails when a query we hold slips. It runs weekly in
  CI.
- `npm run site` renders the documentation site; `scripts/check-site-links.mjs` fails the deploy on
  an unresolvable internal link.

---

## 4.4.1

### `setup` ran the install with npm's own environment, which could refuse it

Running `setup` through `npx` — the documented way — put the parent npm's resolved configuration
into `npm_config_*` variables, and the nested `npm install` inherited them. With an npm that
supports an `allowScripts` switch the child aborted with
`EALLOWSCRIPTS: --allow-scripts is not allowed in project-scoped installs`, so the install was
skipped and only a warning said so. The nested run now gets the caller's environment minus
`npm_config_*` (and npm's lifecycle variables), so it reads the project's own `.npmrc` and flags —
which is the point of using the project's package manager at all. A shim-based test pins it: the
package manager is invoked, and none of npm's config reaches it.
## 4.4.0

### One command that does the whole first run

`npx @ankurhalder/codebase-snapshot setup` — detect the project, write the commented config (only
when the repository has none; an existing one is kept byte for byte and the output says so), add
the npm scripts, the devDependency and the `.gitignore` entries, install dependencies with the
package manager the repository's lockfile names (`bun`, `pnpm`, `yarn` or npm), then generate
through the normal `generate` command so every guard, warning and JSON field is the same one a
plain run produces.

- `--no-install` skips the install: CI, an offline machine, or a lockfile the project's own tooling
  owns.
- A failed install is a warning, not a dead end — the snapshot is still generated, because the
  scripts resolve the package through `npx` until it is installed.
- `--dry-run` prints the plan and the config it would write, and writes nothing.
- `--format json` emits one document: `{ "setup": { … }, "manifest": { … } }`.
- The ownership guard is untouched: an `outDir` holding files this tool did not write is still
  refused (exit 1), and the refusal names the entries.

`init` keeps its old behaviour — it refuses when a config exists and needs `--force`, because
someone who typed `init` should be told. `setup` is the merge-friendly path.

### An outDir that holds only empty directories is replaced

Reported from a real repository: `generate` refused with "it holds no .codebase-snapshot marker
(found parts, reports) — remove the directory yourself" for a directory that held **no files**, just
`parts/` and `reports/` from an interrupted run. Replacing a tree with no files destroys nothing, so
the guard now treats it as empty. The walk is iterative, a symlink counts as content, and a
directory holding even one file is still refused without a marker.
## 4.3.0

### Node 18 and 20 actually run the suite now — and one of them was broken

`engines` has said `>=18`, and until this release no run had ever executed on 18 or 20: the publish
workflow ran `npm run verify` on one Node version only. The gate now runs on 18, 20 and 22 for every
release, and the first honest run found a real defect — see the next section. Verified locally on
18.20.4 and 20.19.4: 498 tests, 493 pass, 0 fail, 5 version-dependent skips.

### `validate` called an unreadable file "missing from disk" on Node 18

A Windows `Deny-Read` ACE makes Node 18's `statSync` throw `EPERM` and `existsSync` answer `false`,
so a file the user could not read looked *deleted*: `validate` reported "no longer exists on disk"
for a file sitting right there. The validator now asks why a path cannot be stat'd (`ENOENT` means
gone, `EPERM`/`EACCES` means unreadable) instead of trusting a boolean, and both drift classes are
deduplicated — an unreadable file is seen by the scan loop and the manifest loop.

### A base64-wrapped private key is detected

`LS0tLS1CRUdJTi…` is the base64 of `-----BEGIN `, so a wrapped key is found by its prefix without
decoding anything. The new `base64-private-key` rule takes the built-in set to 30; archives and
other encodings remain out of scope, and `SECURITY.md` now says which is which.

### A dependency manifest is data, not documentation

`requirements.txt` and its variants were classified kind `doc` because they end in `.txt`. They are
machine input, like `package.json`, so they are `data` now.

### The monolith explains the one field it cannot carry

`full-codebase.json` embeds a copy of the manifest, and a file cannot record its own sha256. The
embedded copy keeps `artifacts.fullJson: null` and carries a `selfReference` sentence pointing at
`manifest.json`, which holds the real byteSize and digest, instead of leaving the reader to wonder
why the two manifests disagree.

### Empty and trailing-blank line accounting is documented

`includedLines` counts content lines after CRLF normalisation and without a trailing empty element:
an empty file records `0` while the fence shows one empty line. That is the intended meaning of the
field, and `docs/output.md` now states it rather than leaving it to be rediscovered.

### The audit release

Every other change here came out of a full audit of the tool against eight real repositories and an
adversarial review of every module. The three defects that mattered most were all in the two
promises this package leads with — "never leak secrets" and "machine-readable output".

### Two ways a secret kept its tail

A quoted credential containing an escaped quote was masked only up to the backslash:
`JSON.parse('{"password": "p\"ssw0rd"})` was emitted as
`"[REDACTED: potential secret-like value omitted from snapshot]"ssw0rd"` — most of the value in
clear, and the line left syntactically broken. An unquoted value stopped at the first character
outside `[A-Za-z0-9_+=/-]`, so a percent-encoded token kept its tail:
`?access_token=abc%2Edef&scope=read` lost `abc` and shipped `%2Edef`. Both value classes now
describe the value they are masking — escaped pairs are consumed by the quoted rule, and `%`,
`:` and `~` are token characters — and the mask replaces the whole value.

### A compressed fixture was emitted as mojibake, at twice its own size

`.br` was missing from `BINARY_EXTENSIONS`, so ripgrep's 186-byte `sherlock.br` failed UTF-8
decoding instead of being recognised as binary: it was emitted `full` as 341 bytes containing 78
U+FFFD — the one case where the artifact is larger than its source and says nothing. `.br` (and
`zst`, `lz4`, `lzma`) are now in the list, and a second guard catches the next unknown format:
at least 32 undecodable bytes **and** at least a third of the file means binary. The bar is high
on purpose — a Latin-1 document is legitimately full of invalid UTF-8 bytes and must stay
`utf-8-lossy`.

### A config that exported nothing ran on the built-in defaults

`export default null;` was erased by a nullish fallback (`imported.default ?? imported`), so the
module namespace stood in for the config, every setting was ignored, and the run generated with
the defaults at exit 0. The loader now distinguishes "no default export" from "the default
export is null" and refuses with the same message every other wrong export gets.

### An unknown setting was dropped in silence

`{ maxPartByte: 4096 }` generated with the default budget at exit 0 — the typo was invisible, and
it is the silent fallback this project forbids. A config file (module, JSON or `.snapshotrc`)
now rejects any key that is not a setting, naming it and pointing at the generated config as the
list of what exists.

### `--format json` produced nothing when the arguments were wrong

Every usage error — unknown flag, unknown command, bad value, missing `--cwd`, wrong arity —
exited 2 with **0 bytes** on stdout, while the docs promised one parseable document per JSON-mode
invocation. The format is now read from raw argv before validation, so the error document is
emitted for usage errors too; the human line stays on stderr.

### An async hook could append to the JSON payload

The stdout redirect that keeps `console.log` inside a hook out of the payload wrapped only the
synchronous call. A hook that logged after an `await` appended its text after the JSON, so
`--format json` output was no longer parseable while the command still exited 0. The redirect now
lives until the returned promise settles, and the payload is written to the real stdout exactly
once.

### Truncation was invisible in the audit

`reports/audit.md` printed "✅ No files exceeded the large file budget" while a third of a
document was missing from the snapshot, because the cut came from `maxPartBytes` rather than
`largeFileBytes`. It is structural for the `docs` preset, whose 100 KB part budget sits *below*
the 200 KB large-file threshold. Section 3 now reports truncation from either cause, with bytes,
lines and a `Cut by` column, and `generate` warns when `maxPartBytes < largeFileBytes`.

### A part-budget cut carried no marker

When the part budget was the binding constraint the block simply stopped — no
`[N lines omitted]` anywhere, and the manifest said `truncated: true` while the artifact read as
complete. Every budget-forced cut now carries a marker naming the budget
(`… [19940 lines omitted: part budget 1887 B] …`), recomputed correctly when a second shrink pass
runs.

### The preview tail window lost lines on newline-terminated files

`content.split("\n")` yields a trailing empty element, which consumed a tail slot: a 10-line file
at `previewHeadLines: 2`, `previewTailLines: 2` emitted `line 1`, `line 2`, an omission marker and
**no tail at all**, while `includedLines` claimed one more line than the block carried. The tail
window and the omission count now describe what is emitted.

### A filename could inject a link into `reports/navigation.md`

The link label escaped `|` and control characters but not brackets, so a file named `b](b).ts`
produced `[src/b](b).ts](…)` — a live Markdown link to `b` — and `x](/evil).ts` linked to `/evil`.
The label is escaped; the link target and anchor are unchanged.

### A deep directory tree crashed the run

The project-tree walker recursed per directory, so a ~6,000-level chain overflowed the stack after
76 s and wrote **no snapshot**. The walk is iterative, the output order is unchanged, and the tree
is capped at 512 levels with a marker and a warning.

### One oversized text file aborted the whole run

A file over ~512 MiB of *text* threw `Cannot create a string longer than 0x1fffffe8 characters`
from inside the run, with no `skipped[]` record; the equivalent *binary* file was skipped
correctly. A decode failure is now a per-file `read-error` skip and the run continues.

### `validate`, `report` and `diff` now agree on what a snapshot is

`validate` called a manifest "valid and up to date" with `fingerprint` deleted, `report` printed
`undefined`, and `diff` rejected the same file. One shared guard now requires `generatedAt`,
`schemaVersion`, a 64-character lowercase `fingerprint`, `counts`, `totals`, `layers` and the
`files`/`skipped`/`parts` arrays, and all three commands use it.

### `diff` notices a schema or a parts change

A copy with `schemaVersion: "9.9.9"`, a deleted `parts` array, or a changed part digest was
reported as `+0 -0 ~0 =N unchanged`. `diff` now reports a schema mismatch as a difference and
compares part metadata by filename.

### `--discovery walk` now honours `.gitignore` escapes

`\#hashfile.ts`, `\!bangfile.ts` and `spaced\ .ts` were all *included* in walk mode while git
ignored them — the parser trimmed and sniffed first characters, and the matcher normalised `\` to
`/`. The parser follows gitignore(5)'s line grammar and an escape-aware matcher handles patterns
containing a backslash; plain `!` negation is unchanged.

### `init` writes the repository's real branch

The generated config always said `branch: "main"`, so on any repository whose default branch is
`master` or `vNext` the first `validate` printed a branch-mismatch warning the user never caused.
It now records the branch `getGitInfo` reports and falls back to `"main"` only when git cannot
report one.

### The contract publishes `check` and `--mode`, and stops over-promising `--option=value`

`check` is documented as an alias of `validate`, the hidden `--mode` selector is in
`describe.options` with its values and contradictions, and the help sentence now says
"value-taking options" — booleans never accepted `=true`.

### Documentation

The complete list of corrections is in the wiki and `docs/`: option counts, the removed `agents`
skill target, `--tmp-dir` (a config key, not a flag), the `--watch` message, the shipped README's
404 links (`CHANGELOG.md` and `SECURITY.md` now ship; the rest are absolute URLs), and
measurement-backed statements for determinism, text-mode output streams, monolith byte counts and
ignore granularity.

### The generated config was a lint warning in every Next.js project

`init` wrote `export default { … }`. `import/no-anonymous-default-export`, which
`eslint-config-next` enables by default, reports that inline form — so in the framework this tool
detects most often, the one file we tell people to keep and edit arrived flagged the moment it was
created. The object is now assigned to `config` and exported by name:

```js
const config = { /* every setting */ };

export default config;
```

Both forms load identically; only one is quiet. The reason is in the file itself, so deleting the
comment does not invite the warning back.

### A clean repository reported `Warnings: 156`

Every masked line was appended to `manifest.warnings` as `<rule> at <path>:<line>`, so a
repository with nothing wrong with it reported 156 "warnings" — the first thing a new user sees
after `init` + `generate`, and the reason a 583-file project looked broken. Worse, the summary
printed ten of them under that count with nothing to say the other 146 existed.

Redaction is not a warning: a masked value is the tool doing its job, while a warning says the
snapshot may surprise you. The two are now separate — the summary prints
`Redacted: N line(s) — values masked; see reports/audit.md` and keeps `Warnings:` for the things
worth acting on, and a warnings list longer than the ten-row preview ends with
`… and N more in manifest.warnings[]`. When `reports/audit.md` is disabled the manifest says the
per-line detail was not written instead of losing it silently. `manifest.totals.redactedLines`
carries the count for machines.

### One line of code was counted twice

`scanAndRedactSecrets` pushed a finding per (line, rule) pair, so an unquoted
`JWT_SECRET=<value>` — which matches both `credential-assignment-unquoted` and
`env-secret-assignment` — appeared twice in `reports/audit.md` on the same file and line and
inflated the total, making a 78-site repository report 156 findings. A finding is now one *line*
with `rules[]` naming every rule that matched it; the audit table has one row per line and a
`Rules` column that lists them.

### Artifact counts followed the generating machine's locale

`reports/audit.md` and the snapshot `README.md` called `toLocaleString()` with no locale, so the
same repository reported `1,24,976` lines on an `en-IN` machine and `124,976` on an `en-US` one —
different bytes from the same commit, which defeats diffing two snapshots or caching one. Both
generators now share `formatNumber()` with the CLI, which already pinned `"en-US"`.

## 4.1.1

### `init` left the package undeclared, so nothing reached `node_modules`

`init` wrote `npx @ankurhalder/codebase-snapshot generate` into `package.json` and no dependency
at all. `npm install` therefore installed nothing, every `npm run snapshot` resolved `@latest`
from the registry instead of a pinned copy, and the `npm install && npm run snapshot` it printed
as the next step could not have installed it. `init` now records
`devDependencies["@ankurhalder/codebase-snapshot"]` in the same single write as the scripts, and
leaves a range that is already declared — including a deliberate pin — untouched.

### `--minimal` wrote a config that documented nothing

The flag wrote only the settings that differed from the defaults, so a Next.js project received

```js
export default { preset: "nextjs" };
```

— 179 bytes listing none of the twenty-six settings, in the one file a user opens to change
them. The flag is gone: `init` always writes the complete commented config, and `describe` no
longer advertises an option the parser rejects.

### `skill --install` wrote a tool's documentation into the project's `AGENTS.md`

`AGENTS.md` is a repository's own agent contract — build commands, conventions, house rules —
not a registry for third-party skills. The install created it when missing, which meant a file
whose name claims the repository documents itself to agents, holding only this tool's text; and
it merged a marked section into it when present, editing a tracked file on the user's behalf.
It now writes only the two registries keyed by skill name —
`.claude/skills/codebase-snapshot/SKILL.md` and `.cursor/rules/codebase-snapshot.mdc` — and
appends exactly what it *creates* to `.gitignore`, so an install no longer turns a one-line
command into a decision about which untracked files to commit. A file that already existed is
never ignored, and a section left behind by 4.1.0 is reported rather than rewritten. To put the
skill in `AGENTS.md`, print it and paste it: `codebase-snapshot skill >> AGENTS.md`.

`init` also stops printing the tip that led there: an install's whole footprint is now the
config, `package.json` and `.gitignore`.

### A file's recorded bytes and lines described the file, not the block

`includedBytes` counted the final newline that the closing fence swallows — 6 290 of 6 344 files in
a real repository were off by exactly one byte — and a CRLF checkout, which is written as LF, was
over-counted by one byte per line. A bounded preview reported `head + tail + 1` lines, one more than
its block carried. Both numbers are now computed once, from the body after normalisation and after
the closing newline is dropped, and an invariant test compares every `### FILE:` block in every part
against the manifest entry.

### A large file was parsed for a summary the snapshot could not carry

A file above `largeFileBytes` is emitted as a head/tail excerpt, yet it was still parsed into an AST
and had every identifier masked so a whole-file summary could be attached — a summary describing
lines no artifact contains, which the partitioner then discarded. On a 1.9 MB source file that was
70% of the wall clock: 1.8 s / 283 MB peak RSS became 0.5 s / 105 MB. The manifest names every
skipped preview in one grouped warning; `summaryOmitted` is deliberately not reused for them,
because it means "dropped for budget" and the part prints that reason.

### `--format json` wrote nothing at all when a command failed

Progress goes to stderr and payloads to stdout, which meant a failed JSON-mode run produced an empty
stdout: an agent had to notice the empty string, then parse stderr prose and guess. Every failure now
writes one parseable document — `{ "error": { "message": …, "exitCode": … } }` — while the human line
stays on stderr and the exit code is unchanged. A successful run never carries an `error` key.

### Smaller corrections

- Masking no longer walks left through a URL path: `https://example.com/v1/<key>` was emitted as
  `https://example.[REDACTED]`, contradicting "only the matched span is masked".
- `explain` answers a file inside an ignored directory with the record its directory carries,
  naming the ancestor, instead of the weaker `not-discovered`.
- `package.json#snapshot` as an array is reported like any other wrong type instead of being
  silently ignored, and an unreadable config file names itself in the error.
- `init` no longer fails with a raw `EISDIR` when `.gitignore` is a directory — after the config had
  already been written. The `.gitignore` line is a convenience, so it is a note, and `init` finishes.
- `--format`'s scope is the same machine-readable eight-command list as every other option, and a
  test now fails if any option's scope regresses to prose or names a command that does not exist.
- The hook documentation says what "not awaited" does not mean: Node keeps the process alive while
  the hook's own timers and sockets are outstanding, so `afterGenerate` should stay short.
- The generators agree with each other: `full-codebase.md` escapes control and bidi characters like
  every other artifact, the snapshot `README.md` links only to reports that were actually written,
  and a layer or kind name containing `|` or a backtick can no longer break the table or the inline
  code span it is listed in.
- The wizard no longer treats `package.json` `"snapshot": []` as an existing configuration.- The README and `llms.txt` describe what 4.1.0 actually guarantees — the eleven skip reasons, the
  `encoding` field, discovery modes, the emitted-byte accounting — instead of the feature list from
  before the release.

---

## 4.1.0

### A UTF-16 source file was invisible, and a Latin-1 one was quietly mangled

Two encoding decisions were silent, and one was wrong in both directions. `generate` decided
"binary" from a NUL in the first 8 MB and then decoded with `buffer.toString("utf8")`, so a UTF-16
source file — which is half NUL bytes — was skipped as `binary` and vanished from the snapshot,
while a Latin-1 file was emitted with U+FFFD in place of every non-ASCII byte, and `validate` then
reported the snapshot as current because the hash covers the raw bytes.

Decoding is now explicit. A BOM, or the NUL padding of a BOM-less UTF-16 file, is recognised and
the file is transcoded; a file that is not valid UTF-8 is kept, decoded lossily, and labelled
`encoding: "utf-8-lossy"` with the count of undecodable bytes in `warnings`; a NUL anywhere in the
file — including past the 8 MB head scan, which used to be the end of the check — marks it binary
and `skipped[]` records the offset. `files[].encoding` is present only when a file was not plain
UTF-8, so its absence keeps meaning "clean UTF-8". `explain` answers the same question the same
way. Verified: 12 new tests covering both endiannesses, BOM-less detection, five classes of
invalid sequence, a NUL at byte 8388608, and hash stability across two runs.

### A file the tool did not write could be deleted without a word

Ownership checking had a hole with a nice name. `.gitkeep` and `.gitignore` were treated as
placeholders and subtracted from the set of entries belonging to somebody else, so a snapshot
directory this generator owned and that a user then added a `.gitignore` to was replaced — atomically,
exit 0, `manifest.warnings` empty — and the file was gone. A directory holding nothing but
`.gitkeep`, or nothing but a `.gitignore` (`*`, `!.gitignore`), was replaced without any ownership
evidence at all, because the placeholder shortcut fired before the marker was ever read.

Both are files a user creates; the generator never writes either into an output directory. They are
foreign entries now, so the run refuses and names them, exactly as it already did for `notes.md`.
`.DS_Store` remains the only tolerated entry, because Finder writes it and it carries no intent.
Verified: 6 new tests — owned directory plus `.gitignore`, bare `.gitkeep`, bare `.gitignore`, the
refusal naming the entry, `.DS_Store` still discarded, and a genuine snapshot still replaced.

### A directory named `snapshot` disappeared, and the manifest said nothing

The output directory was excluded from the scan by name, at every depth: `snapshot`,
`snapshot.tmp` and `snapshot.backup-*` were dropped before the branch that records a `skipped[]`
entry, so a directory the user committed under one of those names was missing from the snapshot
with no record anywhere — the exact omission `skipped[]` exists to prevent, and it contradicted
the documented promise that every discovered path is accounted for. `generate` and `explain` also
disagreed: one dropped the path, the other called it `not-discovered`.

Exclusion is now evidence-based. A directory is this tool's output when it carries the
`.codebase-snapshot` marker, and only the exact `outDir`/`tmpDir` paths a run is about to write are
excluded by name — so a first run still does not record its own output (two identical runs keep
producing identical manifests) while a user's directory with the same name is scanned like any
other. `snapshot` and `snapshot.tmp` also left the built-in ignore list, where they had been
second-layer protection for the same mistake. Verified: 5 new tests, including the same fixture
through the git and the walking discovery paths, a full generate that now lists
`snapshot/keep.md`, and the determinism guard that the second run does not record the first.

### A hook could kill a run that had already succeeded

`hooks.afterGenerate` ran after the snapshot was swapped into place. A hook that returned a
rejected promise was never awaited and never caught, so Node turned it into an unhandled rejection:
the process exited 1 *after* printing "Snapshot generated … Integrity: passed" and writing its
`--format json` payload, and nothing about the failure reached `manifest.json`. A hook's own files
were also missing from the ownership inventory, so the next run refused a directory the tool had
written itself, and a `console.log` inside a hook landed on stdout in the middle of the JSON
payload.

A returned promise is now tracked rather than awaited — this is a synchronous API — and its
rejection is recorded as a warning on the manifest and in the marker, which are re-shipped when it
lands. The marker is written after the hook for the same reason it now includes the hook's files.
stdout is redirected to stderr for the duration of the hook and restored afterwards, so the payload
channel stays pure. Verified: 6 end-to-end tests through the built CLI, including a rejected async
hook that must exit 0 with a parseable payload and a recorded warning.

### `validate` would read any file the manifest named

A manifest is an input, and `validate` treated it as trustworthy. It joined `parts[].filename`
onto `snapshot/parts` with `path.join`, which accepts `../../../some/file` and absolute paths, so a
manifest naming a file outside the snapshot made `validate` read that file and then report its byte
size — a read primitive, with a size oracle for the file it named, reachable by anyone who can
write a manifest. Part names are bare names by construction, so a name that does not stay inside
`snapshot/parts` is now a drift error and is never read. `explain`'s text form also re-spells
control and bidi characters in paths, layer names, kind names and part names, because a committed
`snapshot.config.*` can put a U+202E in a layer name and the terminal renders it.

Verified: 5 new tests — a traversal name, an absolute name, the byte-size oracle specifically
proven closed, a legitimate snapshot still current, and control characters escaped while accented
text passes through untouched.

### Also in this release

- **`--watch` reloads a module config.** Node's ESM loader caches by URL, so `snapshot.config.ts`
  (exactly what `init` writes) was never re-read: an edited config was ignored and a broken one
  was invisible while the run printed `passed`. The loader now evicts the CJS cache and imports
  with a per-load token. 6 tests.
- **`--watch` never drops an edit.** A change during a run, a change inside the post-run quiet
  window, and a source directory whose name matched the outDir basename were all lost silently
  while the manifest kept reporting `Integrity: passed`. 6 tests plus live repros.
- **JWTs are redacted.** Only three-segment JWTs with long signatures were masked; two-segment,
  padded, empty-signature and short-signature forms reached the parts verbatim. 8 tests.
- **Display hygiene.** Control, C1 and bidi characters in file and layer names are escaped wherever
  a path is displayed (parts, tree, navigation, audit, explain), raw bytes are kept in
  `manifest.json` and file bodies, and the snapshot README and part header say that contents are
  untrusted repository data. 12 tests.
- **The hint after `init` is runnable.** It printed `npm run snapshot` with no `package.json`, and
  a bare package name on re-runs. 4 tests. The scaffolder now records the tool in
  `devDependencies` at its own version instead of resolving it from the registry on first run.
  7 tests.
- **The linter ignores prose.** Content rules matched comments, so documenting why `console` is
  banned failed the lint that bans it.

### `validate` and `report` could be talked into saying the state was fine

Four ways the state checks answered confidently and wrongly.

A run killed mid-write left the output directory holding a marker and no manifest, and `validate`
answered "run generate first" for ever — an instruction that could never resolve, because
generation had already run and failed. The marker records the state, the run id and the start time,
so the message now names them and says whether to wait or regenerate.

A manifest with no `config.digest` fell back to comparing a handful of fields, so a changed
`maxMonolithBytes`, `layers`, `kinds` or custom secret rule passed as "valid and up to date". A
configuration that cannot be verified is not a match: the absence of the digest is itself reported
as drift.

A file that existed but could not be read was reported as "no longer exist on disk", sending the
reader to look for a file that was right there. Unreadable and deleted are separate findings now,
and the summary says which.

`report` printed whatever numbers the manifest contained — `-5 files included`,
`Total lines: 1.5`, `Total size: Infinity MB` — and both `report` and `validate` accepted
`fingerprint: "12345"`. Counts must be non-negative integers and a fingerprint must be a sha256
digest, or the file is refused as not being a snapshot manifest.

Verified: 17 new tests across `tests/snapshot-incomplete.test.js`,
`tests/validate-drift-classes.test.js` and the guards suite, including a real Windows ACL deny for
the unreadable case and a control that an untouched snapshot still reports no drift at all.

### `validate` called a binary file a new file

`generate` decides "binary" twice: from the extension and the 8 MB head scan, and again on the
bytes it reads, where a control-byte payload or a NUL past the head scan only reveals itself.
`validate` re-evaluated skipped paths with the cheap pre-read question alone, so a file `generate`
had just skipped came back as `new file` and the first `validate` after a `generate` failed on an
untouched tree. Both commands decide the same way now.

### `--discovery` chooses how files are found

A `.git` directory that exists but cannot be listed made discovery refuse, and there was no
override — the only way forward was to repair the repository or copy the tree out of it. The
refusal also justified itself with a gap that no longer exists (a walk does honour nested
`.gitignore` files now), so it names the differences that remain: `info/exclude`, the global
excludes file, tracked files that a `.gitignore` now matches, and a submodule as one entry.

`--discovery auto|git|walk` (config `discovery`) makes that choice explicit. `auto` keeps the old
behaviour, `git` requires git, `walk` scans the tree and reads `.gitignore` directly. The mode is
validated, scoped to the commands that scan, published in the contract, written to the init
template, and recorded in `manifest.config`, so changing it is config drift. 10 tests.

### A workspace is classified by what its packages are

Detection read only the repository root, so a Next.js app under `apps/web` in a pnpm workspace
detected as `monorepo` and a docs repository whose markdown lived under `docs/` detected as
`generic` — both contradicting the published preset table. Detection now probes a bounded number
of workspace packages and markdown directories, so a workspace is classified by the frameworks its
packages use. The bounds keep it honest: a bare `apps/` without a workspace declaration does not
trigger it, and a framework two levels down still detects as `monorepo`. 8 tests.

### `skill --install` could write outside the repository

The installer built its three targets from `--cwd` and wrote them without checking where they
landed, so a pre-existing junction (`.claude` itself, or `.claude/skills/codebase-snapshot`) or a
hard-linked `AGENTS.md` made it write outside the repository. Targets are resolved and refused
when they leave it. The section merge also repairs malformed marker layouts — duplicated blocks,
an inverted pair, a missing end marker — instead of appending another one, while a well-formed
file stays byte-identical on a rerun. 11 tests.

### `diff` saw no change when the payload changed

`diff` compared `relativePath` plus the source hash, so two snapshots of identical sources with
different `--max-part-bytes` or `--large-file-bytes` — a 4 KB preview against a 36 KB full body,
275 KB of parts against 307 KB — reported "0 added / 0 removed / 0 changed". The per-file answer
stays the same, and a payload block now says the configuration differs and why (the config digest,
the generator version, part and layer totals), which is what "what changed in the context we hand
to the model?" was asking. 5 tests.

---

## 4.0.9

### The tool executed a config it had been told to ignore

`generate --watch --no-config` printed "config file ignored" and then reloaded the repository
config on every regeneration, running its side effects and applying its include filter (4 tracked
files became 1). The watch loop now honours the flag.

`diff` also loaded the repository config, so comparing two manifests executed repository code —
and `--no-config` was rejected for that command, leaving no way to opt out. `diff` reads two
manifests and nothing else now; it never loads a config, and the flag is accepted there for
consistency. Verified: a config that writes a file on import no longer does so during `diff`, and
still does during `generate`.

### Accepted risk: the ownership marker is evidence, not authentication

A hand-written marker plus a stub manifest with a matching digest can still pass the ownership
check, because there is no secret involved — anyone who can write those two files can also delete
the directory directly. The check exists to stop the tool from deleting a directory *it* did not
create, not to resist an attacker with write access. `SECURITY.md` now says so.

---

## 4.0.8

### A dry run could write and delete
`--dry-run` printed "nothing was written" and then ran `hooks.afterGenerate`. A hook can write
files anywhere and delete parts of the live snapshot — one did exactly that during a dry run. The
hook no longer runs when nothing is written.

### Two runs to one output directory both claimed success
Runs were serialised on `tmpDir` only, so two invocations with different `tmpDir`s but the same
`outDir` each took their own lock, both exited 0, and one snapshot was silently lost. Both keys are
locked now, in a fixed order so two runs cannot deadlock: one succeeds, the other refuses.

### A git failure no longer changes what gets scanned
When `git ls-files` failed (corrupt index, git missing) the scan fell back to a directory walk,
which honours only the root `.gitignore` and ignores nested ones — a gitignored secrets file
entered `files[]` with no warning, and the snapshot looked clean. A git checkout whose files git
cannot list is now an error: fix the repository rather than silently scanning something different.
---

## 4.0.7

Wave-2 findings: nine independent critics, one dimension each.

### Credentials
- **A branch name is user input.** `git checkout -b "release2/<ghp_…>"` copied the token raw into
  `manifest.git.branch`, the README and the audit report — a channel that never passed through
  redaction. It is masked now.
- **Azure had no rules.** DevOps PATs, AD client secrets (`…8Q~…`) and SAS `sig=` values reached
  parts and both monoliths verbatim. Added.
- **Missing prefixes** in otherwise exhaustive alternations: `ABIA` for AWS bearer keys, `glrt-`
  (GitLab runner), `hvb.` (Vault batch), `1//0…` (GCP refresh), `sk_test_` (Stripe test).
- **`exclude` in a config** is the flag's spelling of `excludePatterns` and used to be ignored
  silently, so a directory the user excluded was still emitted. It is accepted as an alias now.

### The documented programmatic flow scanned the wrong project
`resolveConfig(await loadConfigFile(dir))` ignored `dir` and generated into `process.cwd()`, exit 0.
The loaded config now carries the directory it came from (non-enumerable), so the documented flow
scans the project the config describes.

### Small lies in the CLI
- `--mode` was discarded when a command word was present: `generate --mode validate` wrote a
  snapshot. A contradiction is now exit 2, and an unknown mode is an error either way.
- `--only-artifacts monolith` wrote nothing but the marker, because the artifact was off. Naming
  the monolith now enables it.
- `init` wrote `"snapshot": "codebase-snapshot generate"` into `package.json` without installing the
  package, so the very next line it printed (`npm run snapshot`) failed with "not recognized".
  The scripts are `npx @ankurhalder/codebase-snapshot …` now, which works either way.
---

## 4.0.6

### A NUL byte past the first 8 KB
Binary detection sampled 8 KB, so a file with a NUL at byte 9000 was emitted as text into a part.
The whole file is scanned now, up to 8 MB, in 64 KB chunks. Verified: a 20 KB file with one NUL at
offset 9000 is skipped as `binary`.

### Layer and kind names are masked wherever they are derived
Masking `config.layers` was not enough: the *derived* values were raw — `manifest.layers` keys,
`files[].layer`, part headers, the README parts table, the audit layer table, navigation, report and
`config.budgets.byLayer` keys. Eleven sinks, one root. The name is now masked where it is assigned,
so every derived field inherits the mask. Verified with a `ghp_…` layer name: zero occurrences in
any artifact.
---

## 4.0.5

### `validate` now notices every configuration change

It compared a handful of settings field by field and silently ignored the rest: `layers`, `kinds`,
`secrets.customPatterns`, `disableDefaultPatterns`, `maxMonolithBytes`. With a config that is not
itself in the snapshot (`include: ["src/**"]`), changing classification or redaction rules still
produced "✅ valid and up to date" on a stale snapshot — the "config changes are drift" promise
was false for exactly the rules that decide what goes in.

The manifest now records a digest of the effective settings, computed from the raw values, and
`validate` compares it. That covers every setting, including the ones no field comparison lists,
and it works where masked values cannot: two different credential-shaped exclude patterns both
mask to the same placeholder, so a masked comparison would call them equal.

```
$ validate        # same config
✅ Snapshot is valid and up to date with disk.

$ validate        # after adding a layer rule
❌ config: configuration: the settings differ from the ones this snapshot was generated with (run generate)
```

### Still open, recorded rather than hidden
100k files take about 67 s (I/O bound); parallel runs with different `outDir`s can still hit the
staging lock and exit 1 instead of waiting; `--watch`'s quiet window can defer an edit made during
a run; layer and kind names supplied in the config are still emitted raw in derived fields; binary
detection samples the first 8 KB; the monolith is built before `--max-monolith-bytes` rejects it.
---

## 4.0.4

Five defects found by driving the published package from another agent's environment.

### A stale shim exited 0 without doing anything
`dist/cli.js` exported `main()` and never called it. `dist/bin.js` is the shipped entry point, but a
`node_modules/.bin` shim left by an earlier install can point at `cli.js`, which then imported, did
nothing and exited 0 — indistinguishable from a successful run with empty output. `cli.js` now runs
itself when it is the entry file, and only then.

### Redaction was breaking the parser
Structural summaries were built from the **redacted** text, so masking an identifier such as
`const secret = previousSecrets[i]` produced source the TypeScript parser could not read: 969
"parse errors" on a codebase that has none, and incomplete summaries everywhere. The parser now
reads the original source, and every string that leaves a summary — exports, variables, functions,
classes, headings, JSON keys — is masked before it is written. Structure stays correct; nothing raw
reaches an artifact.

### Audit diagnostics
`reports/audit.md` gained a **Parse & AST Diagnostics** section listing every file whose summary
was incomplete, with its parse-error count. The CLI warned about these; the artifact an auditor
reads did not.

### Formatting
- Summary lines no longer mix separators (`snapshot\parts` instead of `snapshot\parts/`).
- Line counts use `en-US` grouping rather than the host locale, so a CI runner and a developer
  machine print the same number.

### Known gaps, not fixed here
`validate` does not compare `layers`, `kinds` or `secrets.customPatterns`, so changing those does
not register as drift; a changed credential-shaped value compares equal because both sides mask;
layer and kind **names** from your config are still emitted raw in derived fields; the ownership
marker can record a hook-written file whose name contains a token; and binary detection samples the
first 8 KB only.
---

## 4.0.3

### A snapshot could fail its own `validate`

4.0.2 masks config values in the manifest, which is right — an `excludePatterns` entry or an
`include` glob can contain a credential-shaped string. But `validate` compared that masked value
against the **raw** current config, so a repository that generated cleanly failed validation one
second later, and the mismatch line printed the very token the mask was hiding.

Both sides are now masked before comparing, and the mismatch text uses the masked form. Verified:
`generate` then `validate` with `excludePatterns: ["ghp_…"]` exits 0, and the token appears in no
file under `snapshot/`.

Known and unchanged: a layer or kind **name** supplied in the config is still emitted raw in the
derived fields (`manifest.layers` keys, `files[].layer`, part headers). It is your own string
rather than a discovered secret, but it is the same class and will be fixed with the next batch.
---

## 4.0.2

### The last place a path secret could reach an artifact

4.0.1 masked the path field of every skip record. It did not mask the **detail** beside it, and
that text names the link target or the exclude pattern: a symlink to `real-ghp_…` and an
`excludePatterns: ["ghp_…"]` both printed the token in `manifest.skipped[].detail`, the audit
table and `explain`. Config values recorded for drift detection (`include`, `excludePatterns`,
layer and kind names) had the same problem. All of them now go through the same rules.

### `--watch` idles again

After 4.0.1's staging changes the watcher fed itself: 15 regenerations in 8 seconds with no edits,
because Windows reports its own writes with paths the segment filter did not recognise. The
watcher now also stays quiet for a short window after each run. Measured: one regeneration in nine
idle seconds, and an edit still triggers exactly one more.

### Honest answers where there used to be silence

- `loadConfigFile()` returned `null` for a config that existed but could not be parsed, so
  `resolveConfig(await loadConfigFile(cwd))` — the documented example — silently generated on
  defaults. It now throws, and `loadConfigFileDetailed` already reported the reason.
- Custom secret rules are no longer stored in a module-level variable: a `collectFiles` call for
  one project applied the previous project's rules. Every caller passes its own.
- `describe` lists `.snapshotrc.json` before `.snapshotrc`, matching the real precedence.

### Measured this round

100k files: 56.6 s (was 336.4 s in 4.0.0), 20k: 11.8 s, 100k `validate`: 50.3 s, 100k `report`:
1.28 s, 50 MB single TypeScript file: 1.33 s. About 60% of the remaining time is Windows file I/O
— read, stat and open — not parsing or redaction.
---

## 4.0.1

### A credential in a file name no longer reaches the snapshot

A path that contained a token was masked only when the file was skipped *for that reason*. If it
was skipped earlier — as a credential-bearing file (`certs/AKIA….key`), by `.gitignore`, by a user
exclude or by the built-in ignore list — the raw path was written into `manifest.skipped[].path`
and the audit table, and a binary file whose name carried a token still reached the manifest as
`binary`. Custom `secrets.customPatterns` were not applied to paths at all, so a file named
`src/CORP-<32>.ts` was *included* and the token landed in the parts, the navigation index and the
project tree — the payload written to be pasted into a model.

Path masking now runs over every skip record regardless of reason, and the included-file check
uses the default **and** custom rules, so a custom-rule hit becomes a `sensitive-path` skip with a
masked path. A tested fixture with all four shapes produces zero occurrences of either token in
any file under `snapshot/`.

### `report` no longer re-scans the repository

`report` printed an integrity verdict by calling the validator, which re-reads every file: 4.5 s
on a 20 000-file repository to print a summary already on disk. It now reads `manifest.json` and
nothing else — **0.54 s** on the same repository — and says plainly that drift is `validate`'s job.
---

## 4.0.0

### `snap` is back

3.0.0 removed the `snap` alias after I misdiagnosed why `npx @ankurhalder/codebase-snapshot`
printed nothing. **The removal was unnecessary and this release reverses it** — both
`codebase-snapshot` and `snap` are published again.

The real cause, confirmed by reading npm's own resolver
(`libnpmexec/lib/get-bin-from-manifest.js`): npm resolves a package from its `bin` entries, and
when every entry points at the same file it treats them as aliases and resolves one. Two
aliases were always fine. What actually broke the bare command was a **stale global install on
the test machine** — a leftover `npm link` back to the development checkout, which made `npx`
run that instead of the published package. A clean profile runs the same command correctly, with
either one or two aliases.

If you ever hit a silent exit 0:

```bash
npm ls -g --depth=0 | grep codebase-snapshot
npm rm -g @ankurhalder/codebase-snapshot
```

### Security: the redaction layer was rebuilt

Independent adversarial review found credentials reaching `parts/*.md` while `audit.md` reported
them as redacted. That is the worst failure this tool can have — its output is written to be
pasted into a model — so the layer was rewritten rather than patched.

Leaks that were real and are now closed, each with a regression test:

- **CRLF checkouts.** Line-oriented rules ended in `$`, and a `\r` before the newline stopped the
  match, so `export TOKEN=…` in a Windows checkout printed in the clear while the byte-identical
  LF file was redacted. Scanning now splits on `\r\n`, `\n` and `\r` and preserves line numbers.
- **Trailing comments and trailing spaces.** `export TOKEN=abc # rotate quarterly` leaked because
  the value had to be the last thing on the line. The rule now matches the value, not the tail.
- **camelCase keys and short values.** `awsSecret`, `dbPassword: "hunter2"` and similar were never
  matched because only snake_case spellings were. Credential **names** now drive matching, and the
  value is masked regardless of length.
- **Unquoted YAML / docker-compose.** `POSTGRES_PASSWORD: hunter2` is now covered, while
  expressions (`password: req.body.password`, `getToken()`, `process.env.SECRET`) are explicitly
  not.
- **Sensitive file names.** `.env~`, `.env.swp`, `.npmrc ` (trailing space), `.vault-token`,
  `prod.env`, `secrets.toml` and friends are denied; deny-list matching normalises the name
  instead of anchoring on the exact spelling.
- **Secrets in a path.** A filename containing a token is skipped as `sensitive-path` with the
  path span-masked, instead of being printed in the tree, the navigation index and the manifest.
- **Authorization headers, and nine vendor prefixes** (`glpat-`, `hvs.`, `s.`, `xoxc/xoxd`,
  `whsec_`, `dckr_pat_`, `hf_`, `ya29.`) are now detected.

Masking is **span-only**: `dbPassword: "[REDACTED…]"` keeps the key and the rest of the line. That
also fixed the opposite defect — over-redaction that corrupted ordinary code (`id-token: write`,
`{ pass: 3 }`, and an unrelated string on a line that also contained a credential) is now
explicitly negative-tested.

The built-in rule count is now **29** (was 21).

**Known limitations, stated rather than hidden** (see [SECURITY.md](SECURITY.md)): detection is
pattern-based, so a secret deliberately split across two string literals is not caught, and
unusual credential shapes can still be missed. Do not treat a clean audit as a guarantee.

### The ownership marker is now evidence, not a filename

`generate` deletes the previous snapshot, and it decides whether it is allowed to by checking
whether it wrote that directory. The check was forgeable: an empty `.codebase-snapshot` file, or a
three-key `manifest.json`, was enough to make the tool delete a directory full of someone else's
files.

`.codebase-snapshot` is now a JSON record — generator name, schema version, a random run id, a
state, a digest of the manifest and an inventory of everything written. Replacement requires the
marker to be complete and every file in the directory to be in that inventory; anything else
blocks the run and is named in the message. The same evidence rule now applies to `tmpDir`, which
used to be deleted wholesale. Concurrent runs take a per-`outDir` lock, so four simultaneous
`generate` invocations leave one complete snapshot rather than a manifest describing parts that
are gone.

### Correctness

- **JSONC comments in strings.** A valid `package.json` containing `//` anywhere in a string
  (`"build": "tsc && echo done//ok"`) made every command fail with "the config could not be
  read". The stripper is now a state machine that respects strings and escapes.
- **Configs that are not objects.** `export default Promise.resolve({…})` was silently treated as
  an empty config; a thenable, array or primitive is now a hard error naming what it received.
- **Wrong-typed settings.** `excludePatterns: "src/**"` and `previewHeadLines: 0` were silently
  ignored. Every setting is now validated, and the error names the setting, the expected shape and
  what arrived.
- **`layers` rejected the documented shape.** `{ name: "api", match: … }` — the shape the type
  declares and the generated config recommends — crashed `generate` with a `TypeError`. Both
  `layers` and `kinds` are validated up front, `name` is canonical for layers with `layer` as an
  alias, and a bad rule is an error naming the index rather than a crash.
- **`preset: "detected"`**, which `describe` published as the default, was rejected as an unknown
  preset. `detected` and `auto` are now accepted.
- **Budget precedence.** `--max-part-bytes` lost to `budgets.default`, so the banner said "Part
  budget: 4 KB" while 151 KB parts were written. The order is now CLI > config `maxPartBytes` >
  `budgets.default` > 300 KB, and `budgets.byLayer` is capped by the chosen budget.
- **The output directory was scanned into the next snapshot.** `--out-dir .context` produced a
  snapshot that included its own previous manifest, so the fingerprint changed on every run and
  `validate` failed immediately after `generate`. The resolved `outDir`/`tmpDir` are excluded as
  tool-owned paths, silently and identically on the first run.
- **The monolith contained previews.** `full-codebase.md` was supposed to be the whole repository
  in one file, but a 400 KB file contributed about 3 KB — its head/tail preview. The monolith now
  carries full redacted bodies; `largeFileBytes` governs the parts only.
- **A failing hook disappeared.** `hooks.afterGenerate` throwing printed a warning, but the
  manifest had already been written, so the warning was not in it. The manifest is now rewritten
  with the final warning list (the hook still runs once).
- **`--out-dir` with a missing parent** failed with a raw `ENOENT` from the rename; parents are
  now created, an ancestor that is a file is refused cleanly, and a failed run no longer leaves
  `snapshot.tmp` behind.
- **`validate` exempted skipped files forever.** A file skipped as binary, then rewritten as
  source, was never reported as new. Skips are re-evaluated.
- **`--dry-run` skipped the output guard**, claiming it would write into a directory the real run
  refuses. A dry run now runs the same guard and exits the same way.
- **`diff` reported `before undefined undefined file(s)` and exited 0** on a manifest that was not
  a snapshot. Both sides are validated and the malformed one is named.
- **`reactComponents` listed plain classes.** A component now requires JSX/`createElement` or a
  React base class.
- **A filename could escape a code fence.** A file named ``` ``` ``` closed the `## Files` fence
  and let the next filename be rendered as live markdown — a prompt-injection vector in a file
  built for LLMs. Fences are now chosen from their content.
- **`--watch` never reloaded the config.** Editing the config while watching appeared to work
  while the old settings stayed in force; a broken config regenerated silently instead of
  reporting the error.
- **`reports/audit.md` said "Redacted Content Bytes"** when it meant emitted bytes. Renamed
  "Emitted Content Bytes".

### CLI honesty

- **Options that do not apply to a command are now rejected** (exit 2) instead of being parsed and
  ignored: `--watch` is generate-only, `--dry-run` is generate/init, config and size options do
  not apply to `diff`/`describe`/`skill`. The published `appliesTo` column is now generated from
  the same table the parser enforces, so the contract cannot drift from the CLI again.
- **`--no-config`** ignores `snapshot.config.*` and runs on the built-in defaults — useful in a
  checkout you do not trust, because a `.ts`/`.js`/`.mjs`/`.cjs` config is imported and executed.
- **`explain` always exits 0** when it can answer; the verdict is `included`/`reason`. Exit 1 now
  only means the command could not run.
- **`skill --format json`** emits JSON instead of markdown.
- **`init` writes `includeMonolith`** (the file now lists every setting, as it claims), honours
  `--out-dir`, refuses to silently override a `package.json#snapshot` config, and no longer says
  `Next: npm run snapshot` in a directory with no `package.json`.

### Upgrading from 3.0.0

- **Old snapshots are refused, not replaced.** A snapshot written by 3.0.0 carries a marker in the
  old format, so `generate` will stop and ask you to remove the directory or point `--out-dir`
  somewhere else. This is deliberate: the old marker could not prove the directory was ours.
- `explain` no longer exits 1 for a file that would be skipped.
- Attention-only flags (`--watch` on `validate`, for example) are now usage errors.
- With `--include-monolith`, the monolith is much larger, because it now actually contains the
  code.

### Documentation and packaging

Every document was rewritten against the current behaviour rather than patched:

- **New** [docs/cli.md](docs/cli.md) — every command, every option with its default and which
  commands it applies to, exit codes, output streams, worked examples.
- **New** [docs/output.md](docs/output.md) — the snapshot layout and the complete
  `manifest.json` schema, field by field, including how to read `skipped[]`.
- **New** [docs/troubleshooting.md](docs/troubleshooting.md) — every message the tool prints,
  its cause and its fix.
- **Rewritten** README, [docs/install.md](docs/install.md),
  [docs/configuration.md](docs/configuration.md) and [docs/agent.md](docs/agent.md).
- **New** [AGENTS.md](AGENTS.md) for agents working in the repository and
  [llms.txt](llms.txt) for AI discovery.
- **New** CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, issue forms and a pull request
  template.

Corrections worth calling out, because the old text was wrong:

- The generated config was documented as importing `defineConfig`; it has been a plain object
  with no imports since 2.2.0, so that it loads when the package is only used through `npx`.
- The "bin-less placeholder" explanation for the bare `npx` failure has been removed. The
  placeholder version is unrelated and harmless.
- `snap init` writes an `.mjs` config for a CommonJS project, not a `.ts` one — the
  documentation now states the rule.

Packaging: `prepare` was replaced with `prepack`, so installing the package no longer triggers an
install-script warning, and the published tarball is still built from source. The test suite now
includes an end-to-end agent simulation that follows the six workflow steps published by
`describe` and asserts the resulting snapshot.

---

## 3.0.0

### BREAKING: the `snap` executable is gone; use `codebase-snapshot`

The package now ships **exactly one** executable, `codebase-snapshot`.

This is what makes the bare form work. `npx @ankurhalder/codebase-snapshot generate`
used to exit 0 printing nothing, on every npm version and every OS, because of how npm
picks a binary: it matches the command you typed against the package's `bin` keys, and no
key can contain an `@scope/`. With two executables (`snap` and `codebase-snapshot`)
nothing matched, so nothing ran. With one, npm uses it regardless of its name.

Verify the rule against packages you know: `@sentry/cli`, `@babel/cli` and
`@changesets/cli` all ship one executable and run fine by bare name;
`@swc/cli` ships three and fails with "could not determine executable to run";
`npm-check-updates` ships two but is unscoped, so its name matches one of its bins.

Migration:

| Before | After |
| :--- | :--- |
| `snap generate` | `codebase-snapshot generate` |
| `npx snap` | `npx codebase-snapshot` |
| `npm run snapshot` (generated by `init`) | unchanged — it already used `codebase-snapshot` |

Nothing else in the API changed: the library exports, the config format, the manifest
schema and every command and option are identical.

### Changed

- The agent contract no longer claims the bare spec is unusable. It documents one
  executable and explains why, so an agent does not add a pin it does not need.
- `docs/install.md` explains the single-executable rule instead of the previous
  (incorrect) "bin-less placeholder" theory.

### Note on `0.0.0-stage`

Earlier notes suggested unpublishing a `0.0.0-stage` placeholder to fix the bare form.
That diagnosis was wrong — the placeholder is unrelated and can stay. The npm behaviour
above is the real cause, and the single-executable change fixes it for everyone with no
registry surgery.

---

Built for AI agents. Everything an agent needs is now available as data, and the tool can
install its own skill where agents look for it.

### Added

- **snap describe** — a machine-readable contract of the whole tool: the invocation that
  works, an ordered workflow array, every command, every option with its default, the
  exit-code contract, all 25 presets, the artifact list, config file names, output layout,
  safety rules and a troubleshooting table. --format json for machines, text for humans.
  Generated from the same code the CLI runs; a test compares its documented defaults
  against a real `generate --dry-run` manifest so it cannot drift into lying.
- **snap skill** — prints the bundled agent skill (to stdout, so it can be redirected),
  or with `--install` writes it to `AGENTS.md`, `.claude/skills/codebase-snapshot/SKILL.md`
  and `.cursor/rules/codebase-snapshot.mdc`. `--target claude|agents|cursor|all`.
  The install is idempotent and replaces only its own marked block, so an existing
  `AGENTS.md` keeps its conventions.
- `snap init` now points at `skill --install`.
- [docs/agent.md](docs/agent.md) explains the contract and the skill for humans.

### Why

`--help` is prose for a person. An agent told "use npx @ankurhalder/codebase-snapshot"
had to guess option names and failure modes. `describe` removes the guessing, and the
skill removes the discovery problem: once installed, an agent finds the tool without being
told it exists.

### Tests

138 pass (130 before): the contract's shape and defaults, skill output and frontmatter,
installation to all three targets, idempotency, and that an existing `AGENTS.md` is
preserved.

---

## 2.1.1

A correctness and contract pass driven by an independent CLI audit of 2.1.0. No new
features; every item below was reproduced against the released build first.

### Fixed

- **`validate` never printed the bookkeeping mismatches it counted.** It reported
  "1 manifest bookkeeping value(s) disagree" without saying which one, while
  `--format json` carried the detail. The text output now names them
  (`counts.totalFiles: manifest 999 vs actual 5`).
- **`generate` claimed artifacts it had not written.** `--only-artifacts parts` still
  printed a `Reports:` line and a `Manifest:` line; `--skip-artifacts manifest` still
  printed `Manifest:`. The summary now reflects the selection, and an all-disabled run
  says so instead of listing files that do not exist.
- **`diff` leaked raw Node errors** — `ENOENT: no such file or directory, stat …` for a
  missing path, and `Cannot read properties of undefined (reading 'totalFiles')` for a
  parseable but foreign manifest. Both are actionable messages now.
- **`validate` double-counted a tracked-but-deleted file**: it appeared in
  `missingOnDisk` twice, so the text said "2 file(s) no longer exist" for one file.
- **A bad `--cwd` exited 1** although the documented contract reserves 2 for usage
  errors. A missing directory or a file passed as `--cwd` is now exit 2.
- **`--max-part-bytes -5`** produced the parser's "option argument is ambiguous" text;
  it now says the value looks like another flag and points at the `--option=value` form.
- **Empty option values silently meant "use the default"**, so `--out-dir "$UNSET"`
  wrote to `./snapshot` instead of failing. Every string option now rejects an empty
  value with a usage error.
- **A detached HEAD was recorded as branch `"HEAD"`**, then `validate` warned about it
  forever. A detached HEAD cannot name a branch, so the configured fallback is used.
- **A read-only output directory produced a bare `EPERM`**. It now says the directory is
  not writable and suggests `--out-dir`; the previous snapshot still survives.
- **A wrong-typed `"snapshot"` key in `package.json` was silently dropped.** It now
  warns. It stays non-fatal on purpose — other tools use that key too.
- The all-artifacts-disabled warning claimed the directory "will be empty", which
  stopped being true once the ownership marker was introduced.

### Tests

130 pass (119 before), including a POSIX-only check that a read-only output directory
fails with a clear message.

---

## 2.1.0

Multi-project support and an interactive setup.

### Added

- **Interactive setup.** `npm create codebase-snapshot` (or `npx @ankurhalder/codebase-snapshot init`)
  detects the project, walks every tunable parameter, and writes the config. Every
  prompt has a flag, so it works non-interactively in CI.
- **A self-documenting config.** The generated `snapshot.config.mjs` lists *every*
  setting at its current value, commented and grouped — not just the ones you
  changed. Deleting any line is safe. `--minimal` writes the terse variant.
- **25 presets**, up from 4: nextjs, nuxt, sveltekit, remix, astro, angular,
  solid, vue-vite, react-vite, nest, node-express, node-lib, python-django,
  python-fastapi, python-lib, go, rust, java-spring, dotnet, php-laravel,
  ruby-rails, monorepo, infra, docs, generic.
- **Per-ecosystem ignores** contributed by each preset — `__pycache__`, `.venv`,
  `.mypy_cache` (Python), `target` (Rust), `.gradle` (JVM), `bin`/`obj` (.NET),
  `vendor`/`storage` (PHP), `.svelte-kit`/`.angular`/`.astro` (JS frameworks) —
  merged with `excludePatterns` and still recorded per file.
- **Structural summaries for non-TypeScript languages.** Python, Go, Rust,
  Java/Kotlin/Scala, C#, PHP, Ruby and C/C++ now get imports, declarations and
  exports. Vue/Svelte/Astro components have their `<script>` block handed to the
  real TypeScript compiler.
- **`summaryQuality`** (`ast` / `structural` / `heuristic`) recorded per file and
  rendered in every part section, so a line-scan is never presented as a parse.
- **`preset`** option to force a preset by name; an unknown name is an error with
  the full list rather than a silent fallback.

### Changed

- Preset detection now reads the repository once per run and shares that view
  with every detector. `peerDependencies` and `optionalDependencies` count.
- A bare `package.json` ranks below any definitive language manifest, so a Go or
  Rust repo with a `package.json` for tooling is not mistaken for a Node library.

### Fixed

- **`outDir`/`tmpDir` pointing at an existing directory could destroy it.** A
  config with `outDir: "src"` or `tmpDir: "src"` deleted the user's source tree
  and exited 0: the scratch directory was removed outright, and the atomic swap
  renamed the directory aside, moved the snapshot in, then deleted the backup. A
  regular file named `snapshot` was destroyed the same way. Both directories are
  now refused unless they are empty, hold only placeholder dotfiles, or carry
  proof that a previous run wrote them (a `.codebase-snapshot` marker or a
  parseable `manifest.json`). Filenames alone are never treated as proof, so an
  existing `docs/README.md` is safe and hook-written artifacts do not block
  reruns.
- **A config that could not be parsed was silently ignored** — a typo produced a
  snapshot with none of the developer's settings and exit 0. Unparseable configs
  are now a hard error (exit 1, nothing written). A `.ts` config on a Node without
  type stripping is still only a warning.
- **Absolute `--out-dir` was honoured by `generate` but not by the readers.**
  `validate`, `report` and `explain` joined instead of resolving the path, so they
  looked for `<cwd>\<absolute path>` and reported a missing manifest immediately
  after a successful generate.
- **`--preset`/`--include`/`--exclude`/`--yes`/`--minimal`/`--force` were accepted
  and ignored outside `init`.** `snap generate --preset nextjs` silently used the
  detected preset. These are now a usage error (exit 2) on any other command.
- **`init --preset <typo>` silently fell back to detection**, writing a config for
  a preset nobody asked for. It is now a usage error listing every valid preset.
- **Astro components were summarized as markup.** The leading `---` fence — where
  the TypeScript actually lives — was not parsed, so the common case degraded to
  `heuristic` quality. It now goes through the compiler like Vue and Svelte.
- Summaries for `.jsonc` strip comments instead of reporting `invalid-json`.
- `export default function Foo` records both `Foo` and `default`.
- Parser diagnostics are counted and surfaced as warnings.

---

## 2.0.0

Configurable snapshots, `explain`/`diff` commands and correctness fixes.

### Added

- `artifacts`: switch each of the seven artifacts off individually, with
  `--skip-artifacts` and `--only-artifacts`.
- `include`: allow-list globs, applied before `excludePatterns`.
- `budgets.byLayer`: per-layer part budgets.
- `layersMode`: user layers merge with the detected preset by default.
- `hooks.afterGenerate`.
- `snap explain <path>` and `snap diff <a> <b>`.
- `generate --watch`.
- Byte budgets accept human sizes (`120k`, `1.5mb`) from CLI and config.
- Globs support brace groups and character classes (`*.{ts,tsx}`, `[abc]`).

### Fixed

- The monolith is built from pre-partition content, so `full-codebase.*` really is
  the whole codebase even when a part truncates a file.
- The part byte bound is enforced after the split-pass cap instead of being
  silently exceeded.
- Default-ignored files are recorded with `reason: "default-ignore"` instead of
  vanishing, including leftover `snapshot.backup-*` directories.
- Watch mode no longer retriggers itself on its own writes.

---

## 1.0.0

Initial release.
