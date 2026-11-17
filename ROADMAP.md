# Roadmap

What is left, in order, with the status of each item. The version in the status column is the
one that shipped it. Nothing here is a promise about a date; it is the order work happens in.

## Phase 1 — MCP that knows what to send (0.12.x → 0.13.0)

| # | Task | Status |
| - | :--- | :--- |
| 1 | `snapshot_plan_for` — given a question, return the minimal set of parts/files within a token budget, with reasons | shipped 0.12.16 |
| 2 | `snapshot_context` — given files or symbols, return only the windows that matter, within a budget | shipped 0.12.17 |
| 3 | `snapshot_diff_context` — a PR-scoped pack: changed files, their callers, their tests | shipped 0.12.23 |
| 4 | `snapshot_query` — structured manifest queries (layer, kind, regex, size) with a budget | shipped 0.12.16 |
| 5 | `snapshot_symbol` — symbol-level packs from the AST | shipped 0.12.23 |
| 6 | `snapshot_review` — review brief for a change set | planned |
| 7 | `snapshot_health` — audit a generated snapshot (see Phase 3) | shipped 0.12.15 |
| 8 | Streamable HTTP transport (`--http`) with CORS, bearer token, loopback default | shipped 0.12.18 |
| 9 | Legacy SSE transport for older clients | planned |
| 10 | 20+ tools, namespaced, with a generated contract and per-tool cost estimates | 14 shipped; more planned |

## Phase 2 — Remote repositories and the browser (0.13.x)

| # | Task | Status |
| - | :--- | :--- |
| 11 | `--remote <url>`: shallow clone, SSRF guard, size/time caps, temp cleanup | shipped 0.12.20 |
| 12 | Private repos via `GITHUB_TOKEN` from the environment; never logged, never in the manifest | shipped 0.12.20 |
| 13 | `snapshot serve`: web UI — paste path or URL, generate, preview, download zip | shipped 0.12.19 |
| 14 | `serve` MCP endpoint + UI on one port, loopback default | shipped 0.12.19 |
| 15 | Zip export written by hand (store-only, no dependency) | shipped 0.12.19 |
| 16 | Dockerfile and deploy docs | planned |

## Phase 3 — The health service (0.14.0)

| # | Task | Status |
| - | :--- | :--- |
| 17 | `snapshot health`: audit a generated snapshot against the repository | shipped 0.12.15 |
| 18 | Leak check: every artifact scanned for masked and unmasked secrets, cross-checked against sensitive files | shipped 0.12.15 |
| 19 | Host-path/PII check: absolute home paths, usernames, machine names in artifacts | shipped 0.12.15 |
| 20 | Token accounting: recomputed estimates vs manifest, over-budget parts, redundancy | shipped 0.12.15 |
| 21 | Coverage claims: parts/artifacts named vs present; phantom parts | shipped 0.12.15 |
| 22 | Freshness: recorded git state vs now; drift summary | shipped 0.12.15 |
| 23 | Score, severities, `--strict` exit code, `--format json` | shipped 0.12.15 |
| 23a | The cheap subset inside `validate`, so CI catches structural dishonesty | planned |

## Phase 4 — Parity where it matters (0.15.x)

| # | Task | Status |
| - | :--- | :--- |
| 24 | `--include-diffs` (working tree) and `--include-logs` (git history) | shipped 0.12.24 |
| 25 | `--token-tree`: per-file token counts in a table | shipped 0.12.24 |
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

## Shipped so far

| Version | Change |
| :--- | :--- |
| 0.12.15 | Health service: CLI, MCP tool, docs, tests |
| 0.12.16 | `snapshot_plan_for`, `snapshot_query` |
| 0.12.17 | `snapshot_context` |
| 0.12.18 | MCP over HTTP (Streamable HTTP, token, CORS) |
| 0.12.19 | `serve`: browser UI, zip writer, MCP on one port |
| 0.12.20 | `generate --remote` with SSRF guard and provenance |
| 0.12.21 | Repository URLs in the browser page |
| 0.12.22 | Seven MCP prompts |
| 0.12.23 | `snapshot_symbol`, `snapshot_diff_context` |
| 0.12.24 | `--include-diffs`, `--include-logs`, `--token-tree` |
