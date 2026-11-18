# MCP tools

The server exposes 26 tools. This page is the reference: what each answers, what it costs, and one
call you can send as it stands. [MCP](mcp.md) covers the transports and the protocol; this page is
the catalogue.

Every tool is read-only unless it says **writes**. Cost is the class `tools/list` publishes as
`_meta["codebase-snapshot/cost"]`: **cheap** reads the manifest, **medium** reads one or a few parts,
**expensive** reads the repository or writes it.

## Orientation

- **`snapshot_status`** — cheap, read-only. Is there a snapshot, when was it built, what does it
  cover, what is stale?
  ```json
  { "name": "snapshot_status", "arguments": {} }
  ```
- **`snapshot_explain`** — cheap, read-only. Why is a path in or out of the snapshot? Reads the
  manifest, so a `--slice` drop is reported as `not-selected` with the run's detail.
  ```json
  { "name": "snapshot_explain", "arguments": { "path": "src/index.ts" } }
  ```
- **`snapshot_entrypoints`** — cheap, read-only. The files a reader should start from: manifests
  first, then `index`/`main`/`app`/`server`/`cli`, with importer counts.
  ```json
  { "name": "snapshot_entrypoints", "arguments": {} }
  ```
- **`snapshot_stats`** — cheap, read-only. Files by layer and kind, part sizes, token estimate,
  heaviest files.
  ```json
  { "name": "snapshot_stats", "arguments": {} }
  ```
- **`snapshot_workspace`** — cheap, read-only. Members of a multi-repository workspace and the
  imports that cross between them, from `WORKSPACE.json`.
  ```json
  { "name": "snapshot_workspace", "arguments": {} }
  ```

## Finding things

- **`snapshot_search`** — medium, read-only. Literal or regular-expression search over every part,
  with the file and part for each hit. Stops at 4 MB of text and says so.
  ```json
  { "name": "snapshot_search", "arguments": { "query": "partitionFiles", "regex": false } }
  ```
- **`snapshot_query`** — cheap, read-only. Filter the index by layer, kind, path pattern, symbol or
  test status; no part is read.
  ```json
  { "name": "snapshot_query", "arguments": { "layer": "src", "symbol": "plan" } }
  ```
- **`snapshot_locate`** — cheap, read-only. Which part holds a path or symbol, and where in it.
  ```json
  { "name": "snapshot_locate", "arguments": { "query": "src/mcp/tools.ts", "by": "path" } }
  ```
- **`snapshot_symbol`** — medium, read-only. A symbol by name: defining file, kind, signature,
  and — unless `references: false` — the call sites where the name appears, with line numbers.

  the exports that reference it.
  ```json
  { "name": "snapshot_symbol", "arguments": { "name": "generateSnapshot" } }
  ```
- **`snapshot_routes`** — cheap, read-only. Every route the summaries recorded, with file and part.
  ```json
  { "name": "snapshot_routes", "arguments": { "pattern": "users" } }
  ```

## Reading

- **`snapshot_answer`** — medium, read-only. One call from question to context: plans the
  question, then returns each chosen file as a head window with line numbers inside the token
  budget. Every file says why it is there; every planned file that did not fit says why not.
  ```json
  { "name": "snapshot_answer", "arguments": { "question": "how does redaction work", "maxTokens": 20000 } }
  ```
- **`snapshot_budget`** — medium, read-only. The planner at several budgets, with what each
  one adds: files, tokens used, and the paths gained over the previous budget. The answer to
  "should I raise the budget, and what would I get?"
  ```json
  { "name": "snapshot_budget", "arguments": { "budgets": [10000, 30000, 60000] } }
  ```
- **`snapshot_history`** — cheap, read-only. The commits behind the snapshot, from
  `reports/log.md`; says how to generate the report when it is absent.
  ```json
  { "name": "snapshot_history", "arguments": { "limit": 10 } }
  ```
- **`snapshot_tests`** — cheap, read-only. The test side of the graph: given a path, the tests
  that import it or are named after it; with no path, every test file and what it covers.
  ```json
  { "name": "snapshot_tests", "arguments": { "path": "src/mcp/tools.ts" } }
  ```
- **`snapshot_read`** — medium, read-only. A bounded window of one file: line range, or the whole
  body when it is small.
  ```json
  { "name": "snapshot_read", "arguments": { "path": "src/index.ts", "fromLine": 1, "lines": 80 } }
  ```
- **`snapshot_context`** — medium, read-only. Whole bodies for the files that fit a token budget, in
  the order the planner ranks them.
  ```json
  { "name": "snapshot_context", "arguments": { "files": ["src/mcp/retrieval.ts"], "maxTokens": 12000 } }
  ```

## The planner

- **`snapshot_plan_for`** — cheap, read-only. The plan for a question: which files fit a budget, why
  each was chosen, what did not fit. Matches stems (`charge`/`chargeCard`), follows imports and
  callers, prefers entry points.
  ```json
  { "name": "snapshot_plan_for", "arguments": { "question": "how does a snapshot get partitioned", "maxTokens": 20000 } }
  ```
- **`snapshot_plan`** — expensive, read-only. Would a generate succeed, and what would it include?
  Runs the real pipeline in a worker with nothing written.
  ```json
  { "name": "snapshot_plan", "arguments": {} }
  ```

## Reviewing a change

- **`snapshot_review`** — expensive, read-only. Is the snapshot current, what does the health audit
  say, what do the given paths contain, and which route methods do they touch?
  ```json
  { "name": "snapshot_review", "arguments": { "paths": ["src/mcp/tools.ts"] } }
  ```
- **`snapshot_diff_context`** — medium, read-only. A changed file's head plus the files that import
  it, within a token budget.
  ```json
  { "name": "snapshot_diff_context", "arguments": { "paths": ["src/mcp/tools.ts"], "maxTokens": 15000 } }
  ```
- **`snapshot_dependents`** — cheap, read-only. What imports this path, one or more hops out.
  ```json
  { "name": "snapshot_dependents", "arguments": { "path": "src/mcp/server.ts", "direction": "imported-by", "limit": 50 } }
  ```
- **`snapshot_neighbors`** — medium, read-only. Both directions of the import graph for one path.
  ```json
  { "name": "snapshot_neighbors", "arguments": { "path": "src/mcp/retrieval.ts" } }
  ```
- **`snapshot_cycles`** — medium, read-only. Strongly connected components: files that import each
  other in a loop.
  ```json
  { "name": "snapshot_cycles", "arguments": { "maxComponents": 10 } }
  ```

## Health and writing

- **`snapshot_health`** — expensive, read-only. The full audit: hashes, missing parts, secrets, host
  paths, token accounting, freshness, signature. Score out of 100, severities, failed check ids.
  ```json
  { "name": "snapshot_health", "arguments": { "maxScanBytes": 2000000 } }
  ```
- **`snapshot_generate`** — expensive, **writes**. Builds the snapshot in a worker. Accepts
  `includeDiffs`, `includeLogs`, `tokenTree`, `stripComments`, and reports progress and cancellation.
  ```json
  { "name": "snapshot_generate", "arguments": { "tokenTree": true, "pack": "xml" } }
  ```
  It can also narrow: `slice` with `sliceTokens`, or `budgetTokens` (not both — the tool refuses
  the pair, as the CLI does).
  ```json
  { "name": "snapshot_generate", "arguments": { "slice": "how is auth done", "sliceTokens": 20000 } }
  ```
- **`snapshot_validate`** — medium, read-only. Drift check: files changed or deleted since the
  snapshot, part hashes, bookkeeping. A selection snapshot is not second-guessed, and says so.
  ```json
  { "name": "snapshot_validate", "arguments": {} }
  ```

## Conventions these tools share

- Relative paths resolve against the repository the server was started for; `root` moves that for one
  call and is bounded by the roots the server allows.
- `outDir` names a snapshot directory other than the configured one; absent means the configured
  one.
- A tool that cannot answer says why in `text` and sets `isError`. It does not return an empty list
  that looks like a true negative — `snapshot_workspace` without a workspace index tells you to make
  one.
- Structured results are returned as `structuredContent` alongside the text, so a client can read
  the same answer either way.
