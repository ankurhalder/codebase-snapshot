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
```

Verification is local, deliberately. GitHub Actions is used for one thing only — publishing —
and that workflow runs `npm run verify` before it uploads, so a green `verify` here is the same
gate a release passes. There is no matrix to wait for, and nothing a pull request can fail that
you could not have caught on your own machine.

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
