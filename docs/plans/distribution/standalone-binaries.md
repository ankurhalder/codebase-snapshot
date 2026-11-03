# Standalone binaries and PyPI wheels

How we turn a Node.js CLI into a native executable that runs on a machine with no Node
installed, and then into a `pip install`-able package. This is the technical design for
milestones **D1** and **D3** in [README.md](./README.md).

## Why this is necessary

`pip`, `brew`, `apt` and `scoop` install *executables*. `npm` installs *JavaScript and a
runtime requirement*. There is no way to express "this needs Node 18+" to any of them, so
the only honest way to appear in a non-Node ecosystem is to bring the runtime with us.

The plan therefore produces **one self-contained executable per platform**, and every
downstream channel becomes a thin packager over that artifact.

## Measured baseline (win-x64, Node 24.12.0)

Executed, not estimated:

| Stage | Size |
| :--- | ---: |
| `esbuild` bundle of `src/bin.ts`, `typescript` inlined, CJS | 9.68 MB |
| SEA preparation blob (bundle + V8 code cache) | 9.92 MB |
| `node.exe` copy + injected blob → `snap.exe` | **95.81 MB** |
| Compressed archive (what a wheel download costs) | **34.70 MB** |

For scale: `uv` ships ~20 MB wheels containing a ~40 MB Rust binary. We are heavier
because we embed an entire JS runtime instead of a compiled native binary, but we are in
the same order of magnitude and the user experience is identical.

### Where the weight comes from, and why we accept it

- **~86 MB**: the Node executable itself. This is the entire cost of "no Node required",
  and it cannot be trimmed without building Node from source per platform
  (`--without-intl` saves roughly 25 MB at the cost of a per-platform custom Node build —
  rejected as disproportionate).
- **~9 MB**: the bundled TypeScript compiler. Required for real AST analysis
  (`summaryQuality: "ast"`), and it is pure JavaScript, so it bundles cleanly.
- **~0.7 MB**: our own code.

Alternatives considered and rejected:

| Option | Why not |
| :--- | :--- |
| `bun build --compile` | Smaller, but swaps the runtime under a CLI whose interactive wizard depends on `node:readline` raw-mode keypress events. Startup-semantics risk on the one code path we cannot cover in CI. |
| `deno compile` | Comparable size to SEA, adds a third runtime to reason about. |
| Ship plain JS + require Node | Zero size, but it is exactly the broken promise we are fixing. |
| `pkg` (vercel) | Unmaintained; does not track modern Node. |

## Build pipeline

Five stages in `scripts/build-binary.mjs`, parameterized by target:

```bash
# 1. Bundle everything (typescript inlined) into one CJS file.
#    CJS is mandatory: SEA's main script must be CommonJS.
esbuild src/bin.ts --bundle --platform=node --format=cjs --target=node18 \
  --outfile=build/snap.cjs

# 2. Describe the injection to Node.
#    useCodeCache compiles the bundle ahead of time for faster startup.
{ "main": "build/snap.cjs", "output": "build/sea-prep.blob",
  "disableExperimentalSEAWarning": true, "useCodeCache": true }

# 3. Generate the blob.
node --experimental-sea-config build/sea-config.json

# 4. Inject it into a copy of this platform's node executable.
cp node build/snap && \
  npx postject build/snap NODE_SEA_BLOB build/sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# 5. macOS only — ad-hoc sign, or arm64 refuses to execute it.
codesign --force --sign - build/snap
```

Stage 5 is the step that forces native runners. `postject` *can* cross-inject (the ELF /
Mach-O / PE rewriting is format-aware), but a macOS binary cannot be ad-hoc signed from
Linux without pulling in `rcodesign`, and an unsigned arm64 Mach-O is killed on exec.
Using one native runner per target is less code and less to go wrong.

### CI matrix

| Target | Runner | Artifact |
| :--- | :--- | :--- |
| linux-x64 | `ubuntu-22.04` | `snap-linux-x64.tar.gz` |
| linux-arm64 | `ubuntu-22.04-arm` | `snap-linux-arm64.tar.gz` |
| darwin-x64 | `macos-13` | `snap-darwin-x64.tar.gz` |
| darwin-arm64 | `macos-14` | `snap-darwin-arm64.tar.gz` |
| win-x64 | `windows-2022` | `snap-win-x64.zip` |

Plus `SHA256SUMS` over all five, uploaded to the GitHub Release. macOS runners bill at
~10× the Linux rate, which is acceptable because this runs only on release tags.

### The gate that makes this trustworthy

The spike proved the binary works *because* it was run with Node removed from `PATH`.
That exact check becomes a CI step after injection:

```bash
# Linux/macOS: strip node from PATH, prove the binary stands alone.
PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node | paste -sd:) ./snap --version
```

Without this, a binary that accidentally still resolves `node` or `node_modules` would
pass every other test and fail on a real user's machine — the failure mode is silent
until someone without Node tries it.

## PyPI packaging (D3)

### Wheel layout

One wheel per platform, `uv`-style. Nothing is compiled at install time; the executable
is shipped as package data.

```
codebase_snapshot-2.1.1-py3-none-win_amd64.whl
├── codebase_snapshot/
│   ├── __init__.py            # __version__
│   ├── cli.py                 # entry point: finds + execs the binary
│   └── bin/snap.exe           # the real thing, 95.8 MB
├── codebase_snapshot-2.1.1.dist-info/
│   ├── METADATA
│   ├── WHEEL                  # Tag: py3-none-win_amd64, Root-Is-Purelib: false
│   ├── entry_points.txt       # [console_scripts] snap = codebase_snapshot.cli:main
│   └── RECORD
```

### Platform tags

| Target | Wheel tag | Notes |
| :--- | :--- | :--- |
| win-x64 | `py3-none-win_amd64` | |
| linux-x64 | `py3-none-manylinux_2_28_x86_64` | tag must match the glibc floor of the embedded Node build |
| linux-arm64 | `py3-none-manylinux_2_28_aarch64` | |
| macOS arm64 | `py3-none-macosx_11_0_arm64` | |
| macOS x64 | `py3-none-macosx_10_12_x86_64` | |

`py3-none-<platform>` (no ABI tag) is the correct choice: there is no CPython C extension,
only a data file whose *platform* matters. This is exactly what `uv` publishes.

**The glibc floor must be verified, not guessed.** The tag advertises a minimum glibc to
pip; if it is too low, the wheel installs and then fails to exec on old systems. The check
before publishing:

```bash
objdump -T snap | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1
```

### The Python entry point

Deliberately tiny — it locates the bundled binary, forwards `argv` verbatim, and
propagates the exit code so `pip`-installed `snap` behaves identically to the npm one:

```python
def main() -> int:
    binary = Path(__file__).parent / "bin" / ("snap.exe" if os.name == "nt" else "snap")
    if binary.exists():
        return subprocess.call([str(binary), *sys.argv[1:]])
    # sdist fallback for platforms we did not build
    return subprocess.call(["npx", "-y", "@ankurhalder/codebase-snapshot", *sys.argv[1:]])
```

`subprocess.call` rather than `os.execv` because `execv` has stdio/console quirks on
Windows; the extra process costs a few milliseconds and is worth the portability.

### sdist fallback

The sdist contains no binary. On a platform with no matching wheel, `pip install` builds
the sdist, and the shim degrades to `npx`. The user gets a clear error only if Node is
*also* absent — never a resolution failure out of nowhere. This keeps exotic platforms
(FreeBSD, 32-bit, Alpine) from being hard-broken while we only maintain five wheels.

### Publishing

PyPI **Trusted Publishing** over GitHub OIDC:

```yaml
permissions: { id-token: write }
environment: pypi
# no PYPI_TOKEN — PyPI mints a 15-minute token from the OIDC claim
```

Same security property as the npm `--provenance` attestation we already publish: no
long-lived secret in the repo. **Blocking prerequisite:** an account on pypi.org and a
registered Trusted Publisher — only the repo owner can create those.

## Risks

| Risk | Severity | Mitigation |
| :--- | :--- | :--- |
| SEA is marked experimental in Node | medium | Pin the exact Node version used to build. Binaries embed their runtime, so a Node upgrade is a deliberate, testable change — not a surprise. |
| Wrong glibc floor in the manylinux tag | medium | `objdump -T` check in CI (above), plus a container smoke test on `ubuntu:20.04` and `debian:11`. |
| macOS Gatekeeper on unsigned/corrupted signature | high | Ad-hoc `codesign` after injection; smoke test on the same runner. Note the spike emitted `warning: The signature seems corrupted!` during injection on Windows — harmless there, fatal on arm64 macOS. |
| 34.7 MB download per platform | low | Accepted; it is the price of a real standalone install. Documented in the README with the size stated up front. |
| Binary drifts from the npm build | medium | Both are built from one commit in one workflow; a CI step asserts `snap --version` equals `package.json.version` in **both** artifacts. |
| `typescript` external in the npm build breaks yarn PnP | **resolved** | Tested: yarn Berry 4.6.0 with `nodeLinker: pnp` runs `yarn snap --version` → `v2.0.0`. No change needed; kept in the CI client matrix as a regression guard. |

## Not in scope

- **Auto-update.** The binary does not phone home. Users update through whichever channel
  installed it.
- **Code signing certificates** (Apple Developer ID / Windows Authenticode). Ad-hoc
  signing suffices for pip and Homebrew installs within the first months; a real
  certificate is a paid, identity-verified purchase and a separate decision.
- **32-bit and musl Linux.** Alpine users get the Docker image (D2) instead.
