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

- [ ] snapshot_plan_for: budgeted selection with reasons
- [ ] snapshot_context: windows for named files or symbols
- [ ] snapshot_query: structured manifest queries with a budget
- [ ] snapshot_diff_context: PR-scoped pack
- [ ] snapshot_symbol: symbol-level pack
- [ ] snapshot_review: review brief for a change set
- [ ] snapshot_health: the auditor as a tool
- [ ] Streamable HTTP transport, CORS, bearer token
- [ ] Legacy SSE transport
- [ ] 20+ tools, contract generated, per-tool cost notes

### Phase 2 - Remote and browser

- [ ] --remote with caps, provenance, SSRF guard
- [ ] GITHUB_TOKEN support, never logged
- [ ] snapshot serve: UI (URL box, tree, brief, tokens, zip)
- [ ] MCP endpoint and UI on one port
- [ ] Zip writer, store-only
- [ ] Dockerfile and deploy docs

### Phase 3 - Health service

- [ ] Audit core: manifest, parts, accounting, artifacts
- [ ] Leak scan: artifacts and derived values from excluded files
- [ ] PII and host-path scan
- [ ] Token accounting and budget checks
- [ ] Skips, freshness, score, --strict
- [ ] MCP tool and docs page

### Phase 4 - Parity

- [ ] --include-diffs and --include-logs
- [ ] --token-tree
- [ ] --pack single/xml/json
- [ ] --strip-comments and --strip-empty-lines
- [ ] Python, Go, Rust, Java, C#, Ruby, PHP parsers
- [ ] Base64/binary truncation policy

### Phase 5 - Beyond parity

- [ ] CLI --slice sharing the MCP planner
- [ ] Delta packs
- [ ] Multi-repo workspaces
- [ ] Signed manifests (Ed25519)
- [ ] Budget planner with a quality report

### Phase 6 - Proof

- [ ] Benchmarks against repomix and gitingest
- [ ] Site pages for every feature
- [ ] Security review of server and remote ingestion
- [ ] Migration guide

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
