# Verification Report — `@ankurhalder/codebase-snapshot` v2.0.0

**Verifier:** `fix-verifier` (adversarial, independent of the remediation)
**Method:** every finding from `AUDIT-REPORT.md`, `audit/01-security.md`, `audit/02-correctness.md` and
`audit/03-api-build.md` was turned into an executable check that fails on the old behaviour and must pass on the
shipped build. 23 scripts / **245 assertions** under `audit/verify/`, each run in a clean process. Nothing
outside `audit/verify/` was modified.

**Pass history — this report covers two frozen targets**

| Pass | Target | Result | What happened |
| :--- | :--- | :--- | :--- |
| 1 | `dist/index.cjs` `48EBE448169B49C1` | 38 FIXED / 3 PARTIAL / 0 STILL BROKEN, 2 regressions | Found `.env.production.local` bypass, a new quadratic regex (`env-secret-assignment`), a config-spread regression and a summary-drop body collapse |
| 2 | `dist/index.cjs` `1E35BFA88D2A3D63` | **41 FIXED / 0 PARTIAL / 0 STILL BROKEN, 0 regressions** | The five open items were fixed and re-verified; the last residual (`02 §4`) is now closed |

**Current target (frozen, verified byte-for-byte against the freeze list):**

| Artifact | SHA-256 (first 16) | Bytes |
| :--- | :--- | :--- |
| `dist/bin.js` | `E4A103D62D39A94C` | 104,082 |
| `dist/chunk-VZPBGJWT.js` | `30CF89831387E66B` | 91,916 |
| `dist/cli.cjs` | `11DB463F892BFFFB` | 105,935 |
| `dist/cli.js` | `4C69FA4784E83F27` | 12,707 |
| `dist/index.cjs` | `1E35BFA88D2A3D63` | 95,319 |
| `dist/index.js` | `04A29D77E8A318D7` | 766 |
| `dist/index.d.ts` | `AC931117266F2225` | 11,968 |
| `dist/types-Bg1Vy9BB.d.ts` | `2989B1C8E87AB1B9` | 8,562 |

Environment: Node v24.12.0, Windows x64, git 2.56.0, two volumes (C: system, D: data — used for a real
cross-device `EXDEV` case), Python 3 + PyYAML 6.0.3 (used to parse `dependabot.yml`). Raw output of the final
run: `audit/verify/RUN-LOG.txt`.

**Aggregate: 245 PASS / 0 FAIL across 23 scripts.** Every assertion is executable: each script self-tests its
own harness first, and the leak/overshoot checks are calibrated against fixtures that are proven to contain the
values they look for.

---

## 1. Per-finding verdicts

Severity is the sub-report's own rating. "Report ref" gives the ranking ID in `AUDIT-REPORT.md` where one
exists. `02 §x` / `03 §x` refer to the numbered sections / ranked table of the sub-reports.

### 1.1 Security — `audit/01-security.md`

| # | Report ref | Sev | Verdict | Evidence (script + observed result) |
| :-- | :-- | :-- | :-- | :--- |
| S1 | 01 §1 · **C2** | CRITICAL | **FIXED** | `v-s1-audit-leak`: 17/17. 12 secret values (AWS id + secret, JWT, mongo URI, `sk-proj`, `npm_`, `github_pat_`, `SG.`, 3× PEM body, frontmatter password) absent from all 6 emitted artifacts; `reports/audit.md` carries only `\| File \| Line \| Rule \|`; `full-codebase.{md,json}` clean; the fixture sources are asserted to contain the values (the grep can fail). |
| S2 | 01 §2 · **C3** | CRITICAL | **FIXED** | `v-s2-pem`: 9/9. All 4 body lines absent from every artifact for RSA, OPENSSH, EC, ENCRYPTED, PKCS#8 and PGP headers, CRLF blocks, a key inside a 420 KB preview-truncated file, and a key embedded in one JSON line. Re-adding the marker line recovers **0/4** body lines (old: usable key reconstructed). Line numbers after a block stay accurate. |
| S3 | 01 §3 · **C4** | CRITICAL | **FIXED** | `v-s3-coverage`: 32/35 realistic families caught vs **11/36** at audit time; every family named in the fix list is caught. 3 deliberately unkeyed controls are still missed (the matrix discriminates). 0 false positives across `src/`. |
| S4 | 01 §4 · **H6** | HIGH | **FIXED** | `v-s4-s7-s9`: a `/g` custom rule redacts **8/8** lines (was 4/8), two files with identical content produce byte-identical output, caller `pattern.lastIndex` is 0 after the scan, overlapping rules mask each span once, and a rule matching the redaction marker cannot resurrect a secret. |
| S5 | 01 §5 · **H1** | HIGH | **FIXED** | `v-s5-sensitive`: 14/14 credential files skipped with `reason:"sensitive-file"` in git **and** no-git walk paths; templates `.env.example/.sample/.template/.dist/.production.example` still included; opt-in still emits with values redacted; **10/10** `.env.*` variants (incl. `.env.production.local`, `.env_backup`, `.env-bak`, `.envrc`) skipped; the previously recorded names `credentials.json`, `service-account.json`, `secrets.json`, `terraform.tfvars` are now denied too. |
| S6 | 01 §6 | MEDIUM | **FIXED** | `v-s6-summary`: a mongo URI and AWS id in Markdown headings, body and frontmatter are absent from `parts/*.md` and `manifest.json`; the summary's `headings[]` keep the safe parts and carry the marker — summaries are built from redacted text. |
| S7 | 01 §7 | MEDIUM | **FIXED** | `v-s4-s7-s9`: the old fixture keeps `export const region`, `us-east-1` and `retries = 3` around the mask; two secrets on one line are both masked and `doWork();` survives. |
| S8 | 01 §8 | MEDIUM | **FIXED** | `v-s8-redos`: 1 MB `eyJ`-dense line = **625 ms**, linear (4× input → 4.0× time; old ≈31 s/MB); the audit's 300 KB `base64(json)` shape = 2 ms (was 2,783 ms); 1.2 MB base64 = 20 ms; worst of **21 rules × 14 adversarial 200 KB lines (294 runs) = 1 ms**. |
| S9 | 01 §9 | LOW | **FIXED** | `v-s4-s7-s9`: a `.snapshotrc.json` string pattern loads → compiles → redacts; an invalid pattern raises `Invalid regular expression for secret rule "bad"`; a `42` pattern raises `…neither a RegExp nor a string` (old: `pattern.test is not a function`). |

### 1.2 Correctness — `audit/02-correctness.md`

| # | Report ref | Sev | Verdict | Evidence (script + observed result) |
| :-- | :-- | :-- | :-- | :--- |
| C02-1 | 02 §1 · **C1** | CRITICAL | **FIXED** | `v-c1-dataloss`: 13/13. `outDir` `.`, `./`, `..`, `""`, `outDir=tmpDir`, nested `tmpDir`, `tmpDir="."` refused **before any write** (source + `.git` fingerprint unchanged). Previous snapshot survives a rejected config. A real junction onto `D:` (EXDEV) writes via the copy fallback and regenerates with no litter on either volume. A locked `outDir` (`EBUSY` from a live child process) leaves the old manifest byte-identical. |
| C02-2 | 02 §2 · **H2** | HIGH | **FIXED** | `v-c2-nonascii`: 9/9 paths (`café.ts`, `ümlaut-ok.ts`, `日本語.ts`, `emoji-🚀.ts`, `résumé.md`, `with space.ts`, `hash#tag.ts`, `percent%41.ts`) collected verbatim, hashed, parted and emitted as headings; 0 `read-error` records; walk fallback clean; `validate` afterwards is `valid:true`. |
| C02-3 | 02 §3 · **H3** | HIGH | **FIXED** | `v-c3-hash`: manifest hash equals `sha256(raw bytes)` for 6 fixtures including 2 genuinely lossy UTF-8 files (lossiness asserted, so the check is not vacuous); `validate` clean immediately after `generate` and after 2 regenerations; a real byte edit — including in an invalid-UTF-8 file — still reported as exactly one mismatch. |
| C02-4 | 02 §4 · **H4** | HIGH | **FIXED** | `v-c4-budget`: 19/19. 4.16 MB single-line file → **305,331 B** part vs 307,200 B (was 4,160,812 B = 13.54×); 4-byte UTF-8 truncation never emits U+FFFD; 4 KB floor respected; 98% budget fill (was 55%); counters agree in 4 configs. Fixed-metadata cases: 6,000-char layer name → **1,241 B, `passed`** (was 12,588 B / `failed`); 10,000-char kind → 1,237 B; 10,000-char path → 2,528 B with the full path kept in `includedFiles`; 400-char path elided to a 309-char heading; 30 files each with a 6 KB layer name → 15 parts, worst 2,085 B. |
| C02-5 | 02 §5 · **H5** | HIGH | **FIXED** | `v-c5-c6`: 9 malformed manifests (missing `files`/`skipped`/`parts`, `files` not an array, `{}`, `null`, `[]`, a bare string, invalid JSON) return `{valid:false}` without throwing; `validate` via the CLI exits 1 with `❌ Snapshot validation failed:` and **no stack trace**. |
| C02-6 | 02 §6 | MEDIUM | **FIXED** | `v-c5-c6`: 26/26. Parts verified (deleted / corrupted / tampered metadata), config drift, extra + deleted files, bookkeeping, monolith artefacts. New bookkeeping pass: **15/15 tamper cases detected** (`counts.totalFiles/partsCount/skippedCount/totalSizeBytes`, `totals.includedFiles/partCount/skippedFiles/totalSourceBytes/totalContentBytes/candidateFiles/warningCount`, `fullFiles+previewFiles`, `budgets.maxPartBytes/largeFileBytes`, Σ `includedBytes`), each reported as a named `totalsMismatches[]` entry (`totals.includedFiles: manifest 999 vs actual 4`). Pristine manifest: `valid:true`, 0 mismatches, 0 warnings. Git: new commit → `Snapshot was generated at commit 9ce1740a but HEAD is 657c6c8c.`; dirty tree → `Working tree has uncommitted changes.` |
| C02-7 | 02 §7 | MEDIUM | **FIXED** | `v-c7-c14`: a 1.6 KB file above a 500 B `largeFileBytes` whose preview was **not** truncated is `isLarge:true, inclusionMode:"full"` under `#### Content`; a genuinely truncated file is `"preview"` under `#### Bounded Preview`; `fullFiles`/`previewFiles` derived (10/1). |
| C02-8 | 02 §8 | MEDIUM | **FIXED** | `v-c7-c14`: **11/11** `navigation.md` links resolve to an emitted `<a id>` (was 0/3); `anchorForPath` injective for the old collision (`src-a-b-ts-33d4be26` ≠ `src-a-b-ts-eb704146`). |
| C02-9 | 02 §9 | MEDIUM | **FIXED** | `v-c7-c14`: `full-codebase.md` uses 4-backtick fences; an `INJECTED HEADING` after an inner triple fence stays inside the block (fence-state machine). |
| C02-10 | 02 §10 | MEDIUM | **FIXED** | `v-c7-c14`: `status` is a function of `validation.errors` across 5 adversarial fixtures (normal, huge line, huge summary, huge layer name, empty — all `passed/0`); the derivation `errors.length === 0 ? "passed" : "failed"` is present in `dist/index.cjs` and no hardcoded literal remains; a manifest *declaring* `failed` is surfaced as invalid to consumers. `generator` is exactly `{name, version}`. |
| C02-11 | 02 §11 | MEDIUM | **FIXED** | `v-c11-ast`: 20,000 `&&` operands summarise (iterative walk); 20,000 nested parentheses (TypeScript's own parser throws) are contained — run completes, file kept, content emitted, warning names the file, CLI exit 0, no `RangeError`. |
| C02-12 | 02 §12 | MEDIUM | **FIXED** | `v-c12`: `src/app/**` 7/7 (`src/apple/`, `src/application/`, `src/app2/` not `app`); `"test"` 5/5 (`contest/`, `attest/`, `attestation/` kept); globs `*.lock` / `**/fixtures/**` / not `fixturesx/`; end-to-end excludes keep `attest/words.ts` and `contest/entry.ts`. |
| C02-13 | 02 §13 | MEDIUM | **FIXED** | `v-c7-c14`: `indexes.imports.byFile` 9 entries with `./b` for `src/a.ts`, `centralFiles` derived (`src/b.ts`), `directives` has `use client`, `features` has `billing` (2 files). |
| C02-14 | 02 §14 | LOW | **FIXED** | `v-c7-c14`: `totalContentBytes` (4,722) equals `Σ includedBytes` and differs from `totalSourceBytes` (11,642). |
| C02-15 | 02 §15 | LOW | **FIXED** | `v-c15`: config in `hash#dir/percent%41dir` loads (was silently `null`); syntax-error and malformed-JSON configs warn instead of being swallowed; `.ts` config loads and is gated by `supportsTypeScriptImports()`; `package.json` `snapshot` key honoured. |
| C02-16 | 02 §16 | LOW | **FIXED** | `v-c16-18-19`: a directory junction in the no-git walk produces `skipped[{path:"link-dir", reason:"symlink", detail:"followed directory symlink"}]` (was dropped with no record); a self-referential junction terminates. File symlinks: **fixed by inspection** — `fs.symlinkSync` → `EPERM` here. |
| C02-17 | 02 §17 | LOW | **FIXED** | `v-c7-c14`: `countLines` 7/7; `two.ts`=2 (was 3), `onlynewline.ts`=1 (was 2), `empty.ts`=0; preview `originalLines`=400 (was 401), `includedLines`=121, **280** omitted (was 281); `counts.totalLines` equals the sum. |
| C02-18 | 02 §18 | LOW | **FIXED** | `v-c16-18-19`: code-unit ordering, directories suffixed `src/`, 25,000-path tree capped at 401 KB with a truncation marker. The file/dir name-collision PoC is unreachable on a real filesystem (the OS refuses it — recorded, not claimed). |
| C02-19 | 02 §19 | LOW | **FIXED** | `v-c16-18-19`: `.mts`/`.cts` summarised; anonymous `export default function/class` and `export default 42` record `"default"`; `export * from "./star"` in `reExports` **and** `imports`; only exported route handlers (`GET,POST`) recorded. |
| C02-20 | 02 §20 | — | **NOT A FINDING** | `v-c20-rejected`: the audit's own rejected claims re-checked and still rejected — `byteSize` == file size at every digit boundary, CRLF parts contain no `\r` and stay in budget, empty repo → 0 parts / `valid:true` / no `NaN`, Windows path config loads via `pathToFileURL`, self-referential junction terminates. |

### 1.3 API / packaging / CI — `audit/03-api-build.md` (ranked table)

| # | Rank | Sev | Verdict | Evidence (script + observed result) |
| :-- | :-- | :-- | :-- | :--- |
| A03-1 | 1 · **H7** | HIGH | **FIXED** | `v-a1-a4`: `--cwd=<dir>` honoured by `generate` **and** `validate` (old: validated `process.cwd()` → false drift; now `valid:true`); `--out-dir=`, `--max-part-bytes=`, `--mode=` honoured in equals form. |
| A03-2 | 2 · **H8** | HIGH | **FIXED** | `v-a2-a3`: `--format=json` stdout parses for `generate` (5,114 B), `validate`, `report`, and after a file redirect like the audit's own command (6,570 B); progress only on stderr. |
| A03-3 | 3 · **H9** | HIGH | **FIXED** | `v-a2-a3`: `--dry-run` creates nothing in a fresh dir (0 new entries), leaves an existing snapshot's 6 files byte-identical, no `.backup-*`/tmp litter, prints the plan; dead `--force`/`--monolith-content` exit 2; `--max-monolith-bytes` skips and warns. |
| A03-4 | 4 | MEDIUM | **FIXED** | `v-a1-a4`: 10 invalid invocations (unknown flag/command, typo, two commands, bad `--format`, `abc`/`0`/`4095`/`-5`) exit **2** with usage, no stack trace, no snapshot written; a typo cannot overwrite; `--help`/`--version` exit 0. |
| A03-5 | 5 | MEDIUM | **FIXED** | `v-a5-a9`: `init` writes `snapshot.config.ts`, the next `generate` reports `⚙ Using config …snapshot.config.ts` and applies it; second `init` exits 1. Node ≤ 20 `.mjs` fallback: **fixed by inspection** (only Node 24 available). |
| A03-6 | 6 | MEDIUM | **FIXED** | `v-a6-a10`: `scripts.prepare = npm run build`; a fresh copy **without `dist/`** run through the real `npm pack` builds and ships 15 files incl. every entry point and **0** sourcemaps. |
| A03-7 | 7 | MEDIUM | **FIXED** | `v-a6-a10`: `exports["./cli"]` has `import`+`require` with `types` that exist; root `require.types` resolves the previously-dead `dist/index.d.cts`; real `require()` and `import()` of `./cli` and `./package.json` work (`function 2.0.0` both ways). |
| A03-8 | 8 | MEDIUM | **FIXED** | `v-a6-a10`: `npm test` in a dist-less checkout passes **56/56** (`pretest` builds first). Recorded, not hidden: the suite still imports `../dist/index.js` (the audit preferred `src`); `pretest` is what makes it safe. |
| A03-9 | 9 | MEDIUM | **FIXED** | `v-a5-a9`: `generateSnapshot(config)` returns a `Manifest` with no `.then`; `await` still works; `generateSnapshotAsync` returns a real `Promise`. |
| A03-10 | 10 | LOW | **FIXED** | `v-a6-a10`: `exports["./package.json"]`, `sideEffects:false`, `files` excludes `.map`, tarball has 0 maps, root `require.types` resolves. |
| A03-11 | 11 | LOW | **FIXED** | `v-c7-c14`: no `path`/`bytes`/`sha256` aliases on `FileEntry`, no `bytes`/`files` on `PartMetadata`; `includedBytes`/`byteSize` present. |
| A03-12 | 12 | LOW | **FIXED** | `v-c15`: `resolveConfig(cfg, undefined, dir).cwd === dir` (no more generation into `process.cwd()`); nonexistent cwd and file-as-cwd rejected with clear messages. |
| A03-13 | 13 | LOW | **FIXED** | `v-a13-ci`: 12/12. SHAs pinned 4/4, least-privilege `permissions`, `concurrency`, typecheck + coverage + tarball gates, main-guarded `workflow_dispatch`, `noUnusedLocals/Parameters`. **New gates verified:** `scripts/lint.mjs` wired as `npm run lint` (ci.yml:49-50) and `npm run check`; the real tree passes (`lint: 29 file(s) clean`); an injected file with six violations makes it **exit 1** naming `trailing-ws`, `src-console`, `empty-catch`, `explicit-any`, `stray-todo`, `eol`; `npm audit --audit-level=high` present (ci.yml:53-54); `.github/dependabot.yml` parses as YAML (PyYAML) with `npm` + `github-actions` ecosystems and grouped `runtime`/`development` updates. |

---

## 2. PARTIAL / STILL BROKEN

**None.** All three findings that were PARTIAL in pass 1 (`02 §4`, `02 §6`, `03 §13`) now pass every check,
including the exact fixtures that failed before.

### 2.1 What changed, and the re-test that closed each item

**`02 §4 / H4` — fixed metadata could exceed the budget.**
Pass-1 evidence: a 6,000-char layer name produced a **12,588 B** part against a 4,096 B budget with
`validation.status = "failed"`. Pass-2 evidence (`v-c4-budget`):

```
    OBS C4.fixed-metadata: worst part=1241 B budget=4096 status=passed errors=0
PASS C4.fixed-metadata :: worst 1241 B <= 4096 B, status passed (was 12,588 B / failed)
    OBS C4.fixed-metadata-kind: worst=1237 B budget=4096 status=passed
    OBS C4.fixed-metadata-path: worst=2528 B budget=4096 recordedPathLen=10007 anchorLen=1979 sectionTruncated=true
    OBS C4.fixed-metadata-path-elision: fileLineLen=309 elided=true listEntryLen=299 part=1481 B
    OBS C4.fixed-metadata-many: parts=15 worst=2085 B budget=4096 status=passed
```

Implementation: metadata values capped at 200 chars and display paths at 300 (middle-elided, full path kept in
`includedFiles[].relativePath`) in `src/partitioner/chunker.ts:89-105,288-310`; `greedyGroups` accounts for the
displayed path (`:179-195`); and the single-section overflow branch no longer early-returns — it hard-truncates
and re-hashes (`:60-86`, `rehashPart` at `:166-177`). Residual, recorded and **not** scored: `anchorForPath`
slugs the full path, so a 10 KB path spends the budget on the anchor and the section is hard-truncated
(`sectionTruncated=true`) before the elided heading renders. The byte bound still holds, and Windows cannot
create such a path (MAX_PATH ≈ 260).

**`02 §6` — totals/counts/budgets and git state were not checked.**
Pass-1 evidence: `totals.includedFiles=999` and a branch switch both validated clean. Pass-2 evidence
(`v-c5-c6-validate`):

```
    OBS C6.pristine: valid=true totalsMismatches=[] warnings=[]
PASS C6.pristine :: valid:true, 0 totalsMismatches, 0 warnings
    OBS C6.totals-matrix: detected=15/15
PASS C6.totals-detail :: totals.includedFiles: manifest 999 vs actual 4
    OBS C6.git-commit: manifest=9ce1740a HEAD=657c6c8c valid=true warnings=["Snapshot was generated at commit 9ce1740a but HEAD is 657c6c8c."]
    OBS C6.git-dirty: warnings=["Working tree has uncommitted changes."]
```

Implementation: a bookkeeping pass in `src/validator/validate.ts:227-293` recomputes every count/total/budget
from the manifest's own file and part lists (including Σ `includedFiles[].includedBytes`) into a new
`drift.totalsMismatches[]` (`src/types.ts:278-288`); git commit/HEAD and dirty-tree checks at
`validate.ts:295-310`. The pristine case is asserted explicitly — no false positives.

**`03 §13` — no lint/format gate, no dependency review.**
Pass-1 evidence: no lint script/step, no Dependabot, no audit. Pass-2 evidence (`v-a13-ci`): all 12 checks
pass, including the injected-violation run:

```
PASS A13.lint-wired :: npm run lint + CI step + npm run check
PASS A13.lint-clean :: lint: 29 file(s) clean
PASS A13.lint-fails :: 6 rules fired on an injected file
PASS A13.dependabot :: yaml ok: npm + github-actions, npm groups runtime/development
PASS A13.audit-step :: run: npm audit --audit-level=high
```

**On "lint gate without eslint":** sufficient to close the finding as written. The finding was that CI had no
lint/format gate at all; the substance is that convention violations fail the build, and that is verified — a
scratch copy with trailing whitespace, `console.log` in `src`, an empty `catch`, `: any`, a TODO and CRLF exits
1 and names each rule. The dependency-free script also keeps `npm ci` reproducible offline (eslint would
require a lockfile change that cannot be made here). Rule breadth is narrower than eslint's — if broader rule
coverage is wanted later, adding eslint is an additive change, not a reopening of this finding.

---

## 3. Regressions introduced by the fixes

All three regressions found in pass 1 are now **closed** on the frozen target; residual behaviours of the same
code are recorded below without being scored as regressions.

| ID | Status | Detail |
| :--- | :--- | :--- |
| **R1** | **closed** | The `env-secret-assignment` rule added by the C4 fix was quadratic (`^\s*[A-Za-z0-9_]*(?:KEY\|TOKEN\|…)[A-Za-z0-9_]*\s*=`). Pass 1 measured **5,630 ms** for a 240 KB `KEY`-dense line (349 ms @60 KB → 1,397 ms @120 KB, 4.0× per doubling). Now bounded: **2 ms** for the same line, and the full matrix of 21 rules × 14 adversarial 200 KB lines (294 runs) has a worst case of **1 ms**. |
| **R2** | **closed** | `{ ...resolvedConfig, override }` lost the non-enumerable brand and re-resolved as a user config, silently dropping custom `secretRules` (pass 1: direct=1 finding, spread=0 findings, `ACME_abcdefgh1234` emitted in clear). Now `isResolvedConfig` also accepts the complete structural shape with `secretRules` as discriminator (`src/config.ts:46-105`), `normalizeResolvedConfig` recompiles rules (`:112-122`), and both entry points route through it (`src/index.ts:334-340`, `src/validator/validate.ts:44-46`). Re-verified: spread **1 finding, no leak**; `structuredClone` of a function-free config **1 finding**; a spread with a `/g` rule **0 survivors of 8**; string patterns compile (**1 finding**); the documented user-config path unchanged. |
| **R3** | **closed** | Dropping an oversized summary zeroed the body (pass 1: 0 B emitted of 400,003 B while ~305 KB was free). `prepareSection` is now staged — truncate, drop summary, re-truncate with the reclaimed room, hard-truncate only as a last resort (`src/partitioner/chunker.ts:117-155`). Re-verified: **304,715 B** emitted (control `.txt` 304,764 B); a mid-file-heading fixture keeps its **tail** (`TAILMARKER` present, 161,868 B body); a 20,000-export TS file emits **304,703 B** of body. |

Recorded residuals of the new code (not regressions — inherent limits or recorded, non-scored gaps):

* **R2 residual — JSON round-trip.** `JSON.parse(JSON.stringify(resolvedConfig))` cannot carry `RegExp`
  objects (`pattern` becomes `{}`), so `isResolvedConfig` is false and the run falls back to the default rules;
  the custom rule's value is emitted (`leaked=true`). No implementation can recover a regex from `{}`; what
  could be added is a loud error when `secretRules` entries are unusable. Documented, not scored.
* **R2 residual — preset configs are not cloneable.** `structuredClone` of a config carrying the default preset
  layers/kinds throws `DataCloneError` because preset matchers are functions. Unrelated to the brand; a
  function-free config clones and keeps its rules.
* **Almost-resolved objects.** A hand-built object missing one resolved-only field is (correctly) treated as a
  user config: it is re-resolved, defaults apply, no crash — and its `secretRules` are ignored, so such a
  caller must express patterns through `secrets.customPatterns` (verified working).
* **C10 `failed` branch is now unreachable from public inputs.** Because every invariant `verifyInMemory`
  guards is enforced, no fixture can make `generateSnapshot` report `failed`. Verified instead that the field
  is a function of `validation.errors` across five adversarial fixtures, that the derivation is present in the
  shipped bundle, and that a manifest *declaring* `failed` is surfaced as invalid. This is the intended end
  state, not a gap.
* **S5 remaining filename gaps.** `.env-`, `.env_` (no dot separator) and `.netrc.bak` are still allowed. All
  `.env*` dot-variants and backups, `credentials.json`, `service-account.json`, `secrets.json` and
  `terraform.tfvars` are denied. Recorded, not scored.
* **S2 malformed keys.** A PEM body with a blank line, an indented *unterminated* body, and a lowercase
  `-----begin …` header still keep their body. All require a non-standard or truncated key; every realistic
  shape is masked.
* **S6 frontmatter key name.** Span-only redaction erases the whole `db_password: "…"` span, so that key name
  is lost from the summary (`title` survives). Value protected, key name collateral.

---

## 4. Counts

**Findings (41 distinct, sub-report granularity):**

| Verdict | Pass 1 | Pass 2 (final) |
| :--- | :--- | :--- |
| FIXED | 38 | **41** |
| PARTIAL | 3 (`02 §4`, `02 §6`, `03 §13`) | **0** |
| STILL BROKEN | 0 | **0** |
| NOT REPRODUCIBLE | 0 | **0** |

Plus `02 §20` (the 5 claims the audit itself rejected) re-checked as still sound, and `03 §8`'s “imports dist”
detail recorded as mitigated rather than fixed.

**Assertions:** 245 across 23 scripts → **245 PASS / 0 FAIL** on `dist/index.cjs 1E35BFA88D2A3D63`.
(Pass 1: 220 assertions, 213 PASS / 7 FAIL, where every FAIL was a residual or regression probe.)

**Fixed by inspection only (could not be executed in this environment):**

| Item | Why | Where |
| :--- | :--- | :--- |
| EXDEV *rollback* after the old dir was moved to `.backup-*` | needs the second rename to fail after the first succeeded; not deterministic on one volume. The EXDEV copy path itself **was** executed over a real `D:` junction. | `src/index.ts:295-321` |
| File symlinks (`entry.isSymbolicLink()` + `isFile()` branch) | `fs.symlinkSync` → `EPERM` (no admin/Developer Mode) | `src/scanner/files.ts:305-325` |
| `.mjs` config fallback for Node < 22.6, and the “ignored .ts config” warning | only Node 24.12 installed | `src/config.ts:63-71,115-121`, `src/cli.ts:211` |
| GitHub Actions execution (pinning, permissions, gates) | no Actions runner; verified by static inspection of the YAML | `.github/workflows/*.yml` |
| `npm publish --provenance` | requires registry credentials | `publish.yml` |
| CLI `1` exit half of `status === "passed" ? 0 : 1` | branch now unreachable (see §3); the `0` path was executed | `src/cli.ts:386` |

**Reproduce:**

```
node audit/verify/run-all.mjs          # all 23 scripts + summary table (245 assertions)
node audit/verify/v-c4-budget.mjs      # H4 + R3 evidence
node audit/verify/v-c5-c6-validate.mjs # 02 §6 bookkeeping + git evidence
node audit/verify/v-a13-ci.mjs         # 03 §13 lint/dependabot/audit evidence
node audit/verify/v-s4-s7-s9-rules.mjs # R2 evidence
```

Each script creates its own fixtures under `os.tmpdir()` and removes them; the two `EXDEV` cases use a real
junction on `D:` and delete it afterwards; the lint-failure case runs in a scratch copy of `src/tests/scripts`,
never in the frozen tree. `audit/verify/RUN-LOG.txt` holds the complete raw output quoted above.
