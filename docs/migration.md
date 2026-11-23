# Migrating to 0.20.12

Nothing was removed. Every command, flag, config key and MCP tool that existed in 0.12.14 still
works. This page maps what was added and the behaviour changes that matter when upgrading an old
checkout, config or snapshot.

## New commands

| Command | Since | What it does |
| :--- | :--- | :--- |
| `snapshot health` | 0.12.15 | Audits the written snapshot: hashes, artifacts, secrets, host paths, tokens, freshness, signature. `--strict`, `--format json`, `--deep`, `--all-members`. |
| `snapshot serve` | 0.12.19 | A browser page to generate, preview and download a snapshot; MCP on the same port. |
| `snapshot mcp --http` | 0.12.18 | MCP over Streamable HTTP instead of stdio; `GET /sse` for legacy clients since 0.12.29. |
| `snapshot update` | 0.18.0 | Bypasses the update cache, prints the registry answer, exits 0 current / 1 newer / 2 unreachable. |

## New `generate` flags

| Flag | Since | What it does |
| :--- | :--- | :--- |
| `--remote <url>` | 0.12.20 | Shallow, SSRF-safe clone of a public repository; provenance in the manifest. |
| `--ref <branch>` | 0.12.20 | Branch or tag for `--remote`. |
| `--allow-private` | 0.12.20 | Explicit override for private addresses and `file:` URLs. |
| `--keep-clone` | 0.12.20 | Keep the temporary clone. |
| `--include-diffs` | 0.12.24 | `reports/diff.md` from the uncommitted diff. |
| `--include-logs <n>` | 0.12.24 | `reports/log.md` with the last n commits. |
| `--token-tree` | 0.12.24 | `reports/tokens.md` with per-file estimates. |
| `--delta <path>` | 0.12.25 | Only what changed since a base snapshot, plus its importers. |
| `--slice "<question>"` | 0.12.26 | Only what the retrieval planner picks for a question. |
| `--slice-tokens <n>` | 0.12.26 | The slice budget (default 30000). |
| `--pack single|xml|json` | 0.12.31 | One full-repository file in the chosen shape. |
| `--sign` | 0.12.32 | Ed25519 signature over the manifest. |
| `--budget-tokens <n>` | 0.12.33 | Fit the repository into a token budget by selecting whole files. |

## New config keys

| Key | Since | Notes |
| :--- | :--- | :--- |
| `artifacts.diff`, `artifacts.log`, `artifacts.tokenTree` | 0.12.24 | Default `false`. `--skip-artifacts` still wins. |
| `logCount` | 0.12.24 | 1-500, default 20. |
| `pack` | 0.12.31 | `single`, `xml` or `json`; unset keeps the monolith pair. |
| `discovery` | 0.13.x | `auto`, `git` or `walk`; recorded in the config digest. |
| `maxParts` | 0.16.x | Grow the part budget until the snapshot has at most this many parts. |

## MCP

Tools went from eight to **26**: health, budget, history, tests, workspace, entrypoints,
neighbors, routes, cycles, search, stats, review, diff_context, symbol, context, query,
plan_for, answer, plan, generate, validate, locate, dependents, read, explain and status.
Prompts went from two (`orient`, `keep-current`) to seven (`audit`, `review`, `explain`,
`onboard`, `security-review` were added). Resources gained `snapshot://prompt` and the three
opt-in reports.

stdio is still the default. `--http` adds Streamable HTTP with a bearer token and a loopback
bind; `--no-auth` is refused on a non-loopback bind. The page and the MCP endpoint can share
one port with `serve`.

## 0.18.0 to 0.20.12: what changed

| Change | Since | Why it matters |
| :--- | :--- | :--- |
| `snapshot update` and a corrected update cache | 0.18.0, 0.20.0 | The command bypasses the cache; a failed check is remembered for five minutes, not an hour. |
| `health` recognises its own redaction marker and scans parts per section | 0.18.2, 0.19.0 | A clean snapshot no longer scores 70 for leaks that do not exist. The remaining host-path warning is documentation examples, not a credential. |
| The audit verifies snapshot claims, not only hashes | 0.20.1, 0.20.2 | Artifact counts, bodies, packs and workspace indexes are recomputed; a hand-edited snapshot fails. |
| `health` skips a secret check in linear time | 0.20.3 | A large skipped-secret set no longer re-reads the snapshot per token. |
| Security hardening across CLI, scanner, redaction, MCP, serve and remote | 0.20.4-0.20.12 | CodeQL, audit and live-verdict findings: path confinement, redaction continuations, rate limiting, 413 flushing, part-size caps, IPv6 remote parsing, git/walk parity and clone cleanup. |

## Behaviour changes to know

1. **`validate` accepts `--include-diffs`, `--include-logs` and `--token-tree`** (0.12.28).
   Those flags change the artifact selection the manifest records, so pass the same flags to
   compare like with like.
2. **The 0.20 line is published in place.** Every 0.20.x patch is committed, tagged and may be
   published; earlier lines published only at `x.y.0`. Pin an exact version when the same build
   must run everywhere.
3. **The 0.20.12 HTTP/MCP limits are stricter.** Empty JSON-RPC batches are invalid, oversized
   bodies return 413 before the socket closes, and content tools refuse a part above 16 MiB.

`validate` on a snapshot written by an older version still works: newer manifest keys are
optional, and an artifact the manifest does not record is not required to exist.

## If you are on an older 0.12.x

Upgrade to the latest 0.12.x first; every change since 0.12.14 is a patch on the same line, and
the configuration file format has not changed. Run `snapshot health` after the first generate on
the new version - it is the fastest way to see whether an old snapshot carries anything the
newer checks would refuse.
