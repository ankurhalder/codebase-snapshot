# Changelog

All notable changes to `@ankurhalder/codebase-snapshot`.

---

## 2.2.0

Built for AI agents. Everything an agent needs is now available as data, and the tool can
install its own skill where agents look for it.

### Added

- **snap describe** — a machine-readable contract of the whole tool: the invocation that
  works, an ordered workflow array, every command, every option with its default, the
  exit-code contract, all 25 presets, the artifact list, config file names, output layout,
  safety rules and a troubleshooting table. --format json for machines, text for humans.
  Generated from the same code the CLI runs; a test compares its documented defaults
  against a real `generate --dry-run` manifest so it cannot drift into lying.
- **snap skill** — prints the bundled agent skill (to stdout, so it can be redirected),
  or with `--install` writes it to `AGENTS.md`, `.claude/skills/codebase-snapshot/SKILL.md`
  and `.cursor/rules/codebase-snapshot.mdc`. `--target claude|agents|cursor|all`.
  The install is idempotent and replaces only its own marked block, so an existing
  `AGENTS.md` keeps its conventions.
- `snap init` now points at `skill --install`.
- [docs/agent.md](docs/agent.md) explains the contract and the skill for humans.

### Why

`--help` is prose for a person. An agent told "use npx @ankurhalder/codebase-snapshot"
had to guess option names and failure modes. `describe` removes the guessing, and the
skill removes the discovery problem: once installed, an agent finds the tool without being
told it exists.

### Tests

138 pass (130 before): the contract's shape and defaults, skill output and frontmatter,
installation to all three targets, idempotency, and that an existing `AGENTS.md` is
preserved.

---

## 2.1.1

A correctness and contract pass driven by an independent CLI audit of 2.1.0. No new
features; every item below was reproduced against the released build first.

### Fixed

- **`validate` never printed the bookkeeping mismatches it counted.** It reported
  "1 manifest bookkeeping value(s) disagree" without saying which one, while
  `--format json` carried the detail. The text output now names them
  (`counts.totalFiles: manifest 999 vs actual 5`).
- **`generate` claimed artifacts it had not written.** `--only-artifacts parts` still
  printed a `Reports:` line and a `Manifest:` line; `--skip-artifacts manifest` still
  printed `Manifest:`. The summary now reflects the selection, and an all-disabled run
  says so instead of listing files that do not exist.
- **`diff` leaked raw Node errors** — `ENOENT: no such file or directory, stat …` for a
  missing path, and `Cannot read properties of undefined (reading 'totalFiles')` for a
  parseable but foreign manifest. Both are actionable messages now.
- **`validate` double-counted a tracked-but-deleted file**: it appeared in
  `missingOnDisk` twice, so the text said "2 file(s) no longer exist" for one file.
- **A bad `--cwd` exited 1** although the documented contract reserves 2 for usage
  errors. A missing directory or a file passed as `--cwd` is now exit 2.
- **`--max-part-bytes -5`** produced the parser's "option argument is ambiguous" text;
  it now says the value looks like another flag and points at the `--option=value` form.
- **Empty option values silently meant "use the default"**, so `--out-dir "$UNSET"`
  wrote to `./snapshot` instead of failing. Every string option now rejects an empty
  value with a usage error.
- **A detached HEAD was recorded as branch `"HEAD"`**, then `validate` warned about it
  forever. A detached HEAD cannot name a branch, so the configured fallback is used.
- **A read-only output directory produced a bare `EPERM`**. It now says the directory is
  not writable and suggests `--out-dir`; the previous snapshot still survives.
- **A wrong-typed `"snapshot"` key in `package.json` was silently dropped.** It now
  warns. It stays non-fatal on purpose — other tools use that key too.
- The all-artifacts-disabled warning claimed the directory "will be empty", which
  stopped being true once the ownership marker was introduced.

### Tests

130 pass (119 before), including a POSIX-only check that a read-only output directory
fails with a clear message.

---

## 2.1.0

Multi-project support and an interactive setup.

### Added

- **Interactive setup.** `npm create codebase-snapshot` (or `npx @ankurhalder/codebase-snapshot init`)
  detects the project, walks every tunable parameter, and writes the config. Every
  prompt has a flag, so it works non-interactively in CI.
- **A self-documenting config.** The generated `snapshot.config.mjs` lists *every*
  setting at its current value, commented and grouped — not just the ones you
  changed. Deleting any line is safe. `--minimal` writes the terse variant.
- **25 presets**, up from 4: nextjs, nuxt, sveltekit, remix, astro, angular,
  solid, vue-vite, react-vite, nest, node-express, node-lib, python-django,
  python-fastapi, python-lib, go, rust, java-spring, dotnet, php-laravel,
  ruby-rails, monorepo, infra, docs, generic.
- **Per-ecosystem ignores** contributed by each preset — `__pycache__`, `.venv`,
  `.mypy_cache` (Python), `target` (Rust), `.gradle` (JVM), `bin`/`obj` (.NET),
  `vendor`/`storage` (PHP), `.svelte-kit`/`.angular`/`.astro` (JS frameworks) —
  merged with `excludePatterns` and still recorded per file.
- **Structural summaries for non-TypeScript languages.** Python, Go, Rust,
  Java/Kotlin/Scala, C#, PHP, Ruby and C/C++ now get imports, declarations and
  exports. Vue/Svelte/Astro components have their `<script>` block handed to the
  real TypeScript compiler.
- **`summaryQuality`** (`ast` / `structural` / `heuristic`) recorded per file and
  rendered in every part section, so a line-scan is never presented as a parse.
- **`preset`** option to force a preset by name; an unknown name is an error with
  the full list rather than a silent fallback.

### Changed

- Preset detection now reads the repository once per run and shares that view
  with every detector. `peerDependencies` and `optionalDependencies` count.
- A bare `package.json` ranks below any definitive language manifest, so a Go or
  Rust repo with a `package.json` for tooling is not mistaken for a Node library.

### Fixed

- **`outDir`/`tmpDir` pointing at an existing directory could destroy it.** A
  config with `outDir: "src"` or `tmpDir: "src"` deleted the user's source tree
  and exited 0: the scratch directory was removed outright, and the atomic swap
  renamed the directory aside, moved the snapshot in, then deleted the backup. A
  regular file named `snapshot` was destroyed the same way. Both directories are
  now refused unless they are empty, hold only placeholder dotfiles, or carry
  proof that a previous run wrote them (a `.codebase-snapshot` marker or a
  parseable `manifest.json`). Filenames alone are never treated as proof, so an
  existing `docs/README.md` is safe and hook-written artifacts do not block
  reruns.
- **A config that could not be parsed was silently ignored** — a typo produced a
  snapshot with none of the developer's settings and exit 0. Unparseable configs
  are now a hard error (exit 1, nothing written). A `.ts` config on a Node without
  type stripping is still only a warning.
- **Absolute `--out-dir` was honoured by `generate` but not by the readers.**
  `validate`, `report` and `explain` joined instead of resolving the path, so they
  looked for `<cwd>\<absolute path>` and reported a missing manifest immediately
  after a successful generate.
- **`--preset`/`--include`/`--exclude`/`--yes`/`--minimal`/`--force` were accepted
  and ignored outside `init`.** `snap generate --preset nextjs` silently used the
  detected preset. These are now a usage error (exit 2) on any other command.
- **`init --preset <typo>` silently fell back to detection**, writing a config for
  a preset nobody asked for. It is now a usage error listing every valid preset.
- **Astro components were summarized as markup.** The leading `---` fence — where
  the TypeScript actually lives — was not parsed, so the common case degraded to
  `heuristic` quality. It now goes through the compiler like Vue and Svelte.
- Summaries for `.jsonc` strip comments instead of reporting `invalid-json`.
- `export default function Foo` records both `Foo` and `default`.
- Parser diagnostics are counted and surfaced as warnings.

---

## 2.0.0

Configurable snapshots, `explain`/`diff` commands and correctness fixes.

### Added

- `artifacts`: switch each of the seven artifacts off individually, with
  `--skip-artifacts` and `--only-artifacts`.
- `include`: allow-list globs, applied before `excludePatterns`.
- `budgets.byLayer`: per-layer part budgets.
- `layersMode`: user layers merge with the detected preset by default.
- `hooks.afterGenerate`.
- `snap explain <path>` and `snap diff <a> <b>`.
- `generate --watch`.
- Byte budgets accept human sizes (`120k`, `1.5mb`) from CLI and config.
- Globs support brace groups and character classes (`*.{ts,tsx}`, `[abc]`).

### Fixed

- The monolith is built from pre-partition content, so `full-codebase.*` really is
  the whole codebase even when a part truncates a file.
- The part byte bound is enforced after the split-pass cap instead of being
  silently exceeded.
- Default-ignored files are recorded with `reason: "default-ignore"` instead of
  vanishing, including leftover `snapshot.backup-*` directories.
- Watch mode no longer retriggers itself on its own writes.

---

## 1.0.0

Initial release.
