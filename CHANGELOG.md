# Changelog

All notable changes to `@ankurhalder/codebase-snapshot`.

---

## 4.0.1

### A credential in a file name no longer reaches the snapshot

A path that contained a token was masked only when the file was skipped *for that reason*. If it
was skipped earlier — as a credential-bearing file (`certs/AKIA….key`), by `.gitignore`, by a user
exclude or by the built-in ignore list — the raw path was written into `manifest.skipped[].path`
and the audit table, and a binary file whose name carried a token still reached the manifest as
`binary`. Custom `secrets.customPatterns` were not applied to paths at all, so a file named
`src/CORP-<32>.ts` was *included* and the token landed in the parts, the navigation index and the
project tree — the payload written to be pasted into a model.

Path masking now runs over every skip record regardless of reason, and the included-file check
uses the default **and** custom rules, so a custom-rule hit becomes a `sensitive-path` skip with a
masked path. A tested fixture with all four shapes produces zero occurrences of either token in
any file under `snapshot/`.

### `report` no longer re-scans the repository

`report` printed an integrity verdict by calling the validator, which re-reads every file: 4.5 s
on a 20 000-file repository to print a summary already on disk. It now reads `manifest.json` and
nothing else — **0.54 s** on the same repository — and says plainly that drift is `validate`'s job.
---

## 4.0.0

### `snap` is back

3.0.0 removed the `snap` alias after I misdiagnosed why `npx @ankurhalder/codebase-snapshot`
printed nothing. **The removal was unnecessary and this release reverses it** — both
`codebase-snapshot` and `snap` are published again.

The real cause, confirmed by reading npm's own resolver
(`libnpmexec/lib/get-bin-from-manifest.js`): npm resolves a package from its `bin` entries, and
when every entry points at the same file it treats them as aliases and resolves one. Two
aliases were always fine. What actually broke the bare command was a **stale global install on
the test machine** — a leftover `npm link` back to the development checkout, which made `npx`
run that instead of the published package. A clean profile runs the same command correctly, with
either one or two aliases.

If you ever hit a silent exit 0:

```bash
npm ls -g --depth=0 | grep codebase-snapshot
npm rm -g @ankurhalder/codebase-snapshot
```

### Security: the redaction layer was rebuilt

Independent adversarial review found credentials reaching `parts/*.md` while `audit.md` reported
them as redacted. That is the worst failure this tool can have — its output is written to be
pasted into a model — so the layer was rewritten rather than patched.

Leaks that were real and are now closed, each with a regression test:

- **CRLF checkouts.** Line-oriented rules ended in `$`, and a `\r` before the newline stopped the
  match, so `export TOKEN=…` in a Windows checkout printed in the clear while the byte-identical
  LF file was redacted. Scanning now splits on `\r\n`, `\n` and `\r` and preserves line numbers.
- **Trailing comments and trailing spaces.** `export TOKEN=abc # rotate quarterly` leaked because
  the value had to be the last thing on the line. The rule now matches the value, not the tail.
- **camelCase keys and short values.** `awsSecret`, `dbPassword: "hunter2"` and similar were never
  matched because only snake_case spellings were. Credential **names** now drive matching, and the
  value is masked regardless of length.
- **Unquoted YAML / docker-compose.** `POSTGRES_PASSWORD: hunter2` is now covered, while
  expressions (`password: req.body.password`, `getToken()`, `process.env.SECRET`) are explicitly
  not.
- **Sensitive file names.** `.env~`, `.env.swp`, `.npmrc ` (trailing space), `.vault-token`,
  `prod.env`, `secrets.toml` and friends are denied; deny-list matching normalises the name
  instead of anchoring on the exact spelling.
- **Secrets in a path.** A filename containing a token is skipped as `sensitive-path` with the
  path span-masked, instead of being printed in the tree, the navigation index and the manifest.
- **Authorization headers, and nine vendor prefixes** (`glpat-`, `hvs.`, `s.`, `xoxc/xoxd`,
  `whsec_`, `dckr_pat_`, `hf_`, `ya29.`) are now detected.

Masking is **span-only**: `dbPassword: "[REDACTED…]"` keeps the key and the rest of the line. That
also fixed the opposite defect — over-redaction that corrupted ordinary code (`id-token: write`,
`{ pass: 3 }`, and an unrelated string on a line that also contained a credential) is now
explicitly negative-tested.

The built-in rule count is now **29** (was 21).

**Known limitations, stated rather than hidden** (see [SECURITY.md](SECURITY.md)): detection is
pattern-based, so a secret deliberately split across two string literals is not caught, and
unusual credential shapes can still be missed. Do not treat a clean audit as a guarantee.

### The ownership marker is now evidence, not a filename

`generate` deletes the previous snapshot, and it decides whether it is allowed to by checking
whether it wrote that directory. The check was forgeable: an empty `.codebase-snapshot` file, or a
three-key `manifest.json`, was enough to make the tool delete a directory full of someone else's
files.

`.codebase-snapshot` is now a JSON record — generator name, schema version, a random run id, a
state, a digest of the manifest and an inventory of everything written. Replacement requires the
marker to be complete and every file in the directory to be in that inventory; anything else
blocks the run and is named in the message. The same evidence rule now applies to `tmpDir`, which
used to be deleted wholesale. Concurrent runs take a per-`outDir` lock, so four simultaneous
`generate` invocations leave one complete snapshot rather than a manifest describing parts that
are gone.

### Correctness

- **JSONC comments in strings.** A valid `package.json` containing `//` anywhere in a string
  (`"build": "tsc && echo done//ok"`) made every command fail with "the config could not be
  read". The stripper is now a state machine that respects strings and escapes.
- **Configs that are not objects.** `export default Promise.resolve({…})` was silently treated as
  an empty config; a thenable, array or primitive is now a hard error naming what it received.
- **Wrong-typed settings.** `excludePatterns: "src/**"` and `previewHeadLines: 0` were silently
  ignored. Every setting is now validated, and the error names the setting, the expected shape and
  what arrived.
- **`layers` rejected the documented shape.** `{ name: "api", match: … }` — the shape the type
  declares and the generated config recommends — crashed `generate` with a `TypeError`. Both
  `layers` and `kinds` are validated up front, `name` is canonical for layers with `layer` as an
  alias, and a bad rule is an error naming the index rather than a crash.
- **`preset: "detected"`**, which `describe` published as the default, was rejected as an unknown
  preset. `detected` and `auto` are now accepted.
- **Budget precedence.** `--max-part-bytes` lost to `budgets.default`, so the banner said "Part
  budget: 4 KB" while 151 KB parts were written. The order is now CLI > config `maxPartBytes` >
  `budgets.default` > 300 KB, and `budgets.byLayer` is capped by the chosen budget.
- **The output directory was scanned into the next snapshot.** `--out-dir .context` produced a
  snapshot that included its own previous manifest, so the fingerprint changed on every run and
  `validate` failed immediately after `generate`. The resolved `outDir`/`tmpDir` are excluded as
  tool-owned paths, silently and identically on the first run.
- **The monolith contained previews.** `full-codebase.md` was supposed to be the whole repository
  in one file, but a 400 KB file contributed about 3 KB — its head/tail preview. The monolith now
  carries full redacted bodies; `largeFileBytes` governs the parts only.
- **A failing hook disappeared.** `hooks.afterGenerate` throwing printed a warning, but the
  manifest had already been written, so the warning was not in it. The manifest is now rewritten
  with the final warning list (the hook still runs once).
- **`--out-dir` with a missing parent** failed with a raw `ENOENT` from the rename; parents are
  now created, an ancestor that is a file is refused cleanly, and a failed run no longer leaves
  `snapshot.tmp` behind.
- **`validate` exempted skipped files forever.** A file skipped as binary, then rewritten as
  source, was never reported as new. Skips are re-evaluated.
- **`--dry-run` skipped the output guard**, claiming it would write into a directory the real run
  refuses. A dry run now runs the same guard and exits the same way.
- **`diff` reported `before undefined undefined file(s)` and exited 0** on a manifest that was not
  a snapshot. Both sides are validated and the malformed one is named.
- **`reactComponents` listed plain classes.** A component now requires JSX/`createElement` or a
  React base class.
- **A filename could escape a code fence.** A file named ``` ``` ``` closed the `## Files` fence
  and let the next filename be rendered as live markdown — a prompt-injection vector in a file
  built for LLMs. Fences are now chosen from their content.
- **`--watch` never reloaded the config.** Editing the config while watching appeared to work
  while the old settings stayed in force; a broken config regenerated silently instead of
  reporting the error.
- **`reports/audit.md` said "Redacted Content Bytes"** when it meant emitted bytes. Renamed
  "Emitted Content Bytes".

### CLI honesty

- **Options that do not apply to a command are now rejected** (exit 2) instead of being parsed and
  ignored: `--watch` is generate-only, `--dry-run` is generate/init, config and size options do
  not apply to `diff`/`describe`/`skill`. The published `appliesTo` column is now generated from
  the same table the parser enforces, so the contract cannot drift from the CLI again.
- **`--no-config`** ignores `snapshot.config.*` and runs on the built-in defaults — useful in a
  checkout you do not trust, because a `.ts`/`.js`/`.mjs`/`.cjs` config is imported and executed.
- **`explain` always exits 0** when it can answer; the verdict is `included`/`reason`. Exit 1 now
  only means the command could not run.
- **`skill --format json`** emits JSON instead of markdown.
- **`init` writes `includeMonolith`** (the file now lists every setting, as it claims), honours
  `--out-dir`, refuses to silently override a `package.json#snapshot` config, and no longer says
  `Next: npm run snapshot` in a directory with no `package.json`.

### Upgrading from 3.0.0

- **Old snapshots are refused, not replaced.** A snapshot written by 3.0.0 carries a marker in the
  old format, so `generate` will stop and ask you to remove the directory or point `--out-dir`
  somewhere else. This is deliberate: the old marker could not prove the directory was ours.
- `explain` no longer exits 1 for a file that would be skipped.
- Attention-only flags (`--watch` on `validate`, for example) are now usage errors.
- With `--include-monolith`, the monolith is much larger, because it now actually contains the
  code.

### Documentation and packaging

Every document was rewritten against the current behaviour rather than patched:

- **New** [docs/cli.md](docs/cli.md) — every command, every option with its default and which
  commands it applies to, exit codes, output streams, worked examples.
- **New** [docs/output.md](docs/output.md) — the snapshot layout and the complete
  `manifest.json` schema, field by field, including how to read `skipped[]`.
- **New** [docs/troubleshooting.md](docs/troubleshooting.md) — every message the tool prints,
  its cause and its fix.
- **Rewritten** README, [docs/install.md](docs/install.md),
  [docs/configuration.md](docs/configuration.md) and [docs/agent.md](docs/agent.md).
- **New** [AGENTS.md](AGENTS.md) for agents working in the repository and
  [llms.txt](llms.txt) for AI discovery.
- **New** CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, issue forms and a pull request
  template.

Corrections worth calling out, because the old text was wrong:

- The generated config was documented as importing `defineConfig`; it has been a plain object
  with no imports since 2.2.0, so that it loads when the package is only used through `npx`.
- The "bin-less placeholder" explanation for the bare `npx` failure has been removed. The
  placeholder version is unrelated and harmless.
- `snap init` writes an `.mjs` config for a CommonJS project, not a `.ts` one — the
  documentation now states the rule.

Packaging: `prepare` was replaced with `prepack`, so installing the package no longer triggers an
install-script warning, and the published tarball is still built from source. The test suite now
includes an end-to-end agent simulation that follows the six workflow steps published by
`describe` and asserts the resulting snapshot.

---

## 3.0.0

### BREAKING: the `snap` executable is gone; use `codebase-snapshot`

The package now ships **exactly one** executable, `codebase-snapshot`.

This is what makes the bare form work. `npx @ankurhalder/codebase-snapshot generate`
used to exit 0 printing nothing, on every npm version and every OS, because of how npm
picks a binary: it matches the command you typed against the package's `bin` keys, and no
key can contain an `@scope/`. With two executables (`snap` and `codebase-snapshot`)
nothing matched, so nothing ran. With one, npm uses it regardless of its name.

Verify the rule against packages you know: `@sentry/cli`, `@babel/cli` and
`@changesets/cli` all ship one executable and run fine by bare name;
`@swc/cli` ships three and fails with "could not determine executable to run";
`npm-check-updates` ships two but is unscoped, so its name matches one of its bins.

Migration:

| Before | After |
| :--- | :--- |
| `snap generate` | `codebase-snapshot generate` |
| `npx snap` | `npx codebase-snapshot` |
| `npm run snapshot` (generated by `init`) | unchanged — it already used `codebase-snapshot` |

Nothing else in the API changed: the library exports, the config format, the manifest
schema and every command and option are identical.

### Changed

- The agent contract no longer claims the bare spec is unusable. It documents one
  executable and explains why, so an agent does not add a pin it does not need.
- `docs/install.md` explains the single-executable rule instead of the previous
  (incorrect) "bin-less placeholder" theory.

### Note on `0.0.0-stage`

Earlier notes suggested unpublishing a `0.0.0-stage` placeholder to fix the bare form.
That diagnosis was wrong — the placeholder is unrelated and can stay. The npm behaviour
above is the real cause, and the single-executable change fixes it for everyone with no
registry surgery.

---

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
