# Run codebase-snapshot as an MCP server

`codebase-snapshot mcp` serves a repository to any [Model Context Protocol](https://modelcontextprotocol.io)
client over stdio. It is one command, no configuration, and it is the snapshot — not a directory
walk — that the client sees.

> Available from **0.9.4**. Run `npx codebase-snapshot --version` before wiring a client; anything
> older does not have the `mcp` command.

## Start it

```bash
npx -y codebase-snapshot@0.9.6 mcp
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
      "args": ["-y", "codebase-snapshot@0.9.6", "mcp", "--cwd", "/absolute/path/to/repo"]
    }
  }
}
```

Claude Code registers the same thing from a shell:

```bash
claude mcp add codebase-snapshot -- npx -y codebase-snapshot@0.9.6 mcp --cwd /absolute/path/to/repo
```

On Windows, wrap the command as `cmd /c npx` with the same arguments — `npx` is a `.cmd` shim
there, and clients that spawn without a shell cannot execute it directly.

## The seven tools

| Tool | Answers | Writes |
| :-- | :-- | :-- |
| `snapshot_status` | Is there a snapshot, when was it built, what does it cover? | no |
| `snapshot_plan` | What would a generate at this budget include, and what would it leave out? | no |
| `snapshot_generate` | Build it. | yes |
| `snapshot_validate` | Is the context the agent was given still current? | no |
| `snapshot_locate` | Which part holds this symbol, route or file? | no |
| `snapshot_read` | A window of one file, as the snapshot contains it. | no |
| `snapshot_explain` | Why is this path not in the snapshot? | no |

Six are declared `readOnlyHint`, which most clients use to run them without asking. Only
`snapshot_generate` prompts.

`snapshot_locate` is the one that makes the others usable: a twelve-part snapshot is hundreds of
kilobytes, and asking "which part holds authentication?" is cheaper than reading all twelve. It
searches the manifest's index — file paths, exported symbols, component names, routes, layers and
kinds — and returns the part each match lives in.

`snapshot_read` is windowed on purpose. It defaults to 200 lines and reports `nextFromLine` when
more remains, so an agent continues deliberately instead of pulling a whole part into a context
window it has not budgeted.

## Resources

Resources are the browse surface; tools are the act surface.

| URI | Contents |
| :-- | :-- |
| `snapshot://manifest` | Every included file with layer, kind, part and hash, plus every skip reason |
| `snapshot://parts/{index}` | One budgeted part, by 1-based index |
| `snapshot://reports/audit` | Secret findings, large files, parse diagnostics |
| `snapshot://reports/tree` | The directory tree of included files |
| `snapshot://reports/navigation` | File-to-part lookup |
| `snapshot://contract` | The machine-readable CLI contract |
| `snapshot://skill` | The agent skill, as one read |

Part resources carry their size in the description, so a client choosing between them can see that
one is 300 kB before attaching it.

## Prompts

Two, both about order of operations rather than features: `orient` maps the repository before
anything is read, and `keep-current` validates before trusting earlier context and again after
making changes.

## What it will not do

- **Read outside its root.** `--cwd` is the only directory that is readable. A `root` argument can
  name a sub-directory of it and nothing else; symlinks are resolved before the check.
- **Emit a sensitive file.** `.env`, `*.pem` and the rest stay out, and `includeSensitiveFiles` is
  not a tool argument — a prompt cannot ask for it. Reads come from the emitted snapshot, so
  redaction applies to everything the client sees.
- **Install or configure.** `snapshot_generate` writes the snapshot directory and nothing else. It
  never runs a package manager and never writes a config file.
- **Touch the network.** The server makes no outbound connections, and there is no HTTP transport.

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

Generation is synchronous, so a tool call blocks the server for its duration. Both numbers are
measured, not estimated:

| Repository | Files | `snapshot_generate` |
| :-- | --: | --: |
| This project | 127 | 1.1 s |
| A synthetic tree | 3,000 | 7.5 s |

Both are under any client's request timeout. If a repository large enough to exceed yours shows up,
`snapshot_plan` gives the same numbers without writing, and the fix — moving generation to a worker
thread — is tracked rather than assumed.

## Troubleshooting

**The client lists no tools.** The server writes JSON-RPC to stdout and nothing else; every note goes
to stderr. Check the client's server log — the first line says which directory is being served.

**`Unknown tool` or a missing command.** The published version is older than 0.9.4. Pin the exact
version in the client arguments.

**`Unknown resource` for a part.** Resources are computed from the manifest, so nothing but the
static set exists before the first generate. Call `snapshot_status`, then `snapshot_generate`.

**A file is missing from `snapshot_locate`.** It is excluded, and `snapshot_explain` will name the
reason — an ignore rule, the preset, a sensitive-file pattern, or your own config.
