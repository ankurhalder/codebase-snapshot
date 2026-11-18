# GOAL.md - the master plan and the working log

This file is the contract for the autonomous build. ROADMAP.md is the queue; this is the mission,
the rules, and the record of what was actually done. It is append-only at the bottom.

## Mission

**The context server that knows what to send - and can prove it.**

An agent should not receive a repository dump. It should ask for the smallest set of bytes that
answers its question, within a budget it names, and receive a manifest that can prove the answer is
current, complete, and free of anything the repository owner did not choose to share.

## Decisions locked by the owner

| Decision | Answer |
| :--- | :--- |
| Version ladder | Literal 100 sub-bumps per minor: 0.12.x to 0.12.99, then 0.13.0, and so on. Never 1.0.0. May continue past 0.17.0 if time remains. |
| GitHub releases | A tag for every version. A GitHub release for milestones (0.13.0, 0.14.0, ...). |
| Publishing | **npm only at `x.y.0`** (0.13.0, 0.14.0, ...). Every patch version is still committed, tagged and pushed to GitHub, so the code history and tags are complete; the npm registry stays clean. |
| Runtime dependencies | Zero. node: built-ins only. |
| Priority | MCP and retrieval first; parity second; web UI alongside. |
| Remote repos | Public and private. Private via GITHUB_TOKEN from the environment only. Depth 1, no submodules, no LFS. SSRF-safe by default. |
| Web server | Loopback by default, URL allowlist for remote sources, rate limited, bearer token generated on first start. |
| Browser MCP | Streamable HTTP + legacy SSE, CORS for the served origin. |
| MCP surface | All tools always (no core/all split). Structured output for data tools. Progress and cancellation for long runs. |
| MCP prompts | audit, review, explain, onboard, security-review. |
| Health service | Separate command and MCP tool; the cheap subset also runs in validate. Score 0-100, severities, --strict exits 2 on critical. PII is a warning, secrets are critical. |
| Languages | Python, Go, Rust, Java, C#, Ruby, PHP - imports, exports, symbols, signatures, routes, tests. Framework route patterns included. |
| Compatibility | Breaking changes allowed with a one-minor deprecation window. |
| Docs | One page per major feature plus a comparison page against repomix and gitingest. |
| Telemetry | None, ever. |
| License | MIT. |
| Work in progress | Never on main. main is always shippable. |
| Endgame | Stop new features 2h before 0.17.0; then verify, docs, benchmarks. |

## Standing rules (do not break)

1. No silent fallbacks. An unreadable or inapplicable setting is an error.
2. Never destroy user data. Every write is guarded; every removal is announced.
3. Never leak secrets. Sensitive files stay out; secrets are masked; paths are masked.
4. Progress to stderr, payload to stdout.
5. The contract must not lie. describe is generated and compared against reality in tests.
6. Nothing disappears without a recorded reason.
7. Zero runtime dependencies.
8. Every release is a real change with a regression test and a changelog entry.
9. An artifact may only describe the run it was given. (Three bugs in 0.12 already came from this.)

## The loop

```
1. Pick the next task from ROADMAP.md (highest phase, smallest slice).
2. Write the failing test first when the behaviour is testable.
3. Implement. typecheck + targeted tests after every file.
4. Update docs (the page that claims the behaviour) and the contract (describe).
5. Run the fast gate: lint + typecheck + affected tests.
6. Version bump, sync-docs, changelog entry, commit, tag, push.
7. Every 5-10 versions: full verify, then dispatch the publish train.
8. Append to the log below. Update ROADMAP.md status.
```

## Definition of done per feature

- [ ] Behaviour implemented, no fallbacks.
- [ ] Regression test that fails without the change.
- [ ] Docs page or section that describes it, and the contract updated.
- [ ] Typecheck and lint clean.
- [ ] Changelog entry explains the why, not the diff.
- [ ] Released (tag + npm).

## Phases

### Phase 1 - MCP that knows what to send

- [x] snapshot_plan_for: budgeted selection with reasons
- [x] snapshot_context: windows for named files or symbols
- [x] snapshot_query: structured manifest queries with a budget
- [x] snapshot_diff_context: PR-scoped pack
- [x] snapshot_symbol: symbol-level pack
- [x] snapshot_review: review brief for a change set
- [x] snapshot_health: the auditor as a tool
- [x] Streamable HTTP transport, CORS, bearer token
- [x] Legacy SSE transport
- [x] 24 tools, contract generated, per-tool cost notes

### Phase 2 - Remote and browser

- [x] --remote with caps, provenance, SSRF guard
- [x] GITHUB_TOKEN support, never logged
- [x] snapshot serve: UI (URL box, tree, brief, tokens, zip)
- [x] MCP endpoint and UI on one port
- [x] Zip writer, store-only
- [x] Dockerfile and deploy docs

### Phase 3 - Health service

- [x] Audit core: manifest, parts, accounting, artifacts
- [x] Leak scan: artifacts and derived values from excluded files
- [x] PII and host-path scan
- [x] Token accounting and budget checks
- [x] Skips, freshness, score, --strict
- [x] MCP tool and docs page

### Phase 4 - Parity

- [x] --include-diffs and --include-logs
- [x] --token-tree
- [x] --pack single/xml/json
- [x] --strip-comments and --remove-empty-lines
- [x] Python, Go, Rust, Java, C#, Ruby, PHP parsers
- [x] Base64/binary truncation policy (closed as not applicable: binaries are skipped, never encoded)

### Phase 5 - Beyond parity

- [x] CLI --slice sharing the MCP planner
- [x] Delta packs
- [x] Multi-repo workspaces
- [x] Signed manifests (Ed25519)
- [x] Budget planner with a quality report

### Phase 6 - Proof

- [x] Benchmarks against repomix (gitingest supported by the harness, not installed here)
- [x] Site pages for every feature (29)
- [x] Security review of server and remote ingestion
- [x] Migration guide

## Risks and fallbacks

| Risk | Fallback |
| :--- | :--- |
| npm publish rate limit | Keep tagging; the train retries later; versions stay unpublished but the repo is complete. |
| GitHub Actions queue | Publish in batches of 10-20; never create releases faster than the queue drains. |
| A feature overruns | Land the smallest useful slice; put the rest back in ROADMAP.md. |
| A regression in a release | Fix forward with a patch; never rewrite a published tag. |
| Windows-only behaviour | Cross-platform tests; the server and zip code get macOS/Linux jobs. |

## Log

Append one block per release. Newest last.

### 0.12.14 - no artifact points at a manifest it was not given

Fixed: PROMPT.md and README.md sent readers to manifest.skipped[], the call graph and
manifest.validation.status when the manifest artifact was disabled. The attachment arithmetic
also counted files that were not written. Verified: 1190 tests, 1182 pass, 0 fail.

### 0.12.15-0.12.43 - the retrieval server, the browser, and the proof

A forty-release stretch in one session, every version tagged and pushed. In order:

- **0.12.15** `snapshot health`: hashes, artifacts, secrets, host paths, token accounting, freshness,
  score, severities, `--strict`, and the MCP tool. The cheap subset went into `validate` in 0.12.28.
- **0.12.16-0.12.17-0.12.23** the retrieval tools: `plan_for`, `query`, `context`, `symbol`,
  `diff_context`. The planner matches stems (`charge`/`chargeCard`), packs to a budget and explains
  every choice.
- **0.12.18-0.12.29** transports: Streamable HTTP with a bearer token and loopback default, then
  legacy SSE with the query-token caveat documented and a shutdown that does not hang.
- **0.12.19-0.12.21** `serve`: one loopback process for the page, the API and MCP; a hand-written
  store-only zip writer; repository URLs in the page with the same SSRF guard as the CLI.
- **0.12.20** `generate --remote`: https only, DNS-checked public addresses, shallow clone, token via
  the environment, provenance (URL, host, owner, repo, ref, commit, fetchedAt) in the manifest.
- **0.12.22** seven prompts: orient, keep-current, audit, review, explain, onboard, security-review.
- **0.12.24-0.12.25-0.12.26-0.12.33-0.12.38** the packs that neither competitor has: `--delta`
  (changed files plus their importers, unchanged paths recorded), `--slice` (the planner at generate
  time), `--budget-tokens` (whole files, not torn ones), `--workspace` (one snapshot per member).
- **0.12.27-0.12.31-0.12.32-0.12.34-0.12.35-0.12.37-0.12.39** `--pack single|xml|json`, `--sign`
  (Ed25519 over the manifest, verified by health), benchmarks, the security review, the container,
  the migration guide, the roadmap statuses, the docs.
- **0.12.40-0.12.41-0.12.42-0.12.43** `--strip-comments` (parser-based, line numbers preserved),
  `snapshot_search` and `snapshot_stats`, a language-profile test, and MCP progress notifications.

State at the end: 17 MCP tools, 7 prompts, 5 transports/commands added (`health`, `serve`, `mcp
--http`, SSE, workspace), 27 site pages, ~1,270 tests. Every release has a changelog entry, a tag and
a green targeted gate; full `verify` ran green at 0.12.15, 0.12.24, 0.12.26, 0.12.27 and 0.12.40.

What is still open, in the order the next session should take it:

1. Cross-references between workspace members (a `WORKSPACE.json` that knows which member imports
   which is the obvious next step; today the members are independent).
2. A coverage/quality report for `--budget-tokens`: what fraction of layers, symbols and entry
   points survived, not only the token total.
3. Cancellation for MCP calls. Progress exists; an aborted call still runs to completion, and that
   is stated in the docs.
4. A head-to-head benchmark against repomix and gitingest on the same repository and budget, with
   both tools' own token accounting.
5. The last three tools to reach twenty: candidates are a route/handler index, a dependency-cycle
   reporter, and a resource that serves the workspace index.

### 0.12.44-0.12.48 - the last of the roadmap, and the proof

- 0.12.44 budget coverage: per-layer kept/total, entry points, exported symbols, and a warning when
  an entry point is lost.
- 0.12.45 workspace cross-member links: a relative import that resolves into another member is
  recorded with its specifier count and examples, and printed.
- 0.12.46 four graph tools: entrypoints, neighbors, routes, cycles. 21 tools, which meets the
  "20+" decision.
- 0.12.47 plan_for pulls in the callers of its strongest matches, and resolves `.js` specifiers to
  `.ts` files so a TypeScript repository has caller edges at all.
- 0.12.48 the brief names the opt-in reports it wrote.

Full `verify` at 0.12.47: 1279 tests, 1271 pass, 0 fail, 8 host skips; lint 257 files clean;
tarball 46 files; site 28 pages; audit-site clean.

Still open for the next rounds: head-to-head benchmarks against repomix and gitingest, cancellation
for MCP calls (progress exists; an aborted call runs to completion and the docs say so), per-tool
cost estimates in the contract, and the 0.13.0 milestone (the first publish under the clean-registry
policy).

### 0.12.50-0.12.63 - protocol polish, and the bugs the probes found

- 0.12.50 cancellation: `notifications/cancelled` runs a callback the call registered; a generate
  terminates its worker and says so. 0.12.51 lets `snapshot_generate` write the opt-in reports.
  0.12.52 adds per-tool cost classes to `tools/list` and `describe`.
- 0.12.53-0.12.54 the browser page gained slice/budget modes and a health score for what it wrote.
- 0.12.55-0.12.56 correctness: `--slice` with `--budget-tokens` is refused; `validate` no longer
  reports a selection's unselected files as drift.
- 0.12.57-0.12.58 the health audit expected neither `signature.json` nor the opt-in report files;
  both now come from what the manifest records.
- 0.12.59-0.12.63 docs: the workspace page named a `health --cwd api` that cannot work; the
  changelog preamble still denied the 0.13 ladder; explain now reads `not-selected` from the
  manifest; `resources/list` advertises only reports that exist; scratch probe scripts removed.

Full `verify` at 0.12.60: 1291 tests, 1283 pass, 0 fail, 8 host skips. Every release has a tag;
`main` is clean after each.

Still open for the next rounds: head-to-head benchmarks against repomix and gitingest, a
per-tool cost estimate measured rather than classified, cancellation for HTTP (stdio only today),
and 0.13.0, the first publish under the clean-registry policy.

### 0.12.65-0.12.71 - the comparison, the workspace tool, and the contract split

- 0.12.65-0.12.66 `scripts/compare.mjs`: full, slice and budget against repomix 1.19.0 through
  npx, in one run. Measured here: 330 files / 1,027,911 estimated tokens for us, 329 / 854,178 for
  repomix; slice 6.5%, budget 3.5%. `docs/benchmarks.md` states that the gap is the estimator and
  that ours is conservative.
- 0.12.67 `snapshot_workspace`, the 22nd tool: members and cross-member imports from
  WORKSPACE.json.
- 0.12.68 `snapshot_review` names the route methods a change touches.
- 0.12.69 the contract split `resources` (four always present) from `reportResources` (six, served
  only when written), which is what the parity tests demanded once listing became conditional.
- 0.12.70 `report` prints the selection: slice question and cost, budget coverage, delta counts.

Full `verify` at 0.12.69: 1296 tests, 1288 pass, 0 fail, 8 host skips; tarball 51 files.

Next: the last thirty sub-bumps to 0.12.99, then 0.13.0 as the first milestone publish.

### 0.12.72-0.12.76 - the reference, the test graph, and the guard rails

- 0.12.72 `docs/tools.md`: all tools by name, cost and status, with a ready-to-send call each.
  0.12.73 a test parses that page against the real schemas and caught three examples that named
  arguments no tool accepts (`locate` path/by, `context` files, `dependents` direction/limit).
- 0.12.74 `snapshot_tests`, the 23rd tool: tests that import a path or share its stem, or every
  test and what it covers.
- 0.12.75/0.12.76 the lint gate fixed the newline it caught.

Full `verify` at 0.12.75: 1300 tests, 1292 pass, 0 fail, 8 host skips; tarball 52 files; site 29
pages, audit-site clean.

Next: 0.12.77 through 0.12.99 (23 sub-bumps), then 0.13.0 as the first milestone publish. The
backlog for those: a `snapshot_history` tool over the log report, workspace-wide health, a
docs page for the workspace workflow, and the endgame checks the GOAL.md plan asks for.

### 0.12.77-0.12.79 - history, and a flag that lied

- 0.12.77 `snapshot_history`, the 24th tool, reads `reports/log.md` into commits. The same release
  fixed `--include-logs <n>`: the flag turned the report on, but the count was read from
  `logCount` alone, so `--include-logs 3` wrote twenty and said nothing. A request accepted and
  dropped is the forbidden silent fallback.
- 0.12.78 `snapshot_health` takes `maxScanBytes` for the expensive half of the audit, and a test now
  compares the `docs/mcp.md` tool table with the served set.

Full `verify` at 0.12.78: 1302 tests, 1294 pass, 0 fail, 8 host skips; tarball 52 files.

Twenty-one sub-bumps to 0.12.99, then 0.13.0. The backlog for them: workspace-wide health, a
docs page for the workspace workflow end to end, and the endgame checks GOAL.md lists before 0.17.0.

### 0.12.80-0.12.82 - a workspace audited whole

- 0.12.80 `health --all-members`: reads WORKSPACE.json and audits every member snapshot, one row
  each, combined score = weakest member, a missing member is an error row. Registered in the parser,
  the option-scope table and the contract, so `describe` and the parser agree.
- 0.12.81 the workspace page shows the four commands end to end: generate, audit all members,
  validate one member, serve the index through `snapshot_workspace`.

Full `verify` at 0.12.81: 1304 tests, 1296 pass, 0 fail, 8 host skips; tarball 52 files; site 29
pages, audit-site clean.

Eighteen sub-bumps to 0.12.99, then 0.13.0. Next in the queue: the endgame checks GOAL.md lists, a
pass over the troubleshooting page for the flags added since it was written, and a decision on
whether incremental parsing is worth its invalidation risk before 0.13.0.

### 0.12.83-0.12.86 - the digest stops lying, and the last parity flag

- 0.12.83 the troubleshooting page covers the flags added since it was written: selections,
  workspaces, signatures, remote refusals, the opt-in log report.
- 0.12.84 `configDigest` covered neither `--strip-comments`, `--pack` nor the `--include-logs`
  count, so `validate` compared equal for snapshots that differ — while `option-scope.ts` already
  claimed the digest covered them. Each is now written only when non-default, so existing
  snapshots keep their digest; a snapshot that used one reports it, as validate promises.
- 0.12.85 `--remove-empty-lines`, the last parity flag. Line numbers move, so each file records
  `emptyLinesRemoved`, the brief says how many files were renumbered, and the digest covers the
  setting. `validate` must be given the same flag, like `--strip-comments`.
- 0.12.86 the phase checklists in this file are ticked, with the two judgment calls written down:
  base64 is not applicable (binaries are skipped, never encoded) and gitingest is supported by the
  harness but not installed in this environment.

Full `verify` at 0.12.85: 1306 tests, 1298 pass, 0 fail, 8 host skips; tarball 52 files.

Fourteen sub-bumps to 0.12.99, then 0.13.0. What is left is the endgame the plan names: a last
pass over every page against the CLI, the milestone publish itself, and whatever the verify finds
between here and there.

### 0.12.87-0.12.89 - the pages prove themselves

- 0.12.87 the CLI reference was missing ten options (the six transport flags, `--all-members`,
  `--strict`, `--mode`, `--no-update-check`) while its description says "every command and option".
  Added, and a test now compares the page with `describe --format json` in both directions.
- 0.12.88 the edge-case probes became a test: empty, CRLF, comments-only, non-ASCII, bracketed and
  deeply nested files all generate, validate and audit cleanly, and the tools read the odd path. A
  path beyond 260 characters was created and scanned correctly on this host too.

Full `verify` at 0.12.88: 1310 tests, 1302 pass, 0 fail, 8 host skips; tarball 52 files; site 29
pages, audit-site clean.

Ten sub-bumps to 0.12.99, then 0.13.0. What remains is the milestone publish itself and the last
pass the plan asks for: every page opened beside the command it documents.

### 0.12.90-0.12.92 - the Windows-shaped leaks

- 0.12.90 the configuration page documents the transforms and the opt-in reports: stripComments,
  removeEmptyLines, logCount, pack, and the diff/log/tokenTree/sarif artifacts, with the rule that
  validate must be given the same flags because all four are in the config digest.
- 0.12.91 the host-path check missed `C:\\Users\\name` — the doubled spelling a JavaScript or JSON
  string literal uses — and `C:/Users/name`. On Windows that is the most likely leak shape, and it
  was invisible. The pattern now accepts one or more separators of either kind.
- 0.12.92 the round log. Also probed without findings: a BOM+CRLF config parses, a zip round-trips
  non-ASCII and bracketed names through Expand-Archive, and a path beyond 260 characters scans.

Full `verify` at 0.12.91: 1311 tests, 1303 pass, 0 fail, 8 host skips; tarball 52 files.

Seven sub-bumps to 0.12.99, then 0.13.0. The publish train is reachable from here (`gh` is
authenticated with the workflow scope), so the milestone can be dispatched after its tag.

### 0.12.93-0.12.95 - answers that do not overclaim

- 0.12.93 `snapshot_status` reported an unreadable manifest as a normal `present: false`, so a client
  planned around a snapshot it could never read. "No snapshot yet" stays an answer; a manifest that
  fails the shape check sets `isError`.
- 0.12.94 `snapshot_context` answered a missing path with an empty text block (the path was only in
  `structuredContent.missing`), and `snapshot_diff_context` claimed "no file imports the changed
  paths" for paths it had never read. Both name what they could not return now.
- 0.12.95 the round log. Also probed without findings: an empty repository generates, validates and
  audits as 0 files / 0 parts; two concurrent generates are serialised by a lock with a clear
  message; a path beyond 260 characters scans.

Full `verify` at 0.12.94: 1313 tests, 1305 pass, 0 fail, 8 host skips; tarball 52 files.

Four sub-bumps to 0.12.99, then 0.13.0 and the first publish through the train.

### 0.12.96-0.12.98 - the last gaps before the milestone

- 0.12.96 `snapshot_generate` can pack (single/xml/json) and narrow (slice/sliceTokens/budgetTokens).
  Both were CLI-only; the narrowing travels through the worker as generate options, and the
  slice/budget pair is refused as the CLI refuses it.
- 0.12.97 `GET /healthz` names the build (`version`, `uptimeSeconds`) without a token, and the
  `--all-members` JSON shape is pinned by a test.
- 0.12.98 this log and the last verify before the milestone.

Full `verify` at 0.12.97: 1316 tests, 1308 pass, 0 fail, 8 host skips; tarball 52 files.

One sub-bump to 0.12.99, then 0.13.0: the first publish under the clean-registry policy, through
the publish train with a dry run first.

### 0.12.99-0.13.2 - the milestone, published

- 0.12.99 closed the last sub-bump with a security fix: the serve API took a `path` and resolved it
  with `path.resolve`, so a bearer token doubled as an arbitrary-file-read primitive. The server now
  allows its working directory and the clones it created, and answers `403` otherwise.
- **0.13.0 is the first published milestone.** Tagged, released on GitHub with notes, and published
  to npm through `publish-train.yml`: the registry now reports `latest = 0.13.0`. The train's first
  attempt printed "Your package is being processed" and the registry showed nothing for about five
  minutes; the retry found the version already there. That is npm's asynchronous processing, not a
  failure — worth knowing before calling a publish dead.
- 0.13.1 fixed the portability bug the failed release-event workflow exposed: twelve test files built
  paths from `URL.pathname` and stripped a leading slash, which is absolute on Windows and relative
  on Linux. All twelve use `fileURLToPath` now.

Full `verify` at 0.13.1: 1317 tests, 1309 pass, 0 fail, 8 host skips; tarball 52 files.

Next: the 0.13.x line toward 0.14.0. The queue from the plan: observability for the HTTP server,
a last pass on the retrieval planner, and whatever the verify finds in between.

### 0.13.3-0.13.5 - observability, and an index that has to agree

- 0.13.3 `GET /metrics` on the HTTP transport: Prometheus text with request totals, per-method
  counts, refusals, rate-limit rejections, tool count and uptime. No label carries a path or a
  credential, because a label built from a URL is an unbounded map and would publish what was asked
  for to the monitoring system.
- 0.13.4 the health audit checks a workspace member against `WORKSPACE.json`: fingerprint and file
  count must agree, an unreadable index warns with the parse error, and a member the index does not
  list is a skip with its reason.
- 0.13.5 this log.

Full `verify` at 0.13.4: 1319 tests, 1311 pass, 0 fail, 8 host skips; tarball 52 files.

Next: the road to 0.14.0 (health service deepening), then 0.15.x parity, 0.16.x beyond parity,
0.17.0 endgame - and a milestone publish at each x.y.0.

### 0.13.6-0.13.8 - the manifest has to prove its own numbers

- 0.13.6 the audit checks every file body against `includedBytes`/`includedLines`. The per-file
  counts were never compared with the parts, so a truncated part with an updated hash agreed with
  every check while under-delivering. The parser moved to `partitioner/part-format.ts` so the auditor
  and the server share it instead of the auditor importing the server.
- 0.13.7 the audit recomputes `counts.totalFiles`, `counts.partsCount`, `counts.skippedCount`,
  `totals.totalContentBytes` and the per-layer counts from the manifest arrays. A manifest edited to
  claim five more files than it held passed every check before this.
- Probes behind both: five generation modes on this repository (full, strip-comments,
  remove-empty-lines, skeleton, forced previews) all agree; one deleted line in a part fails; one
  edited count fails with the field and both numbers.

Full `verify` at 0.13.7: 1321 tests, 1313 pass, 0 fail, 8 host skips; tarball 52 files.

Next: the rest of the 0.14.0 theme is the health service, then the 0.14.0 milestone publish. The
questions left: does the token estimate match the tokenizer it claims, and does the audit cover the
monolith packs.

### 0.13.9-0.14.1 - the audit stops trusting the manifest

- 0.13.9 the JSON monolith must hold exactly the files the manifest lists: a digest proves the pack
  is the recorded file, not that the recorded pack is complete. 0.13.10 extended the same check to
  the XML and markdown packs, each with a small reader.
- **0.14.0 is the second published milestone**: the health service now verifies bodies, counts,
  packs and the workspace index against the data they describe, and the HTTP transport has
  Prometheus metrics. Tagged, released on GitHub, and published to npm; the registry reports
  `latest = 0.14.0` (it again spent about four minutes "being processed" before the version appeared).

Full `verify` at 0.14.0: 1323 tests, 1315 pass, 0 fail, 8 host skips; tarball 52 files; site 29
pages, audit-site clean.

Next: 0.14.x toward 0.15.0 (parity where it matters), then 0.16.0 (beyond parity) and 0.17.0 (the
endgame the plan describes). Two milestones are published; three remain.

### 0.14.2-0.14.4 - three tools, and who calls what

- 0.14.2 gitingest is measured: the harness sets `PYTHONIOENCODING=utf-8` for the child (without it
  gitingest aborts on Windows while printing its tree) and `docs/benchmarks.md` carries the
  three-way table: 3.30 MB / 1,060,727 tokens for us, 3.52 MB / 888,168 for repomix, 3.12 MB of
  digest for gitingest with no token count.
- 0.14.3 `snapshot_symbol` reports call sites: the parts are scanned for the name, bounded and
  case-sensitive, with the definition line marked and `references: false` to skip it. This closes
  roadmap item 33 (symbol-level packs with call-site evidence).

Full `verify` at 0.14.3: 1324 tests, 1316 pass, 0 fail, 8 host skips; tarball 52 files.

Next: 0.15.0 (parity where it matters) - the remaining items are the ten-repository benchmark run
and whatever parity gaps the comparison pages still name.

### 0.14.5-0.15.1 - parity on someone else's repositories

- 0.14.5 `scripts/benchmark-suite.mjs`: ten public repositories, shallow-cloned, packed by this
  tool, repomix and gitingest in one pass. Results in `docs/benchmarks.md`: nine of ten within about
  plus or minus 30% of repomix's tokenizer count; minimatch is a policy difference (its 20–25 MB
  fixtures are emitted by repomix and bounded-previewed by us), and the page says so.
- 0.14.6 `--only` and `--ignore` for a single run, in the config digest so `validate` and `explain`
  compare like with like.
- **0.15.0 is the third published milestone** (`latest` on npm at 01:33Z), tagged and released on
  GitHub with the parity summary.

Full `verify` at 0.15.0: 1328 tests, 1320 pass, 0 fail, 8 host skips; tarball 52 files; site 29
pages, audit-site clean.

Next: 0.15.x toward 0.16.0 (things neither product has) and then 0.17.0, the endgame the plan
describes. Three milestones published, two to go.

### 0.15.2-0.15.4 - budgets that answer "what if", selections that explain themselves

- 0.15.2 `snapshot_budget` (25th tool) runs the planner at several budgets and reports what each adds.
  The manifest budget block gained `headroomTokens` and `nextInLine`; `report` prints both, so the
  CLI and the tool say the same thing.
- 0.15.3 `reports/selection.md`: a slice or budget snapshot lists every chosen file with its cost and
  reason, what was left out, and what more budget would buy. Recorded as an artifact, so `validate`
  fails when it is edited — a selection that cannot explain itself is a claim without evidence.
- 0.15.4 documents both and corrects the tool count in `AGENTS.md` (it still said 21).

Full `verify` at 0.15.3: 1332 tests, 1324 pass, 0 fail, 8 host skips; tarball 52 files.

Next: 0.16.0 (things neither competitor has), then the 0.17.0 endgame. Four milestones published,
one to go.

### 0.15.5-0.16.1 - question in, cited context out

- 0.15.5 `snapshot_answer` (26th tool): plan a question, return each chosen file as a line-numbered
  head window within one budget, each with its reason, every omission named. The one-call version of
  plan-then-read that the MCP surface was missing.
- **0.16.0 is the fourth published milestone** (`latest` on npm at 01:52Z), tagged and released on
  GitHub with the beyond-parity summary: selections that explain themselves, budgets that answer
  "what if", multi-repo, signing, and an audit that proves the manifest.

Full `verify` at 0.16.0: 1333 tests, 1325 pass, 0 fail, 8 host skips; tarball 52 files; site 29
pages, audit-site clean.

Next: 0.17.0 - the endgame: every feature on a site page, the security review refreshed, the
migration guide current, and the final measurement. Then 0.17.x until the deadline, because the
program does not stop at the milestone.

### 0.16.2-0.17.1 - the endgame, and the registry exactly as promised

- 0.16.2 `docs/answer.md` (30 pages), the security review extended for every surface added since it
  was written, and the 0.13.0-0.17.0 migration table. The site builder still said "All 22 MCP
  tools"; it says 26.
- **0.17.0 is the fifth and final milestone**: the capstone changelog states what the tool is, the
  milestone table with publish dates, and how each claim is proven. Tagged, released on GitHub,
  published to npm.
- The registry now carries exactly `0.13.0, 0.14.0, 0.15.0, 0.16.0, 0.17.0`, with `latest = 0.17.0`
  (02:03Z). Every sub-bump in between is committed, tagged and pushed; the npm line is clean.

Full `verify` at 0.17.0: 1333 tests, 1325 pass, 0 fail, 8 host skips; 30 site pages with no link or
metadata problems; a 53-file tarball whose lockfile agrees with `package.json`.

The program reached 0.17.0, but the work does not stop at the milestone: 0.17.x continues with
hardening, coverage and the items listed in the roadmap's "after 0.17.0" note, until the deadline.

### 0.17.1-0.17.6 - hardening after the milestone

- 0.17.1 documented the final milestone; the registry carries exactly the five `x.y.0` versions with
  `latest = 0.17.0`.
- 0.17.2 `--only` matching nothing warned nowhere (exit 0, "integrity passed"); the planner described
  an empty snapshot with two false statements; `snapshot_generate` lacked `only`/`ignore`. All three
  fixed and pinned.
- 0.17.3 the docs/schema test caught that the 0.17.2 docs note had stolen the generate entry's
  example call. Fixed, and the release command now gates on test failure before tagging.
- 0.17.4 `snapshot_answer` dropped the planner notes, so an empty answer had no explanation; the
  planner blamed the budget when nothing had matched. Three states now have three sentences.
- 0.17.5 `snapshot_read` clamped `lines: 0`, `lines: -3`, `fromLine: -5` and `fromLine: 2.7` to one
  line and said nothing; impossible requests are errors that name the argument and the value.

Full `verify` at 0.17.5: 1337 tests, 1329 pass, 0 fail, 8 host skips; tarball 53 files.

The 0.17.x line continues: the backlog still holds the web page hardening, a wider fuzz pass over
the part parser, and the per-command docs audit.

### 0.17.7-0.17.8 - the web page and the workspace audit

- Probing the web surface end to end: `POST /api/generate` with slice mode on a repository whose
  question matched nothing returned `files: 0, dropped: 2, warning: null`. A slice that selects
  nothing now carries the planner's reason as a warning, the way a budget already did.
- `health --all-members` gave **100/100** to a member whose source directory had been deleted: every
  hash was valid, but the workspace index still named a path that no longer exists. It now warns with
  the path and "regenerate the workspace", and the combined score is the weakest member (95/100 in
  the probe, still exit 0 — a warning, not a failure).
- The zip from the page contains `reports/selection.md` for a slice, and the archive names are
  forward-slashed as the format requires (verified by unpacking it).

Full `verify` at 0.17.7: 1339 tests, 1331 pass, 0 fail, 8 host skips; tarball 53 files.

Next: the parser fuzz pass (part sections with adversarial content) and the per-command docs audit.

### 0.17.9-0.17.10 - the parser holds, the transport did not

- Adversarial content was pushed through the whole pipeline: files containing a fake `### FILE:`
  heading, embedded 3/4/6-backtick fences, anchor-like lines, CRLF, and a body ending on a fence.
  All round-trip, and the audit's per-file body accounting agrees — the parser's fence tracking is
  sound.
- The fuzz found the one hole next door: a 200 KB single-line file under a 60k budget came back from
  `snapshot_answer` whole — a 200 KB response with no note, while `snapshot_read` caps one response
  at 64 KiB. Blocks are now capped and labelled (`first 64 KiB of the window`), and `usedTokens` is
  measured on the returned text instead of the pre-clip window.

Full `verify` at 0.17.9: 1340 tests, 1332 pass, 0 fail, 8 host skips; tarball 53 files.

Next: the per-command docs audit (every `describe` command and option has a docs row, and every row
names a real option), then the web page accessibility pass.

### 0.17.11-0.17.12 - the page without a mouse, the docs without a test

- The serve page had four controls with no accessible names (placeholder and title only) and a status
  line that screen readers never announced. Every control now has an `aria-label`, `#status` is a
  live region, and a test fails if a new control arrives unnamed.
- `docs/cli.md` promises every command and nothing compared the list with the contract. A test now
  diffs `describe --commands` against the page's sections both ways — the options tests had this,
  the commands did not.

Full `verify` at 0.17.11: 1343 tests, 1335 pass, 0 fail, 8 host skips; tarball 53 files.

Next: the MCP resource list against the docs, and a pass over the prompts (each prompt should name
the tool that answers its step).

### 0.17.13-0.17.14 - prompts without their subject

- Probed the prompt surface: every prompt names only tools that exist, and every listed resource is
  readable (parts appear in `resources/list` only when the manifest has them).
- The gap was `prompts/get`: `review` without `change` and `explain` without `path` returned the
  prompt with no subject, because the server read `arguments` but never enforced `required`. It now
  refuses with `-32602`, names the argument and quotes its description; optional arguments (orient's
  `focus`) stay optional.

Full `verify` at 0.17.13: 1344 tests, 1336 pass, 0 fail, 8 host skips; tarball 53 files.

Next: the HTTP transport surface (rate limiting, /metrics under load, session teardown), then a
pass over `snapshot_review` with a real diff.

### 0.17.15-0.17.16 - the counter that counted almost nothing

- Probed the HTTP transport instead of the tools: initialize, an unauthorized POST, a cross-origin
  POST, a wrong method, 90 requests into a 60-per-10s window, then `/metrics`. The transport behaved
  correctly (401/403/405/429 as documented); the metric did not.
- `snapshot_requests_refused_total` claimed "requests refused before dispatch" and counted only a
  rejected CORS origin. A missing token, a wrong method, an oversize body and an unknown SSE
  session were served and counted as nothing, so a probed server reported **zero refusals**.
- Counting moved into `send()` for every 4xx except 429 (which keeps its own counter, because the
  question is different). The same probe now reads 3 refusals and 30 rate-limited, and a test pins
  both numbers plus the 429 count the client actually saw.

Full `verify` at 0.17.15: 1345 tests, 1337 pass, 0 fail, 8 host skips; tarball 53 files.

Next: `snapshot_review` against a real working-tree diff, then the `--include-diffs` behaviour on a
repository without git.

### 0.17.17-0.17.18 - the review that called a fresh snapshot stale

- Probed `snapshot_review` on a real git working-tree diff: the review said **"Snapshot: stale; run
  snapshot_generate"** immediately after generating, because `validate` compares the config digest,
  the digest covers the artifact selection (`--include-diffs`), and review has no flags to pass.
- Fixed on two sides: the manifest now records `removeEmptyLines`, `pack` and `logCount` (the three
  digest inputs it lacked, so any no-flag validator can reconstruct the run), and the review takes
  the artifact selection and flag-only settings from `manifest.config` before validating. Config-file
  drift (budgets, include/exclude, layers, kinds, preset) is still reported.
- The same probe now reads "current" after generate and "stale" after one appended line.

Full `verify` at 0.17.17: 1346 tests, 1338 pass, 0 fail, 8 host skips; tarball 53 files.

Next: `--include-diffs` on a repository without git, then the `--delta` flow against a real base.

### 0.17.19-0.17.22 - the flag that did nothing, and the warning that leaked

- `--include-diffs`/`--include-logs` outside a git repository accepted the flag, wrote no report,
  recorded no artifact, warned nothing and exited 0. Both now warn with the reason, the contract and
  `docs/cli.md` say so, and a test asserts both warnings on a non-git fixture.
- The first version of that warning embedded the absolute cwd, and the **health audit failed the
  snapshot it had just generated** for a host path in `manifest.json` — exactly the check that exists
  for this. The message names no path; the test asserts a warning carries no drive-letter path.
- 0.17.20 corrected the `--include-logs` docs row, which the 0.17.19 changelog had claimed agreed
  with the contract but did not (the flag test checks names, not prose).

Full `verify` at 0.17.21: 1347 tests, 1339 pass, 0 fail, 8 host skips; tarball 53 files.

Next: the `--delta` flow against a real base snapshot, then the signature path end to end
(generate --sign, validate, health, tampered manifest).

### 0.17.23-0.17.24 - the signature nobody checked

- The delta flow was reproduced end to end first: a changed file plus its importer, an added file, a
  removed file and one unchanged path, with `delta.removed` and `skipped[reason=unchanged]` both
  recorded and `validate` clean. It holds.
- The signature flow did not. `--sign` with `SNAPSHOT_SIGNING_KEY` writes a `configured` record and
  `health` verifies it, but **`validate` never looked at `signature.json`**: a manifest edited after
  signing passed the drift check. `validate` now verifies and exits 1 with
  `signature: manifest.json changed after it was signed.`
- `docs/signing.md` said health verifies; it now says both do, with the message.

Full `verify` at 0.17.23: 1348 tests, 1340 pass, 0 fail, 8 host skips; tarball 53 files.

Next: the MCP `snapshot_diff_context` and `snapshot_context` against a real base, then the wizard
(`init --yes`, non-interactive refusals) as the last untested surface.

### 0.17.25-0.17.26 - two resolvers, one import graph

- `snapshot_diff_context` had its own importer loop: only relative specifiers, a fixed extension
  list. On a repository importing through a tsconfig path alias (`@/user`), asking about `user.ts`
  returned **no dependents** — while `generate --delta` on the same tree included the importer.
  Silent under-reporting in the one tool whose description says the dependents are what reviewers
  miss.
- The tool now builds the generator's `ImportResolver` (`buildImportResolver` + `tsconfigPathsFor`),
  so aliases, index files, `js`→`ts` and non-JS languages resolve identically in the client and the
  CLI. The probe reports `["src/app.ts"]`; an alias-only fixture pins it.

Full `verify` at 0.17.25: 1349 tests, 1341 pass, 0 fail, 8 host skips; tarball 53 files.

Next: the wizard (`init --yes`, non-interactive refusals) as the last largely untested surface, then
the `mcp` tool list against `snapshot_locate`/`snapshot_search` semantics.
