# Contributing

Thanks for taking a look. This document covers the parts that are not obvious from the code.

## Getting set up

```bash
git clone https://github.com/ankurhalder/codebase-snapshot.git
cd codebase-snapshot
npm install
npm run check      # lint + typecheck + tests
npm run build
```

Node 18 or newer. There is no database, no service, and no build step beyond `tsup`.

## Before opening a pull request

```bash
npm run check      # lint, tsc --noEmit, node --test
```

```bash
npm run verify     # the above, plus a check of the tarball that would be published
npm run verify:deep  # verify, then generate, replay from source, validate, coverage and determinism
```

`verify:deep` is the release gate for changes that touch generation: it writes a snapshot of the
repository into a temporary directory, audits every full body against the source (`health --deep`),
validates it, checks that every path in `git ls-files` is in `files[]` or `skipped[]`
(`coverage-diff`), and generates twice to prove the fingerprint and parts are reproducible. The
individual pieces are `npm run coverage-diff` and `npm run reproducible`.

Verification is local, deliberately, and `npm run verify` is the same command every workflow
runs. GitHub Actions does more than publish: `pr.yml` verifies pull requests, `publish.yml`
verifies and uploads on a tag, `pages.yml` builds the docs site, `seo-rank.yml` measures search
visibility weekly, and `deprecate.yml`/`unpublish.yml` are manual release operations. Apart from
the live docs sync described below, none of them adds a check `verify` does not run, so there is
no matrix to wait for, and nothing a pull request can fail that you could not have caught on your
own machine.

**Docs sync is the one network-only gate.** `npm run check:docs` clones the public wiki and reads
the deployed site, then checks the version labels, every `npx` pin, every sidebar page, internal
links and the modern MCP rules against `PUBLISHED`. `docs-sync.yml` runs it after the Pages
deployment and daily, so a release that updates `docs/` but not the wiki goes red instead of
shipping a stale surface. Run it before tagging when you changed documentation.

## Test headers and the version line

Some test files carry headers like "4.0.9 regression cover". Those numbers belong to the
**retired** `@ankurhalder/codebase-snapshot` line, which reached 4.4.1; the package was renamed
and restarted at 0.9.0, so `4.x` is *older* than `0.9.x` (see the note at the top of
`CHANGELOG.md`). A header names the audit that produced the fix, not the release it shipped in:
those fixes were carried into the 0.9.x line as a batch, so the only way to date one is to find
the changelog and its regression test; the old audit report is not part of the repository any
more.

## What makes a good change here

**Narrow and tested.** A fix with a regression test beats a refactor without one. If you change
behaviour, the test that would have caught the old behaviour should now exist.

**No silent fallbacks.** This project treats "did what you asked, sort of" as a bug. An unknown
preset, an unparseable config, an invalid budget, an unrecognised flag — all of them are hard
errors with a message that says what to do. If you find a place where a setting is accepted and
then ignored, that is a defect worth reporting.

**Never destroy user data.** The output directory is replaced atomically, and only when a
previous run wrote it — proved by the `.codebase-snapshot` marker's JSON payload, never by a
filename and never by a manifest alone. Never weaken that guard to make a case work.

**Never leak secrets.** Credential-bearing files stay out unless the user explicitly asks, and
redaction masks only the matched span. No excerpt of a matched line may reach an artifact.

**Keep the zero-dependency property.** The only runtime dependency is `typescript`, because AST
quality is the point of the tool. Anything else should be a dev dependency.

## Good places to start

- A language profile that is missing or too shallow (`src/ast/profiles/`).
- A project shape that is detected as `generic` but could be recognised
  (`src/presets/`), including its ecosystem ignore patterns.
- A message in [docs/troubleshooting.md](docs/troubleshooting.md) that did not help you.
- A false positive or false negative in secret detection.

## Reporting a bug

Open an issue with the reproduction template filled in. The most useful thing you can include:

```bash
npx codebase-snapshot describe --format json > contract.json
npx codebase-snapshot generate --dry-run --format json > dry-run.json
```

`--dry-run` computes a full snapshot without writing anything, so it is safe on a private
repository. Redact what you need to before pasting.

## Documentation

Documentation lives in `docs/` and ships inside the npm package. If you change behaviour,
update the matching document in the same pull request — `docs/cli.md` for commands and options,
`docs/configuration.md` for settings, `docs/output.md` for the manifest schema.

The agent contract (`codebase-snapshot describe`) is generated from code and its defaults are
asserted against a real dry run, so changing a default without updating the contract fails the
build.

## Commit and PR style

- Commits: `type: summary` — `feat`, `fix`, `docs`, `ci`, `chore` — with a body that explains
  the *why* and what you verified. Breaking changes get a `!`.
- Keep the PR description focused on behaviour and verification; screenshots are appreciated for
  anything visual.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
