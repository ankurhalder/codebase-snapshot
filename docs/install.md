# Installation

`@ankurhalder/codebase-snapshot` is published to the public npm registry, so it installs
with **any** npm-compatible client. There is nothing extra to configure and no second
registry to add.

Requires **Node.js 18 or newer**.

## One-off use (no install)

```bash
npx @ankurhalder/codebase-snapshot generate
```

Pin the version when you need the same build on every machine:

```bash
npx @ankurhalder/codebase-snapshot@latest generate
npx @ankurhalder/codebase-snapshot@3 generate
```

The bare form works because this package ships **exactly one executable**
(`codebase-snapshot`). That is deliberate: npm resolves which binary to run by matching the
typed command against the package's `bin` keys, and no key can contain an `@scope/`, so a
scoped package with several executables cannot be run by its bare name. If a command ever
exits with no output, clear the npm cache and retry — see troubleshooting.

`npx -p @ankurhalder/codebase-snapshot codebase-snapshot generate`, `pnpm dlx`,
`yarn dlx` and `bunx` are equivalent. A normal `npm install -D` followed by
`npx codebase-snapshot` is the more reproducible choice for a project.

Equivalent one-liners for other clients:

```bash
yarn dlx -p @ankurhalder/codebase-snapshot codebase-snapshot generate   # yarn Berry
yarn global add @ankurhalder/codebase-snapshot             # yarn classic (installs globally)
pnpm dlx @ankurhalder/codebase-snapshot generate
bunx @ankurhalder/codebase-snapshot generate
```

## Add to a project

```bash
npm install -D @ankurhalder/codebase-snapshot
yarn add -D @ankurhalder/codebase-snapshot        # yarn classic and Berry
pnpm add -D @ankurhalder/codebase-snapshot
bun add -d @ankurhalder/codebase-snapshot
```

Then run it through your client so it resolves from the project's `node_modules`:

```bash
npx codebase-snapshot generate
yarn codebase-snapshot generate
pnpm exec codebase-snapshot generate
bun run codebase-snapshot generate
```

Both `codebase-snapshot` and `codebase-snapshot` are exposed as binaries — pick whichever you prefer.

Adding it to `package.json` scripts works the same everywhere:

```json
{
  "scripts": {
    "snapshot": "codebase-snapshot generate",
    "snapshot:validate": "codebase-snapshot validate"
  }
}
```

## Global install

```bash
npm install -g @ankurhalder/codebase-snapshot
pnpm add -g @ankurhalder/codebase-snapshot
bun add -g @ankurhalder/codebase-snapshot
```

A global install exists for convenience, but pinning the version per project (the
`-D`/`--save-dev` examples above) is the better default: snapshots are only reproducible
if the generator version is reproducible.

## Version pinning

```bash
npx @ankurhalder/codebase-snapshot@2 generate
pnpm dlx @ankurhalder/codebase-snapshot@3.0.0 generate
```

## Verified clients

Every client below was used to install the published package and run
`codebase-snapshot --version` successfully. This matrix is enforced in CI
(`.github/workflows/ci.yml` → `client-install`), so a change that breaks a client fails
the build rather than a user's terminal.

| Client | Version tested | Run installed binary with |
| :--- | :--- | :--- |
| npm | 10.x | `npx codebase-snapshot` |
| yarn (classic) | 1.22.22 | `yarn codebase-snapshot` |
| yarn (Berry, `nodeLinker: pnp`) | 4.6.0 | `yarn codebase-snapshot` |
| pnpm | 10.28.0 | `pnpm exec codebase-snapshot` |
| bun | 1.4.4 | `bun run codebase-snapshot` |

Yarn Berry's default **strict PnP** mode works: there is no `node_modules` directory, and
the runtime `typescript` dependency still resolves through yarn's `.pnp.cjs` loader.

## Package manager workspaces

The binary is resolved from the workspace it is installed in. In a monorepo, install it
in the package that runs the snapshot (usually the root), or use any client's one-off
runner (`npx` / `pnpm dlx` / `yarn dlx` / `bunx`) which works from any subdirectory.

## Uninstalling

Standard for your client (`npm uninstall`, `yarn remove`, `pnpm remove`, `bun remove`).
Snapshots already written to `snapshot/` are ordinary files and are left alone.

## Not supported yet

- **`pip`, `brew`, `scoop`, `docker`, and standalone binaries.** These require shipping a
  prebuilt executable rather than JavaScript, and are tracked as future work in
  [docs/plans/distribution](../plans/distribution/README.md). Until then, any machine
  running the tool needs Node 18+.
- **Deno.** The API can be imported under Deno's npm compatibility, but running the CLI
  needs a `./bin` subpath export that is not published yet.

## Troubleshooting

**`codebase-snapshot: command not found`** — when installed locally (not globally), the binary lives
in `node_modules/.bin` and is only on your `PATH` inside a package script or a client
runner. Use `npx codebase-snapshot`, `pnpm exec codebase-snapshot`, `yarn codebase-snapshot`, or `bun run codebase-snapshot`.

**`Cannot find module 'typescript'`** — the package declares `typescript` as a runtime
dependency for AST analysis. If your client prunes or externalizes it (some bundlers and
`--ignore-scripts` CI setups do), rerun a clean install, or pin `typescript@^5` yourself.

**CI has no Node** — that is not supported yet; this package is JavaScript and needs a
Node runtime. See the future-work note above.

**`yarn codebase-snapshot` prints extra lines, or breaks a script that parses output** — yarn classic
wraps everything: it echoes `yarn run 1.22.22`, the resolved command, your tool's output,
and a `Done in 0.37s.` trailer. For a human that is harmless; for anything that parses
`codebase-snapshot`'s stdout it is not. In scripts and CI, call the binary directly:

```bash
./node_modules/.bin/codebase-snapshot generate
npx codebase-snapshot generate          # same, without the yarn wrapper
```

This is why the CI job in this repository reads the version from a line that *is* the
version rather than taking the first or last line of output.
