# Workspaces: many repos, one pack

```bash
codebase-snapshot generate --workspace api,web,shared --out-dir context
```

A monorepo is rarely one repository in practice: `api`, `web` and `shared` have different
dependencies, different languages and different reasons to be read. This writes **one snapshot per
member** and an index that ties them together, so a reader gets the same guarantees per member
without one part budget stretched across everything.

## What it writes

```text
context/
├── WORKSPACE.json          the index: one record per member
├── api/                    a complete snapshot of ./api
│   ├── manifest.json
│   ├── PROMPT.md
│   └── parts/…
├── web/
└── shared/
```

```json
{
  "generatedAt": "2026-11-18T05:02:11.402Z",
  "generator": "0.12.38",
  "members": [
    { "name": "api", "path": "/repo/api", "fingerprint": "9f2c…", "files": 412, "parts": 6, "tokens": 184220 },
    { "name": "web", "path": "/repo/web", "fingerprint": "1a77…", "files": 208, "parts": 3, "tokens": 96110 }
  ],
  "links": [
    { "from": "web", "to": "shared", "specifiers": 14, "examples": ["src/api/client.ts"] }
  ]
}
```

Each member directory is a normal snapshot, but it lives under the workspace output directory, so
point the commands at it explicitly:

```bash
codebase-snapshot validate --cwd api --out-dir ../context/api
codebase-snapshot health   --cwd api --out-dir ../context/api
```

The MCP server reads a repository and its own `outDir`; run it from `api` with that output
directory configured if the member should be served on its own.

## Rules

- **Defaults, not member configs.** A member may contain a `snapshot.config.ts`, and a config can run
  code. A workspace is a set of repositories the caller named, not one they configured, so members
  are generated on the defaults. Run the member directly if its config should apply.
- **A failure is reported, not skipped.** A missing member prints its name and the run exits `1`
  after writing the members that succeeded, so a partial workspace is never mistaken for a complete
  one.
- **No combination.** `--workspace` is refused with `--remote`, `--delta`, `--slice`,
  `--budget-tokens` and `--sign`: each of those narrows or signs *one* snapshot, and a workspace is
  several.
- **Names come from the directories.** `--workspace a/api,b/api` would collide; use paths whose last
  segment is unique.
- **Cross-member imports are recorded, not judged.** A relative import in one member that resolves
  inside another is written as a link in `WORKSPACE.json` with the specifier count and a few
  example paths. It is a static link from the specifier text: it says the members are coupled, not
  that the target file is present in the other member's snapshot.

## Why not one merged snapshot

A merged snapshot invents paths (`api/src/…`) that no file has, and one budget across members lets a
large member starve a small one. Per-member snapshots keep the paths real and the budgets local;
`WORKSPACE.json` is the only place that needs to know they belong together.

