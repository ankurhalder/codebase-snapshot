# create-codebase-snapshot

Sets up [`codebase-snapshot`](https://www.npmjs.com/package/codebase-snapshot)
in the current repository.

```bash
npm create codebase-snapshot
```

It detects the project type, asks a handful of questions with sensible defaults,
and writes the config file this project can actually load — `snapshot.config.ts`
for an ES-module project on Node ≥ 22.6, `snapshot.config.mjs` everywhere else —
listing **every setting at its default**, so the config doubles as the
documentation.

```bash
npm create codebase-snapshot -- --preset react-vite --yes
```

| Option | Effect |
| :--- | :--- |
| `--preset <name>` | Force a project preset instead of detecting one |
| `--yes` | Accept every default without prompting |
| `--force` | Overwrite an existing config |

## What it writes

| Path | Notes |
| :--- | :--- |
| `snapshot.config.ts` / `snapshot.config.mjs` | Every setting at its default. `.ts` needs an ES-module `package.json` and Node ≥ 22.6; `.mjs` is used otherwise, because a `.ts` config is loaded with the enclosing package's module type. |
| `package.json` → `scripts.snapshot`, `scripts.snapshot:validate` | Skipped when there is no `package.json` to hold them. |
| `package.json` → `devDependencies` | `codebase-snapshot` at the version this scaffolder shipped with. A range you already declared is never overwritten. |
| `.gitignore` | `snapshot/`, `snapshot.tmp/`. |

The generated scripts run `npx codebase-snapshot …`, and `npx` uses the
local `devDependencies` copy when there is one — so the version is pinned by your
lockfile instead of drifting to `@latest`. Until you run `npm install`, `npx` would
fall back to downloading the newest release, which is why the printed next step is
`npm install && npm run snapshot`. Nothing is installed, and no network is used,
while scaffolding.

Without a `package.json` the scripts cannot be added, and the printed next step is
`npx codebase-snapshot generate` instead.

This package is a shim: the wizard itself lives in the main package, so
`npx codebase-snapshot init` does exactly the same thing.
