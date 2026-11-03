# 03 — API, Packaging, CLI-vs-README, Test Coverage, CI

Auditor: lead (the delegated `api-build-auditor` failed before reporting; its PoC evidence under
`audit/poc/api-*` was harvested and independently re-verified).

Environment: Node v24.12.0, Windows, `dist/` freshly built from current `src/` (`npm run build` clean,
`npx tsc --noEmit` clean, `npm test` 9/9 pass).

---

## 1. CLI behaviour vs README claims

README documents 4 commands and 5 options. Verified by executing `node dist/cli.js` against a temp fixture.

| README claim | Verdict | Evidence |
| :--- | :--- | :--- |
| `generate` (default) works | **OK** | produces parts/reports/manifest |
| `validate` / `check` works | **OK (weak)** | exit 0 on clean; exit 1 on drift — but only hash-checks source files, never `parts/*.md` (see 02 §6) |
| `init` creates `snapshot.config.ts` | **OK**, but see §3 — the file it writes cannot be loaded on Node 18/20 |
| `report` prints metrics | **OK** | requires an existing manifest, exits 1 otherwise |
| `--cwd <path>` | **OK** (space form only) | `--cwd=path` is silently ignored → §2 |
| `--include-monolith` | **OK** | writes `full-codebase.json` + `.md` |
| `--max-part-bytes <n>` | **NOT honored** | `--max-part-bytes 500` → parts of **631 B and 797 B** (1.26× / 1.59× over). Root cause in 02 §4 |
| `--large-file-bytes <n>` | **OK** | changes truncation threshold |
| `--format <text\|json>` | **BROKEN for `generate`** | progress lines precede the JSON → `JSON.parse` fails |
| `snap` alias | **OK** | both bin entries point at `dist/cli.js` |

### 2. Argument parser defects (all PROVEN by execution)

```
unknown command 'frobnicate'      exit=0  -> silently runs `generate`
unknown flag --nonsense           exit=0  -> silently ignored
equals form --cwd=<path>          exit=1  -> IGNORED; validated process.cwd() instead -> false "drift"
space form --cwd <path>           exit=0  -> works
equals form --format=json         exit=0  -> IGNORED; text output emitted
--max-part-bytes abc              exit=0  -> parseInt -> NaN, no error, undefined behaviour
```

Three distinct problems, one root cause (`src/cli.ts:36-110`):

1. **No `--opt=value` support.** Only `--mode=` is handled (`cli.ts:67`); every other option requires a
   separate token. `--cwd=…`/`--format=…` are dropped *silently*, so the tool operates on the wrong
   directory and reports a bogus drift failure. This is the highest-impact CLI bug: it makes `validate`
   lie in CI pipelines, where `--flag=value` is the idiomatic form.
2. **Unknown arguments are ignored.** A typo'd subcommand (`valdate`, `genrate`) silently runs the
   **writable** default command `generate` and overwrites the snapshot instead of failing with usage help.
3. **No numeric validation.** `parseInt` accepts `NaN`, `-5`, `0`; `NaN` makes every budget comparison
   false and silently disables partitioning.

**Fix:** replace the hand-rolled loop with `node:util`'s `parseArgs({ allowPositionals: true, strict: true })`
— it rejects unknown flags, supports `--opt=value`, and gives typed values. Then validate numerics
(`Number.isFinite(n) && n > 0`).

### 3. `--format json` is not machine-readable (PROVEN)

```
$ node dist/cli.js generate --cwd <fixture> --format json > out.json
$ python -c "json.load(open('out.json'))"
PARSE FAILED: Unexpected character ... line 0, position 0
  first lines: 📸 Generating snapshot for: <fixture>
               Branch: main | Part budget: 300 KB
               { "schemaVersion": "2.0.0", ...
```

`src/cli.ts:188-196` prints two human-readable progress lines *before* the JSON on the generate path.
The `validate`/`report` paths are fine (single JSON document). Anyone piping `--format json` into `jq`
or a CI parser gets a hard failure.

**Fix:** route all human output through a `logger` writing to `stderr`, keep `stdout` for payloads only
(standard CLI contract), or emit the progress lines only when `format === "text"`.

### 4. `--dry-run` and `--force` are parsed and then ignored — `--dry-run` is destructive

`parseArgs` sets `dryRun`/`force` (`cli.ts:91-95`), `CliOptions` carries them, and **nothing ever reads
them**. Confirmed by tracing all `writeFileSync`/`rmSync`/`renameSync` calls:

```
$ node dist/cli.js generate --cwd <fixture> --dry-run
WRITE part-001.md 48774B     WRITE navigation.md    RM snapshot     RENAME snapshot.tmp -> snapshot
WRITE project-tree.md       WRITE audit.md         ...same writes as a normal run
```

`--dry-run` performs the **full destructive write sequence**, including `rmSync(existing outDir)`. A user
who adds `--dry-run` to preview a change loses their previous snapshot. Also `--monolith-content` and
`--max-monolith-bytes` exist in `CliOptions`/`config.ts` but have **no CLI flag at all** — dead config.

**Fix:** implement `dryRun` (compute and print the plan, write nothing) or delete the flag from both the
parser and `CliOptions`; add the missing monolith flags or drop those fields.

### 5. Packaging & distribution

```
npm pack --dry-run  ->  11 files, 560.8 kB unpacked, 119.3 kB tarball
   dist/{index.js,index.cjs,index.d.ts,index.d.cts,cli.js}  +  4 × .map (~366 kB, 65% of the tarball)
```

| Item | Finding | Severity |
| :--- | :--- | :--- |
| `exports["."].types` | present, but **no per-condition `types`**; `require` consumers get `dist/index.d.ts` while the matching `dist/index.d.cts` is emitted and **never referenced** — dead file | LOW |
| `exports["./cli"]` | `import` only: **no `require` condition, no `types`** → `require("@ankurhalder/codebase-snapshot/cli")` fails (`ERR_PACKAGE_PATH_NOT_EXPORTED`) | MEDIUM |
| `exports["./package.json"]` | **missing** → `import "…/package.json"` and `require("…/package.json")` both fail; breaks version-detection tooling, bundler plugins, and `npm view`-style introspection | LOW |
| `sideEffects` | **missing** → bundlers must assume the module has side effects; prevents tree-shaking of the 18 exports | LOW |
| `prepare`/`prepack` | **missing**. `prepublishOnly` runs on `npm publish` only. A fresh clone → `npm pack` / `npm install <git-url>` ships **no `dist/`** → unusable package | MEDIUM |
| sourcemaps shipped | `files: ["dist"]` includes `.map`; `sourcesContent` publishes the full TypeScript source and inflates the tarball ~3× | LOW |
| `dependencies.typescript` | **correct as-is.** Verified `typescript` is *not* inlined — `dist/index.js` is 53 kB and contains no `typescript` import; tsup externalizes it. It is imported at runtime by `ast/ts-parser.ts`, so it cannot be a devDependency. Cost: every install pulls the ~30 MB TypeScript compiler for what is optional AST metadata | INFO |
| `engines.node >= 18` | plausible for the library; **not** for the `.ts` config format (§6) | see §6 |

### 6. `init` writes a config the tool cannot load on supported Node versions

`runInit()` (`cli.ts:112-132`) emits `snapshot.config.ts`, and `loadConfigFile` `await import()`s it
(`config.ts:38`). Native `.ts` import needs Node ≥ 22.6 (type stripping). `engines` claims **>= 18** and
CI tests 18/20/22. On Node 18/20 the import throws `ERR_UNKNOWN_FILE_EXTENSION`, which
`catch { continue; }` (`config.ts:40-42`) **swallows**, so the config is silently ignored and the defaults
are used. The README's entire "Configuration" section documents this unusable-on-CI format.

*(Verified working on Node 24.12; the Node ≤20 failure is inferred from the engine matrix and the
swallow — only Node 24 is installed here. The swallow itself is proven: any config error yields
`loadConfigFile → null` with no message.)*

**Fix:** either emit `snapshot.config.json`/`.mjs` from `init`, or raise `engines` to `>=22.6` and say so;
in all cases `console.warn` the swallowed reason.

### 7. Public API surface

- `generateSnapshot` is declared `async` but contains **zero `await`** — it is fully synchronous and
  blocks the event loop (503 files / 2.68 MB took 0.74 s; a large monorepo blocks for minutes). The
  `async` signature promises concurrency that does not exist. Either go sync (`generateSnapshotSync` +
  thin async wrapper) or actually stream/chunk with `await`.
- Argument discrimination uses `"secretRules" in (configInput || {})` (`index.ts:49-52`): a caller passing
  a `SnapshotConfig` that happens to carry an extra key is misread, and the two accepted argument shapes
  are indistinguishable by type. Use a brand symbol or two functions.
- `identity.ts`-style duplicate fields in `types.ts` — `path`/`relativePath`, `sizeBytes`/`bytes`,
  `hashSha256`/`sha256`, `bytes`/`byteSize` — are written in pairs at every construction site
  (`index.ts:158-177`, `:270-288`, `chunker.ts:106-127`). Nothing reads the legacy aliases except
  `navigation.ts:34` (`typeof f === "string" ? f : (f as any).relativePath`), which is itself defensive
  code for a schema that no longer exists. The public `Manifest` therefore ships 4 pairs of fields that
  can only ever agree, doubling the JSON size of every file entry.
- `resolveConfig(cwd-less)` footgun: `loadConfigFile(dir)` then `resolveConfig(cfg)` ignores `dir` and
  falls back to `process.cwd()` (`config.ts:63`), so the natural library flow writes into the *caller's*
  cwd. (Hit during this audit — a PoC wrote a stray `snapshot/` into the repository.)
- `cwd` is never validated: `resolveConfig` accepts a nonexistent directory, and `generateSnapshot`
  proceeds until `collectFiles` silently falls back to `walkDirectory`, which throws.
- 18 runtime exports, of which `matchRule`/`classifyLayer`/`classifyKind`/`anchorForPath`/`fenceForContent`
  are **not** exported although `matchRule` semantics are user-facing config behaviour.

### 8. Test coverage

9 tests, 53 assertions — all against `dist/` (the built artifact), never `src/`.

| Export | Tested? | Notes |
| :--- | :--- | :--- |
| `generateSnapshot` | ✅ happy path | one 3-file fixture; no drift, error, large-file, multi-part or monolith case |
| `validateSnapshot` | ⚠️ happy path only | never exercises a drift/hash-mismatch/malformed-manifest result |
| `partitionFiles` | ⚠️ superficial | asserts only part count + filename; **no byte-budget assertion** (which is why 02 §4 went unnoticed) |
| `truncatePreview` | ✅ | |
| `summarizeTypeScriptSource` | ✅ | |
| `summarizeJson` / `summarizeMarkdown` | ✅ | |
| `scanAndRedactSecrets` | ⚠️ | asserts redaction happened; **no test that no artifact leaks it**, no coverage-gap test |
| `detectLanguage` | ✅ | |
| `isBinaryExtension` / `isBinaryBuffer` | ✅ | |
| `generateProjectTree` | ✅ | |
| `DEFAULT_SECRET_PATTERNS` | ⚠️ indirect | never asserted rule-by-rule |
| **`resolveConfig`** | ❌ **none** | the config backbone |
| **`loadConfigFile`** | ❌ **none** | |
| **`defineConfig`** | ❌ **none** | |
| **`detectPreset`** | ❌ **none** | |
| **`isBinaryFile`** | ❌ **none** | |

5 of 18 exports (28 %) have zero coverage. Zero tests for: the validator's failure modes, the audit
report, the monolith, navigation anchors, CLI argument parsing, config loading, the git-vs-walk scanner
paths, empty repos, non-ASCII paths, and every error path. Ratio: 214 test lines vs 2 506 source lines
(**1 : 11.7**).

Structural flaw: importing `../dist/index.js` means **`npm test` on a clean checkout tests a stale or
absent build**. `dist` is gitignored, so a fresh clone has no `dist` and `npm test` fails outright until
`npm run build` runs; conversely a developer editing `src` and running `npm test` gets a green suite
against the previous build. CI happens to order `build` before `test`, which masks this locally.

**Fix:** import `src` via a TS-aware test runner (or `tsx`/`node --experimental-strip-types` on 22+), and
add the missing case list above — in particular a **leak-regression test** that greps every generated
artifact for fixture secrets.

### 9. CI / CD

| Issue | Detail |
| :--- | :--- |
| **Actions not pinned** | `actions/checkout@v4` / `actions/setup-node@v4` are mutable tags → supply-chain risk; pin to commit SHAs |
| **No lint / format gate** | `tsc --noEmit` only; `noUnusedLocals`/`noUnusedParameters` are off, which is why dead code (`frontmatterDone` in `structured.ts:50`, the `dryRun`/`force` options, wide `unused`) survives |
| **No coverage gate** | no `c8`/`node --test --experimental-test-coverage`, no threshold |
| **No `npm pack` verification** | nothing checks that the published tarball actually contains `dist/` and a working `bin` — would have caught the missing `prepare` and the broken `exports` |
| **No `npm audit` / Dependabot** | no automated dependency review |
| `ci.yml` lacks `permissions:` | defaults to write-all on some repo settings; should be `contents: read` |
| `publish.yml` | `NPM_TOKEN` **and** `id-token: write` for `--provenance`; provenance needs the OIDC `id-token` permission plus a public repo + `repository`/`homepage` metadata — that combination is coherent only if the repo stays public. `workflow_dispatch` allows publishing **any** branch with no guard (`if: github.ref == 'refs/heads/main'` missing), and `npm publish` runs with no tag/branch check and no `--dry-run` smoke test |
| no `concurrency:` | duplicate CI runs on rapid pushes |
| publish is not idempotent | re-running `workflow_dispatch` on an already-published version fails at `npm publish` after building — harmless but noisy |

### 10. Ranked findings

| # | Severity | Finding | Location |
| :-- | :-- | :-- | :-- |
| 1 | HIGH | `--cwd=path` / `--format=json` (equals form) silently ignored → `validate` reports false drift in CI | `cli.ts:80-96` |
| 2 | HIGH | `--format json` output is not parseable on `generate` (progress lines on stdout) | `cli.ts:188-196` |
| 3 | HIGH | `--dry-run` performs the full destructive write incl. `rmSync(outDir)`; `--dry-run`/`--force` are dead | `cli.ts:91-95`, `index.ts:383-386` |
| 4 | MEDIUM | Unknown command/flag silently ignored; a typo runs `generate` and overwrites the snapshot | `cli.ts:48-96` |
| 5 | MEDIUM | `init` emits `.ts` config unloadable on Node 18/20 (advertised engines), error swallowed | `cli.ts:119`, `config.ts:38-42` |
| 6 | MEDIUM | No `prepare`/`prepack` script → `npm pack`/git-install ships no `dist` | `package.json:48-54` |
| 7 | MEDIUM | `exports["./cli"]` has no `require` condition and no `types` | `package.json:39-42` |
| 8 | MEDIUM | Test suite tests `dist`, not `src`; 5/18 exports and every failure path untested | `tests/snapshot.test.js:7-16` |
| 9 | MEDIUM | `generateSnapshot` is async but fully blocking | `index.ts:46-389` |
| 10 | LOW | `exports["./package.json"]` and `sideEffects` missing; dead `index.d.cts`; sourcemaps shipped | `package.json` |
| 11 | LOW | Duplicate legacy fields in the public type surface double manifest size | `types.ts:39-81` |
| 12 | LOW | `resolveConfig` ignores the config's own directory → writes into `process.cwd()` | `config.ts:63` |
| 13 | LOW | Unpinned Actions, no lint/coverage/audit/pack gates, unguarded `workflow_dispatch` publish | `.github/workflows/*` |
