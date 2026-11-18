# Changelog

All notable changes to `codebase-snapshot`.

---

## A note on version numbers

This package started its public life as `@ankurhalder/codebase-snapshot`, which reached 4.4.1. It
moved to the unscoped name and **restarted at 0.9.0**, so the numbers below are not a continuation of
the old line — `0.9.0` is newer than `4.4.1`, not older.

The line now runs **`0.12.x` to `0.17.0`, with literal sub-bumps**: every change ships as its
own version, `0.12.15` through `0.12.99`, then `0.13.0` and the same ladder again. The number is not
the promise; the entry below is. `1.0.0` is never released.

GitHub carries a tag for every version and `main` carries every commit. **npm publication happens
only at `x.y.0`** (`0.13.0`, `0.14.0`, …), so the registry stays clean while the repository keeps a
complete, buildable history.

Two versions exist on the registry that are not releases, and both are deprecated:

| Version | What it is |
| :-- | :-- |
| `codebase-snapshot@4.5.0` | Published for about an hour under the new name before the scheme was reset to 0.9.0. Withdrawn, never the supported version. |
| `codebase-snapshot@0.0.0-stage` | npm's own staging placeholder, created automatically during the first publish of the name. Not a release. |

Deleting them requires account-level rights that the release pipeline does not have, so they are
deprecated with an explanatory message instead. `latest` has pointed at 0.9.0 since it existed.

---

## 0.18.2

**The audit failed a snapshot for containing the redaction marker.**

- Reviewing a real 0.18.0 snapshot of this repository: 343 files, 13 parts, 1.1M tokens, no
  incomplete files — structurally clean, but `health` scored **70/100** with one critical failure:
  "7 artifact(s) contain a secret-shaped value".
- Every one of those hits was the marker itself: `token: [REDACTED: potential secret-like value
  omitted from snapshot]`. The scanner did not recognise its own output, so a second pass over an
  emitted artifact re-found lines the generator had already redacted. The audit also scanned each
  part as a whole under `parts/part-007.md`, losing the source path — the generator had deliberately
  left `DB_PASSWORD=envpass!@#$%^&*()` in a comment, because an unquoted value in a source file is an
  expression, but the same text inside a part was read as markdown and flagged.
- Three fixes: a candidate that already contains the marker is a placeholder; a finding whose original
  line carried the marker is not reported (the mask still runs, so a credential added after the marker
  is still removed); and the artifact scan is per section, under the section's own path, so the
  path-aware rules see what the generator saw. Marker-only YAML blocks no longer count as masked
  values either.

The same snapshot regenerated: **95/100, 14 passed, 0 failed, 1 warning** — the warning is the
host-path check finding `/Users/name` and `C:\Users\name` in the documentation examples, which are
genuinely in the text. Tests: the marker shapes produce no finding, a real secret in the same shapes
still does, and a health run over a snapshot that quotes the marker exits 0.
## 0.18.1

- `PUBLISHED` moves to 0.18.0, so every `npx codebase-snapshot@…` example in the docs now pins the
  milestone that is actually on the registry (`publish-train` run 44312176554: `+
  codebase-snapshot@0.18.0`, provenance published).
## 0.18.0

**"A newer version is available" now has a command, and stops hiding after one failure.**

- The notice has existed since 0.9.6, and a reader running an old global copy reported seeing it
  never. The cause was in their cache file: `{"checkedAt":…,"latest":null}` — a **failed** request
  remembered for an hour. One slow answer (the deadline was 1.2 s) made every run in the next hour
  silent, which is indistinguishable from "you are current".
- A failed check is now remembered for **five minutes**, and the request deadline is **2.5 s**. The
  request overlaps the command, so the longer deadline adds no wall time to real work.
- New command: **`snapshot update`**. It bypasses the cache, works without a terminal, prints the
  version it compared against even when that answer is "current", and sets an exit code a script can
  branch on: `0` current, `1` newer release, `2` registry unreachable. `--format json` returns
  `{ current, latest, updateAvailable, command }`. `CODEBASE_SNAPSHOT_REGISTRY_URL` points it at a
  mirror.
- The command is registered in the contract, the option scope, the usage text, the README table and
  the CLI reference; five tests drive it against a local registry, including a directory whose
  `snapshot.config.ts` this server refuses to run.
## 0.17.58

**The changelog lost its first 4,278 lines, and nothing noticed for eight releases.**

- The 0.17.50 release rewrote `CHANGELOG.md` in a PowerShell one-liner meant to normalise the final
  newline. It wrote back only the head of the file: 5,120 lines became 884, and every section older
  than 0.13.4 — 118 tagged versions, the 0.9.x, 0.10.x, 0.11.x and most of the 0.12.x line — was
  gone from the working tree. The commit recorded the deletion honestly; the changelog that was
  supposed to be the release record no longer was one.
- Restored from `git show v0.17.49:CHANGELOG.md` spliced with the eight sections written since: 227
  sections, 5,226 lines, ending at 1.0.0, and **every one of the 203 `v0.*` tags now has its section**
  (checked individually, not just counted).
- A hygiene test now compares the tag list with the changelog: a tagged version without a section fails
  the suite. It reads tags from git, so a truncated file cannot pass again. The one-liner is gone from
  this repository's release procedure; file rewrites go through a script that reads and writes the
  whole file.

This also explains part of what the tags looked like from outside: with the history gone, most recent
release diffs were only the few files a small fix touched.
## 0.17.57

- The goal log records the 0.17.52-0.17.56 backlog round: docs prose, SSE end to end, answer/query
  edges, and a benchmark re-run that reproduced every published number.
## 0.17.56

**The ten-repository benchmark was re-run, not assumed.**

- `node scripts/benchmark-suite.mjs --json` cloned all ten default repositories shallow, packed each
  with ours, repomix 1.19.0 and gitingest: **10/10 succeeded for all three tools**, and every file
  count, token count and byte count is identical to the table already in `docs/benchmarks.md`. The
  scanner is deterministic across 0.14.5 → 0.17.55, which is the result a refresh is meant to
  establish.
- The page now says so, and the minimatch ratio carries its second decimal (202.72).

Verified: the run itself (exit 0, 10 rows, no skips); site checks unchanged.
## 0.17.55

**The output page's tree omitted two artifacts it documents elsewhere.**

- `reports/selection.md` (written by `--slice` and `--budget-tokens`, referenced in `slice.md`,
  `answer.md` and `migration.md`) and `reports/audit.sarif` (`--sarif`) were missing from the tree in
  `docs/output.md`.
- The `artifacts` row counted "a digest of every artifact" and listed eight keys, leaving out
  `selection` and `fullXml` — both real keys in the manifest's digest map.

Verified: site rebuilt, 66 files / 742 links / 0 problems, `audit-site` clean.
## 0.17.54

**`snapshot_answer` said "1 skipped for budget" and named nothing.**

- With a tight budget the planner leaves a strong match out and packs a cheap one; the text said
  "1 skipped for budget" while the structured `omitted` array stayed empty. A client reading the
  reply could not tell which file it had missed or why.
- The planner's own skips now flow into the answer: `omitted` carries `{ path, reason }`, and the
  text lists them under "Not included". The same 500-token question now says
  `src/auth/login.ts - does not fit the remaining budget`.
- Probed the rest of both tools' edges and left them as they are: `snapshot_query` caps at `maxFiles`,
  reports `0 file(s) matched` when nothing matches, and rejects an invalid `pathPattern` with the
  reason; `snapshot_answer` measures `usedTokens` on the text it returns, marks clipped blocks, and
  keeps the planner notes when nothing was assembled.

Verified: the new test asserts the omitted path in both the text and the structured reply;
`mcp-tools` 42/42.
## 0.17.53

**SSE probed end to end for the first time outside its unit tests.**

- Stream with `?token=`: 200, `event: endpoint`, then `initialize` and `tools/list` answered over a
  `POST /messages` that carries no Authorization header but the token in the query — the pattern a
  browser client with only `EventSource` needs. Both replies arrived as `message` events; a POST with
  neither form of the token is 401.
- The page told clients to POST "to that path" without saying how a header-less client authenticates.
  It now says to append `&token=<token>`, and a test drives the whole session that way and asserts a
  supported version (`2025-06-18`) is echoed rather than upgraded.
- Also confirmed what the page already documents: a client asking for `2024-11-05` is answered with the
  newest legacy revision (`2025-11-25`) because that request names a version this server does not
  support; the version table in `docs/mcp.md` is accurate.

Verified: `mcp-http` 13/13, including the new query-token session.
## 0.17.52

**The resource page described a layout the server did not have.**

- `docs/mcp.md` said "the first four rows are always listed" above a table whose first four rows were
  manifest, `parts/{index}`, `reports/audit` and `reports/tree` — two of which are conditional. The
  always-listed set is `manifest`, `contract`, `skill`, `prompt`; the table now leads with those, then
  the part template, then the six reports that appear only when written. The same page counted "the
  three reports" when there are six.
- `docs/cli.md` still said "resources and two prompts"; the server serves seven.
- Three statements still described the browser surface as generating "with the default settings"
  after 0.17.45 made it apply the repository's JSON configuration: `docs/serve.md`,
  `docs/security-review.md` and the header comment in `src/web/server.ts`. All three now say the JSON
  config is applied and an executable config is refused.
- The URI constants are exported from the MCP entry (`STATIC_RESOURCE_URIS`, `REPORT_RESOURCE_URIS`,
  `RESOURCE_TEMPLATE_URIS`) so a test can compare the page with the server: every published URI must
  appear on the page, and the page's prompt count must equal `buildPrompts().length`.

Verified: `check-site-links` (66 files, 742 links, 0 problems), `audit-site` clean, and both new docs
tests pass.
## 0.17.51

- The goal log records the 0.17.49-0.17.50 round: the README tool list that disagreed with the
  server, the monolith warning about a pack that was never built, and the release gate that read a
  pipe's exit code instead of the test run's.
## 0.17.50

**A warning about a file the run never tried to build.**

- With `--pack json --max-monolith-bytes 100`, the run printed two skip warnings: one for the JSON
  pack (8 174 B, true) and one for the markdown pack reading
  `full-codebase.md skipped: 0 B exceeds maxMonolithBytes 100 B`. Markdown was not requested; no size
  existed; the 0 B was a placeholder compared against the ceiling.
- A pack that was not built can no longer be reported as too large. The warning is emitted only in
  the branch where the pack exists and its real byte count exceeds the ceiling.

Verified: the same command now prints exactly one skip warning, for the JSON pack; a test filters the
warnings and asserts the markdown one is absent, with no `skipped: 0 B`.

`0.17.50` was tagged while a test run reported two failures from a stale `dist` and one from a fixture
this change forgot to remove. The exit code of that check had been lost in a pipe (`node --test … |
Select-String`), so the gate passed on a red run. The commit, tag and branch head were corrected
before the round ended; the fixture now removes itself. A gate reads the exit code of the command, not
of the filter at the end of its pipe.

## 0.17.49

**The README listed the tools in a different order than the server builds them — and was missing five.
**

- The tool-count test guaranteed the number, not the list. The README sentence introduced "26 tools"
  and then named a different set in a different order: `budget` before `health`, `stats` after
  `search`, and `history`, `tests`, `workspace` tacked on at the end.
- A test now parses the sentence and compares it with `buildTools()` name by name, in order. The
  sentence was rewritten to the server's own order.

Also probed this round, and clean: the three `--pack` formats. XML escapes the CDATA terminator by
splitting it (`]]]]><![CDATA[>`), the JSON pack embeds `manifest` and `files[]`, and the markdown
pack uses `## File:`. The pack's `includedBytes` differing from the manifest is documented, not a
bug: it counts the raw content including the trailing newline.
## 0.17.48

- The goal log records the 0.17.47 round: remote provenance (clean), and the fallback branch that
  every surface presented as fact.
## 0.17.47

**A directory that is not a repository was described as being on `main`.**

- The `branch` setting exists so a tree with no git history still gets deterministic metadata — but
  nothing downstream said the value was a fallback. `README.md`, the audit, `PROMPT.md`, the CLI
  header and `snapshot_status` all printed `Branch: main` (or `Git: main @ unknown`) for a plain
  directory: a claim about a branch that does not exist, indistinguishable from a real one.
- `GitInfo` now carries `branchFromGit`, the manifest records it (optional, so older manifests still
  read), and every surface that prints the branch says `fallback` when git did not report one.
  Detached HEAD counts as a fallback too, which is what the recorded value always was.

Verified: a non-repository fixture prints `Branch: main (fallback)` on the terminal and `fallback;
git reported no branch here` in README, with `"branchFromGit": false` in the manifest; a repository
keeps the plain form.
## 0.17.46

- The goal log records the 0.17.45 round: the browser surface that ignored the repository config,
  and the executable config it silently skipped.
## 0.17.45

**The web page generated on defaults and silently ignored the repository's config.**

- `POST /api/generate` called `generateSnapshot({ cwd })` directly, and the library never loads a
  config file — the CLI and the MCP server do that before calling it. So a project with
  `snapshot.config.json` got one snapshot from the browser and a different one from the terminal.
- Worse, an **executable** config (`snapshot.config.ts`) was silently ignored: the page generated on
  defaults and said nothing, while the MCP server and the security review both promise this surface
  refuses repository code. It now loads the config with `allowExecutableConfig: false` and answers
  400 with the same message the server gives (`… is an executable config, and this server does not
  run repository code.`).

Verified: a JSON config excluding `src/generated/**` removes the path from the browser snapshot and
records the skip; a `.ts` config is refused and its side effect never runs.
## 0.17.44

- The goal log records the 0.17.43 round: the health page covering 14 of 18 checks, and the
  stats field named "sizes" that carried tokens.
## 0.17.43

**The health page listed 14 of the 18 checks, and its sample output was from an older tool.**

- `docs/health.md` had a "What it checks" table with 14 rows and no ids. The audit emits **18** ids
  (16 on a clean snapshot, plus `pipeline.monolith` and `workspace.index` when they apply);
  `bookkeeping`, `pipeline.bodies`, `pipeline.monolith` and `workspace.index` were missing entirely,
  and the table could not be compared with the code.
- Every row now carries the check id, and a test runs a real audit and fails if any emitted id is not
  documented. The sample output ("13 passed") and the JSON example were updated to what a clean
  snapshot prints today (15 passed, 1 skipped).
- `snapshot_stats` `partSizes` carried `{ filename, tokens }` under a name that promises bytes; it
  now carries `bytes` and `tokens`, and `heaviest`/`partSizes` appear in the output schema they were
  missing from.

Verified: the docs parity test passes; the stats test compares both numbers with the manifest.
## 0.17.42

- The goal log records the 0.17.40-0.17.41 round: the concurrency probes that held, and the validate
  tool that used to disagree with the snapshot it was validating.
## 0.17.41

- A test from an earlier release asserted that `snapshot_validate` **without** the generating flags
  reports drift ("the flag has to be doing something"). That was the documented behaviour then; with
  0.17.40 it is the bug, because a no-flag validate now compares against the manifest's recorded
  settings. The assertion and its comment were updated to the new contract, and `docs/tools.md` says
  it: validate uses the recorded settings, and a changed config file is still drift.
## 0.17.40

**`snapshot_validate` called a fresh snapshot "out of date".**

- The tool resolved a bare config file and compared digests. A snapshot generated with `tokenTree`,
  `includeDiffs`, `removeEmptyLines`, `stripComments`, a pack or `maxParts` therefore reported
  "2 setting(s) changed since the snapshot" immediately after generating — the same defect
  `snapshot_review` had (0.17.17), in the other tool that makes the same claim.
- Both now share `configAsGenerated`: the artifact selection and flag-only settings come from the
  manifest's own record, while everything the config file sets (budgets, include/exclude, layers,
  kinds, preset) still comes from the current config, so real configuration drift is still reported.

Verified: generate with `tokenTree` + `removeEmptyLines` then validate reports "matches the
repository"; one appended line turns it into "1 file(s) changed on disk".
## 0.17.39

- The goal log records the 0.17.37-0.17.38 round: docs that pinned an unpublished version, and a
  count test that could not fail catching two wrong counts once it could.
## 0.17.38

**Two documents described a server that no longer exists, and the test could not notice.**

- The hygiene test that compares the documented tool count with the real one matched only the words
  `zero`…`ten`, so with 26 tools it could never fail, and it could not see a count split across a line
  ("serves the repository as 25\ntools"). It now parses digits and hyphenated number words and
  tolerates whitespace, and it immediately found `AGENTS.md` saying **25** and `docs/agent.md` saying
  **eleven**.
- A twin check for the prompt count found `README.md` and `docs/agent.md` saying **two** prompts where
  the server serves **seven**, and the README's tool list was missing `budget`, `answer`, `history`,
  `tests` and `workspace`. All corrected.

Verified: both counts come from `buildTools().length` and `buildPrompts().length`, so the documents
cannot drift from the server without failing.
## 0.17.37

**The docs told readers to install a version that does not exist.**

- `sync-docs` rewrote every `npx -y codebase-snapshot@x.y.z` example to the **current** package
  version. Under the publish-at-`x.y.0` policy that is an unpublished patch, so the install commands
  in `README.md`, `docs/mcp.md` and `docs/deploy.md` named a version the registry does not carry and
  a reader who copied one got a 404.
- A `PUBLISHED` file now records the last milestone on npm (`0.17.0`), `sync-docs` pins the examples
  to it, and a test fails when any doc pin disagrees or names a non-milestone. The devDependency
  sample stays on the current version, because that is what `init` prints.
- `AGENTS.md` says when to update `PUBLISHED` (in the same commit as the milestone publish).

Verified: all five pins in the docs read `codebase-snapshot@0.17.0`, which is on the registry; the
pin test passes and would fail on an unpublished patch.
## 0.17.36

- The goal log records the 0.17.35 round: the history tool that repeated an edited report, and the
  clean probes of stats, explain and tests.
## 0.17.35

**`snapshot_history` repeated an edited report as fact.**

- The tool read `reports/log.md` and printed its commits. It never compared the file with the digest
  the manifest records for it, so appending `- fake commit` to the report changed the history an agent
  received, with no signal; `validate` and `health` would have caught the edit, the tool that serves
  the history did not.
- It now hashes the file and refuses a report whose digest no longer matches the manifest, naming the
  reason and telling the caller to regenerate. A snapshot without the recorded artifact (older
  manifests) is read as before.

Verified: a git fixture lists its commits; after one line is appended the tool is an error; the
snapshot without a recorded digest (pre-0.12 log) still reads.
## 0.17.34

- The goal log records the 0.17.33 round: the search summary that conflated searched with matched,
  and the 3.5 MB harness artefact that had been tracked since 0.14.2.
## 0.17.33

**A 3.5 MB benchmark artefact was hiding in the repository.**

- `snapshot_search` said `3 match(es) in 4 file(s)`, which reads as three matches spread over four
  files; the four was the size of the snapshot, not the number of files with a hit. It now says
  `3 match(es) in 2 file(s) of 4 searched.` and `No match in N file(s).` when there are none.
- `repomix-output.xml` — 3.5 MB of this repository in repomix's format, written by the comparison
  harness into the working directory — was **tracked in git** since 0.14.2, swept in by `git add -A`.
  It is removed from the index and the working tree, and `.gitignore` now names it beside the probe
  patterns. A hygiene test asserts that this and the `full-codebase.*` monoliths are never tracked.

Verified: the search wording test covers both the match and no-match forms; the hygiene test fails
if a generated monolith or the harness output is committed again.
## 0.17.32

- The goal log records the 0.17.30-0.17.31 round: routes that lost their paths, and the tests that
  had pinned the loss.
## 0.17.31

- Two tests written before this round asserted the **method-only** route shape, so `verify` failed
  after 0.17.30 fixed the extractor. They had pinned the defect as the contract; both now assert
  `METHOD /path`, and their names say so.
## 0.17.30

**`snapshot_routes` printed a method and no route.**

- Probed the graph tools on a fixture with an import cycle and two Express routes. The cycle, the
  entry points and the neighbors were right. The routes read:

  ```text
  GET  (src/index.ts, part-001.md)
  POST  (src/index.ts, part-001.md)
  ```

- The extractor pushed only the verb (`callee.name.text.toUpperCase()`) and **discarded the path
  argument**. Every Express/Hono/Koa/Fastify route in every snapshot was recorded without its path,
  and `/health` was indistinguishable from `/users/:id`.
- The handler now records `METHOD /path`; method-only handlers (Next.js route exports, decorators)
  stay method-only because there is no literal to record, and the renderer trims so they do not print
  a dangling double space.

Verified: the fixture reports `GET /health` and `POST /users/:id`, in text and in the structured
reply; the cycle/entrypoints/neighbors outputs are unchanged.

Two older tests asserted the method-only shape (`["DELETE", "GET", "POST"]`) — they had pinned the
defect as the contract. Both now assert `METHOD /path`, which is what the snapshot actually knows.
## 0.17.29

- The goal log records the 0.17.27-0.17.28 round: the response cap missing in half the tools, and the
  audit that failed its own signature about one run in forty.
## 0.17.28

**`--sign` failed its own health check, about one run in forty.**

- Reproduced a full-`verify` failure: `health` reported `signature.json` as containing a
  secret-shaped value, for a snapshot the tool had just signed with a fresh key. The rule was
  `known-vendor-token-prefix`, whose Azure DevOps shape is **52 mixed-case alphanumerics** — a random
  ed25519 public key or signature contains such a run often enough to match. A brute-force scan of
  5,000 generated records put the false-positive rate at 2.6%.
- The audit now exempts the record's **key material** (`publicKey`, `signature`, `manifestSha256`,
  `fingerprint`) from the artifact scan and scans every other field of the record, so a token
  smuggled into `keyOrigin` or `signedAt` is still a critical failure. The exempt bytes are random
  by construction and are verified against the manifest by the signature check.
- The first test I wrote for this replaced the public key with a fake one and expected health to
  pass; it failed for the right reason (the signature no longer verified). The test now finds a real
  ed25519 key whose base64 contains the token shape and signs the manifest with it, so it exercises
  the false positive without lying about validity.

Verified: 12 consecutive signed snapshots pass health; the crafted token-shaped-but-valid signature
passes; the same record with a vendor token in `keyOrigin` fails.
## 0.17.27

**One limit, four tools, three of them ignoring it.**

- The 64 KiB per-response cap was applied in `snapshot_read` and, after 0.17.9, in `snapshot_answer`.
  `snapshot_context`, `snapshot_diff_context` and `snapshot_symbol` rendered file bodies without it:
  a 200 KB single-line file came back whole from `snapshot_context` — a 200 KB response measured and
  unlabelled, while its siblings would have refused.
- One helper (`capResultText`) now applies the same limit and the same code-point-safe truncation in
  all four places, and a clipped block says `first 64 KiB` in its heading.

Verified: the same 200 KB fixture returns under 80 KiB from all three formerly unbounded tools;
`snapshot_read` and `snapshot_answer` are unchanged.
## 0.17.26

- The goal log records the 0.17.25 round: the two resolvers that disagreed about the same import
  graph, and the alias dependents that vanished without a word.
## 0.17.25

**`snapshot_diff_context` silently missed every alias import.**

- Probed a repository whose `src/app.ts` imports `@/user` through tsconfig `paths`. Asking
  `snapshot_diff_context` for `src/user.ts` returned **no dependents**; `generate --delta` on the same
  tree included `src/app.ts`, because the generator uses the real resolver. The tool had its own
  hand-rolled loop that skipped any specifier not starting with `.` and tried a fixed extension list.
- The tool now builds the same `ImportResolver` the generator uses (`buildImportResolver` with
  `tsconfigPathsFor`), so aliases, index files, `js`→`ts` mapping and non-JS languages resolve the
  same way in the client and the CLI. The probe now reports `["src/app.ts"]`.

Verified: an alias-only fixture returns the dependent; the delta suite and the tool suite pass.
## 0.17.24

- The goal log records the 0.17.23 round: the delta flow reproduced clean, and the signed manifest
  that `validate` called valid after it had been edited.
## 0.17.23

**`validate` did not verify signatures, and the docs implied it did.**

- Reproducing the signing flow end to end: `--sign` with `SNAPSHOT_SIGNING_KEY` writes a `configured`
  record, `health` verifies it, and `validate` passed a manifest edited **after** signing — it never
  looked at `signature.json`. A signature only matters if the tool that says "is this snapshot what
  it claims" checks it.
- `validate` now verifies the record whenever it exists and fails with the reason:
  `signature: manifest.json changed after it was signed.` (exit 1).
- `docs/signing.md` said health verifies; it now says validate does too, and shows the message.

Verified: a signed snapshot validates clean; editing one field of the manifest afterwards makes
`validate` exit 1 with the signature reason; `health` agrees.
## 0.17.22

- The goal log records the 0.17.19-0.17.21 round: the silent non-git report flags, the warning that
  leaked the host path the audit then caught, and the docs row that claimed agreement it did not have.
## 0.17.21

- **The warning leaked the host path it was warning about.** 0.17.19 wrote "…was requested, but
  C:\Users\… is not a git repository" into `manifest.warnings`; the health audit scans every written
  artifact for host paths and failed the snapshot the run had just produced. That is the audit doing
  its job.
- The message now says "the generated directory is not a git repository" and names no path. The
  report test additionally asserts that a warning contains no drive-letter path.

Verified: the full health suite passes (15 tests), including the host-path check that caught this;
the non-git fixture still gets both warnings.
## 0.17.20

- `docs/cli.md` still described `--include-logs` as if it always wrote its report, and the 0.17.19
  changelog said the contract and the page agreed. They did not: the row now carries the same
  warning as the contract. The docs row is hand-written, which is why the flag test (names only)
  did not catch it.
## 0.17.19

**A requested report that could not be written now says so.**

- `generate --include-diffs` outside a git repository accepted the flag, wrote no `reports/diff.md`,
  recorded no artifact, printed no warning and exited 0. `--include-logs` did the same. The one
  silent fallback this project forbids was in a documented feature.
- Both now warn with the reason and the path: "…was requested, but <cwd> is not a git repository;
  reports/diff.md was not written." A clean tree in a real repository is a different fact — there is
  nothing to show — and stays silent.
- The contract and `docs/cli.md` say the same thing, so the flag is not advertised as unconditional.

Verified: a non-git fixture generates with both flags, exit 0, neither artifact recorded, and both
warnings in `manifest.warnings`; the git tests still see their reports on a real repository.
## 0.17.18

- The goal log records the 0.17.17 round: the review that called a freshly generated snapshot stale,
  the manifest fields added so it cannot happen again, and the two-sided fix.
## 0.17.17

**`snapshot_review` said "stale" about a snapshot it had just generated.**

- A review of a snapshot generated with `includeDiffs` (or `tokenTree`, `removeEmptyLines`, a pack,
  `stripComments`, `sarif`) reported **"Snapshot: stale; run snapshot_generate before trusting it"**
  immediately after the generate. The cause was honest and narrow: `validate` compares the config
  digest, the digest covers the artifact selection and the run flags, and `snapshot_review` has no
  flags — so it validated with a bare config file and blamed the user for a difference the review
  tool itself could not see.
- The review now validates **as the snapshot was generated**: it takes the artifact selection and the
  flag-only settings from `manifest.config`, where the run recorded them. Configuration drift the
  config file still shows (budgets, include/exclude, layers, kinds, preset) is still reported.
- The manifest now records `removeEmptyLines`, `pack` and `logCount`, the three digest inputs it did
  not carry, so a no-flag validator can reconstruct the run. The fields are optional; older
  manifests are unaffected, and the digest does not change.

Verified: a review immediately after `snapshot_generate { tokenTree: true, removeEmptyLines: true }`
reports current; after appending one line to a file it reports stale. Same probe with a real git
diff and `includeDiffs`.
## 0.17.16

- The goal log records the 0.17.15 round: the HTTP probe that found the refusal counter counting
  only CORS refusals while 401/405/413/404 passed uncounted.
## 0.17.15

**The refusal counter counted almost no refusals.**

- `GET /metrics` published `snapshot_requests_refused_total` with the help text "Requests refused
  before dispatch", and only one path incremented it: a rejected CORS origin. A missing token (401),
  a wrong method (405), an oversize body (413) and an unknown SSE session (404) were all served and
  counted as nothing, so a server being probed with bad credentials reported **zero refusals**.
- Counting now happens in `send()` for every 4xx except 429, which keeps its own counter. The probe
  that found it (401 + 403 + 405, then 90 requests into a 60-per-10s limit) now reads exactly 3
  refusals and 30 rate-limited responses, and the test asserts both the totals and the 429 count.

Verified: `/metrics` after a 401, a cross-origin 403 and a 405 reports `refused 3`; the rate limit
fires at the documented threshold and `snapshot_requests_rate_limited_total` equals the number of
429 responses the client saw.
## 0.17.14

- The goal log records the 0.17.13 round: the prompts and resources probe, and the required argument
  that `prompts/get` was not enforcing.
## 0.17.13

**A prompt cannot be requested without its subject.**

- `prompts/list` marks `review`'s `change` and `explain`'s `path` as required, and `prompts/get` did
  not check: a client that omitted one received "Review a change" with no change named, and the
  model had nothing to review. The request is now refused with `-32602`, the argument names and the
  descriptions, in the same place the other argument checks live.
- Optional arguments stay optional: `orient` without `focus` still works.

Verified: `review` without `change` is refused and names the argument; with it, the text carries the
change; `orient` without `focus` is accepted.
## 0.17.12

- The goal log records the 0.17.11 round: accessible names and a live status on the serve page, and
  command/docs parity now pinned by a test.
## 0.17.11

**The page works without a mouse, and the docs page is pinned.**

- The web form had four controls with no accessible names — only placeholders and `title` — and a
  status line that screen readers never announced. Each control now carries an `aria-label`, and
  `#status` is a `role="status" aria-live="polite"` region. A test fails if a future control arrives
  without a name.
- `docs/cli.md` claims to document every command; nothing compared that list with the contract. A
  new test compares `describe --format json` commands with the page's `### `command`` sections in
  both directions, the way the options tests already did.

Verified: the page test asserts `lang`, the live region and a name on every control; the command
test fails on either an undocumented command or a section for a command that does not exist.
## 0.17.10

- The goal log records the 0.17.9 round: the adversarial-content pass (parser sound) and the 200 KB
  block it found leaving through `snapshot_answer`.
## 0.17.9

**A block cannot flood the transport.**

- Probing adversarial content found the circular risk that survived the earlier checks: a file whose
  body is one 200 KB line. The planner accepted it under a 60k budget, and `snapshot_answer`
  returned the whole line — a 200 KB response, no note, while `snapshot_read` caps one response at
  64 KiB.
- Each block is now capped at `MAX_RESULT_BYTES` (64 KiB) with the same code-point-safe truncation;
  the header says `first 64 KiB of the window` and the structured entry carries `clippedAtBytes`.
- `usedTokens` is measured on **what is returned** rather than on the window before clipping: it used
  to describe 200 KB while 64 KB was sent, which is the contract lying about its own size.

Verified: a 200 KB single-line file under a 60k budget returns under 80 KiB, labels the cap, and
keeps `usedTokens` consistent with the text; the other adversarial cases (fake `### FILE:` headings,
embedded fences, anchors, CRLF, EOF fence) all round-trip and pass the audit's body accounting.
## 0.17.8

- The goal log records the 0.17.7 round: the silent empty slice, the 100/100 member whose source was
  gone, and the web page probe that found the first one.
## 0.17.7

**A slice that selected nothing, and a member whose source is gone.**

- `--slice "question"` that matched no file wrote an empty snapshot with no warning (`web` reported
  `files: 0, dropped: 2, warning: null`). It now carries a warning with the planner's own reason,
  the same way `--budget-tokens` already did.
- `health --all-members` reported **100/100** for a member whose source directory had been deleted:
  the written snapshot is intact, so every hash passed, but the workspace index still names a path
  that no longer exists. The audit now warns with the path and "regenerate the workspace"; the
  combined score drops to the weakest member (95/100 in the probe).

Verified: an empty slice has exactly one warning naming the reason; a matching slice has none; a
deleted member loses five points, names the path, and keeps exit 0 (a warning, not a failure).
## 0.17.6

- The goal log records the 0.17.1-0.17.5 hardening round: the empty snapshot that warned nowhere, the
  planner notes that blamed the wrong thing, the impossible line windows that were clamped, and the
  docs slip the schema test caught.
## 0.17.5

- **`snapshot_read` refused nothing it could not do.** `lines: 0`, `lines: -3`, `fromLine: -5` and
  `fromLine: 2.7` all returned a one-line window and said nothing: the schema declared a minimum, the
  handler clamped. A request that cannot be honoured is now an error naming the argument and the
  value.

Verified: the four impossible requests are refused with an explanatory message; a valid window is
  unchanged.
## 0.17.4

**When the answer is empty, say why.**

- `snapshot_answer` dropped the planner's notes entirely, so a zero-file answer was a header and
  nothing else. The notes now close the block under `Notes:`.
- The planner had one budget sentence for two different failures: "Nothing fit the budget" was
  printed even when no file matched at all, sending the reader to the wrong number. It now says
  "No candidate file matched the question…" when there were no candidates, and only blames the
  budget when candidates existed and the cheapest one did not fit — with its cost named.
- The fallback sentence is emitted only when the centrality fallback produced files; saying "the
  plan falls back to the most-imported files" and then "<no files> and no fallback to offer" said it
  twice and contradicted itself.

Verified: an unmatched question on a repository without imports reports "no centrality data"; one
  with imports lists its centrality reasons; neither claims the budget was the problem.
## 0.17.3

- The 0.17.2 docs change put the `snapshot_generate` note in the reading list as its own bullet,
  which left the real entry without its example call; the docs/schema test caught it after the
  commit. The note now sits inside the generate entry, where it belongs.
## 0.17.2

**An empty snapshot says it is empty.**

- `--only "nomatch/**"` produced a legitimate-looking empty snapshot: exit 0, no parts, "Integrity:
  passed", no warning. The manifest now carries one: "No file matched the include allow-list (N
  pattern(s): …), so the snapshot is empty."
- The planner said two false things about an empty snapshot at once ("no file matched … the plan
  falls back" and "the budget is too small for any file"). It now says the one true thing and stops:
  the snapshot holds no files, and `manifest.skipped` explains why.
- `snapshot_answer` and `snapshot_budget` repeat that sentence instead of returning zeros with no
  explanation.
- **`snapshot_generate` takes `only` and `ignore`**, the last CLI narrowing flags without an MCP
  equivalent; the tool description and `docs/tools.md` say so.

Verified: an allow-list matching nothing warns in stderr and in `manifest.warnings`; a matching one
does not; the empty-snapshot messages are pinned by a test that generates a real empty snapshot.
## 0.17.1

- The goal log records the final milestone: 0.17.0 published, and the registry carrying exactly the
  five `x.y.0` versions with `latest = 0.17.0`. `ROADMAP.md` marks it published.
- What follows is 0.17.x: hardening and coverage until the deadline, with no new milestone promised.
## 0.17.0

**The endgame: what this is, and how it is proven.**

`codebase-snapshot` reads a repository and writes a text representation of it that an AI reader can
use: budgeted parts, a manifest that accounts for every path, and — since 0.12.15 — a server that
answers questions about the repository instead of making the reader open all of it.

### What a reader gets

- **A dump that fits.** Byte-budgeted parts, a per-file accounting of what was written, previewed,
  stripped or skipped, and an audit that recomputes those claims from the parts.
- **A selection, when the question is narrower than the repository**: `--slice` for a question,
  `--budget-tokens` for a ceiling, `--delta` for a change set. Each explains itself in
  `reports/selection.md`, and each records what it left out.
- **A server that answers questions.** 26 MCP tools over stdio or Streamable HTTP with bearer tokens,
  from `snapshot_answer` (question to cited windows) to `snapshot_health` (an audit of the snapshot
  itself), plus prompts and resources. Reads come from the snapshot, so redaction and exclusions
  still apply.
- **Proof of its own output.** Ed25519 signatures, artifact digests, a workspace index that must
  agree with its members, and `snapshot health` with a score and a strict exit code.

### The program, by milestone

| Version | Theme | Published |
| :--- | :--- | :--- |
| 0.13.0 | The MCP server, remote ingestion, signing, slicing, delta packs, multi-repo | 2026-11-18 |
| 0.14.0 | The audit proves the manifest: bodies, counts, packs, workspace index, metrics | 2026-11-18 |
| 0.15.0 | Parity measured on ten public repositories; per-run `--only`/`--ignore` | 2026-11-18 |
| 0.16.0 | Beyond parity: self-explaining selections, what-if budgets, `snapshot_answer` | 2026-11-18 |
| 0.17.0 | This milestone: the site, the security review, the migration guide, the final number | 2026-11-18 |

Every version in between was committed, tagged and pushed; `x.y.0` is what the registry carries, and
`latest` never points at a patch. The number is not the promise — the changelog entry is.

### How it is proven

- **Tests**: 1333 in the suite, 1325 passing, 0 failing, 8 skipped because they need a host this
  runner is not. The suite treats the tool as a black box where it can: generate, validate, serve,
  ask, and check the answer.
- **The audit**: every generated snapshot in the suite is audited, and the audit is itself probed by
  breaking what it claims to check — a truncated part, an edited count, a pack minus one entry, an
  index with a wrong fingerprint, an edited selection report.
- **Measurement**: ten public repositories through this tool, repomix and gitingest in one command
  (`scripts/benchmark-suite.mjs`), with the page saying where the numbers are comparable and where
  they are a policy difference.
- **The artifact**: a 53-file tarball whose lockfile agrees with `package.json`, checked before every
  publish by the same `verify` a reader can run.
- **The site**: 30 pages, every one with a description, a canonical URL and no broken link
  (`audit-site`), generated from the same documents the repository ships.

### What is deliberately not here

- **No 1.0.0.** The line ends at 0.17.0 because a version number is a promise about stability, and
  this project would rather make the next promise in a changelog than in a semver jump.
- **No runtime dependencies.** Node built-ins and the TypeScript compiler (a dev dependency) only.
- **No silent fallback.** An unknown flag, preset, budget or config key is an error, and a path that
  leaves the snapshot is recorded with the reason it left.
## 0.16.2

**The endgame pages.**

- `docs/answer.md` is a site page of its own: one call from question to cited, line-numbered
  context, the four-way comparison with `plan_for`/`read`/`budget`, and what the tool deliberately
  will not do (invent a path, truncate silently, read the working tree, exceed the budget without
  saying so). 30 pages, audit-site clean.
- The site builder still described the tool reference as "All 22 MCP tools"; it is 26, and the
  number now matches `tools/list`.
- `docs/security-review.md` gains "What changed since this review was written": metrics labels, the
  web server's allowed roots, the audit that stopped trusting the manifest, `snapshot_answer`, and
  `--only`/`--ignore` — each reviewed for what new input arrives and what it can reach.
- `docs/migration.md` gains the 0.13.0-0.17.0 table: what a reader upgrading across those milestones
  will notice, and why nothing was removed.
## 0.16.1

- The goal log records the fourth published milestone: 0.16.0 tagged, released on GitHub and
  published to npm (`latest` at 01:52Z). `ROADMAP.md` marks it published.
## 0.16.0

**Things neither competitor has.**

Parity was the floor. This milestone is what the snapshot does that repomix and gitingest do not:

- **Selections, not dumps.** `--slice "question"`, `--budget-tokens N` and `--delta <base>` each
  narrow the snapshot to what answers a question, fits a budget, or changed. The three are mutually
  exclusive on purpose: each is a different claim, and letting two win silently would make the
  manifest describe a selection nobody asked for.
- **The selection explains itself.** `reports/selection.md` (0.15.3) lists every chosen file with its
  cost and reason, what was left out, and what a larger budget would buy next; it is a recorded
  artifact, so `validate` treats an edited one as drift.
- **Budgets answer "what if".** `snapshot_budget` (0.15.2) runs the planner at several budgets and
  reports what each adds; the manifest records `headroomTokens` and `nextInLine`.
- **Question in, cited context out.** `snapshot_answer` (0.15.5) plans a question and returns
  line-numbered windows within one budget, each with its reason, every omission named.
- **Multi-repo workspaces** with `WORKSPACE.json`, cross-member import links and a workspace-wide
  audit (`health --all-members`).
- **Signed manifests** (Ed25519) behind `--sign`, verified by `validate` and the audit.
- **An audit that proves the manifest** rather than trusting it: bodies, counts, packs, the workspace
  index, host paths and secrets — the work of 0.14.x, now part of what a snapshot is.

### The shape of the whole

A reader should be able to take a snapshot and answer three questions without the working tree:
what is in it (manifest, navigation, tree), why it is in it (selection report, skip records), and
whether it is what it says it is (hashes, signatures, audit). None of the three depends on the other
two agreeing by accident.

### How it was verified

Full `npm run verify`: 1333 tests, 1325 pass, 0 fail, 8 host skips; 29 site pages with no link or
metadata problems; a 52-file tarball whose lockfile agrees with `package.json`. The new tools are
pinned by tests that call them over the real MCP registry, and the docs/schema parity test fails if a
tool is documented but absent or present but undocumented.
## 0.15.5

**`snapshot_answer`: question in, cited context out, in one call.**

- The 26th tool. `snapshot_plan_for` says which files to read and `snapshot_read` returns one of
  them; an agent that wants an answer had to make a call per file and do its own budget arithmetic.
  `snapshot_answer` plans the question, then returns each chosen file as a head window with line
  numbers, within one token budget.
- Every included file carries its `why` from the planner. Every planned file that did not fit is
  listed under "Not included" with the reason — the budget, a missing part, or a missing section —
  so a truncated answer never looks like a complete one.
- The block is measured with the same estimator as the manifest, so `usedTokens` is comparable with
  every other token figure this tool prints.

Verified: a question about a fixture module returns line-numbered windows, each with a reason;
`usedTokens` stays within the requested budget.
## 0.15.4

- The goal log records the 0.15.2-0.15.3 round: `snapshot_budget`, budget headroom and `nextInLine`,
  and `reports/selection.md` for narrowed snapshots.
- `AGENTS.md` said the MCP server exposes 21 tools; it exposes 25. The count is part of the contract
  and a wrong one is a lie, however small.
## 0.15.3

**A narrowed snapshot explains itself.**

- A slice or a budget now writes `reports/selection.md`: the question and budget, every chosen file
  with its token cost and the reason it was chosen, the count of files left out, and for a budget
  the files a larger budget would buy next. The numbers come from the manifest blocks, so the report
  and the data cannot drift.
- The report is a recorded artifact: `validate` fails when it is edited or deleted, and the audit
  expects it only when the manifest records it.

Verified: `--slice` writes the question and the chosen path; `--budget-tokens 500` names the
headroom and the next files; appending one line to the report makes `validate` fail with the path.
## 0.15.2

**Budgets answer "what if", not only "what fits".**

- **`snapshot_budget`, the 25th tool**: run the planner at several budgets and report what each one
  adds — files, tokens used, and the paths gained over the previous budget. The question a budget
  raises ("should I raise it, and what would I get?") is now answerable without writing a snapshot.
- The budget block in the manifest records `headroomTokens` and `nextInLine` — the files a larger
  budget would take, in the order it would take them. `report` prints both, so the CLI shows the same
  answer as the tool.

Verified: a 500-token budget on a fixture selects 3 of 8 files, reports 2 tokens of headroom and
names the next six by cost; `snapshot_budget` at 500 and 5,000 returns a superset with the gained
paths listed.
## 0.15.1

- The goal log records the third published milestone: 0.15.0 tagged, released on GitHub and
  published to npm (`latest` at 01:33Z). `ROADMAP.md` marks it published.
## 0.15.0

**Parity, measured on someone else's repositories.**

0.15.x was the parity phase, and the honest test of parity is not a feature list — it is running the
same repositories through both tools and publishing what happened.

- **Ten public repositories, three tools, one command** (`scripts/benchmark-suite.mjs`): is-odd,
  chalk, co, minimatch, luxon, requests, click, express, zod and github-readme-stats, cloned shallow
  and packed by this tool, repomix 1.19.0 and gitingest. Nine of ten land within about plus or minus
  30% of repomix's own token count. The tenth, minimatch, is a policy difference: five 20–25 MB
  benchmark fixtures are emitted by repomix (64.8M tokens) and bounded-previewed by us (319,879).
  The page says which is which instead of celebrating a ratio.
- **`--only` and `--ignore`** narrow a single run without editing a configuration: `--only` replaces
  the allow-list, `--ignore` adds to the deny-list, and both enter the config digest so `validate`
  and `explain` compare like with like. An ignored path is recorded in `skipped[]`, never dropped.
- **gitingest runs in the harness** now, with `PYTHONIOENCODING=utf-8` for the child process;
  without it, gitingest aborts on Windows while printing its tree and the comparison silently
  degrades to two tools.

### What parity means here

Feature-for-feature, the floor is covered: diffs, logs, a token tree, single-file packs in three
formats, comment stripping, blank-line stripping, and structural parsers for seven non-TypeScript
languages. What is different is deliberate and stated: a selection (slice, budget, delta) that neither
competitor produces, an audit that verifies the manifest instead of trusting it, and a token estimate
that is documented as an estimate.

### How it was verified

Full `npm run verify`: 1328 tests, 1320 pass, 0 fail, 8 host skips; 29 site pages with no link or
metadata problems; a 52-file tarball whose lockfile agrees with `package.json`. The ten-repository
run is reproducible with one command and reports its own skips.
## 0.14.6

**Per-run narrowing: `--only` and `--ignore`.**

- Both tools this is measured against let one run narrow the files without editing a config. This
  tool did not: `--include`/`--exclude` only wrote settings into a config during `init`/`setup`.
- `--only <globs>` **replaces** the include allow-list for the run; `--ignore <globs>` **adds to** the
  exclude list. The directions differ on purpose — a narrower allow-list is a statement about the
  whole run, while "also ignore this" is naturally cumulative with what the config already denies.
- Both enter the config digest, so `validate` and `explain` accept them and need them to compare like
  with like; an ignored path is recorded in `skipped[]`, not dropped.

Verified: an ignored file disappears from `files[]` and appears in `skipped[]`; `validate` with the
same flag passes and without it reports drift; `explain --ignore` answers "excluded".
## 0.14.5

**Ten public repositories, three tools, one run.**

- `scripts/benchmark-suite.mjs` shallow-clones a list of repositories, packs each with this tool,
  repomix and gitingest, and prints one table (or `--json`). A repository it cannot clone is a skip
  with the reason, never a missing row.
- `docs/benchmarks.md` carries the run: ten repositories from `jonschlinkert/is-odd` (5,450 tokens)
  to `colinhacks/zod` (1.76M). Nine of ten land within about plus or minus 30% of repomix's own
  token count — expected for two estimators.
- The tenth is the interesting one: `isaacs/minimatch` holds five 20–25 MB benchmark fixtures.
  repomix emits them (64.8M tokens); our large-file rule emits a bounded preview and records the
  omission, so the pack is 319,879 tokens. The page says exactly that instead of celebrating a ratio
  that a policy difference produced.

Verified: the suite runs end to end, and a test pins that an uncloneable input becomes a skip with
its reason.
## 0.14.4

- The goal log records the 0.14.2-0.14.3 round. `ROADMAP.md` marks item 27 (`--remove-empty-lines`)
  and item 33 (call-site evidence) as shipped, and item 36 as measured three ways on this repository
  with ten public repositories still to run.
## 0.14.3

- **`snapshot_symbol` reports call sites.** The definition says what a symbol is; the call sites say
  who depends on it. Unless `references: false`, the tool scans the parts (never the working tree) for
  the name, bounded by `MAX_SEARCH_BYTES` and `maxReferences` (default 20), and returns path, line and
  the line text — marking the definition line itself.
- Case-sensitive matching on purpose: a case-insensitive scan of a common word is noise. Import lines
  count as sites, which is why a rename sees them.

Verified: a call in `src/auth.ts` is reported with its line, the import line is included, and
`references: false` skips the scan.
## 0.14.2

- **The comparison harness runs gitingest, and now does.** `--gitingest` reported "not available" here
  because gitingest aborts on Windows with `charmap codec can't encode` while printing its tree; the
  harness sets `PYTHONIOENCODING=utf-8` for that child process and it completes.
- `docs/benchmarks.md` carries the three-way table from a real run: our full pack 336 files /
  1,060,727 estimated tokens, repomix 335 / 888,168, gitingest 3.12 MB of digest with no token count.
  The caveats say which numbers are comparable (bytes) and which are not (tokenizers).

## 0.14.1

- The goal log records the second published milestone: 0.14.0 tagged, released on GitHub and
  published to npm (the registry reports `latest = 0.14.0`), after the same few-minute processing
  window that 0.13.0 had. `ROADMAP.md` marks it published.

## 0.14.0

**The audit now proves the manifest, instead of trusting it.**

0.13.x was the health service facing its own claims. Each sub-bump asked "what does this audit
actually verify?", and five answers were uncomfortable:

- **0.13.3** `GET /metrics`: request totals, per-method counts, refusals, rate limits, tool count and
  uptime in Prometheus text, with no path or credential as a label.
- **0.13.4** a workspace member is compared with its `WORKSPACE.json`: fingerprint and file count must
  agree, and a stale index warns with the field that disagrees.
- **0.13.6** every file body in a part is compared with the manifest's `includedBytes` and
  `includedLines`, by anchor. A truncated part with an updated hash used to pass every check.
- **0.13.7** `counts.totalFiles`, `counts.partsCount`, `counts.skippedCount`, `totals.totalContentBytes`
  and the per-layer counts are recomputed from the manifest's own arrays. A manifest claiming five
  more files than it held passed everything before this.
- **0.13.9/0.13.10** each single-file pack (JSON, XML, markdown) must hold exactly the files the
  manifest lists. A digest proves the pack is the recorded file, not that the recorded pack is
  complete.

### What this milestone changes for a reader

- A snapshot that says it contains something it does not now fails the audit with the field and both
  numbers, instead of scoring 100.
- The audit is stricter about its own bookkeeping, so a hand-edited manifest is a failure even when
  every hash was updated to match.
- The JSON, XML and markdown packs are audited as deliverables rather than as opaque artifacts.

### How it was verified

Full `npm run verify`: 1323 tests, 1315 pass, 0 fail, 8 host skips; 29 site pages with no link or
metadata problems; a 52-file tarball whose lockfile agrees with `package.json`. Each new check was
probed by breaking the thing it checks: a truncated part, an edited count, a pack minus one entry, an
index with a wrong fingerprint — and each probe became a test.
## 0.13.10

- **Every single-file pack is checked for membership, not only the JSON one.** The XML pack writes
  paths as `<file path="…">` and the markdown pack as `## File: …`; each has a small reader and the
  same both-directions comparison against `manifest.files`. A pack entry deleted and the digest
  updated is a critical failure in all three formats.

Verified: clean `--pack xml`, `--pack single` and `--pack json` snapshots pass their checks; removing
one file section from the XML and the markdown pack and re-digesting fails with
`is in the manifest but not the pack`.
## 0.13.9

- **The JSON monolith must hold every file the manifest lists.** The pack's digest proves it is the
  file the manifest recorded, not that the manifest recorded a complete pack. The audit parses it and
  compares the file set both ways: an entry removed and the digest updated is now a critical failure.
- Membership only, deliberately: the pack keeps a file's final newline and a part body does not, and
  normalising that difference would duplicate the per-file body accounting with a fragile check.

Verified: a clean `--pack json` snapshot passes; removing one entry and re-digesting the artifact
fails with `is in the manifest but not the pack`.
## 0.13.8

- The goal log records the 0.13.6-0.13.7 round: per-file body accounting and the count recomputation,
  with the probes that found both gaps.
## 0.13.7

**The audit checks the counts against the data they summarise.**

- `counts.totalFiles`, `counts.partsCount`, `counts.skippedCount`, `totals.totalContentBytes` and the
  per-layer counts were quoted, never verified. A manifest edited to claim five more files than the
  parts hold passed every check — each part hashed correctly and the artifacts were present.
- The audit recomputes all of them from the manifest's own arrays and fails with the field and both
  numbers when they disagree (probed: `counts.totalFiles: manifest says 7, the data has 2`).

Verified: a clean snapshot passes the check, and one edited count field fails with its name.
## 0.13.6

**The audit checks every file body against the manifest accounting.**

- The manifest records `includedBytes` and `includedLines` per file; nothing verified them against
  the parts. A part could be truncated or edited, its hash updated in the manifest, and every
  integrity check would agree while the reader received less than the manifest promised.
- Each part is parsed once with the same parser the MCP reader uses (moved to
  `src/partitioner/part-format.ts` so the auditor does not import the server), and every file's
  section is compared by anchor: bytes must equal `includedBytes`, lines must equal `includedLines`.
  A missing section is a failure with the path named.

Verified: the check passes on this repository in five modes (full, strip-comments,
remove-empty-lines, skeleton, forced previews); deleting one line from a part without touching the
manifest fails the audit.
## 0.13.5

- The goal log records the 0.13.3-0.13.4 round: Prometheus metrics on the HTTP transport and the
  workspace-index check in the health audit.
## 0.13.4

- **The health audit checks a workspace member against its index.** When `WORKSPACE.json` sits beside
  the snapshot, the member's recorded fingerprint and file count must match the snapshot; a stale or
  edited index warns (and `--strict` exits 1) rather than leaving the deliverable saying two things
  about one directory. An index that cannot be read warns with the parse error; an index that does not
  list this member is a skip with the reason.

Verified: editing a member's fingerprint makes the audit warn with the field that disagrees, and
regenerating the workspace makes it pass again.
## 0.13.3

- **`GET /metrics` on the HTTP transport.** Prometheus text, no dependency: request totals, a count
  per method, refusals (a disallowed CORS origin) and rate-limit rejections, plus the tool count and
  uptime. Labels are fixed — no path, no tool name, no credential — because a label built from a URL
  is an unbounded map and would publish what was asked for to the monitoring system.
- `/healthz` and `/metrics` need no token (neither exposes repository data); everything else still
  does.

Verified: a refused origin and a normal request move their counters, and no request path appears in
the output.
## 0.13.2

- The goal log records the milestone: 0.13.0 tagged, released on GitHub and **published to npm**
  through the train (the registry reports `latest = 0.13.0`), plus the 0.12.99 security fix and the
  0.13.1 portability fix the release workflow exposed.
- `ROADMAP.md` carries a milestone table with the published state, so the next milestone has a place
  to be recorded rather than being inferred from the changelog.
## 0.13.1

**The test suite could not run on Linux, so the release workflow never passed.**

- Twelve test files built the binary path with `new URL(import.meta.url).pathname` and stripped a
  leading slash. On Windows that yields `C:/…` and works; on Linux it yields `home/runner/…` — a
  *relative* path — so `dist/bin.js` resolved under the scratch directory and the test failed with
  `Cannot find module`. The release workflow runs the suite on Ubuntu, so the first milestone release
  failed there even though every local run was green.
- All twelve now use `fileURLToPath(import.meta.url)`, which is absolute on both platforms. The
  rewrite was mechanical; the eleven suites it touches were re-run.

Verified: 49 tests across the eleven rewritten suites pass locally, and the construct no longer
depends on the platform.
## 0.13.0

**The first published milestone.** Every release from 0.12.15 to 0.12.99 is tagged in this
repository; 0.13.0 is the first one published to npm under the policy that patches are tagged and
only `x.y.0` is published. The code is the same code those 85 sub-bumps tested — this entry is the
map of what they built.

### Retrieval, which is the point

- `snapshot_plan_for` — the plan for a question: which files fit a budget, why each was chosen, what
  did not fit. Matches stems (`charge`/`chargeCard`), follows imports **and** callers, prefers entry
  points, and resolves `.js` specifiers to their `.ts` files.
- `snapshot_context`, `snapshot_query`, `snapshot_symbol`, `snapshot_read`, `snapshot_locate`,
  `snapshot_dependents`, `snapshot_neighbors`, `snapshot_routes`, `snapshot_cycles`,
  `snapshot_tests`, `snapshot_entrypoints`, `snapshot_search`, `snapshot_stats`, `snapshot_history`
  — 24 tools in total, each with a cost class, structured output and a reference page.
- `snapshot_diff_context` and `snapshot_review` for a change set; `snapshot_health` for the proof.

### Transports and the browser

- Streamable HTTP with a bearer token, loopback by default, CORS for loopback origins, a 2 MB body
  cap, 60 requests per 10 seconds and a real `/healthz`; legacy SSE for older clients.
- `snapshot serve`: one loopback process for the page, the API, MCP and a store-only zip; the page
  can generate, slice for a question, fit a token budget, audit what it wrote and download it.
- `generate --remote`: https only, DNS-checked public addresses, shallow clone, `GITHUB_TOKEN` from
  the environment, provenance in the manifest.

### The proof

- `snapshot health`: hashes, artifacts, secrets, values from excluded files, host paths, token
  accounting, freshness and signatures, with a score, severities and `--strict`. It audits a whole
  `--workspace` with `--all-members` and takes the weakest member as the combined score.
- `--sign` writes an Ed25519 signature over the manifest; health verifies it.

### Parity, and past it

- `--include-diffs`, `--include-logs <n>`, `--token-tree`, `--pack single|xml|json`,
  `--strip-comments`, `--remove-empty-lines`, and parsers for Python, Go, Rust, Java, C#, Ruby and
  PHP.
- Neither competitor has: `--slice` (the retrieval planner at generate time), `--delta` (what
  changed plus its importers), `--budget-tokens` with a coverage report, `--workspace` with
  cross-member links, and signed manifests.

### What changed for an existing snapshot

- A snapshot generated with `--strip-comments`, `--pack` or a non-default `--include-logs` count now
  reports configuration drift once, because those settings entered the config digest (0.12.84).
  Regenerate with the same flags; the drift is the digest telling the truth about bytes it had not
  been covering.
- `resources/list` advertises a report only when the run wrote it, and `describe` publishes the six
  report resources separately as `reportResources` (0.12.62, 0.12.69).
- `--slice` and `--budget-tokens` together are refused; `validate` no longer reports unselected
  files of a selection as drift (0.12.55, 0.12.56).

### How it was verified

Full `npm run verify` at 0.12.99: 1316 tests, 1308 pass, 0 fail, 8 host skips; 29 site pages with no
link or metadata problems; a 52-file tarball whose lockfile agrees with `package.json`. The
benchmarks in [Benchmarks](benchmarks.md) are generated by a script that can be re-run, and the
head-to-head against repomix is measured rather than claimed.
## 0.12.99

**The last sub-bump before the milestone: the browser API cannot be pointed anywhere.**

- `/api/snapshot`, `/api/snapshot.zip` and `/api/health` took a `path` and resolved it with
  `path.resolve`, which accepts an absolute one. With a bearer token, that made the page an
  arbitrary-file-read endpoint for anything the process could read — the token was the only boundary,
  and a leaked token (or a tunnel) widened it to the whole disk.
- The server now records the directory it was started for and the clones it created, and answers
  `403` for anything else. The token still decides who may ask; this decides what may be asked
  about. The docs say which is which.

Verified: all three endpoints refuse the parent directory with `403` and still serve the generated
snapshot inside it; the nine serve tests pass.
## 0.12.98

- The goal log records the 0.12.96-0.12.97 round and the last verify before the milestone: 1316
  tests, 1308 pass, 0 fail.
## 0.12.97

- **`GET /healthz` says which build is answering.** It returned `ok`, the name and a tool count; a
  probe that reaches a stale process had no way to tell. It now carries `version` and
  `uptimeSeconds`, needs no token, and is covered by a test.
- `health --all-members --format json` is pinned by a test: one record per member with its score and
  counts, the combined score equal to the weakest, and no `error` field for a healthy member.
## 0.12.96

- **`snapshot_generate` can pack and can narrow.** `pack` (single/xml/json) is a config setting the
  tool could not reach, and `slice`/`sliceTokens`/`budgetTokens` are generate options it never had —
  so an MCP client could ask for the whole repository but not for the twenty thousand tokens of it
  that answer its question. Both travel as the CLI sends them: `pack` through the configuration, the
  narrowing through the worker's generate options. Passing `slice` and `budgetTokens` together is
  refused with the same reason the CLI gives.

Verified: `pack: "xml"` writes `full-codebase.xml`; a slice records its question and budget; a budget
records its block; the pair is an error.
## 0.12.95

- The goal log records the 0.12.93-0.12.94 round, including the probes that found nothing: an empty
  repository generates as 0 files / 0 parts and still validates, and two concurrent generates are
  serialised by the staging lock with a message that says which lock and how old its heartbeat is.
## 0.12.94

**Two tools answered a missing path with silence.**

- `snapshot_context` returned an empty text block for a path that is not in the snapshot, with the
  path only in `structuredContent.missing`. Most clients render the text, so "not here" read as "this
  file is empty". It now ends with `Not returned: <paths>.`
- `snapshot_diff_context` said "No file in the snapshot imports the changed paths" when the changed
  paths were never read. That is a fact it had not checked; it now says
  `Not in the snapshot: <paths>.` — and names any path it could not include alongside the dependents
  it did find.

Verified: both tools name the missing path in their text, and the diff context no longer claims a
dependent fact it did not check.
## 0.12.93

- **`snapshot_status` reports an unreadable manifest as an error, not as a status.** "No snapshot
  yet" and "the manifest is not a snapshot manifest" were both returned as a normal result with
  `present: false`, so a client reading the second planned around a snapshot it could never read. The
  missing case stays a successful answer (that is what the tool is for); a manifest that exists and
  fails the shape check sets `isError`.

Verified: a repository without a snapshot answers with `present: false` and no error; a manifest with
  `indexes` removed answers with `isError` and the shape message.
## 0.12.92

- The goal log records the 0.12.90-0.12.91 round, including the three probes that found nothing: a
  BOM+CRLF config parses, a zip round-trips non-ASCII and bracketed names through Expand-Archive, and
  a path beyond 260 characters scans correctly on this host.
## 0.12.91

- **The host-path check missed a Windows path written as a string literal.** `C:\Users\name` was
  caught; `C:\\Users\\name` — the exact spelling inside a JavaScript or JSON string, which is how
  such a path usually reaches a source file — was not, and `C:/Users/name` was not either. On a
  Windows host that is the most likely shape of the leak the check exists to find. The pattern now
  accepts one or more separators, either kind.

Verified: a source file with the doubled form warns and reports `C:\\Users\\someone`; the plain and
  forward-slash spellings still warn.
## 0.12.90

- **The configuration page documents the transforms and the opt-in reports.** `stripComments`,
  `removeEmptyLines`, `logCount` and `pack`, plus the `diff`, `log`, `tokenTree` and `sarif` artifacts,
  were readable only in the CLI page or the source. The new section says which of them change line
  numbering, that all four are part of the config digest, and that `validate` must be given the same
  flags — the rule a user discovers the hard way otherwise.

Verified: site builds 29 pages and `audit-site` reports no problems.
## 0.12.89

- The goal log records the 0.12.87-0.12.88 round: the CLI page completed and guarded, and the
  unusual-file probes pinned as tests.
## 0.12.88

- **Unusual files are a pinned test, not a one-off probe.** An empty file, a CRLF file, a file that
  is nothing but comments under `--strip-comments`, a non-ASCII name, spaces and brackets in a name,
  and a path deep enough to make a Windows path long: generate, `validate` and `health` all pass, the
  manifest records the right line counts and mode, and `snapshot_read` and `snapshot_locate` answer
  for `src/odd [name] (v2).ts`.
- The probes ran against the built binary before they became tests; nothing needed fixing, which is
  worth recording too — the scan and part code handles these cases already, and now a regression
  would be caught rather than discovered.
## 0.12.87

**The CLI reference was missing ten options.**

- `docs/cli.md` is described as "Every command and option". It was missing the six transport flags
  (`--http`, `--port`, `--host`, `--token`, `--no-auth`, `--allow-origin`) and `--all-members`,
  `--strict`, `--mode`, `--no-update-check`. All ten have rows now, in the same five-column shape as
  the rest, with the contract's own defaults and applies-to text.
- A new test compares the page with `describe --format json` in both directions: a published option
  the page omits, and a documented option the contract no longer publishes, both fail.

Verified: 60 contract options, 60 documented, none missing and none unknown.
## 0.12.86

- The phase checklists in `GOAL.md` are ticked against what actually shipped, with the two judgment
  calls written down rather than left as unticked boxes: base64/binary is closed as not applicable
  (binaries are skipped, never encoded), and gitingest is supported by the comparison harness but not
  installed in this environment, so only repomix appears in the measured table.
## 0.12.85

**`--remove-empty-lines`: the last parity flag.**

- Blank and whitespace-only lines are dropped from emitted bodies, on the CLI and through
  `snapshot_generate { removeEmptyLines: true }`. It is the one transform that moves line numbers,
  so every affected file records `emptyLinesRemoved: true`, the brief states how many files were
  renumbered and tells the reader not to cite a line number for them, and the config digest covers
  the setting.
- Because the digest now covers it, `validate` must be given the same flag: without it the run
  reports configuration drift, which is the same contract `--strip-comments` has had since 0.12.84.

Verified: a body with blank lines is emitted without them, the file entry carries the marker, the
brief says so, `validate --remove-empty-lines` passes and `validate` without it reports drift.
## 0.12.84

**`validate` compared a digest that did not cover three settings that change the bytes.**

- `--strip-comments`, `--pack` and the `--include-logs` count were missing from `configDigest`, so a
  snapshot generated with `--strip-comments` and validated without it compared equal: the bodies on
  disk were comment-free and the configuration said comments were kept. `option-scope.ts` already
  claimed `validate` accepted `--strip-comments` "because the digest is computed over all of them" —
  it was not, and now it is.
- Each field is written into the digest material only when it is not the default, so a snapshot
  taken with the defaults keeps the digest it was recorded with and does not report drift after an
  upgrade. A snapshot actually generated with one of these flags reports the change it was made
  with, which is the answer `validate` promises.

Verified: the digest moves for `stripComments`, `pack` and a non-default `logCount`, and an explicit
default compares equal to the default.
## 0.12.83

- **The troubleshooting page covers the features added since it was written.** A new section maps the
  failure modes of selections, workspaces and signatures to their real messages: the `--slice`/`--delta`
  and `--slice`/`--budget-tokens` refusals, the selection warning `validate` prints, the `not-selected`
  answer from `explain`, a missing workspace index or member, why the combined score is the weakest
  member, a signature that does not verify, the https-only and 1 GB refusals for `--remote`, and the
  opt-in log report `snapshot_history` needs.
- These are the messages a user hits first, and until now the page that promises "every message below
  is the real text the tool prints" did not list them.

Verified: site builds 29 pages and `audit-site` reports no problems.
## 0.12.82

- The goal log records the 0.12.80-0.12.81 round: `health --all-members` and the workspace workflow
  page.
## 0.12.81

- **The workspace page now shows the whole workflow**, not just the generate call: the health audit
  across members, validating one member against its repository, and serving the index to an agent
  through `snapshot_workspace`. Each command in it was run on a fixture while the feature shipped.
## 0.12.80

- **`health --all-members` audits a whole workspace.** It reads `WORKSPACE.json` and audits every
  member snapshot a `--workspace` run wrote, one row each; the combined score is the weakest member,
  and a missing member snapshot is an error row rather than a silent skip. `--format json` returns
  the members with their counts and failed check ids.
- The flag is registered in the parser, the option-scope table and the contract, so `describe` says
  it applies to `health` and nowhere else — the parser rejects it anywhere else.

Verified: a two-member workspace audits to 0 with both members listed; tampering with one member's
part fails the run and names that member; no index gives exit 1 with the instruction.
## 0.12.79

- The goal log records the 0.12.77-0.12.78 round: `snapshot_history`, the `--include-logs` count fix,
  `maxScanBytes` on the health tool, and the page-parity test.
## 0.12.78

- **`snapshot_health` takes `maxScanBytes`.** The audit reads text to look for secrets and host
  paths; on a multi-gigabyte snapshot that is the expensive half, and a client may want the structural
  checks without it. The bound is stated in the result like every other audit cap.
- A test now compares `docs/mcp.md`'s tool table with the served set, so a tool added without its
  row — or a row left behind — fails the suite. It and the argument check from 0.12.73 keep the two
  MCP pages from drifting apart.

Verified: 26 MCP/docs tests pass, including the new page parity check and the `maxScanBytes` example.
## 0.12.77

- **`snapshot_history`, the 24th tool.** The commits behind the snapshot, read from
  `reports/log.md`: hash, date, subject. When the report was not written it says how to make one
  (`includeLogs`) instead of returning an empty list.
- **`--include-logs <n>` was ignored.** The flag turned the report on, but the count was read from
  `logCount` alone, so `--include-logs 3` wrote the default twenty and told nobody. A request that
  is accepted and dropped is exactly the silent fallback this project forbids; the number is now
  the count, for the CLI and for `snapshot_generate { includeLogs: n }` alike.

Verified: a generated log report is parsed into commits with a hash, a date and a subject; the
count from the flag is the count in the file; a snapshot without the report says how to make one.
## 0.12.76

- The goal log records the 0.12.72-0.12.75 round: the tool reference and the test that guards it,
  `snapshot_tests` as the 23rd tool, and the verify totals.
## 0.12.75

- `tests/mcp-tools.test.js` ended with two newlines after the new test was appended; the lint gate
  caught it, and it is one newline again.
## 0.12.74

- **`snapshot_tests`, the 23rd tool.** Given a path, the tests that import it — plus the ones named
  after it, because a test file and the source it exercises often share a stem without importing
  each other. With no path, every test file and the files it covers. "Which tests should I run?" is
  the second question after "what changed".
- Counts follow everywhere: README, the site description, `AGENTS.md`, the skill, the reference page
  and the MCP tool table.

Verified: a test importing `src/user.ts` is found by the path query and by the full listing; a path
no test mentions says so instead of returning an empty list.
## 0.12.73

- **The tool reference is checked against the real schemas.** Three examples on the new page were
  wrong — `snapshot_locate` takes `query`/`by`, not `path`; `snapshot_context` takes `files`, not
  `paths`; `snapshot_dependents` takes `direction`/`limit`, not `depth` — and a reader who sent them
  would have got an error from the page that promised they worked. The examples are fixed, and
  `tests/docs-tools.test.js` now parses the page and fails when a documented tool does not exist, an
  argument is not in its schema, a type disagrees, or a required argument is missing.

Verified: both checks pass over all 22 documented tools.
## 0.12.72

**A tool reference page: all 22 tools, with a call you can send.**

- `docs/tools.md` lists every tool by name, cost class and read-only status, with one ready-to-send
  JSON-RPC call each and the conventions they share (root, outDir, errors that say why). The site is
  now 29 pages; `docs/mcp.md` links to it.
- The page states what the tools will not do: a tool that cannot answer returns `isError` with a
  reason instead of an empty list that looks like a true negative.

Verified: `npm run site` builds 29 pages and `audit-site` reports no problems.
## 0.12.71

- The goal log records the 0.12.65-0.12.70 stretch: the head-to-head harness and its measured
  numbers, `snapshot_workspace` (22 tools), route methods in a review, the contract's static/report
  resource split, and the selection section in `report`.
## 0.12.70

- **`report` says which selection produced the snapshot.** A budget or slice snapshot is a choice,
  and the summary printed only totals: now it prints the slice question and cost, the budget usage
  and coverage (entry points, symbols), and the delta base with its changed/added/removed/unchanged
  counts. The data was in the manifest; the first screen a reader opens did not show it.

Verified: a budget snapshot reports its section, usage and entry-point coverage.
## 0.12.69

- **The contract distinguishes static resources from report resources.** Splitting the list fixed two
  real failures: `resources/list` no longer advertises a report that was never written (0.12.62), but
  `describe` still claimed all six unconditionally, so the parity tests — correctly — failed.
  `describe` now publishes `resources` (the four always-present) and `reportResources` (the six, served
  only when written); the tests assert that split.

Verified: 48 MCP/contract/hygiene tests pass, including the two that caught it.
## 0.12.68

- **`snapshot_review` names the route methods a change touches.** A review of `route.ts` that says
  only "3 files, 120 lines" hides the fact that a `GET` and a `POST` changed shape. The summary
  already recorded the methods; the review now prints them and returns them as `routes`.

Verified: a file exporting `handler as GET, handler as POST` is reviewed with
`Routes touched: GET/POST src/users/route.ts`.
## 0.12.67

- **`snapshot_workspace` joins the server: 22 tools.** It reads `WORKSPACE.json` and answers which
  members exist and which imports cross between them — the first question on a monorepo. Without a
  workspace index it says how to make one rather than returning an empty list.

Verified: two members and an app→shared link are reported and printed; a missing index is an error
that names `--workspace`.
## 0.12.66

- `scripts/compare.mjs` is the one change: the file ends with a newline, and the lint gate is clean
  again. 0.12.65 shipped the harness with that rule failing, which is exactly what the gate exists to
  catch and what `npm run verify` would have refused.
## 0.12.65

**A measured head-to-head, not a claim.**

- `scripts/compare.mjs` runs this tool's full, slice and budget packs and, with `--repomix`, repomix
  through `npx` (never a dependency), in one run on one repository. `--gitingest` does the same for
  gitingest when it is installed; a missing competitor is reported, not silently skipped into a
  misleading table.
- Measured here at 0.12.65 against repomix 1.19.0: 330 files / 1,027,911 estimated tokens for us,
  329 files / 854,178 for repomix, with slice at 6.5% and budget at 3.5% of our full pack. The
  difference is the estimator — we count one token per four bytes, repomix uses a tokenizer — and
  the page says so, including that our number is the conservative one.
- `docs/benchmarks.md` carries the table, the caveats and the exact command to reproduce it; a test
  runs the harness on a fixture so it cannot rot.
## 0.12.64

- The goal log records the 0.12.50-0.12.63 round: cancellation, the opt-in reports through MCP,
  tool cost classes, the page's slice/budget modes and health score, and the five correctness fixes
  the probes found (selection validate, signature and report expectations, explain, resources).

## 0.12.63

- Removed four `.probe-*.mjs` scratch scripts that an earlier `add -A` committed. They were
  investigation scaffolding, not source, and they had no place in the tree.

## 0.12.62

- **`resources/list` no longer advertises a report that was never written.** The three opt-in
  reports were listed unconditionally, so a client that trusted the list got an error on every read
  of a report the run did not produce. A resource in the list is now a promise that the read works;
  asking for an absent report directly still explains why it is not there.
- The reports directory is resolved against the repository root, so a relative `outDir` in the
  configured project is found instead of being resolved against the process's working directory.

Verified: a default snapshot lists `reports/audit` and not `reports/diff`; generating with
`tokenTree: true` makes `reports/tokens` appear and readable.
## 0.12.61

- **`explain` answers why a selection dropped a file.** On a slice or budget snapshot, a file that
  passes every per-file rule was reported as "part: (not in the last snapshot; run generate)" — true
  and useless. The manifest records the decision, so explain now reads it and answers
  `included: no, reason: not-selected` with the detail the run wrote.
- The same lookup covers `unchanged` for a snapshot that records a changed-files scope.

Verified: on a slice snapshot, explaining a dropped file reports `not-selected` and names the
selection; the six earlier slice tests still pass.
## 0.12.60

- The version note at the top of this file still claimed there would be no `0.13` and that every
  change was a patch; the project has moved to the 0.12.x→0.17.0 ladder with npm publication at
  `x.y.0`. The note now states the policy that is actually in force.
- `tests/mcp-cancel.test.js` created its scratch directory at module load and never removed it; the
  hygiene test caught the leak and the directory now dies with the test.

Verified: full `verify` green at 1291 tests, 1283 pass, 0 fail; the changelog/version agreement test
passes.

## 0.12.59

- **The workspace docs named a command that cannot work.** A member snapshot lives at
  `<outDir>/<name>`, not `<name>/snapshot`, so `snapshot health --cwd api` finds nothing. The page now
  shows the real invocation (`--cwd api --out-dir ../context/api`) and says what the MCP server needs
  to serve one member.
- A delta pack and a token budget compose, and a test now pins it: narrow to the change, then fit the
  window, with both blocks recorded.
## 0.12.58

**The health audit knows every artifact the run wrote.**

- `reports/diff.md`, `reports/log.md`, `reports/tokens.md`, `full-codebase.xml` and
  `reports/audit.sarif` were missing from the audit's expected set, so a snapshot that used any of
  them warned "unexpected path" about a file the tool had just written. All five are known now, and
  their digests are verified when the manifest records them.
- Expected paths are derived from what the manifest declares rather than from a static list, so an
  artifact a run did not write is not expected and a file it did not declare is still unexpected.

Verified: a snapshot with every artifact reports 13 passed, 0 warnings, no unexpected path.
## 0.12.57

- **A signed snapshot no longer reports `signature.json` as an unexpected file.** The health audit
  knew every artifact the manifest records, and the signature is written after the manifest, so it
  was not among them. It is now part of the expected set, and the check still verifies it.

Verified: generating with `--sign` and auditing reports no unexpected path and says the signature
verifies; an unsigned snapshot keeps the skip.
## 0.12.56

**`validate` no longer fails a correct slice or budget snapshot.**

- Files a `--slice` or `--budget-tokens` run deliberately left out were reported as "new file …
  missing from the snapshot", so `validate` exited 1 on a snapshot that was exactly right. They are
  skipped with reason `not-selected`, and that is now treated as accounted for rather than drift.
- `validate` cannot re-run the planner — the question and the budget are not in the manifest — so it
  says so in a warning: it checks what is present and does not second-guess the selection. A changed
  file that *is* in the snapshot is still drift, which the test pins.

Verified: a slice validates clean, a budget snapshot validates clean, and editing a selected file
still fails with its path.
## 0.12.55

- **`--slice` and `--budget-tokens` together are refused.** Both narrow the selection, nothing defined
  which should win, and the combination produced an empty snapshot in testing. The error points at
  `--slice-tokens` for the slice's own budget. `--delta` still composes with a budget, which is
  defined: narrow to the change, then fit it.

Verified: the combination exits non-zero with the reason; the slice tests still pass.
## 0.12.54

- **The page audits what it just wrote.** `POST /api/generate` returns a health summary (score,
  failed check ids, warning count) and the page shows it beside the fingerprint. `GET /api/health?path=`
  re-runs the audit for the snapshot on screen.
- A page that can produce a snapshot and not say whether it is safe to hand over was only half a
  tool; the health service was already there, and now it is on the surface.

Verified: generation returns a score, the standalone endpoint returns the same score with the full
check list, and the eight serve tests pass.
## 0.12.53

- **The browser page can slice and budget, not only dump everything.** A mode selector offers *whole
  repository*, *a slice for a question* and *fit a token budget*; the API accepts
  `{ mode, question, budgetTokens }`, validates them (a slice needs a real question, a budget at least
  500) and reports how many paths were not selected.
- The page sends the mode and the result line says which one ran, so the same page is useful for a
  question, a context window and a full audit.

Verified: slice and budget modes generate through the API with their `dropped` counts; a slice with
an empty question and a budget below 500 are 400s.
## 0.12.52

- **Every tool states its cost**: `cheap` (manifest), `medium` (one or a few parts), `expensive`
  (reads the repository or writes), published as `_meta["codebase-snapshot/cost"]` in `tools/list`
  and as `cost` in `describe --format json`. The table lives in one place and `buildTools` throws if
  a tool is added without one.

Verified: every one of the 21 tools reports a valid class through the protocol, and the contract lists
them.
## 0.12.51

- **`snapshot_generate` can write the opt-in reports.** `includeDiffs`, `includeLogs <n>`,
  `tokenTree` and `stripComments` are tool arguments now, so a client can ask for the diff, the log,
  the token tree or comment stripping without shelling out to the CLI. The options travel to the
  worker exactly as the CLI passes them, and `--skip-artifacts` semantics are unchanged.

Verified: generating with `tokenTree: true` writes `reports/tokens.md` and records it in
`artifacts.tokenTree`.
## 0.12.50

**Cancellation reaches the tool.**

- `notifications/cancelled` with a `requestId` now runs a callback the running call registered.
  `snapshot_generate` terminates its worker and answers "The generation was cancelled."; the
  staging rules remove what was half-written, so no snapshot claims to be complete.
- Every tool is offered the hook; the ones that are bounded simply finish before they could notice.
  The response says the call was cancelled rather than pretending it never ran.
- The docs no longer claim cancellation is ignored.

Verified: a stub tool registers its callback, the notification reaches it, and the call resolves with
the cancelled result; the existing progress tests still pass.

## 0.12.49

- The goal log records the 0.12.15-0.12.48 stretch: what shipped, the verify totals, and the work
  still open for the next rounds. Documentation only.

## 0.12.48

- **The brief names the opt-in reports this run wrote.** `PROMPT.md` has one list of "what else you
  were given"; `reports/diff.md`, `reports/log.md` and `reports/tokens.md` were missing from it, so a
  reader was never told to open a report the run had just produced. Each is listed when — and only
  when — the manifest records it.
- Roadmap statuses brought up to date: 21 tools, workspace cross-links, the budget coverage report,
  and the binary files item closed as not applicable (binaries are skipped, never base64-encoded).

Verified: a run with `--token-tree --include-diffs` names both reports and does not name the log it
was not asked for; full `verify` green at 1279 tests, 1271 pass, 0 fail.
## 0.12.47

- **`snapshot_plan_for` includes the callers of its strongest matches.** Dependencies alone answer
  "what does this use"; a reader editing a function also needs "what uses this". Up to four callers
  of the top three files are pulled in with `why: "imports <path>"`, still inside the budget.
- The planner now resolves `.js` specifiers to their `.ts`/`.tsx` files and extension-less
  specifiers, so a TypeScript repository's caller edges are found rather than looking empty.

Verified: a question matching `getUser` plans `src/user.ts` and its caller `src/auth.ts`, with the
caller's reason naming the dependency.
## 0.12.46

**Four graph tools: 21 in total.**

- `snapshot_entrypoints`: the files a reader should start from (manifests first, then `index`/`main`/
  `app`/`server`/`cli`), with importer counts and token costs. The same heuristic the budget planner
  uses, exposed so an agent can start where a maintainer would.
- `snapshot_neighbors`: both directions of the import graph for one path — what it imports and what
  imports it, resolved against the snapshot and listed with their parts.
- `snapshot_routes`: every route a summary recorded, with the file and part. A project without
  framework routes reports none rather than an empty table with no explanation.
- `snapshot_cycles`: strongly connected components in the import graph, computed with the same
  resolver the generator uses, so a reported cycle is one the snapshot really has.
- `docs/mcp.md` lists all 21, and the hygiene test holds the count.

Verified: a two-file loop is found and a clean tree reports none; neighbors names both directions;
entry points sort manifests first; routes reports a count even when it is zero.
## 0.12.45

- **Workspaces record cross-member imports.** A relative import in one member that resolves inside
  another becomes a link in `WORKSPACE.json` — from, to, specifier count and a few example paths —
  and the summary prints it. It is the one thing a per-member snapshot cannot see, and the first
  thing a reader of a monorepo needs.
- The edge is a static link from the specifier text: it says the members are coupled, not that the
  target file is present in the other member's snapshot. The docs say so.

Verified: an app→shared import is recorded with its example path and printed; the three earlier
workspace behaviours still pass.
## 0.12.44

- **The token-budget report says what survived.** `budget.coverage` records, per layer, how many
  files were kept of how many, plus entry points and exported symbols. The brief quotes the symbol
  and entry-point counts, and a lost entry point is a warning rather than a silent omission.

Verified: the coverage block exists, every `kept` is at most its `total`, symbols are counted from
the summaries, and the fixture's entry points are counted.
## 0.12.43

- **MCP progress notifications.** A `tools/call` carrying `_meta.progressToken` receives
  `notifications/progress` while it runs; `snapshot_generate` reports "generating" and "writing the
  snapshot" with a 2-step total. A call without a token emits nothing.
- Notifications are delivered by the stdio loop; the HTTP transport answers one request with one
  document and cannot interleave them.
- `notifications/cancelled` is still accepted and ignored, and the docs now say so instead of leaving
  a client to guess: there is no cancellation signal inside a generate.

Verified: a call with a token emits notifications carrying that token and a numeric progress before
the response; a call without one emits nothing.
## 0.12.42

- **The language profiles are pinned by a test.** Python, Go, Rust, Java, C#, Ruby and PHP each get a
  fixture asserting what the docs claim: imports, top-level definitions and, for Python, route
  decorators. The profiles predate this stretch; the test exists so a regression in the import graph
  or `snapshot_locate` for those languages fails here instead of in a user's repository.
## 0.12.41

**Two more tools: `snapshot_search` and `snapshot_stats`.**

- `snapshot_search` answers "where is this mentioned?" across the emitted parts, case-insensitive or
  as a regular expression, with a match cap, a scan budget and optional context lines. It reads only
  what the snapshot contains, so a redacted value and an excluded file cannot be found by searching
  for them. A query under three characters is refused rather than matching everything.
- `snapshot_stats` reads the manifest: files by layer and kind, part sizes, token estimate, the
  heaviest files and the most expensive parts.
- Seventeen tools now, and every count in the docs follows.

Verified: a symbol is found with real line numbers, an absent string finds nothing, a two-character
query and an invalid regex are refused, and stats agree with the manifest exactly.
## 0.12.40

**`--strip-comments`: less prose, same line numbers.**

- Removes comment text from JavaScript and TypeScript bodies before emission. The TypeScript
  **parser** decides what is a comment, so a marker inside a string, a template literal, a regex
  literal or JSX attribute is left alone — the case a regular expression gets wrong.
- Newlines inside removed comments are kept, so every line number in the manifest still points at
  the same source line. Files record `inclusionMode: "comments-stripped"` rather than `full`, and
  the brief says comments were removed.
- `--strip-comments` is accepted by `validate` (it changes the recorded configuration), and `explain`
  reports the same mode `generate` would choose.

Verified: a fixture with a URL, a template literal, a regex and block comments loses only the
comments; line counts and `originalLines` are unchanged; markdown is untouched; health stays clean.

## 0.12.39

- The roadmap records what shipped, with the version that shipped it, rather than a wall of
  `planned` rows that no longer describe the repository.
- The workspace page title fits the site title budget that `audit-site` enforces.

## 0.12.38

**`--workspace a,b`: several repositories, one deliverable.**

- One snapshot per member under `<outDir>/<name>`, plus `WORKSPACE.json` listing each member's
  fingerprint, file count, part count and token estimate. Each member directory is a normal
  snapshot: `health`, `validate` and the MCP server work on it.
- Members are generated on the defaults: a member may contain a config that runs code, and a
  workspace is a set of repositories the caller named, not one they configured.
- A missing member is named and the run exits 1 **after** writing the members that succeeded, so a
  partial workspace is never mistaken for a complete one.
- Refused with `--remote`, `--delta`, `--slice`, `--budget-tokens` and `--sign`: those narrow or sign
  one snapshot.

Verified: two members produce two manifests and two records; a missing member exits 1 with the good
member written; the combination refusal names the conflicting flags.
## 0.12.37

- **A migration guide** for 0.12.14 → 0.17.0: every new command, `generate` flag and config key with
  the version that added it, the MCP surface from eight to fifteen tools and two to seven prompts,
  and the two behaviour changes (`validate` accepts the report flags; npm publishes only at
  `x.y.0`). It also says what did not change, which for a reader deciding whether to upgrade is the
  first question.
## 0.12.36

- **The opt-in reports are resources too**: `snapshot://reports/diff`, `snapshot://reports/log` and
  `snapshot://reports/tokens` are listed and readable when the snapshot has them. When it does not,
  the read is a not-found that names the artifact, not an empty document that looks like an answer.

Verified: all three are advertised by `resources/list`, and reading one from a snapshot generated
without the flag raises the documented not-found error.
## 0.12.35

- **A Dockerfile, entrypoint and deploy page.** The image copies the built bundle and runs as the
  `node` user; the entrypoint **refuses to start without `SNAPSHOT_TOKEN`**, because `serve` on
  `0.0.0.0` without one would expose the repository. Compose and systemd examples are on the page.
- The packaging suite pins the mistakes that make a Dockerfile rot: a `COPY` of a path that no
  longer exists, a floating `latest` base, an entrypoint that starts without a token, and a
  `.dockerignore` that stops excluding repository state. The build itself is not exercised here
  because Docker is not available in this environment, and the page says the image is not published.
## 0.12.34

- **`scripts/benchmark.mjs` and a benchmarks page.** Three modes on this repository: full 987,750
  estimated tokens across 313 files and 11 parts; a task slice 66,430 tokens (6.7%); a 30,000-token
  budget 36,315 tokens across 21 whole files (3.7%). Generation time is about the same in all three,
  which is the point: the saving is in what is written, not in what is read. The script is runnable
  against any repository.
- **A security review page.** The threat model (malicious repository, URL, browser page, MCP client,
  log reader), the controls for each surface, the tests that pin them, and six residual risks stated
  rather than hidden — including the SSE query token, DNS rebinding and prompt injection.
## 0.12.33

**`--budget-tokens <n>`: fit a repository into a limit without tearing files.**

- Part budgets truncate; a token budget **selects whole files**. Entry points first, then the
  most-imported, configuration before source and tests last, with a small penalty for cost so a
  cheap file that matters beats an expensive one that barely does.
- The selection is recorded in `budget { maxTokens, usedTokens, files, dropped }`; every path that
  did not fit is in `skipped[]` with reason `not-selected`, and the brief states the budget, the
  selection size and the drop count.
- It composes with `--delta`, so a budget can be spent only on what changed.

Verified: the selection fits the budget, the entry point survives, every selected file is
`inclusionMode: full`, and a budget too small for anything still exits cleanly and says so.
## 0.12.32

**Signed snapshots (`--sign`).**

- Signs the exact bytes of `manifest.json` with Ed25519 and writes `signature.json` beside it:
  algorithm, fingerprint, `manifestSha256`, public key, signature, and whether the key was
  configured or generated. One signature covers every part and artifact through the manifest digests.
- The key comes from `SNAPSHOT_SIGNING_KEY` (PEM). With none set, a fresh key is generated and its
  public half is written in the record — trust on first use, stated as such in the file and the docs.
- `snapshot health` verifies a signature when present: a manifest changed after signing is a
  critical failure; no signature is a skip, because absence is not tampering.

Verified: a generated signature verifies and health agrees; a tampered manifest fails with
"changed after it was signed"; a configured key produces a record the matching public key verifies;
an unsigned snapshot skips the check.
## 0.12.31

**`--pack single|xml|json`: one full-repository file, in the shape you asked for.**

- `--pack xml` writes `full-codebase.xml` (one `<file>` element per source, attributes for layer,
  kind, language, lines and bytes, the body in CDATA). `]]>` cannot appear in CDATA, so it is split
  across two sections — a file containing that sequence still produces valid XML.
- `--pack single` writes only `full-codebase.md`; `--pack json` only `full-codebase.json`. Unset
  keeps the historical `--include-monolith` pair, so nothing that worked before changes.
- The chosen pack is gated by `--max-monolith-bytes` like the pair, records its digest in
  `artifacts` (`fullXml` for XML), and `validate` requires it to exist and match.

Verified: XML parses and has one element per file including a `]]>` body; each mode writes only its
file; a deleted XML fails validate with its path; an invalid mode is a usage error.
## 0.12.30

**`snapshot_review`: three questions in one call.**

- Returns whether the snapshot is current (validate), the health score with every failed check, and
  the head window of the paths a change touched. A reviewer starts with one call instead of three.
- Fifteen tools now; every count in the docs follows, enforced by the hygiene test.

Verified: a current snapshot reviews clean with the requested body; an edited file makes the same
call report stale while still returning the body.
## 0.12.29

- **Legacy SSE transport** for clients that predate Streamable HTTP: `GET /sse` announces
  `/messages?sessionId=…`, the client POSTs JSON-RPC and reads the answer as a `message` event.
  The token may arrive as `?token=` on this path only, because `EventSource` cannot set headers;
  the docs say that is a leak into logs. A heartbeat every 15 s keeps the stream alive, and
  shutdown ends the streams instead of waiting on them forever.
- `/healthz` reports the real tool count (it said 12 while the server served 14).

Verified: a full SSE handshake and JSON-RPC answer, 401 without the token, 404 for an unknown
session id, and the suite no longer hangs on teardown.
## 0.12.28

- `validate` now checks the opt-in reports the manifest declares (`reports/diff.md`,
  `reports/log.md`, `reports/tokens.md`), like it already checked the README, brief, navigation,
  tree, audit and monoliths. Deleting one fails with its path instead of leaving validate green.
- `validate` accepts `--include-diffs`, `--include-logs` and `--token-tree`, because those flags
  change the artifact selection the manifest records: without them validate reported the selection
  as drift. Comparing like with like is the point of a drift check.
## 0.12.27

- Site: hand-written meta descriptions for the five pages added in this stretch (`health`, `serve`,
  `remote`, `delta`, `slice`), each 100–160 characters and stating the problem, the artifact and the
  differentiator. `audit-site` caught the fallback descriptions as too long, which is what it is for.
## 0.12.26

**Task slices: `--slice "<question>"`.**

- The retrieval planner runs at generate time: only the files it chooses for the question are written,
  within `--slice-tokens` (default 30000). For a focused question about one subsystem, the snapshot
  is small enough to paste and carries the callers it needs.
- Every scanned path that was not chosen is in `skipped[]` with reason `not-selected` — deliberately
  not `unchanged`, which would be a different and untrue statement. The manifest records the
  question, the budget, the used tokens, the chosen paths and the dropped count.
- `PROMPT.md` says at the top that the snapshot is a slice, quotes the question and warns that
  unselected paths are not in the parts.
- Symbol matching learned stems: `charge` matches `chargeCard`, `authenticated` matches `auth`, which
  is what makes a real question plan something.
- `--slice` and `--delta` are refused together: they narrow in different directions.

Verified: the matching file is kept and the unrelated document is dropped and recorded; the budget
is a ceiling; the contradiction is refused.
## 0.12.25

**Delta packs: `--delta <base>`.**

- The snapshot contains only the files that changed since a base snapshot (compared by content
  hash, not mtime), plus the one-hop importers of those files. For a change review, that is the new
  bytes and the callers that might break, and nothing else.
- Nothing is dropped silently. Unchanged files go into `skipped[]` with reason `unchanged` **and**
  into `delta.unchanged`; the manifest records `base { path, fingerprint, generatedAt }` and the
  added/changed/removed lists.
- `PROMPT.md` states the delta at the top with the counts and the warning that unchanged files are
  not in the parts, so a reader cannot describe them from memory.
- The shared narrowing is now one function (`narrowTo`): totals, layer/kind counts, findings,
  warnings and monolith bodies are undone together, which `--with-dependents` and `--delta` both use.

Verified: changed file plus its importer are in the parts and the unrelated file is not; an added
and a removed file are classified; a missing base is an error that names the path.
## 0.12.24

**Three opt-in reports: the diff, the log, the token tree.**

- `--include-diffs` writes `reports/diff.md` from the unstaged and staged diff, names the git
  command, is bounded to 200 KiB with a truncation note, and is **absent when the tree is clean** —
  an empty report is noise. It records `artifacts.diff` in the manifest.
- `--include-logs <n>` writes `reports/log.md` with the last n commits (1–500, one line each). An
  invalid n is a usage error, not a silent default.
- `--token-tree` writes `reports/tokens.md`: per-file estimates sorted by cost with directory
  rollups, using the same estimate the manifest carries, and the rows add up to the stated total.
- All three are also config keys (`artifacts.diff`, `artifacts.log`, `artifacts.tokenTree`,
  `logCount`), default off, and `--skip-artifacts` still wins.

Verified: a clean tree produces no diff artifact and a changed one contains the change and the
command; the log names its range and the commit; the token rows sum to the stated total; a bad
`--include-logs` value is refused.
## 0.12.23

**Two more retrieval tools, aimed at the questions an agent actually asks.**

- `snapshot_symbol`: where is this function/class/constant defined? Returns the emitted window around
  the definition with a real line number, searched in the parts so redaction still applies. A miss
  says the symbol may be excluded, unsupported or named differently, and points at `snapshot_explain`.
- `snapshot_diff_context`: given the paths a change touched, the body window of each plus the files
  that import it, within a token budget. Dependents resolve through extension-less and `.js` → `.ts`
  specifiers, because that is how the repository writes them.
- Fourteen tools; the count in every document follows, enforced by the hygiene test.

Verified: symbol definition with line number, a clean miss, an empty name refused; diff context with
its dependent named, a missing path reported, and an empty list refused.
## 0.12.22

**Seven MCP prompts: two about order, five about a job.**

- `audit` (health, drift, exclusions, findings), `review` (plan the reading for a change, name the
  dependents), `explain` (why a path is here, what it does), `onboard` (a reading order for a new
  contributor), `security-review` (authn/authz, secrets, injection, and what the snapshot cannot
  see). `orient` and `keep-current` stay.
- Every tool a prompt names is a tool the server serves, and a test holds the two lists together so
  a prompt cannot point an agent at a name that does not exist.
- The docs no longer claim there is no HTTP transport, because there is one.

Verified: the seven prompts exist with descriptions, every `snapshot_*` name in every prompt is a
served tool, required arguments reach the text, and a missing optional argument yields the base
prompt.
## 0.12.21

- **The browser page accepts repository URLs.** `serve` uses the same parser, private-address
  refusal and shallow clone as `generate --remote`, generates into a temporary snapshot, and keeps
  the clone alive for the page until the server exits. `--allow-private` opts out deliberately;
  without it a URL pointing at the local network is a 400 with the reason.
- The API returns the snapshot directory (not the clone root), so preview and zip work on a remote
  exactly as they do on a local path.

Verified: a `file:` source clones through the API, the manifest carries the provenance, and
`https://127.0.0.1` is refused with "private address".
## 0.12.20

**`generate --remote`: a repository URL in, a traceable snapshot out.**

- https only, no credentials in the URL, and the resolved address must be public: loopback,
  RFC1918, link-local (including cloud metadata `169.254.169.254`), CGNAT and their v6 equivalents
  are refused unless `--allow-private` says otherwise. The host is checked again after DNS, because
  a name can point at 127.0.0.1.
- Shallow clone (`--depth 1`, one branch, no tags, no submodules, no LFS) into a temporary
  directory that is removed on exit; `--keep-clone` keeps it. `GITHUB_TOKEN` reaches git through
  the environment, never argv, and never enters the manifest.
- The manifest records `source: { url, host, owner, repo, ref, commit, fetchedAt }`, so the snapshot
  names the commit it describes instead of a branch that may have moved. A fetched repository is
  not a trusted one, so its config file is not loaded.
- `--allow-private` for air-gapped mirrors and `file:` tests; it is an explicit override, not a
  fallback.

Verified: parser and refusal table, private-address classification (v4 and v6), `file:` gated behind
`--allow-private`, and an end-to-end clone whose manifest carries a 40-character commit and writes
into the caller directory rather than the temp clone.
## 0.12.19

**`snapshot serve`: the browser face.**

- One process serves the page, the API it calls, and MCP at `POST /mcp`, all on loopback with one
  bearer token, generated on first run and printed once. The page asks for the token and keeps it
  in `localStorage`, so serving `/` can never leak the credential.
- `POST /api/generate` runs the same `generateSnapshot` the CLI runs, with the defaults (a page
  request must not execute repository config code); `GET /api/snapshot` returns the brief and the
  file list from the written snapshot; `GET /api/snapshot.zip` returns the directory as a zip.
- A store-only zip writer, no dependencies, with a parser test that reads the central directory back
  and a manual check that Windows `Expand-Archive` opens it.
- A remote URL is refused with the reason ("not enabled in this build") rather than a pretend fetch.

Verified: page without token, API without token 401, generate → preview → zip round trip, the
remote refusal, MCP on the same port, 404 for an unknown path.
## 0.12.18

**MCP over HTTP, for the clients that cannot spawn a process.**

- `snapshot mcp --http` serves the same twelve tools as Streamable HTTP: POST a JSON-RPC message
  (or an array) to `/mcp`, read the answer from the response body. `GET /healthz` answers
  `{ ok, name, tools }`.
- Loopback by default (`127.0.0.1:4789`). A bearer token is generated on first run and printed;
  `--token` picks one, `--no-auth` turns the requirement off and is refused on a non-loopback bind.
- CORS for loopback origins and any `--allow-origin` listed; everything else gets 403. Bodies are
  capped at 2 MB, requests at 60 per 10 s per address, and every error is a JSON-RPC error document.

Verified: initialize and tools/list over POST, 401 without the token, `--no-auth` refusing a
non-loopback bind, CORS allow/deny, a notification answered 202, invalid JSON answered -32700, and
the health endpoint.
## 0.12.17

- **`snapshot_context`**: named files or exported symbols in, one bounded context block out, read
  from the snapshot (so redacted and preview-bounded). Each file contributes a head window; a file
  that does not fit is shortened and says "first N lines", never silently dropped, and a file that
  cannot be shortened is listed in `missing` with the reason.
- Twelve tools. The counts in the docs move with the server, enforced by the hygiene test.

Verified: file and symbol lookup, honest `missing`, the budget ceiling and the shortened-file
notice are covered in `tests/mcp-retrieval.test.js`.
## 0.12.16

**Two retrieval tools, which are the point of the product.**

- `snapshot_plan_for`: given a question and a token budget, the smallest set of files that answer
  it, in reading order, each with the reason it was chosen and the part it lives in. Deterministic:
  path and symbol matches first (a question saying "authenticated" matches `auth.ts`), then the
  imports of the strongest matches, packed to the budget. A file too large for what remains is
  offered as a head-only read rather than dropped; every skip says why.
- `snapshot_query`: filter the index by layer, kind, a path regular expression or a symbol name,
  with the part, line count and token estimate. Invalid regular expressions are an error, not an
  empty result.

The MCP server now serves eleven tools. Every document that states the count agrees, enforced by
the existing hygiene test. npm publication now happens only at `x.y.0`; this version is tagged and
pushed, not published.

Verified: the new suite covers reading order, the budget ceiling, determinism, test exclusion, an
empty question, a missing snapshot, filtering, capping and an invalid pattern.
## 0.12.15

**New command: `snapshot health`.** `validate` answers "did the code move?"; health answers the
four questions a reader has before pasting a snapshot somewhere: did a secret survive into an
artifact, can the claims be checked, is the token count real, does this machine leak into the text.

- Checks: manifest shape, every part on disk and matching its hash, every file in exactly one part,
  every recorded artifact present and unchanged, nothing unexpected in the directory, an
  unmasked-secret scan of every written text file, a byte comparison against values from files
  excluded as sensitive, host paths, the recorded token estimate, the published budget, skip
  records and freshness.
- A 0-100 score (critical -25, warning -5), severities, `--format json`, and `--strict` (exit 2 on
  a critical failure). It never prints a secret it finds, and never writes.
- `snapshot_health` over MCP returns the same report as structured output.

Verified: the new suite covers a clean 100, a tampered part, a leaked secret (and that the value is
not echoed), a host path as a warning, a missing artifact, a stale snapshot and both exit codes.
## 0.12.14

- **A brief written without a manifest still pointed at one.** With `--skip-artifacts manifest`,
  `PROMPT.md` sent the reader to `manifest.skipped[]` for per-path reasons, to "the call graph in
  `manifest.json`" for entry points, and to `manifest.validation.status` for the check — none of
  which existed. `README.md` did the same. Each sentence now says what the run actually wrote.
- **The attachment arithmetic counted files that were not written.** "1 part plus `manifest.json`,
  `README.md` and the three reports — 6 of 10" became 5 of 10 the moment the manifest was skipped,
  and the list of accompanying files is built from what exists.

Both are the same failure as 0.12.12/0.12.13: an artifact describing a run it was not given.

Verified: 1 190 tests, 1 182 pass, 0 fail, 8 host skips; every gate clean at 0.12.14.
## 0.12.13

- **`README.md` counted a part it had just said was not written.** With `--skip-artifacts parts`,
  the header said "Part Count: 1 (budget 300 KB per part)" three lines above "No parts were
  written for this run." The count is what was written now: `0`, with the reason.

The second instance of the same class as 0.12.12 — an artifact describing a run it was not given —
and the reason the no-parts test checks both files.

Verified: 1 189 tests, 1 181 pass, 0 fail, 8 host skips; every gate clean at 0.12.13.
## 0.12.12

- **A brief written without parts described parts that were never written.** With
  `--skip-artifacts parts`, `PROMPT.md` said "Paste this file first, then the parts it names",
  listed `part-001.md` under "Parts: 1 at a 300 KB ceiling", claimed the files "are in the parts",
  and pointed at `reports/navigation.md` to "locate here before you read anything" — while zero
  part files existed. The manifest records the partition either way (`files[].part` needs it), so
  the brief now says what happened: no part files were written, the index still records the
  planned partition, and the code itself is not in the snapshot.

`docs/output.md` had claimed since 0.11.0 that `--skip-artifacts parts,audit` produces a brief that
does not tell a model to read parts. It does now.

Verified: 1 189 tests, 1 181 pass, 0 fail, 8 host skips; every gate clean at 0.12.12.
## 0.12.11

- **`setup` wrote the scaffold and did not mention it.** `init` said "Wrote BRIEF.md …"; `setup`,
  which runs the same wizard, printed everything except that line. A scaffold nobody is told about
  is a file for nothing.

Verified: 1 188 tests, 1 180 pass, 0 fail, 8 host skips; every gate clean at 0.12.11.
## 0.12.10

- **The contract said `init` writes nothing else.** It writes `BRIEF.md` as of 0.12.9, and the
  command summary still ended "Nothing else is written." It names the scaffold now and keeps the
  part that is still true: no agent file is written.

Verified: 1 187 tests, 1 179 pass, 0 fail, 8 host skips; every gate clean at 0.12.10.
## 0.12.9

- **`init` now writes `BRIEF.md`.** The scaffold holds the five headings with their guidance in
  comments, and the config keeps `brief:` commented: an untouched scaffold renders no section, and
  because nothing points at it, deleting the template cannot break `generate`. One edit enables it.
  The summary line says which edit.
- **HTML comments are stripped before the brief is parsed.** The scaffold is nothing but comments;
  without this, every comment would have been pasted into the model's instructions.
- **An empty recognised section is no longer rendered.** A heading someone has not filled in yet is
  not an assertion, and it no longer produces a provenance line above nothing.
- New page: [docs/brief.md](docs/brief.md) — the merge, the refusals, the parse rules and a worked
  example. Linked from the README table and the configuration page.

Verified: 1 187 tests, 1 179 pass, 0 fail, 8 host skips; lint 226 files; site 16 pages, 410 internal
links, 0 problems; every gate clean at 0.12.9.
## 0.12.8

- **0.12.7 published its own test log.** A `Tee-Object` capture (`.t127.txt`) was in the working
  tree when `git add -A` ran. Removed, and `.gitignore` now covers root-level `.*.txt` captures.

Nothing else changed. Verified: 1 183 tests, 1 175 pass, 0 fail, 8 host skips; every gate clean at
0.12.8.
## 0.12.7

- **A part ceiling below the per-layer bucket count could never be met, and the run said the wrong
  thing about why.** With `budgets.byLayer.test` and a default, `maxParts 1` has two buckets and
  each yields at least one part. The retry loop grew the budget six times (to 160 KB in the
  reproduction) and then advised "raise maxParts" without naming the real constraint. It now fails
  before the first probe: "maxParts 1 cannot be met: this configuration has 2 distinct part budgets
  across config, root, src, test ... Raise maxParts to at least 2, or remove the per-layer budgets."

Found by fuzzing per-layer budgets with a part ceiling. Verified: 1 183 tests, 1 175 pass, 0 fail,
8 host skips; lint 225 files; every gate clean at 0.12.7.
## 0.12.6

- **Four scratch harnesses were published.** `git add -A` in 0.12.5 swept the fuzz probes that
  found the `maxParts` bug into the commit. The npm tarball was unaffected (its `files` list is a
  whitelist and pack-check counted 38 entries), but the repository should not carry them: they are
  removed, and `.gitignore` now covers root-level probe scripts so a future `git add -A` cannot
  repeat it.
- **`docs/output.md` described a brief that no longer exists.** It listed "two halves" and the
  pre-0.12 sections: no Stakes, no What this is, no What a useful answer contains, no Owner notes,
  and "the last ten commit subjects" where the brief now carries subjects and bodies. It matches
  the rendered order now, and the how-to guide says the same.
- New test: the monolith keeps whole bodies when `maxParts` grows the budget — the partitioner
  captures them before partitioning, and the 0.12.5 rewrite had to keep that true.

Verified: 1 182 tests, 1 174 pass, 0 fail, 8 host skips; lint 225 files; every gate clean at 0.12.6.
## 0.12.5

A lost-file bug in the experimental `maxParts`, found by fuzzing part budgets rather than reading
code.

- **Growing the budget dropped files from the layout.** Every probe re-partitioned the same file
  records, which the previous probe had already assigned and truncated. When the probes disagreed,
  files ended up with no part: three parts were written without them, `Integrity: failed`, and the
  run exited 1 — after printing "Snapshot generated". Probes now run on a copy of the records, and
  the real records are partitioned exactly once, at the chosen budget. 120 randomised budgets
  (1-30 files, 4-64 KB, with and without token ceilings) found no failure after the fix; the
  reproduction is a test.
- **A failed verification was announced as success.** The banner printed a tick above "Integrity:
  failed" and then exited 1. It says what happened now.

`--max-parts` remains experimental and off by default. Verified: 1 181 tests, 1 173 pass, 0 fail,
8 host skips; lint 225 files; every gate clean at 0.12.5.
## 0.12.4

Two ways the MCP surface described itself wrongly.

- **`describe` did not list `snapshot://prompt`.** The resource was served from 0.12.2 and missing
  from `contract.mcp.resources`, which is generated from a leaf list precisely so it cannot drift.
  It is in that list now, and a test compares the contract against a live `resources/list`.
- **A known resource that was simply absent said "Unknown resource".** `snapshot://prompt` in a
  snapshot generated with `--skip-artifacts prompt`, or a report with its artifact disabled,
  answered `-32602 "Unknown resource"` — telling the client its URI was wrong when the artifact had
  been left out. Those reads now answer `-32002` (resource not found) with the cause and the fix;
  a genuinely unknown URI is unchanged.

Verified: 1 180 tests, 1 172 pass, 0 fail, 8 host skips; lint 225 files; every gate clean at 0.12.4.
## 0.12.3

A read of what the tool says, rather than what it does.

- **Drift named the digest instead of the cause.** Editing the brief produced "the settings differ
  (run generate)" and nothing else. `validate` compares `promptTask` and the brief digest directly
  now: "brief: brief.md changed since this snapshot was generated", and "promptTask: manifest audit
  vs current review". The generic line stays, because it is still true.
- **The digest explanation was incomplete.** `diff` said the digest covers "budgets, preview
  thresholds, redaction rules and artifact selection"; it also covers the prompt task and the owner
  brief since 0.12.0.
- **Singular counts read as plurals.** "1 path(s) were found; 1 are in the parts", "1 file(s) are
  emitted as head/tail previews", "1 route(s)", "1 handler(s)", "1 file(s), 39 % of the included
  bytes" - the plural is chosen now, the same way the part plan already did.

No behaviour changes beyond the words. Verified: 1 178 tests, 1 170 pass, 0 fail, 8 host skips;
lint 225 files; every gate clean at 0.12.3.
## 0.12.2

Six defects in the brief, five of them found by attacking it rather than reading it.

- **A fenced sample heading was parsed as a section.** A brief that documents the format —
  ```` ```markdown ```` then `## Coverage` — was refused for redefining a measured section it never
  defined. Fences are tracked now: content inside one is content, whatever it looks like.
- **Control characters in reproduced text reached the artifact.** A `NUL` (or a bidi override) in the
  owner brief, a commit body or the README paragraph was written into `PROMPT.md` verbatim. Every
  reproduced string is escaped the same way the rest of the tool escapes them.
- **`## Stakes:` fell into Owner notes.** A trailing colon is a typo, not a different heading, so the
  canonical form drops trailing punctuation and the stakes render in their section.
- **The brief had no size limit.** A 240 kB brief produced a 240 kB `PROMPT.md`, which is a second
  codebase rather than instruction. It is capped at 64 KiB, and the error names the size.
- **`config.brief.path` was recorded unmasked.** Every other user-supplied name in the manifest is
  masked; a credential-shaped directory in the brief path was echoed into `manifest.json` and the
  provenance line of `PROMPT.md`. It goes through the same masking now.
- **The shape guard ignored the fields added in 0.11 and 0.12.** A manifest with `promptTask: 5`, a
  string `brief`, a negative `attachmentSlots` or `maxParts: 0` was accepted: `report` echoed it and
  `validate` read it as unset. Each is refused by name now.

New: `snapshot://prompt` over MCP, so a client can read the brief before it attaches parts instead of
running the CLI to see it.

Everything else is unchanged. `0.12.2` is the same line: no `0.13`, no `1.0.0`.

Verified: 1 178 tests, 1 170 pass, 0 fail, 8 host skips; lint 225 files; every gate clean at 0.12.2.
## 0.12.1

Three defects in the facts 0.12.0 printed about a project, found by reading the artifact as the
model that receives it:

- **The README summary leaked markup.** A centred header wraps the first prose in `<p>` with `<br>`
  and `<code>` inside it, and the brief printed the tags. Markup is now removed before the paragraph
  is found, and heading elements are removed whole — after stripping tags, `<h1>Demo</h1>` became
  the line "Demo", which read as the first paragraph and then ended it at the next blank line, so
  the summary of every such README was its own title.
- **"Most recent releases" listed prose headings.** `CHANGELOG.md` has a `## A note on version
  numbers`; the brief called it a release. Only version-shaped headings count now.
- **Commit bodies were cut mid-word.** A 400-character `slice` produced bodies ending in "…and the
  bui…", which reads as a truncated file rather than an edited quotation. They are cut at a sentence
  boundary, fall back to a word boundary, and no longer carry the pipes of a quoted markdown table.

Also: "The last 1 commits" is "commit", and two lines that wrapped past 100 columns were reflowed.

Nothing else changes; no setting, artifact or manifest field is different.

Verified: 1 171 tests, 1 163 pass, 0 fail, 8 host skips; lint 225 files; every gate clean at 0.12.1.
## 0.12.0

The brief stops being only generated. Facts can be proved from the repository; judgement cannot,
and pretending otherwise produced a document that was accurate and generic.

**The owner half (`brief`).** A markdown file with five recognised headings is merged at fixed
slots:

| Heading | Result |
| :--- | :--- |
| `## Stakes` | its own section, right after the job |
| `## The system` | replaces the generated narrative; the measured facts still follow under "What the index records" |
| `## What came before` | rendered above the generated commit ledger |
| `## The bar` | replaces the standard |
| `## Calibration` | replaces the example failures |

Any other heading is kept verbatim under **Owner notes** — nothing is dropped because the merge
did not recognise it. Every owner section is marked in the output as written by the project owner,
so a reader can tell an assertion from a measurement. Three things are refused because they would
make the document lie: a heading that redefines a measured section (`Coverage`, `This snapshot`,
`Attaching this`, `The job`, `What you have`, `What a useful answer contains`, `Your task`), a
`brief` path that cannot be read, and — indirectly — an edited brief, which no longer matches the
digest the manifest recorded. A stale brief is the same failure as a stale snapshot.

**More facts, for free.** The history section now carries commit bodies, not only subjects: the
subject says what changed, the body usually says why, and the why is the part a reader can verify.
A new "What this is" section quotes what the repository says about itself — the `package.json`
description, the first README paragraph, the two most recent release headings — labelled as the
project`s own claims rather than evidence. All of it is masked like every other reproduced string.

**The job is a setting (`promptTask`).** `audit` (the default) asks for what is still wrong or
will break, `review` for what a change breaks, `explain` for how a subsystem works. The standard
and the coverage duty are the same in all three; only the opening section changes. An unknown
value is a usage error, not a silent fall back.

**Upgrading.** Nothing existing changes unless you set `brief` or `promptTask`: the default job is
the one 0.11.0 shipped, and both settings are omitted from the config digest at their defaults, so
a snapshot written before this release still validates. New `manifest.config.promptTask` and, when
configured, `manifest.config.brief: { path, digest }`.

Verified: 1 168 tests, 1 160 pass, 0 fail, 8 host skips; lint 225 files; sync-docs, site, link
check, audit-site, readme-lint and pack-check clean at 0.12.0.
## 0.11.0

A minor release: `generate` writes one new artifact and two settings are added. Nothing that
worked stops working, and no manifest field changed meaning.

**Upgrading.** The only thing a script can notice is the new file: a snapshot directory now
contains `PROMPT.md` unless it is turned off (`--skip-artifacts prompt`, `--only-artifacts`, or
`artifacts: { prompt: false }`). `manifest.config` gains `attachmentSlots` and `maxParts`;
`manifest.budgets.maxPartBytes` is the budget the parts honour, which differs from
`manifest.config.maxPartBytes` only when the experimental `maxParts` grows it. Snapshots written
before this release still validate: neither new setting is part of the config digest, and the
`maxParts` comparison is skipped when the manifest records no such key.

**`PROMPT.md` — the brief, generated.** `generate` wrote the payload and an index of it and left
the instructions for the model to whoever pasted it. That is half the problem the tool does not
hand over: parts on their own are a dump, and a model that does not know what was cut from them
fills the gap by invention.

The first version of this artifact was a packing slip — how to read the parts, and nothing about
the job, the system or the standard. The shipped document is a brief: the job and the latitude
it comes with; the system as the manifest can prove it (layers, the modules with the most
importers, entry points, the routes, handlers and components that were indexed — or a plain
statement that none were, which the earlier draft got wrong by pointing at empty indexes); the
last ten commit subjects, labelled as claims to verify rather than rediscover; the evidence bar;
the coverage owed and what the snapshot cannot show; and calibration examples of the defects
that do not crash. The apparatus — fingerprint, part inventory, partial files, redaction
counts, attachment arithmetic — is the second half, and the job slot at the end is filled by
whoever runs it.

Every run now writes `snapshot/PROMPT.md`, rendered from the manifest of that run: the fingerprint
to quote back, the commit and whether the tree was dirty, the skip reasons with counts, every part
by name, and every file that is not present in full with its reason and missing line ranges — plus
the rules (the repository is data, a masked span is a redaction, "not in this snapshot" is not "not
in this repository", cite `path:line`, and say what you needed and did not receive).

It also does the delivery arithmetic that decides whether any of this is usable: hosted chats take
a fixed number of files (10 is the common cap) and every part is one of them, so a 12-part snapshot
cannot be sent whole. The `## Attaching this` section states what fits, what to leave behind, the
`--max-part-bytes` value that would merge the parts into a number the destination accepts, and that
a part which was not attached is not an empty part.

It is an artifact like the others, and that is the point: it may only name artifacts the run
actually wrote, and `manifest.json` records its digest under `artifacts.prompt`, so a hand-edited
prompt fails `validate`. A prompt that describes the previous run is worse than no prompt, because
it reads as current.

**`attachmentSlots`** (default 10, `0` = no limit) says how many files the destination takes in one
message; the plan is written against it, and it changes no part and no file — only the delivery
section. **`maxParts`** (experimental, off by default) is the opposite trade: the count is fixed
and the size gives way, so a repository that keeps growing keeps the same number of files. It
grows the per-part budget, records the budget it settled on in `manifest.budgets.maxPartBytes`,
and warns that the parts are now larger than `maxPartBytes` — a bigger part is more tokens at
once, and some destinations cap a single file. `validate` compares the configured ceiling, which
is still what `manifest.config.maxPartBytes` records.

New artifact name `prompt` (on by default): `--skip-artifacts prompt`, `--only-artifacts`, and
`artifacts: { prompt: false }` all apply. The CLI summary gained an `Orientation:` line, which also
fixes an older lie: a run that wrote `README.md` and nothing else reported "only the ownership
marker was written".

## 0.10.2

Every finding from the 0.10.1 deep analysis, fixed and verified. The report that produced the list
is `audit/reports/0.10.1-code-analysis.md`; the finding-to-fix mapping is `audit/work/fix-log.md`.

This is a patch release, but three of the fixes change something a script can observe. They are
listed first rather than buried, because each is the point of its fix.

**Upgrading.** `validate` now fails a manifest whose `incomplete[]` and `files[]` disagree — a
hand-edited or foreign `manifest.json` that used to report "valid and up to date" is refused, which
is the point. `partitionFiles` (a library export) now throws for a byte budget below the 2 610 B a
part header needs, instead of silently clamping it to that size. A new built-in secret rule, the
32nd, masks a quoted value whose closing quote is missing, so a snapshot that used to emit such a
line now carries the marker — and one more line in `totals.redactedLines`. No option was added or
removed, and no existing manifest field changed meaning.

**Security**

- A quoted assignment whose closing quote is not on the line (`API_KEY="value` in a truncated file,
  a hand-edited `.env`, or a string that continues on the next line) matched no rule at all: it was
  emitted in clear and the run reported zero redactions. `credential-assignment-unterminated` now
  masks it and records a finding. When a mask would unbalance an otherwise balanced line, the value
  is now masked around its quotes instead of being left untouched with no finding at all.
- `diff` applies the caller's `secretRules`. `compareManifests` gained the parameter, every masking
  call in `diff.ts` passes it through, and the payload block's `layers` maps are masked too — they
  were printed verbatim while every line of prose beside them was masked.
- `validate` verifies the completeness contract. `incomplete[]`, `counts.incompleteCount`,
  `omittedRanges`, `omittedLines`, `includedLines` and `incomplete[].relativePath` are checked against
  each other and against `files[]`; `relativePath` was the only unconfined member of the three
  path-bearing arrays. Ten tampered variants of a real record used to report "valid and up to date".

**Correctness**

- The monolith entries no longer carry a `truncationReason` or `omittedRanges` beside
  `inclusionMode: "full"` — one object said "complete file" and "large-file-budget" at once.
- A previewed or oversized importer is in `indexes.imports.byFile`, so `snapshot_dependents` no
  longer answers "0 importer(s)" for a file that has one. Its `exports` list says `exportsOmitted`.
- `snapshot_plan` runs on the worker thread, like `snapshot_generate`: a dry run parses the whole
  repository and blocked the JSON-RPC loop for as long as a generate did.
- `discovery` is a member of `SnapshotConfig`, so a TypeScript config containing it compiles; a
  compile-time proof on `CONFIG_KEY_NAMES` keeps the parsed key list from drifting from the
  interface again — `CONFIG_KEYS` is built from that tuple, so both follow it.
- SARIF results are ordered by code unit, not `localeCompare`: the same commit produced different
  bytes under different host locales.
- `generatorOrigin` reads a `package.json` behind a byte-order mark, so a pinned project is no
  longer told it has a "global or direct install".
- A nested `.DS_Store` is Finder noise in the ownership check, compared by basename like the other
  four sites; `reports/.DS_Store` used to make the tool refuse a directory it had just written.
- `init --out-dir .context` ignores `/.context/` rather than `/snapshot/`, so the snapshot it
  generates is actually untracked; a nested or out-of-tree outDir is handled.
- `exportsKind: "esm"` is produced for a file whose exports are all ES exports, so absence means
  "no exports" again.
- Both project-tree caps (lines and depth) are recorded as manifest warnings; only the depth cap was.
- `diff --format json` carries a stable `payload.codes` array — one code per prose reason.

**Documentation**

- The published site no longer requests two 404s: `docs/assets/*` is rewritten to the `assets/`
  copy the build writes, and the link gate now checks `src` as well as `href`.
- `docs/configuration.md` lists the placeholder shapes that survive redaction, exhaustively, with a
  test that pins the list to `PLACEHOLDER_PATTERNS`; the "a placeholder is indistinguishable from a
  secret" claim it contradicted is gone.
- Three surfaces that disagreed with the binary are corrected: the `.gitignore` entries in
  `docs/cli.md` (they are anchored), `validate`'s actual output in
  `docs/stale-context-is-your-bug.md`, and `explain`'s `{ rules, line }` shape.
- `codebase-token-budget.md`'s measured example is re-measured; `how-to-context-budget.md` no
  longer cites a `manifest.totals.events` field that does not exist.
- Eight test failure messages interpolate their variables; on a security failure they printed the
  literal `${…}`.

## 0.10.1

Documentation only. The build is 0.10.0 with the documentation that describes it — no behaviour,
option or manifest field changed.

`npm install codebase-snapshot@0.10.0` bundles `README.md`, `CHANGELOG.md` and `docs/*.md` as they
stood when that tarball was built. The documentation pass that followed 0.10.0 landed after that,
so anyone reading `node_modules/codebase-snapshot/docs/` got the previous release's description of
truncation — including `docs/output.md` explaining an `isLarge: false` preview route that 0.10.0
had already turned into a config error. Publishing the corrected docs is the whole change.

Corrected in that pass, for the record:

- `--help` printed the pre-0.10.0 `--large-file-bytes` default (204800).
- Three comparison pages promised a file too large is "truncated with a marker" rather than a
  preview listed in `incomplete[]`.
- `docs/output.md` documented a preview route that no longer exists, and did not mention
  `truncationReason`, `omittedRanges` or `summaryOmittedReason`.
- `docs/configuration.md` listed the old per-preset budgets (100k–200k) and quoted
  `recommendedBudget: "120k"`.
- The README, the `describe` contract's `consume` step and the MCP `snapshot://manifest` row
  described the manifest without `incomplete[]`.
- `setup` wrote `largeFileBytes: "200k"` beside a 300 KB budget, previewing files that would fit.
  It follows the budget now, which is what the pages already claimed.

Also: `sync-docs` rewrites the `Generator: … (project dependency ^…)` banner sample, which sat in
a fence and so could not carry a marker. It described the previous release from the day after
every publish; it cannot now.
## 0.10.0

The 0.9.18 report had one real bug in it. A complete file could be cut down to fit a part budget
and the run still exited 0: 1 241 of 2 883 lines emitted, a marker on line 1 300, and a manifest
that recorded `inclusionMode: "preview"` beside `isLarge: false` — a shape that reads as policy
whether the preview was chosen or 57 % of the file had been lost.

**Upgrading.** A config that sets `largeFileBytes` above `maxPartBytes` now refuses to run. That
is the change, and the refusal is the point: the pair described a file the tool could not emit
whole but would not call large either. Raise `maxPartBytes` to at least `largeFileBytes`, or
delete the `largeFileBytes` line so it follows the budget. Configs written by this release's
`setup` already agree, and every preset now recommends the same 300 KB budget.

### A file is not cut to fit a part

The two ceilings answer one question — *can this file be emitted whole?* — so they are now
resolved together and cannot disagree:

- `largeFileBytes` defaults to `maxPartBytes`, and an explicit value **above** it is a config
  error before anything is written. A file between the two cannot fit a part, so it would be cut
  while the manifest called it a preview by policy.
- Every preset recommends the same 300 KB budget. The old per-preset tuning went as low as
  100 KB, which is exactly how a 197 KB file ended up gutted in a repository that had one.
- A file above the threshold is a head/tail preview — the declared policy for something that
  cannot fit — and the `isLarge: false` + `isPreviewTruncated: true` combination is now
  unreachable.

Nothing is lost silently either way: `manifest.json` gained a top-level `incomplete[]` naming
every included file that is not present in full, with `reason` (`large-file-budget`,
`part-budget`, `section-metadata`) and `omittedRanges`, 1-based inclusive source lines that are
missing or partial. `files[]` carries the same two fields per entry, and `counts.incompleteCount`
is the length of the list.

A summary dropped for size now records *why* — `summaryOmittedReason` is `oversize`, `preview` or
`part-budget` — and the part says which, instead of printing "exceeds the part budget" for a
summary that was never built because the file was a preview.

### The run summary says what it left out

`Tracked files: 434` read as "the whole repository" when 155 tracked files had gone out the
window. It now prints the coverage and the reasons that took the rest:

```
   - Tracked files: 434 included of 589 found — 155 skipped (binary 152, gitignore 18, sensitive-file 1); every one is listed in snapshot\reports\audit.md
   - Incomplete:   2 file(s) — 1 large-file-budget, 1 part-budget; see manifest.json incomplete[]
```

The generator also asserts the invariant behind that line: every scanned path appears in
`files[]` or in `skipped[]` with a reason, and a truncated file has both a reason and ranges. A
run that fails the check reports `validation.status: "failed"` instead of a clean bill.

### The output swap survives a held handle

On Windows and OneDrive the second run failed with `EPERM: rename 'snapshot' ->
'snapshot.backup-…'`: an indexer, an antivirus or a sync client holds a handle *inside* the
directory, which makes the directory itself un-renameable, and the handle outlives the retry
budget. When the retries end, the snapshot that the ownership guard has already proved is this
tool's own is now removed and replaced in place, with a note on stderr naming the cause. Anything
that is not a lock error, and any directory the guard has not cleared, still fails as before.

### `setup` no longer installs into a directory that is not a package

With no `package.json`, the install step answered `ENOENT` and npm left an empty
`package-lock.json` at the repository root — a file nobody asked for, in a run that said nothing
about it. The install is skipped, and the skip is stated.

The run banner also names the generator and where it came from, because a snapshot whose
behaviour depends on whichever `npx` cache or global install was first on `PATH` is what a
pinned project dependency exists to prevent:

```
   Branch: main | Part budget: 300 KB | Generator: 0.10.0 (via npx)
```

The origin is printed and not written into an artefact: an artefact naming an absolute install
path would stop being byte-identical across machines.
## 0.9.18

A release about what the listing says. The generator is unchanged; what changed is every place
that describes it — the npm page, the README, the machine-readable summary, and one comparison
table that had two rows wrong.

### The update notice waited a day

The check remembered "you are already current" for 24 hours, so a release published two hours
after a run went unnoticed until the next day — even though the tool exists to prove a thing is
current. A cached answer that names a newer release still keeps the daily interval, because the
upgrade command is already known; a "you are current" answer is now re-asked after an hour. An
active run therefore notices a release within the hour, and a machine that is up to date makes at
most one request an hour instead of one a day.

### The npm description did not contain the product's name

"Pack a codebase for an LLM into budgeted Markdown parts" described the mechanism and never said
*snapshot*. The package is called `codebase-snapshot` and the words people type are "codebase
snapshot"; the description now opens with that phrase, names the clients it is used with, and says
it is local.

The keyword list lost the words that describe the implementation rather than the job —
`partitioner`, `ast`, `ai`, `code-analysis`, `prompt-engineering` — and gained the ones a person
searching for this would use: `llm-context`, `codebase-to-markdown`, `token-budget`, `claude-code`,
`drift-detection`. Twenty terms, and none of them a competitor's name.

### Two rows in the repomix comparison were wrong

`docs/vs-repomix.md` said repomix emits "a single packed file" with "no per-artifact ceiling". It
has `--split-output <size>` and `--token-budget <n>`, and the second exits non-zero above a token
count — a ceiling of the kind the table denied it. Both rows are corrected, and the page now lists
a token budget under *where repomix is the better choice*: tokens are what a context window
measures, and this project budgets bytes.

The page was also the first thing a search for "repomix alternative" could land on. A comparison
that is wrong about the other tool is worse than no comparison, and the correction costs less than
the credibility it protects.

### The README asked for a command the reader did not have yet

The first block led with `snapshot`, which exists only after a global install, so the very first
thing a visitor copied could fail. It leads with `npx codebase-snapshot generate` now, with the
short form after it.

The weekly-downloads badge is gone. On a repository with two stars it advertised a number that is
mostly registry mirrors and old lockfiles, in a README whose central claim is that it does not
overstate what it has proven.

### `llms.txt` described three of the four pillars

The summary an agent reads first mentioned budgeted parts, the manifest and a secret audit, and
left out `validate` and the MCP server — the two things the project argues about. Both are in the
summary now.

### The scaffolder now says it is the scaffolder

`create-codebase-snapshot` described itself as "Set up codebase-snapshot in a repository", which
reads as the tool itself when it is the first npm result for the name. It describes the scaffolding
it actually performs.

### Also

- The 0.9.5 paragraph beginning "The MCP server has not been run against a real client" now carries
  a note pointing at what superseded it: the digit-as-string fix in 0.9.6 was reported from a live
  client session, and `snapshot_dependents` arrived in 0.9.8. The paragraph is history, not a
  current disclaimer, and a reader who found it by search had no way to tell.

## 0.9.17

Closes the remaining entries of the 0.9.16 verified-bug report and the follow-up report from a
CommonJS gateway. The theme is that a gate now proves what it claims: the manifest is the schema
it says it is, an artifact cannot be deleted while `validate` stays green, a staged snapshot is
what `git commit` will write, and a mask never changes what a file means.

**Redaction.** Unquoted assignments in source files are expressions, not credentials:
`SEARXNG_SECRET_KEY: optionalString`, `{ "x-api-key": key }` and `? "PASS" : "MUTATE"` survive
verbatim, while the same text in YAML, a `.env` or a shell file is still masked. A shell
expansion (`"${VAR:-…}"`, `$(date -u …)`) is a reference and is never partially masked; the
`-u` userinfo rule no longer matches a date format; `${VAR:?message}` keeps its message; and
placeholders (`replace-me-…`, `sk-...`, `<…>`) stay readable. A line whose quotes were balanced
before masking and not after is left untouched rather than emitted broken.

**Scope and graph.** `--staged` reads the index blob, so further unstaged edits are not
snapshotted, and a staged deletion is recorded as `deleted`. Git paths keep their bytes (no
`.trim()`, no backslash rewrite). A deleted module is a tombstone, so its importers are found by
`--with-dependents`. `tsconfig` `baseUrl`/`paths` aliases resolve. Case folding is a
platform property. `**` inside a segment no longer crosses `/`. `.gitignore` updates preserve
UTF-8/UTF-16 BOMs and dedupe by meaning; the entries written are root-anchored.

**Lifecycle.** The run lock carries a heartbeat refreshed from a worker thread (the main loop is
synchronous), so a zero-byte or pid-reused lock recovers in two minutes instead of an hour or
never. An async `afterGenerate` hook holds both locks until it settles, so it cannot mutate a
newer snapshot. Size limits are checked before the skeleton parse and before serialising a
monolith that cannot fit.

**Validation.** The manifest shape guard checks the schema it claims (`generator`, `git`,
`config`, `budgets`, `indexes`, `kinds`, per-file part/hash/size/mode, per-part
sha256/byteSize/index). `README.md`, `reports/navigation.md`, `reports/project-tree.md` and
`reports/audit.md` carry recorded digests and are verified; a navigation link that points at
nothing fails. `counts.totalLines` is summed from `files[]`, and the fingerprint is recomputed
from the manifest's files and recorded settings digest. A file deleted from disk is `missing`
with a detail, not a bare `read-error`, and `validate` surfaces unreadable skips.

**Internals.** Module configs are re-evaluated only when their bytes change. Layer/kind registries
are ordered-safe (`constructor`, `__proto__`). The derivation cache subtracts replaced entries
and is LRU. Part assembly is memoised. The ownership marker reuses digests recorded at write time.
`.js` is parsed as JavaScript, CommonJS exports are summarised, and Express/Hono/Koa/Fastify
route registrations populate route methods.

**MCP.** At most four requests run at once, with a typed `overloaded` error for the rest. The route
lookup is indexed rather than quadratic. A `snapshot_read` page that ends inside one very long line
reports `pageable: false` instead of advancing `fromLine` past the only line.

**Contracts and repository gates.** `describe` says JS/JSX for `--skeleton` and nested
`.gitignore` files for `--discovery`, and says `--autopilot` chooses the preset. `explain`
rejects the partitioning/artifact flags it never read and reports the inclusion mode
`generate` would choose. Every workflow action is pinned to a commit SHA, enforced by
`scripts/check-workflows.mjs` in `npm run verify`. Secret scanning no longer ignores `docs/**`,
`**/*.md` or `llms.txt`; the residual risk and the documented example values are stated in
`SECURITY.md`.

### Verified

`npm run verify` — lint, typecheck, 1,080 tests (0 failures, 8 skipped), the workflow pin check,
the docs sync check, the site build, the site link check, the site audit, the readme lint and the
tarball check
(38 files, lockfile agrees with 0.9.17). The publish workflow runs the same gate on Node 18, 20
and 22 before it uploads.

---

## 0.9.16

A run refused by the lock it did not get could leave a lock of its own behind — one naming a
**live** pid, so the refusal outlived the run that caused it. The suite that should have noticed
was itself leaving scratch directories in the host temp directory: five days of runs had left 616
of them and about 600 MB. Both are fixed, and the second is why the first stayed hidden.

### A refused run kept the lock it took

`generate` locks the staging root and the output directory, in sorted order, before staging is
touched. The acquisitions came from one `map()`, so when the second lock was refused the first was
still held — and there was no list of releases to run in the `finally`, because the throw happened
before the assignment. The file left behind named the current process, so `reclaimStaleLock` read
it as an active run. An MCP server, watch mode, or a `setup` that retries would be refused for the
rest of that process's life, with no other run in existence.

Each acquisition is now recorded, and a failure releases the locks already taken. The regression
test starts a run that a fresh staging lock must refuse and asserts the output-directory lock is
gone afterwards.

### The test suite stops leaving its scratch directories behind

`npm test` created every fixture in the host temp directory and relied on each test to remove it.
Two tests never did: `agent-simulation.test.js` made two fixtures per run with no cleanup, and one
`repo()` argument in `generation-truth.test.js` was never assigned, so its directory had no handle
to remove. A wrapper now runs the suite with `TEMP`, `TMP` and `TMPDIR` pointed at one scratch root
that is deleted when the run ends, pass or fail, and reports by name anything a test leaves inside
it. Tests create scratch trees with `makeTempDir(t, prefix)`, which registers the removal with the
test, and a hygiene suite fails the build if a test creates a directory it never removes, if the
npm scripts stop using the wrapper, or if the fixture-heavy generation suite leaves anything behind.

### Verified

`npm run verify` — lint, typecheck, 1032 tests (0 failures, 7 skipped), the docs sync check, the
site build, the site audit, the readme lint and the tarball check — on the release commit. The same
gate runs on every pull request and every push to `main`, and the release runs it on Node 18, 20
and 22; Node 18 caught a portability defect in this release's own new test before it shipped.

## 0.9.15

A sixth audit, of the promises rather than the code paths the gate already covers. The gate was
green before this release and is green after it; every defect below lived somewhere the test suite
did not look. Two put credentials in the artifact, one broke the repeatability guarantee, and one
made `validate` fail on a snapshot it had just written.

### Two credential shapes were left in clear text

**A quoted camelCase key in JSON or YAML was never redacted.** `{"dbPassword": "hunter2"}`,
`"discordToken"`, `"awsSecret"`, `"botToken"`, `"jwtSecret"` and `"sessionKey"` were emitted
verbatim, while the same names unquoted — and the short names `"password"` and `"apiKey"` — were
masked. The quoted rule wanted the whole key between quotes; the bare-tail rule was suppressed
after a quote. Every JSON configuration file has that shape.

**A mask could print `[REDACTED]` and keep most of the value.** Unquoted values stopped at `$`,
`!` and `@`, so `db_password: [REDACTED]$$w0rdSecr3t` shipped twelve characters of a seventeen
character password while looking redacted. A value that begins with punctuation was not matched at
all, so `!en$value` went out whole, and one containing `&` was masked as a prefix. A mask now
covers the whole value or nothing is emitted: a match that cannot be bounded is dropped in source
code and masked whole in a data file, never half-written.

The same pass closed narrower leaks: URL userinfo with an empty user part (`redis://:pass@host`),
`curl -u user:pass`, short unpadded Basic credentials, and fixed shapes for Discord, Telegram,
Azure DevOps, Shopify and Azure SAS tokens. The rule count stays 31 — the coverage folded into
existing rules rather than adding new ones.

### The second run could change the preset, and drop a file

Preset detection counts markdown to decide whether a repository is `docs`. It excluded the output
directory only when that directory was literally named `snapshot`. With `--out-dir snap` on a
repository with no root `package.json`, run one detected `generic` and included `site/page.md`;
run two counted its own output, detected `docs`, applied that preset's `site/` exclusion, and
**silently dropped a source file** — with a different fingerprint, and in one variant with the same
fingerprint and different parts. The walk now skips any directory carrying an ownership marker,
whatever it is called, which is the same evidence the scanner already uses.

### validate failed on a snapshot it had just generated

A text file with a binary extension — a Git-LFS pointer is the common case, three lines of plain
text ending in `.png` — was skipped by `generate` as binary and then reported by `validate` as
`new file`, exit 1, forever. Regenerating could not clear it, because the two commands asked
different questions. `validate` now applies `generate`'s decision order exactly, so they agree by
construction, and `explain` agrees with both: it no longer says `included: true` for a file the
snapshot skipped, and a skipped path no longer carries layer, kind or language.

### A JSON consumer received nothing when the config was broken

`--format json` with an unparseable config, an unknown key, an invalid value or a bad preset exited
1 with **zero bytes on stdout**, contradicting the documented error document and the contract in
`describe`. Every config failure now goes through the same writer as every other failure.

### snapshot://manifest was not JSON on an ordinary repository

Above roughly 350 files the resource was cut at 512 kB with a truncation marker injected mid-document,
advertised as `application/json`. Resource reads are now all-or-nothing: a document that does not
fit one read fails with `-32000`, its size, the limit and the tool to use instead. The same rule
covers parts and reports.

### Ownership evidence was a shape, not evidence

A hand-written `.codebase-snapshot` listing the directory's own files was accepted as proof that
this tool wrote the directory, and the next `generate` deleted those files. Markers now record the
sha256 and byte length of every file written, and replacement verifies them. A marker that cannot
prove a completed run is refused and nothing is deleted. Snapshots written by earlier releases are
still accepted on their manifest digest, so an upgrade does not strand the output directory a user
already has.

### The rest

- **`setup`** honoured neither `--only-artifacts` over a reused config that disabled the artifact,
  nor the config it actually kept: it reported a filename that did not exist and a preset it had not
  applied. `--install-hook` baked `snapshot` as the output directory whatever the config said, and
  `--dry-run --install-hook` wrote the hook anyway.
- **`--mode explain <path>`** and **`--mode diff <a> <b>`** could not work: the positional arguments
  were parsed as the command word. Both forms now run.
- **`report`** accepted seven generation flags as silent no-ops while rejecting `--discovery`. It
  rejects all of them now, and `describe` agrees.
- **A closed pipe** (`generate --format json | head`) was an uncaught `EPIPE` stack trace and exit 1;
  it is now a quiet early exit.
- **The omission marker** named an internal section allowance (1887 B for a 4096 B part) instead of
  the part budget the manifest and the CLI report.
- **The docs site** had heading elements with no `id` while carrying 49 anchor links: every table of
  contents on all fifteen published pages was dead. The site generator emits GitHub-compatible ids
  and the link checker now validates fragments, so the gate can see it.
- **`docs/install.md`** claimed the release check enforces the verified-client list "on every pull
  request". There was no pull-request workflow and no client install test; the claim is gone.
- **The CLI reference** carried stale rows: `setup` missing from ten options, `report` advertised
  with flags it rejects, `--mode` listing nine command names where there are eleven, "text-mode
  stdout is empty" false for `skill`, and `validate` documented with five drift classes where there
  are six. All corrected against the source.
- **`docs/configuration.md`**'s "complete example" omitted six settings that `init` writes.
- **The redaction section of `SECURITY.md`** described the old, narrower behaviour; it now states
  what the rules do, including the shapes that are still not covered.
- **A pull-request workflow** now runs the same verify gate as a release, on Node 18, 20 and 22.
  Until now that matrix ran only at release time, which is why 0.9.14 needed four publish attempts.
- **Publishing** asserts that the release tag agrees with `package.json`, ships the LICENSE the
  `create` package declares, and no longer builds `dist` twice for one publish.

### Verified

`npm run verify` — lint, typecheck, 1027 tests (0 failures), the docs sync check, the site build,
the site audit, the readme lint and the tarball check — on the release commit. Beyond the suite:
the published-install path, and real repositories in five languages where every part stays inside
its budget, repeat runs are byte-identical, `validate` is clean, and a snapshot written by 0.9.14
is upgraded in place without being refused.

An independent red-team pass then ran against the built artifact, trying to reproduce each of the
seven blockers from the outside. Six were closed outright; the seventh exposed a `.env` value whose
mask left a punctuation tail, and a quoted `id-token` that was over-redacted. Both were fixed and
re-tested before this release — which is the argument for a verifier who did not write the fix.

### Three limitations became fixes instead

The first cut of these notes listed three known limitations. All three are fixed here, because a
release note that documents a leak is still a leak.

- `parsePartSections` reported the wrong count for a one-line file (`null`) and for a section that
  collapsed to one line — `1 line of 3 lines` was read as 3, the source count. The counts are now
  read from the metadata field that holds them, singular or plural, and free-form layer and language
  names can no longer be mistaken for a count.
- `manifest.fingerprint` covered the input but not the settings, so two runs with different part
  budgets over the same source shared a fingerprint while their parts differed. The settings digest
  is folded in, so the fingerprint identifies the artifact set the documentation promises, and
  `diff` says `packed or configured differently` when only the settings moved.
- A lowercase `key=value` credential in an INI or properties file was masked only while its value
  fitted the rules' alphabet. In a data or shell file the whole value is masked now, whatever it
  contains; the same line in source code is still left alone.

Two deliberate behaviours remain. A YAML value that is really a reference
(`password: !Ref SomeParam`) is masked, because in a data file the fail-closed choice is the right
one. And no rule set can promise that every credential shape is recognised — a clean audit is
evidence that the known patterns did not fire, not a guarantee, which `SECURITY.md` says plainly.

## 0.9.14

A fifth audit, of what the tool does to text it did not write. Three of the defects below were
editing the user's code: a redaction rule erased 36 lines of source, a truncation left a code fence
open, and a preview budget did not apply to a file with CR line endings. The rest are credentials
left in clear text, two records that disagreed with the files beside them, and the performance work
the previous audits kept deferring.

Every item has a test that fails without it, with the exception of two performance changes that have
no behavioural signal — both are named.

### A redaction rule erased source code

`PEM_BLOCK_PATTERN` is lazy over `[\s\S]`, which places no restriction on what may lie between a
`BEGIN` and the next `END`. A file holding an *unterminated* header — a truncated key, a fixture, a
half-written file — and, later, a properly terminated block had **everything between the two
headers replaced with blank lines**, including the source code that happened to sit there.

This repository did it to its own test suite: the security fixture's "unterminated key" test was
followed by another test whose key was terminated, and the generator bridged the two — 36 lines of
assertions, braces and the second test's declaration, replaced with 36 empty newlines.

The body may no longer contain another `-----BEGIN`. A header with no `END` before the next `BEGIN`
does not match as a block, and `PEM_UNTERMINATED_PATTERN` handles its header and its own base64 body,
which is what that pattern is for. The newline after the header is deliberately still not required:
a PEM inside a JSON or `.env` value is written with escaped `\n`, two characters rather than a line
break, and a rule that insisted on one would mask the header alone and leave the base64 in clear.

### A truncated section left its code fence open

When the fixed metadata of a section would not fit the part budget, the *rendered* section was cut at
a byte offset. The cut lands in the body or in the opening fence, and the closing fence it removes is
the one that ends the block: every section after it was rendered inside this file's code block, and
`parsePartSections` merged the next file into this one's body.

The body now goes and the notice takes its place inside the block, with the file marked `preview`
first so the re-rendered `- Meta:` line describes what the reader will actually find. A section that
is a closed, empty, labelled block is readable; an unclosed fence corrupts the files after it, and no
block at all is invisible to the part reader.

### A file with CR line endings was never previewed

`countLines` and `truncatePreview` split on `\n` alone, so a CR-only file — an old Mac file, anything
written by a tool that predates LF on that platform — counted as **one line**. `largeFileBytes`
therefore never fired: a 5 MB CR file went into a part whole, with its carriage returns intact, and
`manifest.json` reported `lines: 1` for a 40 000-line file. The redaction pass counted terminators
with `/\r\n|\n|\r/g`, so `reports/audit.md` reported line numbers the manifest disagreed with.

All four places now normalise CR, LF and CRLF, and `countLines` counts by scanning rather than
splitting — it runs on every file body and every part, and normalising first allocated a second copy
of a multi-megabyte string to answer a question about its terminators.

### Four credential shapes were left in clear text

**`${VAR:-fallback}`, unquoted.** `POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-MyProdPassword123!}`
defeated every rule, and each refusal was individually reasonable: the quoted rules need a quote
after the separator, and the unquoted ones need the value to begin with a word character — a
fallback begins with `$`. That idiom is the norm in `.env` files, docker-compose, GitHub Actions and
shell scripts. A rule for the shape now masks the fallback and keeps the variable name.

**`readonly` and `declare` in shell files.** Those words introduce a binding in TypeScript and an
assignment in POSIX sh and `.envrc` — the same word, opposite meaning. The guard that suppresses
redaction for declarations therefore suppressed it for exactly the files most likely to hold a
credential. Bare `declare` is gone from the keyword list (the form that can initialise a binding in
TS is `declare const`, matched through `const`), and the guard now knows which files are assignments.

**A credential inside a string literal.** `startsInsideStringLiteral` rejected any match whose name
began immediately after a quote, which is right for a list of key names and wrong for every
connection string: `const dsn = "password=Secret;host=db"` and `curl -d "password=Secret"` were
emitted in clear. The test now also asks whether the literal closes between the name and the value.

**The MCP line cap.** `createLineReader` checked `MAX_LINE_BYTES` only on the buffer it had just
appended to, so a chunk carrying a discarded line's terminator *and* the start of the next message
left that remainder unmeasured until the stream ended — and `onEnd` delivered it whole to
`JSON.parse`. It also compared `.length`, which is UTF-16 code units: a line of astral characters
could be twice the ceiling in bytes and still pass. The cap is applied at every path that can
deliver, and measured in bytes.

### `--with-dependents` lost an importer, and three languages had no import graph

The closure was computed from `file.summary.imports`, and a previewed or oversized file has no
summary. An importer over `largeFileBytes` was therefore dropped as unchanged while `validate` and
`explain`, which read the same file from disk, called it a dependent — generate and validate
disagreed about the snapshot generate had just written. Import specifiers are cheap to extract from
text already in hand, so they are now collected for files whose summary was refused, and the size
ceiling lives in one place so all three commands refuse the same files.

`resolveSpecifier` only understood JavaScript's `./x` shape, so the Python, Ruby, C/C++ and Dart
imports the profiles have been recording for several releases resolved to nothing. Each language
spells "this directory" differently — Python with dots, Ruby with `require_relative`, C with a
quoted include, Dart with nothing at all — and each is now resolved on its own terms. Package-rooted
languages (Go modules, Rust `crate::`, PHP PSR-4, JVM packages, Swift modules) stay unresolved on
purpose: their specifiers go through a manifest, and guessing a path would fabricate edges that
`validate` then has to disagree about.

### `setup --format json` could corrupt its own output

`setup` replaced `process.stdout.write` with a capture and restored the function it had captured on
entry. A nested generate with an `async` hook installed the hook diversion inside that window, so
`setup`'s restore ran first and removed it — the hook's `console.log`, after its first `await`, went
straight to the real stdout — and the hook's restore then put back `setup`'s *finished* capture.
Every later write in the process was appended to a dead string and silently discarded.

Both borrow stdout and neither can own it, so there is now one router, installed at most once and
released by reference counting, consulting two `AsyncLocalStorage` scopes.

The same function also merged a failed nested generate in as `manifest`: `{ setup, manifest: { error } }`
came out with exit code 1 and no top-level `error`. The failure is now at the top level.

### A transient lock on the old snapshot could cost the new one

`fs.rmSync(backupDir)` ran inside the `try` whose `catch` restores the previous snapshot. `rmSync`
throws EPERM or EBUSY on Windows and on network filesystems when an indexer, an antivirus or an
editor holds a handle in the old snapshot — and by then `outDir` already holds the new one. The catch
deleted the new snapshot, restored the old one and rethrew; the retry then failed with ENOENT
because the staging directory no longer existed. Removing the backup is no longer part of the
transaction.

### Two runs could take two different lock files

`realpathSync(stagingRoot)` was used when the root existed and the unresolved path when it did not —
and the run creates the root *after* taking the lock. On macOS, where `/var` is a symlink to
`/private/var`, process 1 hashed `/var/folders/…/snapshot.tmp` and process 2, starting once the
directory existed, hashed `/private/var/…`: two locks, no mutual exclusion, two concurrent writers.
The key now resolves the nearest existing ancestor. Reclaiming a stale lock also re-checks the file's
identity immediately before unlinking it, so two runs that both find the same dead lock cannot
delete each other's.

### The MCP worker ran the hook the docs say it does not

`docs/mcp.md` tells the reader that `hooks.afterGenerate` does not run for a generation started from
MCP. It did: the worker resolved the config file with its hooks intact, so an after-generate script
ran from inside an MCP tool call, and a hook still running when the worker posted its result kept
the thread alive for as long as the server did. The worker now empties `hooks` before resolving, and
is terminated as soon as the result is settled.

### A byte-order mark in `package.json` broke four readers

`findConfigFile` reads `package.json` through `stripJsonComments`, which drops a BOM, so `generate`
loaded a BOM'd project happily. Every other reader used bare `JSON.parse`, which throws on `\uFEFF`,
and every one of them caught the throw and reported the ordinary, wrong answer: an existing
`"snapshot"` block was invisible, `"type": "module"` was invisible, the scripts and devDependency
were skipped with a note, and `nextStepHint` told the user to run `npx codebase-snapshot generate` —
which resolves the *published* package instead of the one the run had just installed. The
`npm create` shim had the same bug in `hasSnapshotScript`.

A BOM is what a Windows editor writes when it saves UTF-8. All five readers now parse the same way
the config loader does, and `init` writes the mark back rather than silently removing it.

### `validate` could not name seven of the settings it compared

`maxPartTokens`, `maxMonolithBytes`, `skeleton`, `sarif`, `changedSince`, `staged` and
`withDependents` were recorded in the manifest and folded into the configuration digest, but never
joined the field-by-field block. The digest can say *that* something changed; only the per-field
comparisons say *what*. Toggling `--skeleton` produced the generic "the settings differ" line and
nothing else.

### A `.vue` or `.astro` script block was always parsed as `.ts`

`<Button onClick={() => go()}>` is a type assertion followed by six parse errors to the TypeScript
grammar, and no component at all, for a perfectly valid Vue `lang="tsx"` block. The script kind now
follows the component: Astro frontmatter is JSX-capable by construction, and a Vue or Svelte block
says so with `lang="tsx"`.

### Performance

- **The split loop re-rendered every part on every pass.** `partitionFilesForBuckets` renders all
  groups, finds the first one over budget, splits it, and goes round again — up to 64 times. Each
  pass re-assembled, re-token-estimated and SHA-256 hashed *every* part. A group's rendered size
  depends on its sections, its index and the *width* of the numbering, and the width only changes
  when the part count crosses 1 000, so sizes are now measured instead of rendered and cached per
  group. Each part is hashed exactly once.
- **The skeleton pass parsed with `setParentNodes: true`** and walked every node a second time to set
  `.parent`, which nothing reads. It also expanded empty bodies from `{}` to `{ /* ... */ }`, making
  small files larger, and rewrote the text once per span — 400 functions copied a 200 KB file 400
  times.
- **`fullContents` retained every file body on runs that wrote no monolith.** The map held a
  reference to every pre-partition body and was read only inside `if (config.includeMonolith)`,
  pinning the multi-megabyte originals that the partitioner had just replaced with previews.
- **31 regexes were recompiled for every file.** `scanAndRedactSecrets` called `toGlobal` per rule
  per call, and it is called once per file: a 20 000-file scan built 620 000 identical objects.
- **`--watch` re-derived the whole repository for one changed file.** The derivation — redaction,
  findings, skeleton, preview, summary — is a pure function of (bytes, settings, path), so it is now
  cached and reused when the content hash and a settings digest both match. Validity is the **content
  hash**, not `mtime`: a formatter or a `git checkout` can rewrite a file within the same timestamp
  tick at the same length. Measured on a synthetic 250-file TypeScript repository: cold 520 ms, warm
  196 ms of wall clock (2.65x) — the remainder is reading, hashing, partitioning and writing, which
  a per-file cache cannot remove. The suite asserts the *work* instead, in CPU time on a denser
  fixture: 1 046 ms against 48 ms, 21x, against a 3x floor.

### What has no test, and why

The last two are structural. The regex cache and the `fullContents` change have no behavioural
signal — the output is byte-identical by construction — so they are covered by the existing suite
and by the reasoning above rather than by a new test. The `--watch` cache is different: four of its
five tests are correctness guards that pass on the previous build (that is the requirement — the
cache must be invisible), and the fifth measures the CPU time the cache saves and fails without it.

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

> Superseded since: the digit-as-string fix in 0.9.6 was reported from a live client session, and
> `snapshot_dependents` arrived in 0.9.8 on the same basis. This paragraph describes 0.9.5 and is
> left as written — it is history, not a disclaimer about the current server.

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
