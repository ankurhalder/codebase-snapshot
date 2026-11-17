# Remote repositories

```bash
npx -y codebase-snapshot generate --remote https://github.com/owner/repo
npx -y codebase-snapshot generate --remote https://github.com/owner/repo --ref v2.1.0
GITHUB_TOKEN=... npx -y codebase-snapshot generate --remote https://github.com/owner/private
```

The snapshot is written where you ran the command, not inside the clone. The manifest records where
the tree came from:

```json
"source": {
  "url": "https://github.com/owner/repo",
  "host": "github.com",
  "owner": "owner",
  "repo": "repo",
  "ref": "main",
  "commit": "9f2c…",
  "fetchedAt": "2026-11-18T04:12:09.144Z"
}
```

The **commit** is the one that was cloned, not the one the URL points at today. A snapshot that names
a moving branch and no commit describes a tree nobody can fetch again; this one can be traced back.

## What it fetches

A shallow clone: `--depth 1`, one branch, no tags, no submodules, no Git LFS. A snapshot needs the
tree a reader would see, not the history. The clone lives in a temporary directory that is removed
when the command exits; `--keep-clone` keeps it and prints the path.

## What it refuses

| Refused | Why |
| :--- | :--- |
| `http://` and other schemes | The URL decides which machine this process talks to. |
| URLs with a username or password | Credentials in a URL end up in argv, shell history and logs. Use `GITHUB_TOKEN`. |
| Loopback, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (cloud metadata), CGNAT, `fe80::/10`, `fc00::/7` | A repository URL must not become a way to read the local network. |
| A host that resolves to any private address | DNS is checked after the literal check, because `repo.example.com` can point at 127.0.0.1. |
| A clone larger than 1 GB | The scan is text; a checkout that large is not a snapshot anyone reads. |
| `file:` URLs | A local directory is not a remote. `--allow-private` is the explicit override, for air-gapped mirrors and tests. |

`--allow-private` exists because "I know what I am doing" is a real answer. It is not a default.

## Private repositories

Set `GITHUB_TOKEN` (or `GH_TOKEN`). The token is passed to git through the environment as an HTTP
header, never on the command line, and it never appears in the manifest, the reports or the brief.
The clone is shallow, so a token with `contents: read` is enough.

## The configuration of a fetched repository is not loaded

A clone may contain `snapshot.config.ts`, and a config can run code. A repository you just fetched
is not a repository you trust, so `--remote` always runs on the defaults — the same rule the MCP
server and the web UI follow. If you want the fetched project's config applied, clone it yourself,
read the config, and run the CLI there.
