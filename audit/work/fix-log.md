# 0.10.1 audit — fix log

Every finding in `audit/reports/0.10.1-code-analysis.md` has a fix, a regression test and a
verification. Nothing is deferred; the batch ships as 0.10.2.

The final gate is `npm run verify` (lint + typecheck + 1 138 tests + workflow pins + sync-docs +
site + link check + site audit + readme lint + tarball check); every row below was also checked
end to end on its own, with the test named in the last column.

## High

| ID | What was wrong | Fix | Test |
| :-- | :-- | :-- | :-- |
| H1 | A quoted credential whose closing quote is not on the line matched no rule: emitted in clear, zero findings. A mask that would unbalance a balanced line was skipped **and recorded nothing**. | New built-in rule `credential-assignment-unterminated` (32 rules now). The balance guard now masks around quotes instead of refusing the rewrite, so parity cannot change and the value does not survive. | `tests/redaction-unterminated-quote.test.js` (4), `scan-truth` rule count |

## Medium

| ID | What was wrong | Fix | Test |
| :-- | :-- | :-- | :-- |
| H2 | `validate` never read `incomplete[]`: ten tampered variants reported "valid and up to date", including `relativePath: "../escape.ts"`. | Shape guard checks the whole record (`incompleteCount`, reason set, ranges sorted/bounded/in range, `omittedLines` = sum of ranges, `includedLines <= lines`, confined `relativePath`); `validate` cross-checks `incomplete[]` against `files[]` both ways. | `tests/incomplete-contract.test.js` (15) |
| H3 | The monolith entry said `inclusionMode: "full"` beside `truncationReason`/`omittedRanges`. | Those fields are dropped from the monolith projection. | `generation-truth` "C4: a monolith entry that says full carries no truncation fields" |
| H4 | `discovery` missing from `SnapshotConfig`, so a TS config was TS2353. | Added to the interface; a compile-time proof keeps `CONFIG_KEY_NAMES` a subset of `keyof SnapshotConfig`. | compile-time (tsc), `discovery-mode` contract assertions |
| H5 | `snapshot_plan` generated on the RPC thread. | `generateInWorker(..., { dryRun: true })`; the worker applies `dryRun` and returns the plan's counts, layers and ranked skip reasons. | `tests/mcp-plan-offthread.test.js` (3) |
| H6 | A previewed importer was absent from `indexes.imports.byFile`, so `snapshot_dependents` said "0 importer(s)". | `buildIndexes` takes `skippedSummaryImports`; such an entry carries `exportsOmitted: true`. | `mcp-dependents` "a previewed importer is still an importer" |
| H7 | `compareManifests` had no rules parameter; `diff` printed project tokens in clear. Also `payload.layers` was unmasked. | Rules parameter threaded through all four masking sites; layer maps masked with the same rules. | `diff-payload` "compareManifests applies the caller's secret rules…" |
| H8 | `init --out-dir .context` ignored `/snapshot/`. | Entries derived from the effective outDir/tmpDir, anchored, out-of-tree skipped. | `init-gitignore-directory` (3 new) |
| H9 | Two live assets 404'd; the link gate read only `href`. | `docs/assets/` rewrites to `assets/`; `check-site-links` checks `src` too. | `site-anchors` (2 new) |
| H10 | `reports/.DS_Store` made the tool refuse its own outDir. | `isIgnorableEntry` compares the basename, used at all three sites. | `ownership-evidence` (2 new) |
| H11 | `generatorOrigin` used bare `JSON.parse`, so a BOM'd package.json read as "global or direct install". | `stripJsonComments`, as 115 lines above. | `records-and-bom` (2 new) |
| H12 | SARIF result order used `localeCompare`. | Code-unit comparison. | `sarif-integration` (2 new) |

## Nits

| ID | Fix | Test |
| :-- | :-- | :-- |
| N1 | `summaryOmitted`/`summaryOmittedReason` asserted, and their invariant checked on every entry. | `summary-preview` (2 new) |
| N2 | Unreachable skip deleted; `validate`/`report`/`diff` print the same sentence with the same `❌`. | `manifest-shape-guard` (no skips) |
| N3 | One cause, one name: audit.md says "part budget (maxPartBytes)" / "large-file budget (largeFileBytes)". | `generator-partitioner-fixes` |
| N4 | "N included of M paths found" — the count is paths, and a skipped directory is one. | `no-silent-loss` |
| N5 | `docs/cli.md` gitignore entries anchored; stale-context output corrected; `explain` shape is `{ rules, line }`. | doc read + `site-anchors` |
| N6 | The placeholder exemption is documented exhaustively with its source of truth, and pinned by a test. | `tests/placeholder-exemption.test.js` (3) |
| N7 | `exportsKind: "esm"` is produced; absence means no exports again. | `ast-edges` |
| N8 | One JSONC reader; the private copy in `config.ts` is gone. | `config-precedence-and-digest` (2 new) |
| N9 | The line cap warns like the depth cap; both go through `treeTruncationWarnings`. | `generator-partitioner-fixes` (2 new) |
| N10 | `payload.codes`; `how-to-context-budget.md` cites `totals.emittedLines`/`counts.partsCount`. | `diff-payload` |
| N11 | The measured example is re-measured: 88 files / 28 969 lines / 1 190 636 B / ≈340 000 tokens. | doc numbers re-derived from `git ls-files src` |
| N12 | Eight test messages interpolate. | the tests themselves |
| N13 | `secretRules` is in `describe.config.settings`; the carve-out is a map with a reason per alias, plus a test that each is a real key. | `contract-completeness` (1 new) |
| N14 | `CONTRIBUTING.md` maps `4.x` headers to the retired line. | doc |
| N15 | Every stacked/orphaned JSDoc block removed or moved (a detector over `src` reports none); three welded statements split. | `npm run lint` (219 files clean) |

## The withdrawn findings' surviving nits

| Finding | Fix |
| :-- | :-- |
| W1 nit | `docs/output.md` and `IncompleteFile` now say plainly that `includedLines` counts the notice for a preview. |
| W2 nit | `partitionFiles` throws below the 2 610 B it can honour instead of clamping; test added. |

## Verification record

- `npm run check`: lint + tsc + 1 138 tests, 1 130 pass, 0 fail, 8 skipped.
- `npm run verify`: the above, plus workflow pins, `sync-docs --check`, site build,
  `check-site-links` (385 internal links, now including `src`), `audit-site`, `readme-lint`
  and `pack-check` — all clean.
- `node audit/work/verify-fixes.mjs`: 28 of 28 checks pass against the built binary.
- Probes kept under `audit/work/`: `h1-probe.mjs` (unterminated quotes), `plan-probe.mjs`
  (`snapshot_plan` off-thread).
