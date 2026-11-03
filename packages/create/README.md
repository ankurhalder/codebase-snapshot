# create-codebase-snapshot

Sets up [`@ankurhalder/codebase-snapshot`](https://www.npmjs.com/package/@ankurhalder/codebase-snapshot)
in the current repository.

```bash
npm create codebase-snapshot
```

It detects the project type, asks a handful of questions with sensible defaults,
and writes a `snapshot.config.mjs` that lists **every setting at its default** —
so the config doubles as the documentation.

```bash
npm create codebase-snapshot -- --preset react-vite --yes
```

| Option | Effect |
| :--- | :--- |
| `--preset <name>` | Force a project preset instead of detecting one |
| `--yes` | Accept every default without prompting |
| `--minimal` | Write only the settings that differ from defaults |
| `--force` | Overwrite an existing config |

This package is a shim: the wizard itself lives in the main package, so
`npx @ankurhalder/codebase-snapshot init` does exactly the same thing.
