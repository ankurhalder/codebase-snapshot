# Configuration reference

Every setting, every default, and what each one changes. For commands and options see the
[CLI reference](cli.md).

Nothing here is required: with no config at all the tool runs on the defaults below.

## Contents

- [Config files](#config-files)
- [Scoping: which files get in](#scoping-which-files-get-in)
- [Project presets](#project-presets)
- [Classification: layers and kinds](#classification-layers-and-kinds)
- [Sizing: byte budgets](#sizing-byte-budgets)
- [Artifacts: what gets written](#artifacts-what-gets-written)
- [Secrets: redaction](#secrets-redaction)
- [Output directories](#output-directories)
- [Hooks](#hooks)
- [Complete example](#complete-example)
- [Interactive setup](#interactive-setup)

## Config files

The first match wins:

```
snapshot.config.ts
snapshot.config.js
snapshot.config.mjs
snapshot.config.cjs
snapshot.config.json
.snapshotrc / .snapshotrc.json
package.json → "snapshot"
```

`snapshot.config.json` accepts comments. `package.json`'s `"snapshot"` key is read only when
no dedicated config file exists, and it must be an object (a wrong type is a warning, since
other tools use that key too).

The extension decides how the file is loaded. `.cjs` is always CommonJS and must use
`module.exports`; `.mjs` and `.ts` are always ESM and must use `export default`. `.js` follows
the package's `type` field — `module` means ESM, `commonjs` means CommonJS; with no `type`
Node decides by detecting the syntax, so `export default` works on current Node but is not
portable to versions without detection. Getting it wrong is the `Could not load …` error
above, not a silent fallback.

A config file that exists but cannot be parsed is a **hard error** (exit `1`, nothing
written). Silently ignoring it would produce a snapshot with none of your settings.

A `.ts` config needs Node ≥ 22.6 **and** an ES-module project, because Node applies the
package's `type` field to a `.ts` file. `codebase-snapshot init` picks the right filename for
the project — `.ts` when both conditions hold, `.mjs` otherwise — and writes a plain object
with no imports so it loads even when the package is only used through `npx`.

The snippets below show an `export default { … }` object for brevity. `init` writes it as
`const config = { … }; export default config;` because the anonymous form is reported by
`import/no-anonymous-default-export`, which `eslint-config-next` enables by default — both load
identically, so use whichever keeps your linter quiet.

CLI flags override the config for a single run (`--max-part-bytes`, `--out-dir`, …).
`--no-config` goes further and ignores every config file, so the run uses the built-in
defaults and the project's detected preset. A code config is executed when it is loaded, so
`--no-config` is also the way to snapshot a repository whose config you do not want to run —
see [the trust boundary](../SECURITY.md#trust-boundary).

## Scoping: which files get in

```js
export default {
  include: [],                    // allow-list; empty means "everything"
  excludePatterns: [],            // extra excludes, applied on top of the preset's
  discovery: "auto",              // "auto" | "git" | "walk" — how files are found
};
```

- `include` is an allow-list of globs. When non-empty, only matching files are considered.
- `exclude` is accepted as an alias of `excludePatterns` and means the same thing; the resolved
  config always records it under `excludePatterns`.
- `excludePatterns` removes files everywhere. Presets contribute their own ecosystem ignores
  on top; those are not removable, only addable to.
- `discovery` chooses how the file list is produced, and is recorded in `manifest.config`, so
  changing it shows up as config drift:
  - `"auto"` (default) — list through `git ls-files` when git can do it; if a `.git` directory
    exists but git cannot list the files, refuse rather than silently switch methods.
  - `"git"` — require git; a directory without a usable repository is an error.
  - `"walk"` — scan the tree and read `.gitignore` files directly (nested ones included), still
    skipping credential files. Use it when a `.git` directory cannot be listed. It cannot
    reproduce git's own ignore sources (`.git/info/exclude`, your global `core.excludesFile`),
    git's inclusion of files that are tracked although a `.gitignore` now matches them, or its
    treatment of a submodule as a single entry. The same setting is available per run as
    [`--discovery`](cli.md#options).

Built-in ignores always apply: `.git`, `node_modules`, `.next`, `dist`, `build`, lockfiles,
minified assets and binaries. Sensitive files are handled separately (see
[Secrets](#secrets-redaction)).

Every path the scanner discovers is recorded in `manifest.skipped[]` with the reason and the
rule that matched — nothing it sees is dropped silently, including a `.gitignore`d path in a
repository where git does the filtering. See the [`skipped[]`
reasons](output.md#skipped). To debug one path:

```bash
npx codebase-snapshot explain src/some/file.ts
```

## Project presets

Detection reads the repository **once** and picks the highest-priority match, so a Next.js
app inside a pnpm workspace is still `nextjs`, not `monorepo`. `peerDependencies` and
`optionalDependencies` count as dependencies. A bare `package.json` ranks below any
definitive language manifest, so a Go or Rust repository with a `package.json` for tooling is
not mistaken for a Node library.

| Preset | Priority | Detected from | Budget | Ecosystem ignores |
| :--- | ---: | :--- | :--- | :--- |
| `nextjs` | 100 | `next.config.*`, or `next` | 300k | `.svelte-kit`, `.astro`, `.vite`, `.output` |
| `nuxt` | 98 | `nuxt.config.*`, or `nuxt` | 200k | `.nuxt`, `.output` |
| `sveltekit` | 96 | `svelte.config.*`, `@sveltejs/kit` | 200k | `.svelte-kit`, `.vercel` |
| `remix` | 94 | `@remix-run/*` | 200k | `.cache`, `public/build` |
| `astro` | 92 | `astro.config.*`, `astro` | 150k | `.astro`, `dist` |
| `angular` | 90 | `angular.json`, `@angular/core` | 200k | `.angular`, `dist` |
| `solid` | 88 | `solid-js`, `solid-start` | 120k | `.solid`, `dist` |
| `vue-vite` | 86 | `vue` + `vite`/`vite.config.*` | 120k | `.vite`, `dist` |
| `react-vite` | 84 | `react` + `vite`/`vite.config.*` | 120k | `.vite`, `dist` |
| `nest` | 80 | `@nestjs/core` | 200k | `dist`, `node_modules` |
| `node-express` | 78 | `express`, `fastify`, `koa`, `@hapi/hapi` | 200k | `dist` |
| `monorepo` | 70 | `pnpm-workspace.yaml`, `nx.json`, `turbo.json`, `lerna.json`, `"workspaces"` | 200k | `.turbo`, `.nx` |
| `python-django` | 56 | `manage.py`, django in `pyproject.toml`/`requirements.txt` | 150k | `__pycache__`, `.venv`, `venv`, `.mypy_cache`, `.pytest_cache`, `.tox`, `.eggs`, `staticfiles`, `media` |
| `python-fastapi` | 54 | fastapi or flask in `pyproject.toml`/`requirements.txt` | 150k | `__pycache__`, `.venv`, `venv`, `.mypy_cache`, `.pytest_cache`, `.tox`, `.eggs` |
| `go` | 50 | `go.mod` | 200k | `vendor`, `testdata` |
| `rust` | 48 | `Cargo.toml` | 200k | `target` |
| `java-spring` | 46 | `pom.xml`, `build.gradle`, `build.gradle.kts` | 200k | `.gradle`, `out`, `target` |
| `node-lib` | 45 | any `package.json` | 120k | `dist` |
| `dotnet` | 44 | `*.csproj`, `*.sln`, `global.json` | 200k | `bin`, `obj`, `.vs` |
| `php-laravel` | 42 | `artisan`, laravel in `composer.json`, `composer.json` | 150k | `vendor`, `storage`, `bootstrap/cache`, `public/build` |
| `ruby-rails` | 40 | `Gemfile`, `config.ru`, `Rakefile` | 150k | `.bundle`, `log`, `tmp`, `vendor/bundle`, `public/assets` |
| `python-lib` | 30 | `pyproject.toml`, `setup.py`, `requirements.txt`, `.py` files | 120k | `__pycache__`, `.venv`, `venv`, `.mypy_cache`, `.pytest_cache`, `.tox`, `.eggs` |
| `infra` | 24 | `*.tf`, `Chart.yaml`, `kustomization.yaml`, `docker-compose.yml` | 100k | `.terraform`, `.terragrunt-cache` |
| `docs` | 22 | ≥ 3 markdown files and no `package.json` | 100k | `.docusaurus`, `.vitepress/dist`, `site` |
| `generic` | 0 | anything else | 120k | — |

Each detector reports **the signal that fired**, not just a verdict: `next.config.ts`, `depends on
express`, `django in pyproject.toml`. The first run prints it — `Detected nextjs` / `Because
next.config.ts` — so a detection can be checked rather than taken on faith. `generic` is the
fallback, reached only when no detector matched, and the first run says so instead of pretending it
recognised the project.

A preset contributes layers, kinds, ignores and a recommended budget — what `init` writes as
`maxPartBytes`. Force one when detection is wrong:

```js
export default { preset: "react-vite" };
```

An unknown name is an error listing every valid preset, never a silent fallback. The resolved
preset is recorded in `manifest.config.preset`, so changing it shows up as config drift.

## Classification: layers and kinds

Layers group files (roughly directories), kinds label their role. Both are first-match-wins
with `other` as the fallback, and both accept a glob string, a `RegExp`, or a function.

```js
export default {
  layersMode: "merge",         // "merge" (default) or "replace"
  layers: [
    { name: "api", match: "src/api/**" },
    { name: "ui", match: /\.(tsx|vue|svelte)$/ },
  ],
  kinds: [
    { kind: "route", match: /(^|\/)route\.tsx?$/ },
    { kind: "hook", match: "src/hooks/**" },
  ],
};
```

A layer rule is `{ name, match }` and a kind rule is `{ kind, match }`. The label key is
different in each, and a row that gets it wrong is rejected rather than silently ignored, so
copy the shapes above.

- `layersMode: "merge"` keeps the preset's rules and lets yours win by being evaluated first.
- `layersMode: "replace"` discards the preset's rules entirely.

Classification drives per-layer budgets and the `Layers:` breakdown in `report`.

## Sizing: byte budgets

```js
export default {
  maxPartBytes: "300k",        // hard ceiling per part; default 307200, minimum 4096
  // maxPartTokens: 32000,     // a per-part ceiling in tokens; narrows maxPartBytes (tokens x 4)
  // changedSince: "main",      // only files changed since this git ref
  // staged: true,             // only files staged for the next commit
  // withDependents: true,     // ...and the files that import them
  largeFileBytes: "200k",      // above this a file becomes a head/tail preview
  previewHeadLines: 80,
  previewTailLines: 40,
  budgets: {                   // optional per-layer overrides
    default: "120k",
    byLayer: { docs: 40_000, core: 300_000 },
  },
};
```

Sizes accept bytes (`307200`), `"120k"`, `"1.5mb"`, and spaces (`"120 k"`). Zero and negative
values are errors; so is anything below 4096 — a part budget that small cannot hold a header,
let alone code.

The budget is a hard ceiling: a part never exceeds it. A single file larger than the budget is
not split mid-file — it becomes a head/tail preview, marked `isPreviewTruncated`.

`budgets.byLayer` lets expensive layers get more room than generated docs, for example.

## Artifacts: what gets written

```js
export default {
  artifacts: {
    readme: true,          // snapshot/README.md
    manifest: true,        // snapshot/manifest.json
    parts: true,           // snapshot/parts/*.md
    navigation: true,      // snapshot/reports/navigation.md
    projectTree: true,     // snapshot/reports/project-tree.md
    audit: true,           // snapshot/reports/audit.md
    monolith: false,       // full-codebase.json + full-codebase.md
  },
};
```

Everything except `monolith` is on by default; `monolith` follows `includeMonolith`. Turn
artifacts off with the config, `--skip-artifacts a,b`, or `--only-artifacts a,b` (the two
cannot be combined).

Two combinations warn because they produce a snapshot that contradicts itself: `manifest` off
means `validate` and `report` cannot inspect the snapshot, and `parts` off with `navigation`
on leaves links pointing at files that were never written. Both are allowed.

The `.codebase-snapshot` ownership marker is always written, whatever the selection.

See [Snapshot output](output.md) for the layout and the manifest schema.

## Secrets: redaction

```js
export default {
  secrets: {
    customPatterns: [
      { rule: "github-pat", pattern: /ghp_[A-Za-z0-9]{36}/ },
      { rule: "internal-token", pattern: /CORP-[A-Z0-9]{32}/ },
    ],
    disableDefaultPatterns: false,
  },
  includeSensitiveFiles: false,   // .env, *.pem, .npmrc, .ssh/, .tfstate …
};
```

Each entry is `{ rule, pattern }`, where `rule` is the name that appears in the audit and
`pattern` is a `RegExp`, or a string in a `.json` config. A bare `RegExp` in the array works
too — it comes out as `custom-1`, `custom-2`, … in the findings — but naming the rule is what
makes an audit entry mean something.

- Credential-bearing **files** are skipped by default and listed in `skipped[]` with reason
  `sensitive-file`. `includeSensitiveFiles: true` emits them.
- Secret-shaped **strings** inside ordinary files are redacted in the emitted parts. Only the
  matched span is masked, never the whole line, and no excerpt of a matched line reaches any
  artifact. Multi-line PEM keys are masked as a block.
- `customPatterns` add rules; `disableDefaultPatterns` removes the built-in set — it does not
  disable redaction itself.

Redaction is **fail-closed**, so a placeholder is indistinguishable from a secret: a
`.env.example` whose line reads `JWT_SECRET=replace-with-base64url-48-bytes` is masked like a
live key would be, and a test fixture literal such as `process.env.X_SECRET = "test-value"` is
masked too. The same holds for an environment reference written as a quoted value —
`password: "${DB_PASSWORD}"` is masked exactly like a literal password, because the rule sees a
credential-shaped key followed by a string and a `${…}` reference cannot be told apart from a
secret by shape alone. That is the intended trade-off — the alternative is guessing which values
are throwaway — and it is worth knowing before you hand the snapshot to a model and find the
template less readable than the original. To narrow it, remove a rule by name with
`disableDefaultPatterns: true` plus your own `customPatterns`.

Findings are summarised in `reports/audit.md` (one row per line, naming every rule that matched
it), counted in `manifest.totals.redactedLines`, and shown in the `generate` summary as a
`Redacted:` line separate from `Warnings:`.

## Output directories

```js
export default {
  outDir: "snapshot",
  tmpDir: "snapshot.tmp",
};
```

`outDir` may not be the working directory, an ancestor, or the filesystem root, and
`outDir`/`tmpDir` may not contain one another — the message prints the resolved paths. Writes
are atomic: the previous snapshot survives until the new one is complete.

Both directories are also **refused if they already exist and this generator did not write
them**, so `outDir: "src"` cannot replace your source tree. Ownership is proved by the
`.codebase-snapshot` marker and nothing else: a JSON object naming this generator, with a
schema version this build understands, a per-snapshot `id`, and the list of entries it wrote.
A file with that name but no valid marker, or a directory holding a manifest from another
tool, is refused. The proof is never a filename, so an existing `docs/README.md` is safe.

Files your hook writes into the output directory are recorded in the marker's entry list, so
they do not block later runs; a file you add by hand afterwards does, because it is not in the
snapshot the marker describes.

## Hooks

```js
export default {
  hooks: {
    afterGenerate: (manifest) => {
      // runs after a real generate; a dry run does not call it
    },
  },
};
```

A throwing hook is downgraded to a warning on the manifest — it never loses a snapshot that
was already written. A hook may return a promise: it is not awaited (this API is synchronous),
and a rejection is recorded as a warning on the re-shipped manifest and marker. Anything the
hook writes to stdout is redirected to stderr for the duration of the call, so `--format json`
stays parseable.

"Not awaited" does not mean "free": Node keeps the process alive while the hook's own timers,
sockets or pending I/O are outstanding, so a hook that schedules a long job delays the command by
that long even though the snapshot is already written. Keep `afterGenerate` short — hand long work
to a background process — or use the programmatic `generateSnapshot`, whose promise you can `await`
alongside your own work.

A hook may write its own files into the output directory; that is safe across reruns because
ownership is established by the marker rather than by the filenames present.

A hook runs in the **process** working directory, so with `--cwd elsewhere` a relative path
resolves against your shell, not the target repository. Use the absolute paths on `manifest`
(or resolve against `outDir` yourself) when passing `--cwd`.

## Complete example

Every setting at its built-in default. Nothing here has to be written — the tool runs on these
values with no config at all.

```js
const config = {
  // ── Project ──────────────────────────────────────────────
  preset: "detected",            // "detected" auto-detects; or name one of the 25
  branch: "main",                // recorded when git cannot report one

  // ── Output ───────────────────────────────────────────────
  outDir: "snapshot",
  tmpDir: "snapshot.tmp",

  // ── Size ─────────────────────────────────────────────────
  maxPartBytes: "300k",
  largeFileBytes: "200k",
  previewHeadLines: 80,
  previewTailLines: 40,
  budgets: { default: "300k", byLayer: {} },

  // ── Scope ────────────────────────────────────────────────
  include: [],
  excludePatterns: [],
  discovery: "auto",                 // "auto" | "git" | "walk"

  // ── Artifacts ────────────────────────────────────────────
  artifacts: {
    readme: true,
    manifest: true,
    parts: true,
    navigation: true,
    projectTree: true,
    audit: true,
    monolith: false,
  },

  // ── Safety ───────────────────────────────────────────────
  includeSensitiveFiles: false,
  secrets: { customPatterns: [], disableDefaultPatterns: false },

  // ── Classification ───────────────────────────────────────
  layersMode: "merge",
  layers: [],
  kinds: [],

  // ── Advanced ─────────────────────────────────────────────
  includeMonolith: false,
  maxMonolithBytes: null,
  hooks: {},
};

export default config;
```

Deleting any line is safe — the defaults are real, and each one is what the comment says.

The object is exported through a name because `export default { … }` is reported by
`import/no-anonymous-default-export`, which `eslint-config-next` enables by default: the inline
form made the generated file a lint error on first save in a Next.js project. A named export is
also what lets you reference the object (from a test, or from `--dry-run`) without a wrapper.

This is **not** byte-identical to a generated file. `codebase-snapshot init` starts from these
values and substitutes two things: `preset` becomes the detected name (`node-lib` for a plain
npm package), and `maxPartBytes` with `budgets.default` become that preset's
`recommendedBudget` (`"120k"` in the same project). `generate` on its own applies no
recommended budget — without a config it uses `--max-part-bytes`, default 307200 — so the
preset's figure only takes effect once `init` has written it into a config.

## Interactive setup

```bash
npx codebase-snapshot init
```

Walks every tunable parameter, showing the detected value as the default — press `enter` through
the lot and you get the recommended configuration.

The bare `snapshot` command starts the same wizard when the project has no config, but asks one
question first: take the recommended setup in a single keystroke, walk through each setting, or pick
a different preset. Every prompt has a flag, so the same setup works non-interactively:

```bash
npx codebase-snapshot init --yes
npx codebase-snapshot init --preset go --max-part-bytes 200k \
    --include "cmd/**,internal/**" --exclude "**/*_test.go" --yes
```

`--dry-run` prints the config and writes nothing. `--force` replaces an existing ES-module
config (`.ts`, `.js`, `.mjs`) in place; without it, an existing config is left alone and the
command exits `1`.

It will not replace a JSON-family config — `snapshot.config.json`, `.snapshotrc`,
`.snapshotrc.json`, or the `"snapshot"` key in `package.json` — because this wizard writes an
ES-module file and a new file beside the old one would silently shadow it. Those cases exit `1`
with a message naming the file to delete or rename. Note that this means `--force` writing
`snapshot.config.ts` does shadow a `"snapshot"` key in `package.json`, since a dedicated config
file always wins.
