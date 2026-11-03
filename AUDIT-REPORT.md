# Codebase Audit — `@ankurhalder/codebase-snapshot` v1.0.0

> **STATUS: REMEDIATED.** Every finding below has been fixed and independently re-verified — 41 distinct
> items in total, covering all 4 critical, all 9 high, all 16 medium and every low-severity item.
> See [FIXES.md](FIXES.md) for the per-finding fix ledger and
> [audit/VERIFICATION.md](audit/VERIFICATION.md) for the adversarial re-audit
> (**41 / 41 findings FIXED, 245 / 245 assertions pass**). This document is preserved as the original
> audit record.

**Audit date:** 2026-11-03 · **Commit:** `4525c29` (branch `main`, clean) · **Node:** v24.12.0 · Windows
**Scope:** full repository — 25 source files / 2,506 LOC (`src/`), 214 LOC (`tests/`), build config, CI, README, public API.
**Method:** source read of 100 % of `src/`, then **every finding reproduced by execution** against a freshly
built `dist/`. 40+ runnable PoCs live in `audit/poc/`. Pre-formed hypotheses that failed to reproduce are
listed as *rejected* in the sub-reports rather than deleted.

Supporting evidence:

| Document | Owner | Content |
| :--- | :--- | :--- |
| [audit/01-security.md](audit/01-security.md) | security-auditor | secret redaction, sensitive-file exposure — 9 findings, all executed |
| [audit/02-correctness.md](audit/02-correctness.md) | correctness-auditor | chunker, manifest, validator, config, generators, AST — 21 findings, 10 PoC programs |
| [audit/03-api-build.md](audit/03-api-build.md) | lead | CLI vs README, packaging, public types, test coverage, CI |

---

## Verdict

The code is **well-structured and cleanly factored but not safe to use as shipped.** The module
boundaries (`scanner` → `ast` → `security` → `partitioner` → `generator` → `validator`) are genuinely good,
`strict` TypeScript is on, the build is clean and the event-loop-free core is deterministic. The problem is
not architecture — it is that **four of the product's five headline guarantees do not hold**, and one of
them fails in the direction that loses data.

The README's five claims, scored:

| Claim | Reality |
| :--- | :--- |
| "LLM Context Budgeting — bounded byte-size chunks" | ❌ **Broken** — a single oversized file produced a part **13.5× over budget** (4.16 MB against a 307 KB limit) |
| "Automated Secrets Redaction" | ❌ **Broken 4 ways** — catches 11/36 realistic secret formats; PEM key bodies survive intact (a usable key was reconstructed); the audit report re-prints the raw secret it just "redacted"; and `.npmrc` / `.git-credentials` / `id_rsa` are always emitted verbatim |
| "Built-in Integrity Validator" | ❌ **Unsound** — the hash domain differs between `generate` and `validate` (permanent unfixable drift on non-UTF-8 files), `parts/*.md` are never verified, and a malformed manifest crashes it |
| "Production-grade" | ❌ `outDir: "."` **deletes the working tree**; `--dry-run` writes; `--cwd=x` is ignored |
| "TypeScript AST Extraction / zero-config presets" | ✅ **Holds** — accurate extraction with a few coverage gaps (`.mts`/`.cts`, anonymous default exports, `export *`) |

**Total: 4 critical, 9 high, 16 medium, 11 low.**

---

## Critical findings

### C1 — `generateSnapshot` deletes the destination before it can write the replacement; `outDir: "."` wipes the repository

`src/index.ts:383-386`

```ts
if (fs.existsSync(finalOutDir)) fs.rmSync(finalOutDir, { recursive: true, force: true }); // 383
fs.renameSync(targetTmpDir, finalOutDir);                                                 // 386
```

Delete-then-rename with no rollback, and `outDir`/`tmpDir` are mere string joins onto `cwd`. Every failure
between the two calls (EXDEV, ENOSPC, a Windows AV/EDR handle, a crash) leaves **old snapshot gone, new
snapshot not in place**.

Reproduced three ways (`audit/poc/correctness-dataloss.mjs`, plus my own `audit/poc/lead-outdir.mjs`):

```
$ node audit/poc/lead-outdir.mjs
before: README.md, package.json, src
generate threw: ENOENT: no such file or directory, rename '...\lead-outdir-aXfBO9\snapshot.tmp'
                -> '...\lead-outdir-aXfBO9'
$ Test-Path '...\lead-outdir-aXfBO9'   ->  False        # the whole directory is gone
```

* `outDir: "."` → `path.join(cwd, ".")` **is** `cwd` → `rmSync(cwd, {recursive:true})` destroys source,
  README, `package.json` and `.git`, then throws because the temp dir it wanted to rename was inside the
  tree it just deleted.
* `tmpDir` nested inside `outDir` (`outDir: "out", tmpDir: "out/.tmp"`) → same self-destruct.
* `outDir` under a junction/mount onto another volume → `EXDEV` **after** the old snapshot is deleted; the
  new snapshot is stranded in `snapshot.tmp`.

`"."` and `"./"` are exactly what a user types to mean "put the snapshot here". **Fix:** reject
`outDir` equal to/ancestor of `cwd`, equal to or containing `tmpDir`; swap via
`rename(outDir → outDir.old)` → `rename(tmp → outDir)` → `rm(outDir.old)` with rollback; `fs.cpSync`
fallback on `EXDEV`.

### C2 — the audit report writes every detected secret to disk verbatim

`src/generator/audit.ts:31` renders `SecretFinding.snippet`, and `snippet` is the **untouched source line**
(`src/security/redact.ts:21`). So a secret is replaced in `parts/*.md` and then printed in clear into
`reports/audit.md` — which `snapshot/README.md` advertises as "Security scan findings" and which users are
told to commit and paste into an LLM.

```
=== LEAK MATRIX ===                              (audit/poc/lead-leak.mjs)
  AWS key (AKIA...)        -> reports/audit.md
=== what audit.md actually contains ===
  | `src/aws.ts` | 1 | `aws-access-key-id` | `const k = "AKIAIOSFODNN7EXAMPLE";` |
```

The redaction feature therefore **concentrates** secrets into a single, well-labelled file. `manifest.json`
is clean (`warnings` carries only `"<rule> at <path>:<line>"`). **Fix:** drop the snippet column entirely;
mask with the matched span when a preview is wanted.

### C3 — multi-line private keys: only the `BEGIN` line is redacted

Redaction is line-granular (`redact.ts:13-26`) and `private-key-header` matches only the header, so for a
PEM block exactly one line dies and the body plus `-----END-----` are copied out.

```
L1: [REDACTED: potential secret-like value omitted from snapshot]
L2: MIIEowIBAAKCAQEAzzzz…            <- 25 of 27 lines intact
```

A real 2048-bit RSA key was extracted from `parts/part-001.md`, the marker line replaced with
`-----BEGIN RSA PRIVATE KEY-----`, and **parsed successfully — the reconstructed public key matched the
original** (`audit/poc/security-e2e-snapshot.mjs`). **Fix:** a second pass replacing whole
`-----BEGIN … PRIVATE KEY-----[\s\S]*?-----END …-----` blocks (with an `|$` arm for keys cut by preview
truncation).

### C4 — the default pattern set misses 25 of 36 realistic secret formats, and `.env` syntax is structurally unmatchable

`audit/poc/security-coverage-matrix.mjs` runs one sample per real-world family against the exact default
rule set: **caught 11/36**. Missed, among others: OpenAI `sk-` and `sk-proj-`, Anthropic `sk-ant-`, npm
`npm_`, PyPI, GitHub fine-grained `github_pat_`, `GOCSPX-`, SendGrid `SG.`, Twilio, DigitalOcean,
`AccountKey=`, Basic-auth URLs, and **every unquoted `KEY=value` line** — because the generic rule requires
quotes and a `[A-Za-z0-9-_]` charset (`patterns.ts:42`), which `.env` files never satisfy. Precision is
excellent (0 false positives across 25 real source files), so this is a coverage hole, not a tuning
trade-off. **Fix:** add the vendor patterns, make the generic rule's quotes optional and its charset wider,
and treat the list as maintainable data (gitleaks-style) rather than 10 hardcoded regexes.

---

## High findings

| # | Finding | Evidence |
| :-- | :--- | :--- |
| H1 | **No sensitive-file deny list.** `.npmrc`, `.git-credentials`, `id_rsa`, `*.pem` are collected and emitted verbatim in *all* git layouts; `.env` escapes only when it is both git-ignored *and* untracked (a tracked `.env`, or the non-git `walkDirectory` fallback that ignores `.gitignore` entirely, leaks it) | 01 §5, `security-scanner-env.mjs`; independently confirmed in `lead-nogit.mjs` |
| H2 | **Every non-ASCII filename is silently dropped.** `git ls-files` without `-z` C-quotes paths; the parser turns `"src/caf\303\251.ts"` into `"src/caf/303/251.ts"`, which never existed → skipped as `read-error` blaming the file. 3 of 5 fixture files lost | 02 §2, `correctness-collect.mjs` |
| H3 | **Integrity hash has two domains.** `generate` hashes the utf8-decoded string; `validate` hashes the raw Buffer. For any file with invalid UTF-8 the mismatch is structural — `validate` fails immediately after `generate` and **regenerating can never clear it** | 02 §3, `correctness-hash-drift.mjs` |
| H4 | **`maxPartBytes` is not a bound.** The flush test is skipped for an empty chunk, so one large file is emitted whole — the byte budget (the product's core promise) can be exceeded without limit | 02 §4, `correctness-bytesize.mjs` (13.5×) |
| H5 | **`validateSnapshot` throws** an uncaught `TypeError` on a manifest lacking `files`/`skipped`; the CLI does not wrap it, so `validate` dies with a raw stack trace | 02 §5, `correctness-validate.mjs` |
| H6 | **A `/g` custom secret rule silently skips every other match** — `pattern.test()` mutates `lastIndex` across lines *and files*, so redaction becomes non-deterministic and the skipped secrets raise no warning. One-character fix: `line.search(pattern) !== -1` | 01 §4, `security-redact-units.mjs` |
| H7 | **CLI ignores `--opt=value`.** Only `--mode=` is handled, so `--cwd=/repo` and `--format=json` are dropped *silently* and the tool acts on `process.cwd()` — `validate` then reports **false drift** (exit 1) in exactly the CI-pipeline idiom | 03 §2, verified live |
| H8 | **`--format json` is not parseable** on `generate`: two progress lines precede the JSON, so `JSON.parse`/`jq` fail | 03 §3, `api-out-json.txt` |
| H9 | **`--dry-run` is destructive.** `dryRun`/`force` are parsed and never read; `--dry-run` performs the full write sequence including `rmSync(existing outDir)` | 03 §4, write-trace |

---

## Medium findings (condensed)

**Correctness / data model**
- `validate` only hash-checks source files: a **deleted or garbled `parts/*.md` still returns `valid:true`**, and budget, `excludePatterns`, git branch/commit and totals are never compared (02 §6).
- `inclusionMode: "summary-only"` is set for every file over `largeFileBytes` **even when nothing was truncated** and the full body is emitted under a heading that says "Bounded Preview"; `totals.fullFiles`/`summaryOnlyFiles` consequently misreport (02 §7).
- **Every file link in `navigation.md` is a dead anchor** — `anchorForPath` slugs are never emitted in `parts/` (0 of 3 resolve; `anchorForPath` is also not injective) (02 §8).
- `monolith.ts` fences with a fixed 3-backtick fence while `chunker.ts` correctly computes an adaptive one → a file containing ``` breaks out of the block in `full-codebase.md` (02 §9).
- `manifest.validation.status` is the **string literal `"passed"`**, never computed — `validate` can disagree with it in the same run. `generator.script` points at `scripts/generate_codebase_snapshot.ts`, which does not exist (02 §10).
- `manifest.indexes.imports` / `.directives` / `.features` are **hardcoded empty** although the per-file summaries already contain that data; README tells consumers to rely on them (02 §13).
- **One deeply-nested JS/TS file aborts the entire run** with an uncaught `RangeError` from the recursive AST walk — no per-file isolation (02 §11).
- `"src/app/**"` compiles to a bare `startsWith("src/app")`, so it also matches `src/apple/`, `src/application/`; `excludePatterns` is a plain substring test, so `"test"` silently drops `contest/` and `attest/`. Both forms are printed in the README (02 §12).
- Summaries are built from **raw** content, so a secret in a Markdown heading is redacted in the body yet emitted unredacted in `parts/*.md` and `manifest.json` (01 §6).
- Whole-line redaction destroys unrelated code: `export const region = "us-east-1"; const retries = 3;` vanishes along with the key it shared a line with (01 §7).
- `jwt-token` backtracks quadratically: **1.22 s per 200 KB** `eyJ`-dense line (~31 s/MB), not bounded by `largeFileBytes`; the other nine patterns measured clean (01 §8).

**CLI / packaging / process**
- Unknown command or flag → **exit 0**, and a typo'd subcommand silently runs `generate` and overwrites the snapshot; `parseInt` accepts `NaN`/`0`/negatives with no validation (03 §2).
- `init` generates `snapshot.config.ts`, unloadable on Node 18/20 despite `engines: >=18`; every config error is swallowed by `catch { continue; }` so the config is silently ignored (03 §6).
- No `prepare`/`prepack` → `npm pack` or a git-install from a fresh clone ships **no `dist/`**; `exports["./cli"]` has no `require` condition and no `types` (03 §5).
- The suite imports `../dist/index.js`, so **`npm test` tests a build, not the source** — green against stale output, failing on a clean clone (03 §8).
- `generateSnapshot` is declared `async` but contains **zero `await`** — it blocks the event loop entirely (03 §7).

---

## What is genuinely good (and worth preserving)

This is not a write-off — several things here are better than typical published tooling:

- **Module boundaries are right.** `scanner` / `ast` / `security` / `partitioner` / `generator` / `validator` are cleanly separated, each with one job, and `src/index.ts` is an honest orchestrator.
- **`console.*` is confined to `cli.ts`** (33 of 33 calls). Library code never writes to the user's terminal — a discipline most CLIs lack.
- **`strict: true`, and only 6 `any` in the whole codebase** (3 `as any` in `index.ts`, 1 in `navigation.ts`, 2 `catch (err: any)`). Typecheck is clean.
- **Only one runtime dependency** (`typescript`), and it is *correctly* placed in `dependencies` — verified externalized, not inlined (`dist/index.js` is 53 kB, `npm pack` = 119 kB).
- **Dual ESM+CJS build verified working**, both resolvable by a real consumer.
- **Adaptive code fencing in `chunker.ts`** — it measures the longest backtick run in the content and picks a longer fence. This is a subtle correctness detail done right (and `monolith.ts` should reuse it — see M4).
- **`git ls-files --exclude-standard` as the primary collector** is the correct default: it honours the repo's own `.gitignore` instead of inventing one.
- **The tmp-dir → rename intent is right**; only the delete-then-rename *sequencing* is wrong (C1).
- **Secret-rule precision is 0 false positives** across real source — the coverage gap (C4) is fixable without a precision regression.
- **Deterministic output**: the fingerprint is stable across regenerations (02 §20).
- 9/9 tests pass, build clean, `npx tsc --noEmit` clean.

---

## Remediation roadmap

**Ship-blocking (do not publish a repo-scanning tool without these)**

1. **C1 write sequence** — guard `outDir`/`tmpDir`, atomic swap, `EXDEV` fallback. *Highest value per line changed; this is the only finding that destroys user data.*
2. **C2 audit-report leak** — delete the snippet column; add a regression test that greps **every** emitted artifact for fixture secrets.
3. **C3 PEM block redaction** — one `replace` covering whole key blocks.
4. **C4 pattern coverage** — at minimum unquoted `.env` assignments, `sk-*`, `npm_*`, `github_pat_`, Basic-auth URLs; plus a sensitive-file deny list (H1).
5. **H2** `git ls-files -z` + split on `\0` — a three-line fix that restores every non-ASCII file.
6. **H3** single read / single hash domain in `generate` — clears permanent phantom drift.
7. **H4** hard-split oversized sections; truncate by bytes, not lines.
8. **H7/H8/H9** CLI: adopt `util.parseArgs` (fixes equals-form, unknown flags and numeric validation at once), send progress to `stderr`, implement or delete `--dry-run`.

**Should fix before the next minor**

9. H5/H6 + 02 §6: schema-guard `validate`, verify `parts/*.md` against their recorded `sha256`/`bytes`, compare recorded config and git state; `search()` instead of `test()`.
10. M1–M3, M6: make `manifest` truthful (`validation.status`, `totalContentBytes`, `inclusionMode`, dead indexes) — it is the machine-readable contract.
11. M4, M5: monolith adaptive fence; per-file `try/catch` around AST summarisation.
12. 01 §7, M7: replace only the matched span, not the whole line.
13. 03 §6, M8: emit a loadable config format; warn instead of swallowing config errors.
14. Exports map + `prepare` script; switch tests to import `src`.

**Backlog**

15. 02 §12 matchers (real globs or documented substring semantics), §14–§19 (line counting, symlinks, `localeCompare` determinism, `ts-parser` gaps, `resolveConfig` cwd), 01 §8 ReDoS bounds.
16. CI hygiene: pin Actions to SHAs, `permissions: contents: read`, lint + coverage + `npm pack` gates, guard `workflow_dispatch` publishing.

---

## Caveats

- Only **Node 24.12** was available. Anything attributed to Node 18/20 (notably the `.ts` config failure, 03 §6) is inferred from the engine matrix and the error-swallowing `catch`, not executed — this is flagged at each occurrence.
- Windows-only environment: POSIX-specific behaviour (permissions, symlink creation, `EXDEV` shape) was reasoned about but not executed; the `EXDEV` case *was* reproduced via a real junction to a second volume.
- File **symlinks** could not be created (needs admin/Developer Mode); that half of 02 §16 is inferred from the identical code branch.
- Findings that failed to reproduce were dropped or explicitly rejected rather than softened — see "claims checked and rejected" in all three sub-reports. Notably **rejected**: the self-referential `bytes` header (always exact), ReDoS in 9 of 10 default patterns, `.env` being collected when git-ignored *and* untracked, `file://C:\…` URL invalidity, infinite recursion in the directory walk, and divide-by-zero on an empty repo.
- `audit/poc/` contains throw-away fixtures and scripts. `dist/` was rebuilt during the audit; `src/`, `tests/`, `package.json` and the workflows were **not** modified.
