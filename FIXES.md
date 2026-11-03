# Fix Ledger — every audit finding and what was done about it

Base: audit of `4525c29` → remediation on branch `main`, package **v2.0.0**, manifest **schemaVersion 3.0.0**.

Verification gates for this ledger:

| Gate | Result |
| :--- | :--- |
| `npx tsc --noEmit` (now with `noUnusedLocals`/`noUnusedParameters`) | clean |
| `npm run build` (tsup: index+cli ESM/CJS+dts, bin ESM) | clean |
| `npm test` (`pretest` builds, then `node --test`) | **62 / 62 pass** |
| `node audit/poc/fix-verify.mjs` (critical/high regressions) | **19 / 19 pass** |
| `node audit/poc/consumer-check.mjs` (ESM + CJS + bin as a real consumer) | pass |
| CI tarball gate run locally | pass (15 files, no `.map`) |
| `npm run lint` (dependency-free lint/format gate) | 29 files clean |
| `node audit/poc/{fix-verify,edge-cases,residual-verify,residual-verify2}.mjs` | **78 assertions, 0 failures** |
| Independent adversarial re-audit (`audit/VERIFICATION.md`) | **41 / 41 findings FIXED, 245 / 245 assertions pass** |

---

## CRITICAL

| # | Finding | Fix | Where |
| :-- | :--- | :--- | :--- |
| C1 | `rmSync(outDir)` before `renameSync` → `outDir:"."` erased the repository; EXDEV lost the old snapshot | `resolveSafeOutputDirs()` refuses `outDir` = cwd/ancestor/root and any `outDir`↔`tmpDir` containment; `swapIntoPlace()` renames the old tree to a backup, renames the new one in, deletes the backup, and rolls back from the backup on failure; `EXDEV` falls back to `cpSync` + `rmSync` | `src/index.ts` |
| C2 | `reports/audit.md` printed the raw matched source line for every detected secret | `SecretFinding.snippet` **removed from the type**; the report renders `path / line / rule` plus counts only | `src/types.ts`, `src/generator/audit.ts`, `src/security/redact.ts` |
| C3 | Multi-line PEM keys: only the `BEGIN` line was masked; a usable RSA key was reconstructed from `parts/` | Whole-block pass that runs **before** the per-line pass, replacing terminated blocks *and* unterminated/truncated ones, preserving the block's line count so later line numbers stay accurate | `src/security/patterns.ts`, `src/security/redact.ts` |
| C4 | Default patterns caught 11/36 real formats; `.env` assignments structurally unmatchable | +11 rules (OpenAI/Anthropic, npm, PyPI, GitHub fine-grained, Google OAuth, SendGrid, Twilio, DigitalOcean, Azure, Slack webhook, basic-auth URL), relaxed AWS rule for JSON keys, widened generic charset, and a dedicated line-anchored `env-secret-assignment` rule. A `.env` file is also skipped entirely by default | `src/security/patterns.ts`, `src/scanner/files.ts` |

## HIGH

| # | Finding | Fix | Where |
| :-- | :--- | :--- | :--- |
| H1 | No sensitive-file deny list (`.npmrc`, `.git-credentials`, `id_rsa`, `*.pem` always emitted; tracked `.env` leaked) | `isSensitivePath()` deny list (basename/path/extension) with a `.env.example`-style allowlist; skipped with `reason:"sensitive-file"`; opt in via `includeSensitiveFiles` / `--include-sensitive-files`; applied in the walk fallback too | `src/scanner/files.ts` |
| H2 | Non-ASCII filenames silently dropped (`git ls-files` C-quoting) | `git ls-files -z` + split on `\0`; removed the backslash normalisation | `src/scanner/files.ts` |
| H3 | `generate` hashed the utf8 string, `validate` hashed the raw buffer → permanent phantom drift | one `readFileSync` returning a Buffer; hash the buffer, decode for content | `src/index.ts`, `src/validator/validate.ts` |
| H4 | `maxPartBytes` unenforced (13.5× overshoot); header reserve wasted 45% of a small budget | sections larger than the budget are byte-truncated (UTF-8 safe) and marked `preview`; the self-referential `Byte Size:` header line is gone, so `byteSize` is measured once; a final render/verify pass splits any part still over budget; `verifyInMemory` asserts the bound | `src/partitioner/chunker.ts`, `src/partitioner/preview.ts` |
| H5 | `validateSnapshot` threw `TypeError` on a manifest lacking `files`/`skipped` | explicit shape guard returning the normal `{valid:false, errors}` result | `src/validator/validate.ts` |
| H6 | A `/g` custom secret rule skipped every other match | rules compiled once via `compileSecretRules()` with `g`/`y` stripped; per-line `exec` loops reset `lastIndex`; spans merged so overlapping rules mask once | `src/security/redact.ts`, `src/config.ts` |
| H7 | `--opt=value` silently ignored → `validate` reported false drift | whole parser replaced with `node:util parseArgs` (`strict: true`), which supports `--opt=value` natively | `src/cli.ts` |
| H8 | `--format json` output was not parseable on `generate` | all human output goes to **stderr**; stdout carries only the payload | `src/cli.ts` |
| H9 | `--dry-run` performed the full destructive write; `--dry-run`/`--force` were dead | `--dry-run` implemented end-to-end (`generateSnapshot(config, {dryRun:true})` writes nothing); `--force` and `monolithContent` deleted | `src/index.ts`, `src/cli.ts` |

## MEDIUM

| # | Finding | Fix | Where |
| :-- | :--- | :--- | :--- |
| M1 | `validate` only hashed source files; deleted/corrupt parts passed | verifies each `parts/*.md` `byteSize` + `sha256`, part↔file bookkeeping, total file counts, and monolith artifact digests | `src/validator/validate.ts` |
| M2 | `inclusionMode:"summary-only"` while full content was emitted; totals misreported | `inclusionMode` derives from `isPreviewTruncated`; renamed `summaryOnlyFiles` → `previewFiles`; `fullFiles + previewFiles == includedFiles` | `src/index.ts`, `src/types.ts` |
| M3 | Every `navigation.md` link was a dead anchor | chunker emits `<a id="…"></a>` before each `### FILE:`; `anchorForPath` appends a path digest so it is injective | `src/partitioner/chunker.ts`, `src/generator/navigation.ts` |
| M4 | Monolith used a fixed 3-backtick fence → fence injection | `fenceForContent()` exported from the chunker and reused by the monolith | `src/generator/monolith.ts` |
| M5 | `validation.status` was the literal `"passed"`; `generator.script` was a fake path | `verifyInMemory()` runs a real pre-write integrity pass (part digests, budget, file→part assignment) and sets the status; `generator.script` removed, `generator.version` now matches `package.json` (asserted by a test) | `src/index.ts` |
| M6 | One deeply-nested file aborted the entire run with `RangeError` | AST traversal is an explicit stack (no recursion); the per-file summary call is wrapped in `try/catch` and downgraded to a recorded warning | `src/ast/ts-parser.ts`, `src/index.ts` |
| M7 | `"src/app/**"` also matched `src/apple/`; `excludePatterns` was a substring test that dropped `contest/` | `/**` now requires a path boundary and defers to the glob matcher when the prefix contains globs; excludes implement `**`/`*`/`?` or segment-sequence matching | `src/config.ts`, `src/scanner/files.ts` |
| M8 | `manifest.indexes.imports/directives/features` were hardcoded empty | populated from per-file summaries; relative imports are resolved to files to build `centralFiles`; `features` derived from path segments; dead `server-action` branch removed | `src/index.ts` |
| M9 | Summaries were built from **raw** content, leaking secrets in headings into parts + manifest | summaries are computed from the **redacted** text | `src/index.ts` |
| M10 | Whole-line redaction destroyed unrelated code | span-only replacement with overlap merging | `src/security/redact.ts` |
| M11 | `jwt-token` backtracked quadratically (1.22 s / 200 KB) | all quantifiers bounded (`{10,1024}`); measured bound asserted by a test | `src/security/patterns.ts` |
| M12 | Unknown command/flag silently ignored; `parseInt` accepted `NaN` | `parseArgs` strict mode + `parsePositiveInteger()` with a floor (`maxPartBytes ≥ 4096`); unknown command lists valid ones; usage errors exit **2** | `src/cli.ts` |
| M13 | `init` wrote a `.ts` config unloadable on Node 18/20; config errors were swallowed | `init` writes `.mjs` when Node cannot import `.ts`; `loadConfigFileDetailed()` returns `warnings` that the CLI prints | `src/cli.ts`, `src/config.ts` |
| M14 | No `prepare`/`prepack`; `exports["./cli"]` had no `require`/`types` | `prepare` script added; `./cli` now has `import`+`require` with `types`, backed by ESM+CJS+dts builds; the CLI module is side-effect free with a separate `bin` shim | `package.json`, `tsup.config.ts`, `src/bin.ts` |
| M15 | Tests imported `dist`, so `npm test` ran against a stale build | `pretest: npm run build` — `npm test` always tests current source; 53 tests now cover the previously untested exports and every fixed defect | `package.json`, `tests/*.test.js` |
| M16 | `generateSnapshot` was `async` but fully blocking | now synchronous (`generateSnapshotAsync` provided for async call sites); `await generateSnapshot(...)` still works | `src/index.ts` |

## LOW

| # | Finding | Fix | Where |
| :-- | :--- | :--- | :--- |
| L1 | `totalContentBytes` mirrored source bytes | measured emitted content bytes per file (`includedBytes`) | `src/index.ts` |
| L2 | Config loading: swallowed errors, naive `file://` concat, no `.ts` gate, `resolveConfig` ignored the config's directory | `pathToFileURL`, warnings surfaced, `.ts` gated on `supportsTypeScriptImports()`, `baseDir` parameter, `cwd` validated | `src/config.ts` |
| L3 | Directory walk silently omitted symlinks | symlinks resolved and followed with a realpath cycle guard; recorded as `reason:"symlink"` | `src/scanner/files.ts` |
| L4 | Line counting off by one, two contradictory conventions | single `countLines()` helper used everywhere | `src/partitioner/preview.ts`, `src/index.ts` |
| L5 | Tree ordering locale-dependent, uncapped, file/dir indistinguishable | code-unit ordering, `/` suffix on directories, 20 000-line cap with truncation notice | `src/generator/tree.ts` |
| L6 | `ts-parser` gaps: `.mts`/`.cts`, anonymous default, `export *`, inconsistent `routeHandlers` | all four fixed (plus `reExports` in the summary); route handlers now require being exported uniformly | `src/ast/ts-parser.ts`, `src/index.ts` |
| L7 | JSON-config `customPatterns` threw `pattern.test is not a function` | `compileSecretRules()` coerces strings to `RegExp` and reports a clear error for invalid ones | `src/security/redact.ts` |
| L8 | `exports["./package.json"]` and `sideEffects` missing; dead `index.d.cts`; sourcemaps shipped | all three export subpaths added, `sideEffects:false`, per-condition `types` (so `.d.cts` is live), `files` excludes `.map` | `package.json` |
| L9 | Duplicate legacy fields doubled the manifest | `path`/`bytes`/`sha256`/`PartMetadata.bytes`/`PartMetadata.files`/`contentFingerprint` removed; documented in the v1→v2 table | `src/types.ts` |
| L10 | `resolveConfig` wrote into `process.cwd()` when given a config from another directory | `baseDir` parameter threaded from the CLI | `src/config.ts`, `src/cli.ts` |
| L11 | CI: unpinned actions, no lint/coverage/pack gates, unguarded publish | actions pinned to verified commit SHAs, `permissions: contents: read`, `concurrency`, typecheck + coverage + tarball-content gates, publish guarded to `main`/release with a pre-flight pack check and serialised concurrency | `.github/workflows/*.yml` |

---

## Also addressed beyond the audit list

- `isBinaryFile` leaked its file descriptor when `readSync` threw (`try/finally`).
- `monolithContent` (never implemented) and `CliOptions.force` (never read) removed rather than left as dead API.
- `--out-dir`, `--max-monolith-bytes`, `--include-sensitive-files` exposed as real flags.
- `init` reports which config filename it chose and why.
- `resolveConfig` rejects a non-existent/non-directory `cwd` with a clear message instead of failing deep inside the scanner.
- Tree/report sorting uses explicit comparators everywhere (no `localeCompare` on machine defaults).
- `grep`-level dead code removed (`frontmatterDone`, unused `originalLines` plumbing, `(f as any)` cast in navigation, hardcoded `generator.script`).

## Behaviour changes worth knowing

1. **`generateSnapshot` is synchronous.** `await` still works; `.then()` no longer does.
2. **Credential files are excluded by default.** A repo that relied on `.env`/`*.pem` appearing in the
   snapshot must pass `includeSensitiveFiles: true`.
3. **Manifest shape changed** (schema 3.0.0) — see the README migration table.
4. **`reports/project-tree.md` is written once**, under `reports/`; the duplicate copy at the snapshot
   root was removed.
5. **`invalid` CLI usage exits 2** (was 0, silently generating).

---

## Residuals found by the independent verifier (all closed)

The adversarial re-audit reported three PARTIAL verdicts and two regressions. All five were fixed before sign-off:

| Item | What was wrong | Fix | Where |
| :--- | :--- | :--- | :--- |
| **R2** regression | `{ ...resolvedConfig, override }` lost the non-enumerable brand, was re-resolved as a *user* config, and **silently dropped custom `secretRules`** — matching secrets then passed redaction | `isResolvedConfig()` takes a structural path in addition to the brand (requires the full resolved shape, with `secretRules` as the discriminator); `normalizeResolvedConfig()` recompiles rules for every inbound resolved config at both entry points | `src/config.ts`, `src/index.ts`, `src/validator/validate.ts` |
| **R3** regression | The new `summaryOmitted` path computed the body allowance while the summary still counted as overhead, zeroing the body (0 B emitted with ~305 KB free) | `prepareSection` is now staged: shrink body → drop summary → **re**-shrink body with the freed room → hard-truncate only as a last resort | `src/partitioner/chunker.ts` |
| **H4** partial | A 6,000-char layer name produced a 12,588 B part against a 4,096 B budget | Metadata values capped at 200 chars, displayed paths at 300 (middle-elided; full path kept in `includedFiles`), `greedyGroups` accounts for the displayed path, and the single-section overflow branch re-hashes a hard-truncated part instead of returning over budget | `src/partitioner/chunker.ts` |
| **02§6** partial | Tampering with `totals`/`counts`/`budgets` still validated `true`; commit drift produced no warning | Bookkeeping pass recomputes every counter from the manifest's own file/part lists (incl. Σ `includedFiles[].includedBytes`) into a new `drift.totalsMismatches[]`; `manifest.git.commit` is compared to HEAD and a dirty tree warns | `src/validator/validate.ts`, `src/types.ts` |
| **03§13** partial | No lint/format gate, no automated dependency review | `scripts/lint.mjs` — dependency-free gate (console confinement, empty `catch`, explicit `any`, TODO markers, tabs, trailing whitespace, EOL/EOF, `debugger`, `test.only`, bare suppressions) wired as `npm run lint` + `npm run check` + a CI step; `.github/dependabot.yml`; CI `npm audit --audit-level=high` | `scripts/lint.mjs`, `.github/`, `package.json` |
| **S5** residuals | `.env-`, `.env_`, `.envbackup`, `.netrc.bak`, `.npmrc.bak`, `id_rsa.bak`, `credentials.json`, `service-account.json`, `secrets.json`, `terraform.tfvars` were still allowed | Deny list rewritten with optional backup/template suffixes; template allowance generalised (a file is emitted only if its name *would have been* denied without the suffix) | `src/scanner/files.ts` |
| Lossy clone | `JSON.parse(JSON.stringify(resolved))` silently reverted to default rules | `assertUsableConfigInput()` throws a clear error when `secretRules` patterns were destroyed by serialization | `src/config.ts`, `src/index.ts`, `src/validator/validate.ts` |

Deliberately **not** changed, recorded as inherent rather than deferred:

- `structuredClone` of a config whose layer/kind rules are functions throws `DataCloneError`. Functions are not cloneable; the error is the platform's and is correct.
- A 10,000-character path spends its budget on the anchor, so the section hard-truncates. The byte bound still holds; such paths are unreachable on Windows (MAX_PATH) and require a deliberate 10 KB directory name on POSIX.
- `manifest.validation.status === "failed"` is now unreachable through public inputs (the byte bound is guaranteed by construction), but the branch is kept as a defence-in-depth assertion and is surfaced when a hand-edited manifest declares it.
- Exotic malformed PEM headers, and the loss of a frontmatter *key name* when its value is redacted, remain; neither is a leak.

## Final gate

```
npm run lint      29 file(s) clean
npx tsc --noEmit  clean
npm test          62 / 62 pass
audit/poc/*       20 + 14 + 27 + 17 pass, 0 fail
consumer          ESM + CJS + bin all OK
npm pack          no .map, all required entry points present
adversarial       41 / 41 findings FIXED
```
