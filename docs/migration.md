# Migrating from 0.12.14 to 0.17.0

Nothing was removed. Every command, flag, config key and MCP tool that existed in 0.12.14 still
works, with two deliberate behaviour changes listed at the bottom. This page is the map of what was
added, so a reader can find the feature they need without reading a hundred changelog entries.

## New commands

| Command | Since | What it does |
| :--- | :--- | :--- |
| `snapshot health` | 0.12.15 | Audits the written snapshot: hashes, artifacts, secrets, host paths, tokens, freshness, signature. `--strict`, `--format json`. |
| `snapshot serve` | 0.12.19 | A browser page to generate, preview and download a snapshot; MCP on the same port. |
| `snapshot mcp --http` | 0.12.18 | MCP over Streamable HTTP instead of stdio; `GET /sse` for legacy clients since 0.12.29. |

## New `generate` flags

| Flag | Since | What it does |
| :--- | :--- | :--- |
| `--remote <url>` | 0.12.20 | Shallow, SSRF-safe clone of a public repository; provenance in the manifest. |
| `--ref <branch>` | 0.12.20 | Branch or tag for `--remote`. |
| `--allow-private` | 0.12.20 | The explicit override for private addresses and `file:` URLs. |
| `--keep-clone` | 0.12.20 | Keep the temporary clone. |
| `--include-diffs` | 0.12.24 | `reports/diff.md` from the uncommitted diff. |
| `--include-logs <n>` | 0.12.24 | `reports/log.md` with the last n commits. |
| `--token-tree` | 0.12.24 | `reports/tokens.md` with per-file estimates. |
| `--delta <path>` | 0.12.25 | Only what changed since a base snapshot, plus its importers. |
| `--slice "<question>"` | 0.12.26 | Only what the retrieval planner picks for a question. |
| `--slice-tokens <n>` | 0.12.26 | The slice budget (default 30000). |
| `--pack single\|xml\|json` | 0.12.31 | One full-repository file in the chosen shape. |
| `--sign` | 0.12.32 | Ed25519 signature over the manifest. |
| `--budget-tokens <n>` | 0.12.33 | Fit the repository into a token budget by selecting whole files. |

## New config keys

| Key | Since | Notes |
| :--- | :--- | :--- |
| `artifacts.diff`, `artifacts.log`, `artifacts.tokenTree` | 0.12.24 | Default `false`. `--skip-artifacts` still wins. |
| `logCount` | 0.12.24 | 1–500, default 20. |
| `pack` | 0.12.31 | `single`, `xml` or `json`; unset keeps the monolith pair. |

## MCP

Tools went from eight to fifteen: `snapshot_health`, `snapshot_plan_for`, `snapshot_query`,
`snapshot_context`, `snapshot_symbol`, `snapshot_diff_context`, `snapshot_review` joined the original
eight. Prompts went from two (`orient`, `keep-current`) to seven (`audit`, `review`, `explain`,
`onboard`, `security-review` were added). Resources gained `snapshot://prompt` and the three opt-in
reports.

Transports: stdio is still the default. `--http` adds Streamable HTTP with a bearer token and a
loopback bind; `--no-auth` is refused on a non-loopback bind. The page and the MCP endpoint can share
one port with `serve`.

## Two behaviour changes

1. **`validate` accepts `--include-diffs`, `--include-logs` and `--token-tree`** (0.12.28). Those
   flags change the artifact selection the manifest records, so passing them is required to compare
   like with like. Before, a snapshot generated with one of them reported a selection mismatch.
2. **npm publishes only at `x.y.0`** (0.12.16 onward). Every patch is committed, tagged and pushed;
   the registry carries `0.13.0`, `0.14.0`, … so `latest` stays a milestone rather than a patch. If
   you pin an exact patch version, install from the git tag or build from source until the next
   minor.

## If you are on an older 0.12.x

Upgrade to the latest 0.12.x first; every change since 0.12.14 is a patch on the same line, and the
configuration file format has not changed. Run `snapshot health` after the first generate on the new
version — it is the fastest way to see whether an old snapshot carries anything the newer checks
would refuse.
