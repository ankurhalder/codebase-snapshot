# Installation

`codebase-snapshot` is published to the public npm registry, so it installs with
**any** npm-compatible client. There is no second registry to add and nothing to configure.

Requires **Node.js 18 or newer**.

## One command

```bash
npx codebase-snapshot --autopilot
```

Detects the project, writes the config (an existing one is kept), adds the npm scripts and the
devDependency, installs them with the package manager your lockfile names, and generates the first
snapshot. `--no-install` skips the install; `--dry-run` writes nothing. `setup` does the same as a
command word, and the bare `snapshot` (or `npx codebase-snapshot` with no arguments) does the
same after one question — see [the first run](#the-first-run). The sections below are the same
steps taken one at a time.

## The first run

With the package installed globally, the whole thing is one word:

```bash
snapshot
```

In a project with no configuration it names what it recognised and what it keyed on
(`Detected nextjs` / `Because next.config.ts`), then offers the recommended setup in one
keystroke or a walk through each setting with the defaults pre-filled. It writes the config,
adds the npm scripts and devDependency, installs, and generates.

In a project that already has a config — or one it has generated before — the same command just
generates, so nobody is walked through setup twice.

**It never guesses.** With no terminal (CI, a container, an agent) a first run exits `2` and
names the three ways forward instead of generating with settings nobody chose. `--autopilot` is
the answer for unattended use; naming the command (`npx codebase-snapshot generate`) is the
other, and it runs on the documented defaults exactly as before.

## One-off use

```bash
npx codebase-snapshot generate
```

This is the shortest path and needs no install.

Pin the version when you need the same build on every machine. `--version` prints the exact
string to pin:

```bash
npx codebase-snapshot@latest generate
npx codebase-snapshot --version
```

**Why the bare name works.** npm resolves which binary to run from the package's `bin`
entries. This package declares `codebase-snapshot` and `snapshot` pointing at the *same file*, so
npm treats them as aliases and can always resolve one. Keep them aliases: two *different*
executables under a scoped package name would make the bare form unresolvable.

If a command exits with no output at all, a stale global install is the usual cause — see
[Troubleshooting](#troubleshooting).

## Add to a project

```bash
npm install -D codebase-snapshot
yarn add -D codebase-snapshot        # yarn classic and Berry
pnpm add -D codebase-snapshot
bun add -d codebase-snapshot
```

Then run it through your client so the binary resolves from the project:

| Client | Run |
| :--- | :--- |
| npm | `npx codebase-snapshot generate` |
| yarn (classic and Berry) | `yarn codebase-snapshot generate` |
| pnpm | `pnpm exec codebase-snapshot generate` |
| bun | `bun run codebase-snapshot generate` |

`snapshot` works everywhere `codebase-snapshot` does — `npx snapshot` from a project dependency,
`pnpm exec snapshot`, `yarn snapshot`, and the bare word after a global install. Adding the script
to `package.json` is the most reproducible option:

```json
{
  "scripts": {
    "snapshot": "npx codebase-snapshot generate",
    "snapshot:validate": "npx codebase-snapshot validate"
  }
}
```

`codebase-snapshot init` writes these entries for you, in exactly this `npx` form: the bare
`codebase-snapshot` command only exists on `PATH` inside a client runner or a script that has
already resolved the package, and `init` does not assume the install has happened yet.

## One-off runners for other clients

```bash
yarn dlx -p codebase-snapshot codebase-snapshot generate   # yarn Berry
pnpm dlx codebase-snapshot generate
bunx codebase-snapshot generate
```

## Agent skill

To make a repository discoverable by an AI agent — so it finds this tool without being told
it exists — run:

```bash
npx codebase-snapshot skill --install
```

That writes `.claude/skills/codebase-snapshot/SKILL.md` and
`.cursor/rules/codebase-snapshot.mdc`, and adds both to `.gitignore` so the install leaves
nothing untracked. It does not touch `AGENTS.md`: that file is your project's own agent
contract. To put the skill there, print it and paste it —
`npx codebase-snapshot skill >> AGENTS.md`. See
[Using this with an AI agent](agent.md).

## Verified clients

Every client below installs the published package and runs it successfully. The automated gate
does not reinstall the package under any of these runners — it runs the test suite with npm on
Node 18, 20 and 22 — so a break specific to yarn, pnpm or bun can reach a release. The table
records what has been verified, not a CI result.

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
npm install -g codebase-snapshot
```

This is what puts the short `snapshot` command on your `PATH`.

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
npm install -D codebase-snapshot@latest
npx codebase-snapshot generate     # rewrite the snapshot with the new version
```

`manifest.generator.version` records which version produced a snapshot. Re-run `generate`
after an upgrade so the snapshot, and the version it records, match the build you are now
running.

A snapshot written by **3.0.0 or earlier** is refused rather than replaced: its
`.codebase-snapshot` marker has no per-snapshot id, so the current build cannot prove it wrote
the directory. Delete the old snapshot directory and generate again.

See [CHANGELOG](../CHANGELOG.md) for breaking changes — 3.0.0 removed nothing, but it briefly
did in error; 4.0.0 restored the `snap` alias, and 0.9.2 replaced that alias with `snapshot`
when the version line was restarted.

## Uninstalling

Standard for your client (`npm uninstall`, `yarn remove`, `pnpm remove`, `bun remove`).
Snapshots already written to the output directory are ordinary files and are left alone.
If you installed globally, `npm rm -g codebase-snapshot` also removes the
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
npm rm -g codebase-snapshot
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
