# Changelog

All notable changes to `codebase-snapshot`.

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

The docs now have a crawlable home at <https://codebase-snapshot.ankurhalder.com>, generated from
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
