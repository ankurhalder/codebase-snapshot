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