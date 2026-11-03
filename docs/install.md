# Installation

`@ankurhalder/codebase-snapshot` is published to the public npm registry, so it installs with
**any** npm-compatible client. There is no second registry to add and nothing to configure.

Requires **Node.js 18 or newer**.

## One-off use

```bash
npx @ankurhalder/codebase-snapshot generate
```

This is the shortest path and needs no install. The command is also available as
`codebase-snapshot` and, once installed, as the short alias `snap`.

Pin the version when you need the same build on every machine:

```bash
npx @ankurhalder/codebase-snapshot@latest generate
npx @ankurhalder/codebase-snapshot@4 generate
```

**Why the bare name works.** npm resolves which binary to run from the package's `bin`
entries. This package declares `codebase-snapshot` and `snap` pointing at the *same file*, so
npm treats them as aliases and can always resolve one. Keep them aliases: two *different*
executables under a scoped package name would make the bare form unresolvable.

If a command exits with no output at all, a stale global install is the usual cause — see
[Troubleshooting](#troubleshooting).

## Add to a project

```bash
npm install -D @ankurhalder/codebase-snapshot
yarn add -D @ankurhalder/codebase-snapshot        # yarn classic and Berry
pnpm add -D @ankurhalder/codebase-snapshot
bun add -d @ankurhalder/codebase-snapshot
```

Then run it through your client so the binary resolves from the project:

| Client | Run |
| :--- | :--- |
| npm | `npx codebase-snapshot generate` |
| yarn (classic and Berry) | `yarn codebase-snapshot generate` |
| pnpm | `pnpm exec codebase-snapshot generate` |
| bun | `bun run codebase-snapshot generate` |

`snap` works everywhere `codebase-snapshot` does. Adding it to `package.json` scripts is the
most reproducible option:

```json
{
  "scripts": {
    "snapshot": "codebase-snapshot generate",
    "snapshot:validate": "codebase-snapshot validate"
  }
}
```

`codebase-snapshot init` writes these entries for you.

## One-off runners for other clients

```bash
yarn dlx -p @ankurhalder/codebase-snapshot codebase-snapshot generate   # yarn Berry
pnpm dlx @ankurhalder/codebase-snapshot generate
bunx @ankurhalder/codebase-snapshot generate
```

## Agent skill

To make a repository discoverable by an AI agent — so it finds this tool without being told
it exists — run:

```bash
npx @ankurhalder/codebase-snapshot skill --install
```

That writes an `AGENTS.md` section, `.claude/skills/codebase-snapshot/SKILL.md` and
`.cursor/rules/codebase-snapshot.mdc`. Re-running only replaces its own marked block. See
[Using this with an AI agent](agent.md).

## Verified clients

Every client below installs the published package and runs it successfully; a CI matrix
enforces this on every pull request, so a change that breaks one fails the build rather than
a user's terminal.

| Client | Run installed binary with |
| :--- | :--- |
| npm 10–11 | `npx codebase-snapshot` |
| yarn classic 1.22 | `yarn codebase-snapshot` |
| yarn Berry 4.6 (`nodeLinker: pnp`) | `yarn codebase-snapshot` |
| pnpm 10 | `pnpm exec codebase-snapshot` |
| bun 1.4 | `bun run codebase-snapshot` |

Yarn Berry's default **strict PnP** works: there is no `node_modules` directory, and the
runtime `typescript` dependency still resolves through yarn's `.pnp.cjs` loader.

## Before scanning a repository you do not own

A `snapshot.config.ts`, `.js`, `.mjs` or `.cjs` in the target repository is **imported and
executed** when the tool runs there — that is what lets a config express a `RegExp` or a
`match` function. Pointing `--cwd` at a checkout you do not trust therefore runs its code.
`--no-config` ignores every config file and uses the built-in defaults plus the detected
preset, and JSON configs are parsed rather than executed. See
[the trust boundary](../SECURITY.md#trust-boundary).

## Global install

```bash
npm install -g @ankurhalder/codebase-snapshot
```

Convenient, but prefer pinning per project: snapshots are only reproducible if the generator
version is. A global install also shadows `npx` for this package — npm will run your global
copy instead of the published one, which is confusing when the two differ. That is exactly
the situation described under [Troubleshooting](#troubleshooting).

## Workspaces

The binary resolves from the workspace it is installed in. In a monorepo, install it in the
package that runs the snapshot (usually the root), or use a one-off runner
(`npx` / `pnpm dlx` / `yarn dlx` / `bunx`) which works from any subdirectory.

## Upgrading

```bash
npm install -D @ankurhalder/codebase-snapshot@latest
npx codebase-snapshot generate     # rewrite the snapshot with the new version
```

`manifest.generator.version` records which version produced a snapshot. Re-run `generate`
after an upgrade so the snapshot, and the version it records, match the build you are now
running.

A snapshot written by **3.0.0 or earlier** is refused rather than replaced: its
`.codebase-snapshot` marker has no per-snapshot id, so the current build cannot prove it wrote
the directory. Delete the old snapshot directory and generate again.

See [CHANGELOG](../CHANGELOG.md) for breaking changes — 3.0.0 removed nothing, but it briefly
did in error; 4.0.0 restored the `snap` alias.

## Uninstalling

Standard for your client (`npm uninstall`, `yarn remove`, `pnpm remove`, `bun remove`).
Snapshots already written to the output directory are ordinary files and are left alone.
If you installed globally, `npm rm -g @ankurhalder/codebase-snapshot` also removes the
shim that shadows `npx`.

## Troubleshooting

**`codebase-snapshot: command not found`** — when installed locally (not globally) the binary
lives in `node_modules/.bin` and is only on `PATH` inside a package script or a client
runner. Use `npx codebase-snapshot`, `pnpm exec codebase-snapshot`,
`yarn codebase-snapshot` or `bun run codebase-snapshot`.

**A command exits 0 and prints nothing** — almost always a stale **global** install
shadowing `npx`. Check and remove it:

```bash
npm ls -g --depth=0 | grep codebase-snapshot
npm rm -g @ankurhalder/codebase-snapshot
```

Then re-run. If the package is not installed globally, clear the npx cache
(`npm cache clean --force`) and retry.

**`Cannot find module 'typescript'`** — the package declares `typescript` as a runtime
dependency for AST analysis. If your client prunes it (some `--ignore-scripts` CI setups do),
rerun a clean install or pin `typescript@^5` yourself.

**`yarn codebase-snapshot` prints extra lines / breaks a script** — yarn classic wraps
everything: it echoes `yarn run 1.22.x`, the resolved command, your output, then
`Done in 0.37s.`. For anything that parses the output, call the binary directly
(`./node_modules/.bin/codebase-snapshot` or `npx codebase-snapshot`).

More symptoms — refusals, config errors, drift, missing files — are in
[Troubleshooting](troubleshooting.md).
