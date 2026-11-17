# Run it as a service

Two shapes: a container for an MCP endpoint and the browser page, and a plain process under systemd
for a CLI that runs on a schedule.

## Container

```bash
npm run build                       # the image copies dist/, it does not build it
docker build -t codebase-snapshot .
docker run --rm -p 4788:4788 -e SNAPSHOT_TOKEN=change-me codebase-snapshot
```

The entrypoint **refuses to start without `SNAPSHOT_TOKEN`**: `serve` on `0.0.0.0` without a token
would expose the repository to anything that can reach the port. Inside the container the process
runs as the `node` user, listens on `PORT` (default 4788), and serves:

| Path | What |
| :--- | :--- |
| `GET /` | The page: generate, preview, download the zip |
| `GET /healthz` | `{ ok, name, tools }` |
| `POST /mcp` | MCP over Streamable HTTP |
| `GET /sse`, `POST /messages` | Legacy SSE transport |

### Compose

```yaml
services:
  snapshot:
    build: .
    ports: ["4788:4788"]
    environment:
      SNAPSHOT_TOKEN: change-me
      PORT: "4788"
    read_only: true
    tmpfs: ["/tmp"]
    security_opt: ["no-new-privileges:true"]
```

The page generates **into the container**, which is ephemeral. Mount a volume and paste that path
into the page if the snapshot needs to outlive the container:

```yaml
    volumes: ["snapshot-data:/data"]
```

### What the image is not

- It is not published to a registry by this repository. Build it where you need it; a public image
  would need a signing and tagging policy that does not exist yet.
- It is not a sandbox. It reads the repository you give it with the permissions of the `node` user.

## systemd, for a schedule

```ini
[Unit]
Description=codebase-snapshot refresh
After=network.target

[Service]
Type=oneshot
User=deploy
WorkingDirectory=/srv/app
ExecStart=/usr/bin/npx -y codebase-snapshot@0.12.64 generate --cwd /srv/app
ExecStartPost=/usr/bin/npx -y codebase-snapshot@0.12.64 validate --cwd /srv/app
```

```ini
[Timer]
OnCalendar=hourly
Persistent=true
```

`validate` exits 1 on drift, so a unit that runs it after `generate` fails when the regeneration did
not produce a current snapshot — a gate, not a log line.
