# Distribution: beyond npm

Status: **D0 shipped. D1–D5 deliberately deferred — kept here as future scope.**
Branch: `feat/distribution` (from `main` @ `27ef82d`)
Baseline: `2.1.0` (on `feat/2.1.0`, unmerged at time of writing)

## Scope decision

This document originally proposed five milestones across npm, PyPI, Homebrew, Docker,
NuGet, RubyGems and Maven Central. **Only D0 was pursued.** The reasoning, recorded so it
is not re-litigated later:

- **Reach is wildly front-loaded.** The npm family plus a release binary covers roughly
  everything within reach for a JavaScript tool. Each additional channel is roughly linear
  cost for sharply diminishing returns.
- **Registry size is the wrong sort key.** "Top 5 registries" ranks by *download volume*,
  which is dominated by transitive build dependencies — not by where developers go looking
  for a CLI. Maven Central's rank reflects Spring and JUnit, not tool discovery.
- **Channels are cheap to create and expensive to own.** Five standalone builds on
  macOS runners billed at 10×, wheel tags, formula sha bumps and manifests all become a
  per-release maintenance tax on a single maintainer. That tax, not the initial build, is
  what makes releases slow enough that maintainers stop cutting them.
- **It was never requested.** Nobody asked for a `pip install`. Committing a week to an
  unvalidated hypothesis is the wrong order of operations.

**If this is ever revisited, start with the cheap probe, not the expensive build:** a 4 KB
PyPI shim that delegates to `npx` costs two hours, proves the whole publish path, and
produces real install numbers. A 35 MB platform wheel can only be justified *after* that
shim shows demand.

D0 — the clients that already work — is shipped:

| Deliverable | Where |
| :--- | :--- |
| Install guide covering npm / yarn / yarn Berry (PnP) / pnpm / bun | [docs/install.md](../../install.md) |
| CI matrix that installs the packed tarball per client and runs a real `generate` | `.github/workflows/ci.yml` → `client-install` |
| README Quick Start refreshed | `README.md` |

## The two questions, answered

**"Can we install this with yarn?"** — Yes. Today. Nothing to build.
Yarn, pnpm, bun and Deno all resolve from the public npm registry, which is where
`@ankurhalder/codebase-snapshot` already lives. All four were installed and executed
against the published `2.0.0` during this spike:

| Client | Version | Result |
| :--- | :--- | :--- |
| yarn (classic) | 1.22.22 | `snap --version` → `v2.0.0`, lockfile → `registry.yarnpkg.com` |
| yarn (Berry) | 4.6.0, `nodeLinker: pnp` | `yarn snap --version` → `v2.0.0`, **no `node_modules`** |
| pnpm | 10.28.0 | `pnpm exec snap --version` → `v2.0.0` |
| bun | 1.4.4 | `bun run snap --version` → `v2.0.0` |
| Deno | not installed | untested — `deno run -A npm:@ankurhalder/codebase-snapshot` |

So the "yarn" half of the ask is a **documentation + CI-verification** problem, not an
engineering one. It is tracked as milestone D0 and costs roughly zero.

**"Can we install this with pip?"** — Not today, and not by accident.
`pip` installs from PyPI, which distributes Python packages. Our tool is a Node.js
program. pip has no way to express "a Node program" unless we ship something it *can*
install — either a Python shim that shells out, or a prebuilt native executable
bundled inside a platform-tagged wheel.

The second option is the honest one, and it is a solved, well-trodden pattern.

## The uncomfortable truth about "top 5"

npm, PyPI, Maven Central, NuGet and RubyGems are not interchangeable distribution
channels. They are *language package managers*. A tool written in language X is a
first-class citizen in X's registry and a **guest** everywhere else. Every cross-ecosystem
tool that looks native in someone else's registry is shipping **prebuilt binaries**,
not source:

| Tool | Written in | Ships on PyPI as |
| :--- | :--- | :--- |
| `uv` | Rust | 18 platform wheels, `uv-0.9.9-py3-none-win_amd64.whl`, ~20 MB each |
| `ruff` | Rust | platform wheels, same shape |
| `pyright` | TypeScript | a Python wrapper that bootstraps Node |
| `esbuild` | Go | npm package that carries 8 platform binaries |

`uv` is the exact template we want: **`py3-none-<platform>` wheels, no compilation on the
user's machine, one real executable per platform.** Verified against the PyPI index:

```
uv-0.9.9-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl   20.3 MB
uv-0.9.9-py3-none-macosx_11_0_arm64.whl                            17.3 MB
uv-0.9.9-py3-none-win_amd64.whl                                    20.3 MB
uv-0.9.9.tar.gz                                                     3.6 MB   ← sdist fallback
```

**Conclusion: the standalone binary is the keystone.** Without it, every non-npm
registry is a fake — a shim that breaks on machines without Node. With it, each
additional registry becomes a few dozen lines of packaging metadata. So the plan is
built in that order, and the first thing built is the binary.

## Evidence collected in this spike

Everything below was executed, not estimated. Raw numbers:

| Check | Result |
| :--- | :--- |
| `yarn add @ankurhalder/codebase-snapshot` | works, v2.0.0 resolved, `snap` binary runs |
| Standalone binary (Node SEA, win-x64) | **95.8 MB**, runs with `node` removed from `PATH` |
| Compressed (what a wheel download costs) | **34.7 MB** — comparable to `uv`'s 20 MB |
| Functional test in a non-Node repo | real snapshot generated: 3 files, 1 part, integrity passed |
| App payload inside the binary | 9.7 MB (of which ~9 MB is the bundled `typescript` compiler) |
| Runtime payload | ~86 MB (the Node 24 executable itself) |
| `codebase-snapshot` on PyPI | **available** (404) |
| `CodebaseSnapshot` on NuGet | **available** (404) |
| `codebase-snapshot` on RubyGems | **available** (404) |
| `codebase-snapshot` on crates.io | available (but see D5 — not worth it) |
| PyPI Trusted Publishing (OIDC) | available — no API token needed, mirrors our npm `--provenance` |

The 86 MB of Node runtime is the price of a truly zero-dependency install. It is
unavoidable with SEA (the binary *is* `node.exe` with our bundle injected). The
alternative — a 4 KB pip package that requires Node — is smaller but is exactly the
broken promise we are trying to avoid.

## Milestones

Ordered by dependency, not by appeal. D1 unblocks everything after it.

### D0 — npm family: prove and document ✅ SHIPPED

Yarn is not a separate registry; it is a client. Four other clients work the same way.

- Verify and document `npm`, `yarn`, `pnpm`, `bun`, `deno` install paths in `docs/install.md`.
- Add a CI job that installs the **published tarball** through each client and runs
  `snap --version` — so a broken `bin`/`exports` field can never ship silently again.
- Fix a real DX wart found during the spike: `snap init` always writes
  `snapshot.config.ts`. On a Python/Go/Ruby project the user should get
  `snapshot.config.json` — we already support reading it (`src/config.ts:25`), we just
  never choose it. A pip user being handed a TypeScript file is a bad first impression.

**Cost:** ~2 hours. **Risk:** none — additive docs + CI.

### D1 — standalone binaries + release assets (DEFERRED)

Build one self-contained executable per platform and attach it to the GitHub Release.

- `scripts/build-binary.mjs`: esbuild bundle (CJS, `typescript` **inlined**) → Node SEA
  blob → inject into a copy of the platform's `node` executable.
- CI matrix, one **native** runner per target (no cross-compilation):

  | Target | Runner | Asset |
  | :--- | :--- | :--- |
  | linux-x64 | `ubuntu-22.04` | `snap-linux-x64.tar.gz` |
  | linux-arm64 | `ubuntu-22.04-arm` | `snap-linux-arm64.tar.gz` |
  | darwin-x64 | `macos-13` | `snap-darwin-x64.tar.gz` |
  | darwin-arm64 | `macos-14` | `snap-darwin-arm64.tar.gz` |
  | win-x64 | `windows-2022` | `snap-win-x64.zip` |

- macOS binaries must be **ad-hoc signed** (`codesign --force --sign -`) after injection,
  or arm64 refuses to execute them. This is the one non-obvious step and it dictates
  using real macOS runners rather than cross-injecting from Linux.
- Publish `SHA256SUMS` alongside; every downstream channel verifies against it.

**Cost:** ~1 day. **Risk:** medium — SEA is still marked experimental in Node.

### D2 — Homebrew + Scoop + Docker (DEFERRED)

All three are just packaging around D1 artifacts.

- `brew install ankurhalder/tap/codebase-snapshot` — one formula file in a `homebrew-tap`
  repo, pointing at the darwin tarballs + sha256.
- `scoop install codebase-snapshot` — one JSON manifest in a `scoop-bucket` repo.
- `docker run --rm -v "$PWD:/work" ghcr.io/ankurhalder/codebase-snapshot` — a three-line
  `Dockerfile` (`FROM alpine` + the linux binary). Genuinely useful in CI pipelines,
  where "no Node on the runner" is the common case.

**Cost:** ~half a day for all three. **Risk:** low.

### D3 — PyPI (DEFERRED)

This is the one that matters, and the one that finally answers "can I `pip install` it".

- One wheel per platform, `py3-none-<platform>` tag, `uv`-style, containing a real
  executable — **no Node required, no compile step, no network call on first run.**
- A ~15-line Python entry point (`[project.scripts] snap = codebase_snapshot.cli:main`)
  that `subprocess`-execs the bundled binary and forwards the exit code.
- An `sdist` fallback for exotic platforms that delegates to
  `npx @ankurhalder/codebase-snapshot`, so `pip install` degrades gracefully instead of
  failing.
- Publish via **PyPI Trusted Publishing** (GitHub OIDC). No API token, no long-lived
  secret, and it gives us attested provenance — the same property we already get from
  npm `--provenance`.

Platforms to ship: `win_amd64`, `manylinux_2_28_x86_64`, `manylinux_2_28_aarch64`,
`macosx_11_0_arm64`, `macosx_10_12_x86_64`. (Add `musllinux` only if someone asks —
Alpine users are better served by the Docker image in D2.)

**Cost:** ~1.5 days (most of it packaging + workflow, not code).
**Risk:** medium — wheel tags and OIDC setup have sharp edges, and PyPI account
registration is a manual step only the repo owner can perform.

### D4 — NuGet + RubyGems (DEFERRED)

- `dotnet tool install -g CodebaseSnapshot` — a `.nuspec` wrapping the win-x64 and
  linux/darwin binaries under `tools/`, plus a `DotnetToolSettings.xml`.
- `gem install codebase_snapshot` — a gem whose `bin/snap` execs the bundled binary.

Both are ~50 lines of packaging each. Value is mostly symbolic: a .NET or Ruby team
discovering the tool through their own registry.

**Cost:** ~half a day each. **Risk:** low.

### D5 — Maven Central and crates.io: still recommended **skip**

Stated plainly, because it is the part of "top 5" that does not survive contact with
reality:

- **Maven Central** publishes JVM libraries and plugins. To be useful there we would have
  to ship a Maven *plugin* (`mvn codebase-snapshot:generate`) that shells out to a
  downloaded binary. That is a real feature for Java teams, but it is a Java project's
  worth of work — not packaging. Worth doing **if** Java teams ask for it; not worth
  doing to satisfy a registry count.
- **crates.io** distributes Rust crates that compile from source. We cannot be one
  without a Rust rewrite. A "wrapper crate" that downloads a binary is hostile to
  `cargo`'s model and would be criticized, correctly.
- **Cargo/Go users** are better served by D1 (a release binary) and D2 (Homebrew/Docker).

If "top 5" must be satisfied literally, the defensible fifth slot is **Homebrew** (D2) —
it is genuinely among the most-used install paths for developer CLIs, and unlike Maven
it costs us an afternoon.

## Original sequence (kept for reference)

```
D0  npm family  (free)     ──┐
D1  binaries    (keystone) ──┼── D2  brew/scoop/docker
                             ├── D3  PyPI
                             └── D4  NuGet + RubyGems
D5  Maven / crates.io — skip unless asked
```

D0 and D1 are worth doing regardless of which other channels are chosen, because D1 also
gives us something we do not have today: **a download that works with no Node installed
at all**, which is the only real answer to "make it usable everywhere".

## Open decisions

1. **Which channels?** D0–D3 is the recommended set. D4 is cheap. D5 needs a reason.
2. **Accounts.** PyPI, NuGet and RubyGems publishing each require an account and a
   one-time "trusted publisher"/token setup that only the repo owner can perform.
   PyPI is the blocking one for D3.
3. **Binary weight.** 34.7 MB download per platform. Acceptable? The only alternative is
   a thin shim that requires Node, which defeats the purpose.
4. **Branch/merge order.** This branch is cut from `main` (`2.0.0`). `feat/2.1.0` is
   unmerged. D1's build script touches `tsup.config.ts` and the release workflow, so this
   work should land **after** 2.1.0 to avoid a pointless conflict.
