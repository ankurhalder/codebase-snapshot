# Roadmap

What is being built, in the order it ships. Every line is a real change with a test; the version
column is the release that carried it (or will). This file is the queue: if a task is not here, it
is not going to happen by accident.

**North star.** The smartest context server, not the biggest dump. An agent asks for what it needs
and gets the smallest set of bytes that answers it — with a manifest that can prove the answer is
current, complete and free of anything the repository owner did not choose to share.

## Phase 1 — MCP that knows what to send (0.12.x → 0.13.0)

| # | Task | Status |
| - | :--- | :--- |
| 1 | `snapshot_plan_for` — given a question, return the minimal set of parts/files within a token budget, with reasons | planned |
| 2 | `snapshot_context` — given files or symbols, return only the windows that matter, within a budget | planned |
| 3 | `snapshot_diff_context` — a PR-scoped pack: changed files, their callers, their tests | planned |
| 4 | `snapshot_query` — structured manifest queries (layer, kind, regex, size) with a budget | planned |
| 5 | `snapshot_symbol` — symbol-level packs from the AST | planned |
| 6 | `snapshot_review` — review brief for a change set | planned |
| 7 | `snapshot_health` — audit a generated snapshot (see Phase 3) | planned |
| 8 | Streamable HTTP transport (`--http`) with CORS, bearer token, loopback default | planned |
| 9 | Legacy SSE transport for older clients | planned |
| 10 | 20+ tools, namespaced, with a generated contract and per-tool cost estimates | planned |

## Phase 2 — Remote repositories and the browser (0.13.x)

| # | Task | Status |
| - | :--- | :--- |
| 11 | `--remote <url>`: shallow clone, size/time caps, temp cleanup | planned |
| 12 | Private repos via `GITHUB_TOKEN` from the environment; never logged, never in the manifest | planned |
| 13 | `snapshot serve`: web UI — paste URL, generate, preview, download zip | planned |
| 14 | `serve` MCP endpoint + UI on one port, loopback default | planned |
| 15 | Zip export written by hand (store-only, no dependency) | planned |
| 16 | Dockerfile and deploy docs | planned |

## Phase 3 — The health service (0.14.0)

| # | Task | Status |
| - | :--- | :--- |
| 17 | `snapshot health`: audit a generated snapshot against the repository | planned |
| 18 | Leak check: every artifact scanned for masked and unmasked secrets, cross-checked against sensitive files | planned |
| 19 | Host-path/PII check: absolute home paths, usernames, machine names in artifacts | planned |
| 20 | Token accounting: recomputed estimates vs manifest, over-budget parts, redundancy | planned |
| 21 | Coverage claims: parts/artifacts named vs present; phantom parts | planned |
| 22 | Freshness: recorded git state vs now; drift summary | planned |
| 23 | Score, severities, `--strict` exit code, `--format json` | planned |

## Phase 4 — Parity where it matters (0.15.x)

| # | Task | Status |
| - | :--- | :--- |
| 24 | `--include-diffs` (working tree) and `--include-logs` (git history) | planned |
| 25 | `--token-tree`: per-file token counts in a table | planned |
| 26 | `--pack single|xml|json`: one file, as a mode, never the default | planned |
| 27 | Comment and blank-line stripping (`--strip-comments`, `--strip-empty-lines`) | planned |
| 28 | Multi-language structural parsers: Python, Go, Rust, Java, C#, Ruby, PHP | planned |
| 29 | Base64/binary truncation policy | planned |

## Phase 5 — Things neither product has (0.16.x)

| # | Task | Status |
| - | :--- | :--- |
| 30 | Task-scoped slicing from the CLI (`--slice "question"`), sharing the MCP planner | planned |
| 31 | Delta packs: what changed since a previous snapshot, with context | planned |
| 32 | Multi-repo / monorepo workspace snapshots with cross-references | planned |
| 33 | Symbol-level packs with call-site evidence | planned |
| 34 | Signed manifests (Ed25519) behind `--sign` | planned |
| 35 | Budget planner: "fit this repo into N tokens" with a quality report | planned |

## Phase 6 — Polish and proof (0.17.0)

| # | Task | Status |
| - | :--- | :--- |
| 36 | Benchmarks against repomix and gitingest on 10 public repos | planned |
| 37 | Site pages for every new feature | planned |
| 38 | Security review of the server and the remote ingestion path | planned |
| 39 | Migration guide for the 0.13-0.17 changes | planned |

## Standing rules

- No silent fallbacks; an unreadable or unapplicable setting is an error.
- Never destroy user data; every write is guarded and every removal is announced.
- Never leak: sensitive files stay out, secrets are masked, paths are masked.
- Progress to stderr, payload to stdout.
- The contract must not lie: `describe` is generated, and a test compares it to reality.
- Nothing disappears without a recorded reason.
- Zero runtime dependencies.
- Every release is a real change with a regression test.
