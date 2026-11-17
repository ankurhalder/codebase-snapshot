# In the browser: `serve`

```bash
npx -y codebase-snapshot serve
```

Open the printed URL. The page has one job: take a repository, show you the snapshot it produced,
and hand you the zip.

```text
Serving http://127.0.0.1:4788/
  MCP endpoint: http://127.0.0.1:4788/mcp
  Token: <generated>
  Open the page and paste the token once; it is kept in this browser only.
```

## What it does

1. **Choose a mode.** *Whole repository* is the default. *A slice for a question* runs the
   retrieval planner at generate time and asks for the question. *Fit a token budget* selects whole
   files to fit the number you give. The result line reports how many paths were not selected.
2. **Generate.** Paste an absolute path or a public repository URL and press Generate. A URL is
   cloned shallowly into a temporary directory (removed when the server exits) with the same
   provenance record the CLI writes. The page calls the same
   `generateSnapshot` the CLI calls, with the default settings — the defaults are what a browser
   session can honestly promise, because a config file can run code and this process will not run
   repository code on a page's request. For a project config, use the CLI.
3. **Preview.** The brief (`PROMPT.md`) and the file list come back from the written snapshot, not
   from the working tree. If the snapshot is wrong, the page shows the wrongness.
4. **Download.** The zip is the snapshot directory, stored entries, no compression — the same bytes
   the agent would read.

## The token

The page is HTML and is served without a token; everything that reads or writes a repository needs
`Authorization: Bearer <token>`. The page asks for the token and keeps it in `localStorage`, so
serving `/` can never leak the credential. `--token` chooses one; `--no-auth` turns the requirement
off and is refused on a non-loopback bind.

## The same process serves MCP

`POST /mcp` on the same port is the MCP endpoint from [MCP](mcp.md), with the same token. A browser
agent and a human look at the same snapshot.

## Limits, stated

| Limit | Value | Why |
| :--- | :--- | :--- |
| Bind | `127.0.0.1` | A repository on the network is a decision, not a default. |
| Request body | 64 KiB (API), 2 MiB (MCP) | A page cannot post a file at the server. |
| Brief preview | first 64 KiB of `PROMPT.md` | Bounded response, always. |
| File list | first 400 files in the page | The JSON carries every file; the page renders a window. |
| CORS | loopback origins only | A page on another origin cannot read the repository. |
| Remote URLs | https, public addresses only | The same shallow clone and SSRF guard as `generate --remote`; `serve --allow-private` opts out deliberately. |

It writes nothing except the snapshot the Generate button asks for, and it never reads outside the
path you typed.
