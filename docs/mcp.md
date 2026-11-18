# Run codebase-snapshot as an MCP server

`codebase-snapshot mcp` serves a repository to any [Model Context Protocol](https://modelcontextprotocol.io)
client over stdio. It is one command, no configuration, and it is the snapshot — not a directory
walk — that the client sees.

> Available from **0.9.4**. Run `npx codebase-snapshot --version` before wiring a client; anything
> older does not have the `mcp` command.

## Start it

```bash
npx -y codebase-snapshot@0.12.99 mcp
```

The server serves the directory it was started in. `--cwd <path>` points it elsewhere, and that
directory is the only one it will read.

A client needs two things: the command `npx` and the arguments above. The surrounding
configuration shape belongs to the client — the example below is the `mcpServers` form used by
Claude Desktop and Cursor:

```json
{
  "mcpServers": {
    "codebase-snapshot": {
      "command": "npx",
      "args": ["-y", "codebase-snapshot@0.12.99", "mcp", "--cwd", "/absolute/path/to/repo"]
    }
  }
}
```

Claude Code registers the same thing from a shell:

```bash
claude mcp add codebase-snapshot -- npx -y codebase-snapshot@0.12.99 mcp --cwd /absolute/path/to/repo
```

On Windows, wrap the command as `cmd /c npx` with the same arguments — `npx` is a `.cmd` shim
there, and clients that spawn without a shell cannot execute it directly.

## Over HTTP, for clients that cannot spawn a process

```bash
npx -y codebase-snapshot@0.12.99 mcp --http --port 4789
```

This is the Streamable HTTP shape: POST one JSON-RPC message (or an array) to `/mcp` and read
the JSON-RPC answer from the response body. `GET /healthz` answers `{ ok, name, version, tools, uptimeSeconds }`, without a token.

The first run prints the URL and a generated bearer token:

```text
MCP over HTTP: http://127.0.0.1:4789/mcp
  Authorization: Bearer <generated>
```

Send `Authorization: Bearer <token>` with every request. `--token` picks your own; `--no-auth`
turns the requirement off and is **refused** on a non-loopback bind, because a repository
reachable from the network must not be readable by any page that guesses the port.

| Flag | Default | What it does |
| :--- | :--- | :--- |
| `--http` | off | HTTP instead of stdio |
| `--port <n>` | `4789` | Port; `0` picks a free one and prints it |
| `--host <addr>` | `127.0.0.1` | Bind address |
| `--token <value>` | generated | Bearer token |
| `--no-auth` | off | Unauthenticated; loopback only |
| `--allow-origin <list>` | unset | Extra CORS origins, comma separated |

CORS is granted to loopback origins (`localhost`, `127.0.0.1`, `[::1]`, any port) and to the
origins you list. Any other `Origin` gets `403`.

### Legacy SSE, for clients that cannot send a header

`GET /sse` opens an event stream and announces its message endpoint:

```text
event: endpoint
data: /messages?sessionId=<id>
```

The client POSTs JSON-RPC to that path, receives `202`, and reads the answer as a `message`
event on the open stream. This exists for browsers and older clients where `EventSource` cannot
set `Authorization`; the token may travel as `?token=` **on this path only**, which is a leak
into logs and is documented as such. A heartbeat every 15 s keeps the connection alive, and
shutdown ends the streams rather than waiting on them. Request bodies are capped at 2 MB, the rate is
capped at 60 requests per 10 seconds per address, and every response is one bounded JSON document.

## The 24 tools

Each tool has an entry with a ready-to-send call in the [tool reference](tools.md).


Every tool states its cost class in `tools/list` as `_meta["codebase-snapshot/cost"]`: `cheap`
reads the manifest, `medium` reads one or a few parts, `expensive` reads the repository or writes.
Two tools that answer the same question can differ by an order of magnitude, and a client choosing
between them should not have to guess.

| Tool | Answers | Writes |
| :-- | :-- | :-- |
| `snapshot_status` | Is there a snapshot, when was it built, what does it cover? | no |
| `snapshot_health` | Does the written snapshot match its manifest, carry any secret or host path, and cost what it claims? `maxScanBytes` bounds the text scan. | no |
| `snapshot_query` | Filter the index by layer, kind, path pattern or symbol | no |
| `snapshot_history` | The commits the snapshot was built from (reads `reports/log.md`) | no |
| `snapshot_tests` | The tests that import a file (or every test and what it covers) | no |
| `snapshot_workspace` | The members of a multi-repository workspace and the imports that cross between them | no |
| `snapshot_entrypoints` | The files a reader should start from, manifests first | no |
| `snapshot_neighbors` | Both import directions for one path | no |
| `snapshot_routes` | Route handlers recorded by the summaries, with their files | no |
| `snapshot_cycles` | Strongly connected components in the import graph | no |
| `snapshot_stats` | Files by layer and kind, part sizes, token estimate, heaviest files | no |
| `snapshot_search` | Case-insensitive text search across the emitted parts, bounded and redaction-safe | no |
| `snapshot_review` | Currency, health and bounded bodies in one call, so a review can start | no |
| `snapshot_symbol` | Where a function, class or constant is defined, with a window and a line number | no |
| `snapshot_diff_context` | Bodies of the changed files plus the files that import them | no |
| `snapshot_context` | One bounded context block from named files or symbols, read from the snapshot | no |
| `snapshot_plan_for` | Given a question and a token budget, the smallest set of files that answer it, in reading order | no |
| `snapshot_plan` | What would a generate at this budget include, and what would it leave out? | no |
| `snapshot_generate` | Build it. Accepts `includeDiffs`, `includeLogs`, `tokenTree` and `stripComments`, so a client can ask for the opt-in reports the CLI has. | yes |
| `snapshot_validate` | Is the context the agent was given still current? | no |
| `snapshot_locate` | Which part holds this symbol, route or file? | no |
| `snapshot_dependents` | What does this file import, and what imports it? | no |
| `snapshot_read` | A window of one file, as the snapshot contains it. | no |
| `snapshot_explain` | Why is this path not in the snapshot? | no |

Seven are declared `readOnlyHint`, which most clients use to run them without asking. Only
`snapshot_generate` prompts.

All eight take `outDir`, so a snapshot generated into a directory other than the configured one is
still reachable: pass the same value to the read side that you passed to `snapshot_generate`. Before
that, only `snapshot_generate` honoured it and every other tool looked in the configured directory
and reported "there is no snapshot manifest here".

An `outDir` **tool argument** must resolve inside the repository the server serves: a prompt cannot
drop a snapshot tree anywhere the process is able to write. The project's *configured* `outDir` is
not confined the same way — that is the repository's own decision, and a config may legitimately
point one directory up. If the argument escapes, the tool refuses and the message says to restart
the server with `--cwd` pointing at the repository you want to write.

`snapshot_plan`, `snapshot_generate`, `snapshot_validate` and `snapshot_explain` also take the
**scope and compression** switches `generate` accepts: `maxPartTokens`, `skeleton`, `sarif`,
`changedSince`, `staged` and `withDependents`. They have to: `manifest.config.digest` covers those
settings, so a snapshot generated with `--skeleton` was not merely un-inspectable over MCP, it was
reported as configuration drift on every `snapshot_validate`. Pass the same switches you generated
with, exactly as you would on the command line. The four remaining tools do not take them, because
none of them re-derives the configuration and a flag that changes nothing is the command-line form
of a silent fallback.

`includeSensitiveFiles` is deliberately absent from every one of them. A prompt can ask for
anything, and a tool that emits `.env` on request is a secret-exfiltration primitive with a
friendly name.

`snapshot_locate` is the one that makes the others usable: a twelve-part snapshot is hundreds of
kilobytes, and asking "which part holds authentication?" is cheaper than reading all twelve. It
searches the manifest's index — file paths, exported symbols, component names, routes, layers and
kinds — and returns the part each match lives in.

`snapshot_read` is windowed on purpose. It defaults to 200 lines and reports `nextFromLine` when
more remains, so an agent continues deliberately instead of pulling a whole part into a context
window it has not budgeted. A single line longer than one result can carry is the exception: the
page ends mid-line, `pageable` is `false` and `reason` says so, because advancing `fromLine` would
silently skip the rest of that line.

At most four requests run at once. A fifth gets a JSON-RPC `overloaded` error (`-32001`) naming
the limit instead of being queued silently or dropped, so a client can retry and `snapshot_status`
stays responsive.

## Resources

Resources are the browse surface; tools are the act surface.

The first four rows are always listed. The report resources are listed only when the run wrote
the file — a resource in `resources/list` has to be readable — and `describe --format json`
publishes them separately as `reportResources`.

| URI | Contents |
| :-- | :-- |
| `snapshot://manifest` | Every included file with layer, kind, part and hash, every skip reason, and `incomplete[]` — the files whose body is not the whole file, with their missing line ranges |
| `snapshot://parts/{index}` | One budgeted part, by 1-based index |
| `snapshot://reports/audit` | Secret findings, large files, parse diagnostics |
| `snapshot://reports/tree` | The directory tree of included files |
| `snapshot://reports/navigation` | File-to-part lookup |
| `snapshot://reports/diff` | `reports/diff.md`, when the snapshot was generated with `--include-diffs` |
| `snapshot://reports/log` | `reports/log.md`, when generated with `--include-logs` |
| `snapshot://reports/tokens` | `reports/tokens.md`, when generated with `--token-tree` |
| `snapshot://prompt` | `PROMPT.md` — the brief: the job, what the snapshot contains and omits, the history it was built from, and the owner half when a `brief` is configured |
| `snapshot://contract` | The machine-readable CLI contract |
| `snapshot://skill` | The agent skill, as one read |

A resource read is **all-or-nothing**. Above the 512 kB single-read limit the read fails with
JSON-RPC error `-32000` (the implementation-defined server-error range) and
`data: { uri, bytes, limit }`; the message says what to use instead — `snapshot_locate`,
`snapshot_read` or `snapshot_status` for a manifest or part, the file on disk for a report, and
the CLI for the contract or the skill. It never returns a truncated document: half a JSON manifest
does not parse, and half a part is a fragment that looks complete. The rule applies to every
resource — `snapshot://manifest`, each `snapshot://parts/{index}`, the three reports,
`snapshot://prompt`, `snapshot://contract` and `snapshot://skill`.

A URI this build serves but this snapshot does not contain — `snapshot://prompt` when the prompt
artifact was disabled, a report when that artifact was — is answered with `-32002` (resource not
found) and a message naming the artifact and the cause. An unknown URI is still "Unknown resource":
the two are different mistakes and a client should be able to tell them apart.

Part resources carry their size in the description, so a client choosing between them can see that
one is 300 kB before attaching it; a part above the limit says in its description that it will be
refused rather than truncated.

## Prompts

Seven. Two are about order of operations, five are a job:

| Prompt | What it does |
| :--- | :--- |
| `orient` | Map the repository before anything is read. |
| `keep-current` | Validate before trusting earlier context, and again after changes. |
| `audit` | Health, drift, exclusions, and the findings that matter — evidence, not impressions. |
| `review` | Plan the reading for a change, read it, name the dependents and risks. |
| `explain` | Why a path is in the snapshot, what it does, who depends on it. |
| `onboard` | A guided tour with a reading order for someone who has never seen the repository. |
| `security-review` | Authentication, authorization, secrets and injection, plus what the snapshot cannot see. |

Every tool a prompt names is a tool the server serves; a test holds the two lists together.

## Progress, and what cancellation does not do

A client that sends `progressToken` in `tools/call` `_meta` receives `notifications/progress` while
a long call runs — `snapshot_generate` reports "generating" and "writing the snapshot" with a
2-step total. The notifications are coarse by design: the worker that does the generation posts a
summary, not a stream of phases, and inventing finer numbers would be a progress bar that lies.

`notifications/cancelled` now stops the work that can be stopped. `snapshot_generate` terminates
its worker and answers with "The generation was cancelled."; the partially written directory is
removed by the generator's own staging rules, so a cancelled run leaves no snapshot claiming to be
complete. Other tools finish before they can notice — they are bounded and fast — and the response
says what happened rather than pretending the call never ran.

## What it will not do

- **Read outside its root.** `--cwd` is the only directory that is readable, and it is the only
  knob that changes it — the command has no `--root` option, only the `root` tool argument. A
  `root` argument may name the served directory or a sub-directory of it; anything else is refused
  with a message saying to restart the server with `--cwd <directory>`. Symlinks are resolved
  before the check.
- **Emit a sensitive file.** `.env`, `*.pem` and the rest stay out, and `includeSensitiveFiles` is
  not a tool argument — a prompt cannot ask for it. Reads come from the emitted snapshot, so
  redaction applies to everything the client sees.
- **Install or configure.** `snapshot_generate` writes the snapshot directory and nothing else. It
  never runs a package manager and never writes a config file.
- **Touch the network.** The stdio server makes no outbound connection. `--http` binds a loopback
  port and answers requests; it still contacts nothing. Module configs (`.mjs`, `.cjs`, `.ts`) are refused: importing one would run repository
  code with the user's privileges, so the server accepts only JSON configuration. The CLI still
  loads a module config, because there the user invoked the repository's own command.

## Both protocol eras

Revision `2026-07-28` removed the handshake that every client in use today still performs. The
server speaks both and answers whichever arrives first.

| Era | Revisions | Opening move |
| :-- | :-- | :-- |
| Legacy | `2025-11-25`, `2025-06-18` | `initialize`, then `notifications/initialized` |
| Modern | `2026-07-28` | `server/discover`, or `_meta` on every request |

The two disagree about an unsupported version, and the difference is observable: a legacy client is
negotiated *down* to a revision the server speaks, while a modern client receives `-32022` with the
list of supported revisions so it can retry.

## Why there is no SDK

`@modelcontextprotocol/sdk` is 4.5 MB unpacked and brings Express, Hono, Ajv, JOSE and Zod with it.
The transport here is newline-delimited JSON-RPC, which is roughly 400 lines of readable code, and
the package's only runtime dependency remains `typescript`. The parity test — a live `tools/list`
compared against `describe --format json` — is what keeps the protocol implementation honest, not
the presence of a library.

## Performance

Generation runs in a worker thread, so the server keeps answering `ping` and acknowledging
`notifications/cancelled` while the snapshot is written. Admission is bounded to four concurrent
requests, so a flood of `snapshot_generate` calls cannot spawn an unbounded number of workers over
the same repository. The numbers below are measured, not estimated:

| Repository | Files | `snapshot_generate` |
| :-- | --: | --: |
| This project | 127 | 1.1 s |
| A synthetic tree | 3,000 | 7.5 s |

They describe how long the *write* takes, not how long the server is deaf — which is the
distinction a client's request timeout actually cares about. `snapshot_plan` produces the same
numbers without writing anything.

The worker re-reads the configuration and applies the same options this thread used, because a
resolved config cannot cross a thread boundary: `layers[].match` may be a function and
`hooks.afterGenerate` always is. That also means `hooks.afterGenerate` does **not** run for a
generation started from MCP — a CLI `generate` runs it. If a hook is part of your pipeline, run
the CLI.

## Troubleshooting

**The client lists no tools.** The server writes JSON-RPC to stdout and nothing else; every note goes
to stderr. Check the client's server log — the first line says which directory is being served.

**`Unknown tool` or a missing command.** The published version is older than 0.9.4. Pin the exact
version in the client arguments.

**`Unknown resource` for a part.** Resources are computed from the manifest, so nothing but the
static set exists before the first generate. Call `snapshot_status`, then `snapshot_generate`.

**A resource read fails with `-32000`.** The resource is larger than the 512 kB single-read limit;
it was refused rather than truncated. `data.uri`, `data.bytes` and `data.limit` say which resource
and by how much. Use `snapshot_locate` then `snapshot_read` for a part, or read the file straight
from the snapshot directory for the manifest or a report.

**A file is missing from `snapshot_locate`.** It is excluded, and `snapshot_explain` will name the
reason — an ignore rule, the preset, a sensitive-file pattern, or your own config.
