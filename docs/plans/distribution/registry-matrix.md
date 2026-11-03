# Registry matrix

Every channel we could plausibly ship through, what it actually costs, and what the
user gets. "Exists" means the name is unregistered on that registry and available to us
(verified by probing the registry APIs — all returned 404).

## Summary

| # | Channel | User command | Effort | Value | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | npm | `npx @ankurhalder/codebase-snapshot` | done | — | **live** |
| 2 | npm clients (yarn/pnpm/bun/Deno) | `yarn dlx …` / `pnpm dlx …` / `bunx …` | ~2 h | high | **D0** |
| 3 | GitHub Releases (binaries) | download + `chmod +x` | ~1 d | very high | **D1** |
| 4 | Homebrew | `brew install ankurhalder/tap/codebase-snapshot` | ~3 h | high | **D2** |
| 5 | Docker | `docker run -v "$PWD:/work" ghcr.io/…` | ~3 h | high | **D2** |
| 6 | Scoop (Windows) | `scoop install codebase-snapshot` | ~2 h | medium | **D2** |
| 7 | PyPI | `pip install codebase-snapshot` | ~1.5 d | **very high** | **D3** |
| 8 | NuGet | `dotnet tool install -g CodebaseSnapshot` | ~4 h | low | **D4** |
| 9 | RubyGems | `gem install codebase_snapshot` | ~4 h | low | **D4** |
| 10 | Maven Central | `mvn codebase-snapshot:generate` | ~1 w | low | skip (see notes) |
| 11 | crates.io | — | n/a | none | **skip** |
| 12 | Conda/conda-forge | `conda install -c conda-forge …` | ~1 d | low | skip for now |
| 13 | apt/dnf (distro repos) | — | weeks | low | skip |

## Per-channel detail

### 1. npm — live

```bash
npx @ankurhalder/codebase-snapshot init
npm install -D @ankurhalder/codebase-snapshot
```

Published `2.0.0` with `--provenance` (Sigstore-signed, SLSA v1 attestation).
`bin` exposes both `snap` and `codebase-snapshot`.

---

### 2. npm-compatible clients — D0

These are **not additional registries**. They are alternative clients for
registry.npmjs.org. Zero publishing work; the entire cost is verification and docs.

| Client | Install | Run once |
| :--- | :--- | :--- |
| npm | `npm i -D @ankurhalder/codebase-snapshot` | `npx snap` |
| yarn (classic) | `yarn add -D @ankurhalder/codebase-snapshot` | `yarn snap` |
| yarn (berry) | `yarn add -D @ankurhalder/codebase-snapshot` | `yarn dlx -p @ankurhalder/codebase-snapshot snap` |
| pnpm | `pnpm add -D @ankurhalder/codebase-snapshot` | `pnpm snapshot` / `pnpm dlx …` |
| bun | `bun add -d @ankurhalder/codebase-snapshot` | `bunx snap` |
| Deno | — | `deno run -A npm:@ankurhalder/codebase-snapshot` |

Verified in spike: yarn 1.22.22 installs and runs `snap --version` → `v2.0.0`,
lockfile resolving to `registry.yarnpkg.com`.

**The PnP question — tested, not assumed.** yarn Berry defaults to strict PnP, where
`node_modules` does not exist and our runtime `import ts from "typescript"` has to
resolve through a `.pnp.cjs` loader. That looked like a real hazard. It is not:

```
corepack yarn 4.6.0 add @ankurhalder/codebase-snapshot   (nodeLinker: pnp)
→ node_modules exists? NO - strict PnP
→ yarn snap --version → v2.0.0   (exit 0)
```

Berry registers the ESM PnP loader when it launches a `bin`, so the resolution succeeds.
No bundling change is needed. This is worth keeping in CI precisely because it *looked*
like it would fail and was only disproved by running it.

---

### 3. GitHub Releases — D1 (keystone)

```
https://github.com/ankurhalder/codebase-snapshot/releases/download/v2.1.1/snap-linux-x64.tar.gz
```

One self-contained executable per platform, no Node required, no install step beyond
extracting. This is the artifact every other channel in this matrix packages, so it is
also the thing to build first.

Measured in spike (win-x64): **95.8 MB binary → 34.7 MB compressed**, fully functional
in a repo with no Node anywhere on `PATH`.

---

### 4. Homebrew — D2

```bash
brew install ankurhalder/tap/codebase-snapshot
```

Requires a separate public repo `ankurhalder/homebrew-tap` containing
`Formula/codebase-snapshot.rb`. The formula downloads the darwin tarball and verifies
its sha256 — both already produced by D1.

Worth noting: a Homebrew **tap** (one repo, install by full name) is an afternoon.
Getting into **homebrew-core** is a submission process with naming/notability rules and
is not worth pursuing at this stage.

---

### 5. Docker — D2

```bash
docker run --rm -v "$PWD:/work" -w /work ghcr.io/ankurhalder/codebase-snapshot generate
```

Publish to **GHCR**, not Docker Hub: GHCR authenticates with the existing
`GITHUB_TOKEN` + OIDC, so no new account or secret. Docker Hub would need credentials and
rate-limits anonymous pulls.

The strongest use case is CI: `node` is often absent from build images, and a container
sidesteps that entirely.

---

### 6. Scoop — D2

```powershell
scoop install codebase-snapshot
```

One JSON manifest in `ankurhalder/scoop-bucket` pointing at the win-x64 zip. ~40 lines.
Serves the Windows audience that Homebrew cannot.

---

### 7. PyPI — D3

```bash
pip install codebase-snapshot
pipx install codebase-snapshot    # the better fit for a CLI
```

Name verified available. Shipping as `py3-none-<platform>` wheels carrying a real
executable, exactly like `uv`. Details in [standalone-binaries.md](./standalone-binaries.md).

**Prerequisite only you can do:** create a PyPI account and register the project's
Trusted Publisher (owner `ankurhalder`, repo `codebase-snapshot`, workflow
`publish-pypi.yml`, environment `pypi`). Until that exists, D3 cannot publish.

---

### 8. NuGet — D4

```bash
dotnet tool install -g CodebaseSnapshot
```

A `.NET global tool` is just a nupkg with binaries under `tools/` and a
`DotnetToolSettings.xml`. Cheap because D1 already produced the binaries. Audience is
small but the tool's .NET/C# analysis support makes it a defensible end-cap.

---

### 9. RubyGems — D4

```bash
gem install codebase_snapshot
```

A gem with an executable script that execs the bundled binary. RubyGems requires a
verified account with 2FA. Low usage; treat as optional.

---

### 10. Maven Central — skip for now

Maven Central hosts JVM libraries and plugins. Being *present* there means either:

- **a dummy artifact** that downloads a binary at runtime — an anti-pattern that will be
  called out, and rightly so; or
- **a real Maven plugin** (`mvn codebase-snapshot:generate`) wrapping the binary — a
  legitimate feature for Java teams, but a multi-week Java project, not packaging.

The honest position: our Java/.NET/PHP/Ruby *source analysis* support does not imply
those ecosystems' developers install CLIs through their registries. They use Homebrew,
Docker, or a release binary. Revisit only if Java teams actually ask.

---

### 11. crates.io — skip

Crates are compiled from source by `cargo`. We are not a Rust program. A wrapper crate
that shells out to a downloaded binary violates the expectations of the registry. `cargo
install codebase-snapshot` should not exist.

---

### 12. conda-forge — skip for now

Genuinely popular in data-science environments, but the feedstock process (staged
recipes, review, maintainer) is heavier than PyPI and we can revisit once PyPI is live.
A `conda` recipe can reuse the PyPI sdist if needed.

---

### 13. Distribution package managers (apt/dnf/flatpak) — skip

Requires becoming a downstream package maintainer in each distro. Not a solo-maintainer
activity.

## What "top 5" actually resolves to

Ranked by realistic adoption for a developer CLI, not by registry size:

1. **npm** (live) — plus the four clients that ride on it (D0)
2. **GitHub Releases binaries** (D1) — the universal fallback, works with no runtime
3. **Homebrew + Docker** (D2) — the two most common ways developers install CLIs
4. **PyPI** (D3) — the second-largest ecosystem, and a genuinely distinct audience
5. **NuGet / RubyGems** (D4) — cheap completeness once D1 exists

Maven Central and crates.io are large registries but wrong-shaped targets for this tool.
