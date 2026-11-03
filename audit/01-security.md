# `@ankurhalder/codebase-snapshot` — Security Audit: secrets redaction

**Scope audited:** `src/security/patterns.ts`, `src/security/redact.ts`, `src/generator/audit.ts`, the `allSecretFindings` flow in `src/index.ts`, and `src/scanner/{binary,files}.ts` only as far as they decide which sensitive files enter the snapshot. Chunking, config loading and build tooling are out of scope and were not audited.

**Environment:** Node v24.12.0, Windows. `dist/` was built from the current `src/` (verified: `dist/index.js` contains `pattern.test(line)` at :1192, the `snippet: line.trim()` at :1198 and the `[REDACTED…]` marker at :1202, matching `src/security/redact.ts`). All PoCs import `../../dist/index.js`. `src/`, `tests/`, `dist/`, `package.json` were not modified. Fixtures and scripts are under `audit/poc/` (`security-*.mjs`, `security-fixture-*/`), each fixture a throw-away `git init` repo.

**Evidence tags:** **[EXEC]** = proven by running the PoC and quoting its real output. Every finding below carries [EXEC]; the only read-only observations are collected in "Read-only observations" at the end.

## Findings, ranked

| # | Severity | Title | Location |
| :-- | :-- | :-- | :-- |
| 1 | CRITICAL | `reports/audit.md` writes the raw, unredacted source line for every detected secret | `src/generator/audit.ts:31` (snippet from `src/security/redact.ts:21`) |
| 2 | CRITICAL | Multi-line private keys are not redacted: only the `BEGIN` line dies, body + `END` survive; a usable key is reconstructible from `parts/*.md` | `src/security/patterns.ts:6`, `src/security/redact.ts:25` |
| 3 | CRITICAL | Default pattern set misses the most common secret formats (11/36 realistic samples caught); `.env`-style assignments are structurally excluded | `src/security/patterns.ts:3-44`, esp. `:18`, `:42` |
| 4 | HIGH | `pattern.test()` on a caller-supplied `/g` rule is stateful → every other match silently skipped, cross-file contamination | `src/security/redact.ts:14` |
| 5 | HIGH | No sensitive-file deny list: `.npmrc`, `.git-credentials`, `*.pem`, `id_rsa` are always collected; `.env` when tracked or when the non-git walk fallback runs | `src/scanner/files.ts:76-91` |
| 6 | MEDIUM | AST/structured summaries are computed from **raw** content → a secret in a Markdown heading is redacted in the body but emitted verbatim in `parts/*.md` and `manifest.json` | `src/index.ts:151-155`, `src/ast/structured.ts:71-74` |
| 7 | MEDIUM | Redaction replaces the whole line, destroying unrelated code that the snapshot is supposed to carry | `src/security/redact.ts:25` |
| 8 | MEDIUM | Quadratic backtracking in `jwt-token`: one `eyJ`-dense line costs ~30 s/MB (measured 1.22 s @200 KB); `largeFileBytes` does not bound it | `src/security/patterns.ts:10` |
| 9 | LOW | `customPatterns` supplied through a JSON config make `scanAndRedactSecrets` throw (`pattern.test is not a function`); whole run aborts | `src/security/redact.ts:14`, `src/config.ts:74-76` |

---

### 1. CRITICAL — `reports/audit.md` writes the raw, unredacted source line for every detected secret

**Description:** `scanAndRedactSecrets` stores the untouched line text in `SecretFinding.snippet` (`redact.ts:21`), `generateAuditReport` prints it into a Markdown table (`audit.ts:31`), and `index.ts:329-333` writes that file into the snapshot directory — so a secret redacted out of `parts/` is written verbatim into `reports/audit.md`, which `snapshot/README.md:23` advertises as "Security scan findings".

**[EXEC]** `node audit/poc/security-e2e-snapshot.mjs` (real repo with an AWS key, a JWT, a Mongo URI, a `.env`, a private key):

```
=== 2. LEAK MATRIX: which emitted artifact still contains the secret verbatim? ===
  LEAK  AWS access key id (default rule)         -> reports/audit.md
  OK    JWT (default rule)                       -> (redacted everywhere)
  LEAK  mongodb URI creds (default rule)         -> reports/audit.md
  LEAK  quoted apiKey in .ts (default rule)      -> reports/audit.md

=== 3. reports/audit.md: does it print the RAW line? ===
  audit.md:17  [AWS access key id (default rule)]
    | `src/aws.ts` | 2 | `aws-access-key-id` | `export const awsKey = "AKIAIOSFODNN7EXAMPLE"; export const region = "us-east-1"; const retries = 3;` |
  snapshot/README.md advertises it as: - [reports/audit.md](reports/audit.md) — Security scan findings, ...
=== 4. Same secret value, side by side in parts/ vs reports/ ===
  parts: [REDACTED: potential secret-like value omitted from snapshot]
  audit: | `src/aws.ts` | 2 | `aws-access-key-id` | `export const awsKey = "AKIAIOSFODNN7EXAMPLE"; ...` |
```

**Blast radius:** every repository scanned. Any value matching one of the 10 patterns is written in clear text into the one artifact users are told to paste into an LLM and to commit with the snapshot. The redaction feature actively *concentrates* secrets into `reports/audit.md`. Mitigating detail: the snippet is `slice(0, 120)` of the trimmed line, so a secret starting beyond column 120 is truncated away. `manifest.json` is *not* affected (`warnings` only carries `"<rule> at <path>:<line>"`, verified in the same run).

**Fix:** emit no source text from the audit report at all.

```ts
// redact.ts — keep a masked preview, never the raw line
const masked = line.trim().replace(new RegExp(src, flagsWithoutGY), "[REDACTED]").slice(0, 120);
```
and make `generateAuditReport` render `| path | line | rule |` only (drop the snippet column). Add a regression test that greps every artifact for the fixture secrets.

---

### 2. CRITICAL — multi-line private keys: only the `BEGIN` line is redacted, the key survives

**Description:** `private-key-header` matches the header line only and redaction is per-line (`redact.ts:13-26`), so for a PEM block exactly one line becomes `[REDACTED…]`; every body line and the `-----END … PRIVATE KEY-----` line are copied verbatim.

**[EXEC]** `node audit/poc/security-redact-units.mjs`:

```
=== B. multi-line PEM: only the BEGIN header line is replaced ===
  L1: [REDACTED: potential secret-like value omitted from snapshot]
  L2: MIIEowIBAAKCAQEAzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz
  L3: BODYSECRETLINE2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  L4: -----END RSA PRIVATE KEY-----
  findings: private-key-header@L1
  body lines preserved verbatim: 3 of 3
  END lines preserved: 2 -> an attacker only has to re-add the BEGIN header
```

**[EXEC]** Same finding closed end-to-end with a real 2048-bit key in `security-e2e-snapshot.mjs`: the script extracts the `keys/id_rsa` block from `parts/part-001.md`, substitutes the marker line with `-----BEGIN RSA PRIVATE KEY-----`, and parses it:

```
=== 5. KEY RECONSTRUCTION ===
  marker lines replaced: 1 of 27 lines | intact key-body lines: 25
  --> RECONSTRUCTED, usable key identical to original (public key matches) | as-emitted body was unparsable -> a single-line header substitution makes it work
```

**Blast radius:** every private key in every scanned repo — `*.pem`, `id_rsa`, `id_ed25519`, `*.key`, k8s/tls secrets. The "redacted" marker is a one-line speed bump; the key is recoverable with a text substitution. This is silent: the audit report says the key was handled.

**Fix:** redact key *blocks*, after the per-line pass:

```ts
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
redacted = redacted.replace(PEM_BLOCK, "[REDACTED: private key block]");
```
(the `|$` arm covers keys truncated by the preview/size limit) and record one finding per block.

---

### 3. CRITICAL — the default pattern set misses most real secret formats; `.env` assignment is structurally excluded

**Description:** the 10 shipped patterns cover a narrow set of vendor formats and, for the generic rule, require quotes plus a restricted charset (`patterns.ts:42`), so `.env`-style `KEY=value` never matches; supply-chain and LLM-era tokens (`sk-`, `npm_`, `pypi-`, `github_pat_`, `GOCSPX-`, `SG.`, `SK…`, `dop_v1_`, `AccountKey=`) have no rule at all.

**[EXEC]** `node audit/poc/security-coverage-matrix.mjs` — one realistic sample per family, run against `resolveConfig({}).secretRules` (the exact default set):

```
  CAUGHT  AWS access key id                  aws-access-key-id
  MISSED  AWS secret key in JSON             -          <-- "aws_secret_access_key": "<40 chars>" (quote between name and colon)
  MISSED  GitHub fine-grained PAT            -          <-- github_pat_…
  MISSED  Slack incoming webhook URL         -
  MISSED  Google OAuth client secret         -          <-- GOCSPX-…
  MISSED  OpenAI key (sk-proj)               -
  MISSED  OpenAI key (legacy sk-)            -
  MISSED  Anthropic key                      -          <-- sk-ant-api03-…
  MISSED  npm token                          -          <-- npm_…
  MISSED  npm _authToken (.npmrc)            -
  MISSED  PyPI token                         -
  MISSED  SendGrid key                       -          <-- SG.…
  MISSED  Twilio key                         -          <-- SK<32 hex>
  MISSED  DigitalOcean token                 -          <-- dop_v1_…
  MISSED  Azure storage AccountKey           -
  MISSED  Private key header (encrypted)     -
  MISSED  Basic auth in URL                  -          <-- https://user:pass@host
  MISSED  unquoted .env API_KEY              -
  MISSED  unquoted .env SECRET_KEY           -
  MISSED  unquoted .env AUTH_TOKEN           -
  MISSED  unquoted .env PASSWORD             -
  MISSED  unquoted .env DB_PASSWORD          -
  MISSED  quoted secret with base64 padding  -          <-- "…==" : '=' is not in [A-Za-z0-9-_]
  MISSED  quoted secret with + / chars       -          <-- '+' '/' not in the charset
  MISSED  JSON password field                -
  MISSED  long random in a URL query         -

  caught 11/36, missed 25/36
```

`.env` is the file most likely to hold the secret, and its native syntax is the one the generic rule cannot express (`["']` is mandatory, `patterns.ts:42`). The `aws_secret_access_key` rule (`patterns.ts:18`) matches `AWS_SECRET_ACCESS_KEY=…` in `.env` but not `"aws_secret_access_key": "…"` in JSON, because it demands `\s*[:=]` immediately after the name.

**[EXEC]** Precision check in the same script (25 source files of this package): **0 false positives**, so the gap is not a tuning trade-off.

**Blast radius:** a snapshot published with the "Automated Secrets Redaction" claim contains `.env` API keys, npm/PyPI publish tokens and LLM provider keys in clear in `parts/*.md` — see finding 5 for how those files get collected.

**Fix (minimum viable):**

```ts
{ rule: "openai-anthropic-key", pattern: /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/ },
{ rule: "npm-token",           pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
{ rule: "pypi-token",          pattern: /\bpypi-[A-Za-z0-9_-]{50,}/ },
{ rule: "github-fine-grained",  pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{36,255}|\bgithub_pat_[A-Za-z0-9_]{22,}/ },
{ rule: "google-oauth-secret",  pattern: /\bGOCSPX-[A-Za-z0-9_-]{28}\b/ },
{ rule: "basic-auth-url",       pattern: /\/\/[^\s/@:]+:[^\s/@]+@[^\s/]+/ },
// generic: optional quotes, wider charset, add password-ish names
{ rule: "generic-secret-assignment",
  pattern: /(?:api_?key|secret_?key|auth_?token|client_?secret|access_?token|refresh_?token|password|passwd|pwd|token)\s*[:=]\s*["']?[A-Za-z0-9+/=_.\-]{16,}["']?/i },
```
Straightforward structural fix, but regex lists age badly: either adopt a maintained ruleset (gitleaks/gitleaks-style TOML, trufflehog detectors) or stop marketing the feature as automated redaction. At minimum, the generic rule must accept unquoted values.

---

### 4. HIGH — a `/g` custom rule silently skips every other match

**Description:** `rules.filter(({ pattern }) => pattern.test(line))` (`redact.ts:14`) reuses the caller's `RegExp` objects for every line of every file; with the `g`/`y` flag, `lastIndex` survives between lines and files, so matches are skipped and *no finding is recorded* for the skipped lines.

**[EXEC]** `node audit/poc/security-redact-units.mjs` (rule `{ rule: "custom-token", pattern: /^X=SECRET_[A-Z]+$/g }`, 8 identical lines):

```
    line 1: lastIndex before= 0 test()=true  lastIndex after=17
    line 2: lastIndex before=17 test()=false lastIndex after=0
    ...
  redacted line indexes: 1,3,5,7 -> 4/8 replaced, 4 secrets leak and 0 warnings

=== D. cross-file contamination: identical file content, different output ===
  file1 redacted lines: 1,3,5,7 findings: 4
  file2 redacted lines: 2,4,6 findings: 3
  same input, different result: true
```

**Blast radius:** any project that configures `secrets.customPatterns` with the `g` flag (the natural thing to write, since `String.replace` users habitually add `/g`). Redaction becomes non-deterministic across files and the audit report says the file is partially clean; nothing warns. No default rule uses `g`/`y` (verified: `0`), so stock configs are unaffected.

**Fix:** one line — `String.prototype.search` neither reads nor mutates `lastIndex`:

```ts
const hits = rules.filter(({ pattern }) => line.search(pattern) !== -1);
```
**[EXEC]** verified in `node audit/poc/security-gflag-fix-check.mjs`: the same `/g` rule then hits `1,1,1,1,1,1,1,1` (vs the buggy `1,0,1,0,1,0,1,0`) and leaves `lastIndex` at 0. Also validate/compile rules once in `resolveConfig` (strip `g`/`y`, reject non-`RegExp`).

---

### 5. HIGH — no deny list for sensitive files: `.npmrc`, `.git-credentials`, `*.pem`, `id_rsa` are always collected

**Description:** `defaultIgnoredPaths` (`scanner/files.ts:76-91`) lists build output only — no `.env*`, no `.npmrc`/`.netrc`/`.git-credentials`, no `*.pem`/`*.key`, no `id_rsa`. Binariness is the only other filter (`binary.ts:4-38`: none of `.pem`/`.key`/`.npmrc` are binary), so these files are read as text and emitted. `.env` is covered only indirectly, by `git ls-files --exclude-standard` honouring the repo's own `.gitignore`.

**[EXEC]** `node audit/poc/security-scanner-env.mjs` (real CLI: `node dist/cli.js --cwd <fixture> --include-monolith`):

```
=== G1. .env untracked and listed in .gitignore (the common, safe-ish layout) ===
  files emitted into parts/: .env.example, .git-credentials, .gitignore, .npmrc, keys/id_rsa, package.json, src/app.ts
    .env               collected & emitted: no  | tree lists basename: n | language: -
    .npmrc             collected & emitted: YES | tree lists basename: Y | language: text
    .git-credentials   collected & emitted: YES | tree lists basename: Y | language: text
    keys/id_rsa        collected & emitted: YES | tree lists basename: Y | language: text
    secrets verbatim in parts/: Sup3rS3cret, npm_9f8e7d, BODYLINE

=== G2. same repo, .env committed once (git add -f .env) ===
  files emitted into parts/: .env, .env.example, .git-credentials, .gitignore, .npmrc, keys/id_rsa, package.json, src/app.ts
    .env classified as bash | secrets verbatim in parts/: Sup3rS3cret, sk-proj-AbCdEf, npm_9f8e7d, BODYLINE

=== G3. non-git checkout (exported tarball / git missing): walkDirectory fallback ===
  note: .env is in .gitignore here and is still collected
  files emitted into parts/: .env, .env.example, .git-credentials, .gitignore, .npmrc, keys/id_rsa, ...
```

**Correction to the working assumption, stated explicitly:** in a normal repo where `.env` is git-ignored *and* untracked, `.env` is **not** collected (case G1). The claim reproduces for (a) a `.env` that was ever committed (`git add -f`, an early sloppy commit, or no `.gitignore`), and (b) the `walkDirectory` fallback used when git is unavailable/fails — where `.gitignore` is ignored entirely. Independently of `.env`, `.npmrc`, `.git-credentials`, `*.pem` and `id_rsa` are collected in **all three** cases and emitted verbatim.

`.env*` is classified `bash` (`language.ts:44`), so it is fenced as ```` ```bash ```` — cosmetic, but it means nothing about the content is treated as data needing masking.

**Blast radius:** private-registry tokens (`.npmrc`), VCS credentials (`.git-credentials`), TLS/SSH private keys — none of which any default pattern catches except the PEM header line (finding 2). Combined with finding 3, a single `snapshot/` published from a real repo contains live npm credentials.

**Fix:** an explicit sensitive-file list evaluated on the basename, recorded as a skip reason and overridable by config:

```ts
const SENSITIVE_BASENAME = /^(?:\.env(?:\..+)?|\.npmrc|\.yarnrc(?:\.yml)?|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519))$/;
const SENSITIVE_PATH     = /(?:^|\/)\.aws\/credentials$/;
const SENSITIVE_EXT      = /\.(?:pem|key|p12|pfx|jks|keystore|ppk|asc)$/i;
if (!config.includeSensitiveFiles &&
    (SENSITIVE_BASENAME.test(path.posix.basename(file)) || SENSITIVE_PATH.test(file) || SENSITIVE_EXT.test(file)))
  return false; // -> skipped: { path: file, reason: "sensitive-file" }
```
Also apply the same list in `walkDirectory`, which currently ignores `.gitignore` altogether.

---

### 6. MEDIUM — summaries are built from raw content and re-emit secrets that the body redacted

**Description:** `index.ts:116` redacts into `finalContent`, but `index.ts:151-155` computes `summary` from **`rawContent`**, and the summary is written into `parts/*.md` (`chunker.ts:170-174`) and `manifest.json`. `summarizeMarkdown` keeps heading text (`structured.ts:71-74`), so a secret in a heading is emitted unredacted while the same line in the body is replaced.

**[EXEC]** `node audit/poc/security-summary-and-config.mjs`:

```
  REDACTED markers in file body: 2
  "- Summary:" block in parts/ contains MONGO: true
  "- Summary:" block in parts/ contains AWS id: true
  manifest.json contains MONGO: true  |  contains AWS id: true
  manifest summary.headings: ["# Infra","## Prod database: mongodb://appuser:pa55w0rd@db.internal:27017/prod","### Deploy key id: AKIAIOSFODNN7EXAMPLE"]
```

**Blast radius:** documentation-style repos where credentials appear in headings/table captions (`## Postgres postgres://…`). Narrow, but it is a silent bypass of the redaction pass in two artifacts; the TypeScript summary is identifier-only (`ts-parser.ts`) and `summarizeJson` keeps keys, not values, so JSON/TS are unaffected.

**Fix:** summarize the redacted text — pass `redacted` instead of `rawContent` at `index.ts:151`/`:152`/`:155` (identical output for non-secret code), and strip heading text through the same in-line redactor.

---

### 7. MEDIUM — whole-line replacement destroys unrelated code in the snapshot

**Description:** a hit on any rule replaces the entire line (`redact.ts:25`), so the part that an LLM reads loses all neighbouring code, not just the value.

**[EXEC]** `node audit/poc/security-redact-units.mjs`:

```
  in : "export const awsKey = \"AKIAIOSFODNN7EXAMPLE\"; export const region = \"us-east-1\"; const retries = 3;"
  out: "[REDACTED: potential secret-like value omitted from snapshot]"
  unrelated code lost: [ 'us-east-1', 'retries', 'export const region' ]
  bytes: in 99 -> out 61
```

**Blast radius:** context integrity, not confidentiality — the snapshot silently drops code the user believes was included, and the audit report's "1 finding" gives no hint about how much was removed. Minified/bundled files (one huge line) lose an entire line per hit.

**Fix:** replace only the match:

```ts
let out = line;
for (const { pattern } of rules) {
  out = out.replace(new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")), "[REDACTED]");
}
```
keeping `snippet`/`findings` derived from the pre-replacement line (then fix finding 1 so the snippet is masked).

---

### 8. MEDIUM — quadratic backtracking in `jwt-token` on long `eyJ`-dense lines

**Description:** `[A-Za-z0-9-_]{10,}` greedily consumes to end of line and then backtracks looking for a `\.` that does not exist; every `eyJ` occurrence is a new start position, so the cost is O(line length × number of `eyJ` seeds). Because `index.ts:116` scans the **full** raw content before preview truncation (`index.ts:130`), `largeFileBytes` does not bound it.

**[EXEC]** `node audit/poc/security-redos-shapes.mjs` (one line = base64 of a JSON dataset, i.e. a vendored `.b64`/`data:` URI — the shape produced by `Buffer.from(json).toString("base64")`):

```
  base64(json array of records)   100k      3125     288.4 ms
  base64(json array of records)   200k      6250    1188.3 ms
  base64(json obj of objs)        400k      6701    2840.0 ms
  raw repeated eyJ (worst case)   400k    133333   51570.9 ms
```

**[EXEC]** `node audit/poc/security-redos-real.mjs` — end-to-end through `generateSnapshot` on a 300 KB single-line vendored file:

```
    50k chars:    67.6 ms   seeds=1563   (1 MB at this shape would be ~27 s)
   300k chars:  2783.7 ms   seeds=9375   (1 MB at this shape would be ~31 s)
  control (identical length, "eyJ" -> "eQJ"): 126 ms  (3 files)
  real blob ("eyJ" seeds present):            2740 ms  (3 files)
  slowdown: 21.7x  -> one 300 KB generated file costs 2.7 s of CPU
```

**Negative results, measured, not assumed** (`node audit/poc/security-redos.mjs`, size ladder 10k/50k/200k/1M with 28 adversarial shapes): the other **9 patterns show no blowup** — worst case 3.22 ms on a 1 MB line (`generic-secret-assignment`, unclosed quote). `database-uri-credentials` overlapping classes stay linear (1.78 ms @1 MB). Default patterns carry no `g`/`y` flag, so `test()` is stateless for them.

**Blast radius:** CPU/memory DoS when snapshotting untrusted or generated repos (inlined source maps, `data:` URIs, vendored base64 fixtures); minutes of CPU per file at multi-MB sizes, no crash, no data exposure. Severity is MEDIUM, not HIGH: it needs a long single line dense in `eyJ`, and ordinary code and line-wrapped base64 (padding/`=`) are cheap.

**Fix:** bound the quantifiers — a JWT segment is never 10⁶ chars:

```ts
pattern: /eyJ[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,2048}\.[A-Za-z0-9_-]{10,2048}/
```
plus skip scanning lines above a threshold (record a `line-too-long` warning instead).

---

### 9. LOW — a JSON config with `customPatterns` aborts the whole run

**Description:** `.snapshotrc.json` / the `snapshot` key in `package.json` are parsed by `JSON.parse` (`config.ts:28-34`, `:45-53`), so `secrets.customPatterns[].pattern` can only be a string; `resolveConfig` passes it through (`config.ts:74-76`) and `redact.ts:14` calls `.test` on it.

**[EXEC]** `node audit/poc/security-summary-and-config.mjs`:

```
  CLI exit code: 1
  CLI stderr: ❌ Failed to generate snapshot: pattern.test is not a function
  snapshot dir created: false
```

**Blast radius:** availability only — no snapshot is produced and no stale snapshot is left behind (the scan loop fails before any write). Note the boundary: the merge point is `config.ts:74-76`, which the config-loading reviewer owns; the unsafe assumption is `redact.ts`'s.

**Fix:** compile rules once, with a clear error:

```ts
export function compileRules(rules: Array<{ rule: string; pattern: RegExp | string }>): SecretRule[] {
  return rules.map((r) => ({
    rule: r.rule,
    pattern: typeof r.pattern === "string" ? new RegExp(r.pattern, "i") : new RegExp(r.pattern.source, r.pattern.flags.replace(/[gy]/g, "")),
  }));
}
```

---

## Claims checked and rejected (stated for the record)

| Claim | Verdict |
| :-- | :-- |
| ".env files are included by default" (as an unconditional statement) | **Partly rejected.** A `.env` that is git-ignored and untracked is *not* collected (`security-scanner-env.mjs`, G1). It is collected when tracked or when the non-git walk fallback runs (G2/G3). The real unconditional leak is `.npmrc` / `.git-credentials` / `*.pem` / `id_rsa`. |
| ReDoS in the default rule set | **Mostly rejected.** 9/10 patterns are linear in all 28 measured shapes (max 3.22 ms @1 MB). Only `jwt-token` is quadratic (finding 8). |
| Over-redaction (B-i) and header-only PEM redaction (B-ii) | **Confirmed**, both reproduced (findings 7 and 2). |
| `audit.md` snippet leak, `.env`-unquoted coverage gap, `/g` lastIndex hazard | **Confirmed** (findings 1, 3, 4). |
| `manifest.json` leaks snippets | **Rejected.** `warnings` is `"<rule> at <path>:<line>"` only; the content leak is `reports/audit.md` alone. |
| Summary-artifact leak | **New** — not in the original claim list, proven in finding 6. |

## Read-only observations (not executed)

- `generateAuditReport` is only called from `index.ts:329-333`; the `report` CLI mode (`cli.ts:158-185`) reads `manifest.json`, which carries no snippets. So the write-down surface is exactly one file, `reports/audit.md` (plus the summary path in finding 6).
- `audit.ts:31` escapes `|` in the snippet but not backticks or newlines, so a matched line containing a backtick breaks the Markdown table — cosmetic, not a leak.
- `snippet` is `line.trim().slice(0, 120)`, so secrets past column 120 of a matched line are not written to the audit report (a lucky truncation, not a control).
- `binary.ts:45-51` only treats NUL bytes in the first 8 KB as binary; `*.pem`, `*.key`, `id_rsa` and `.npmrc` are plain text to it, so finding 5 has no second line of defence there.

## Reproduction

```
node audit/poc/security-e2e-snapshot.mjs        # findings 1, 2 (end-to-end, real RSA key reconstructed), 5
node audit/poc/security-redact-units.mjs        # findings 2, 4, 7, 9 (unit level)
node audit/poc/security-coverage-matrix.mjs     # finding 3 (+ false-positive rate: 0/25 files)
node audit/poc/security-scanner-env.mjs         # finding 5 (real CLI, 3 git layouts)
node audit/poc/security-summary-and-config.mjs  # findings 6, 9 (real CLI)
node audit/poc/security-redos.mjs               # finding 8 + the 9 negative results
node audit/poc/security-redos-shapes.mjs        # finding 8, realistic base64 shapes
node audit/poc/security-redos-real.mjs          # finding 8, end-to-end timing A/B
node audit/poc/security-gflag-fix-check.mjs     # finding 4, proposed fix verified (8/8 vs 4/8)
```

Fixtures are created and destroyed inside `audit/poc/security-fixture-*/`; no file outside `audit/poc/` was modified.
