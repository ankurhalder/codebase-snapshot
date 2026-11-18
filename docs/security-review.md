# Security review

Written for this release, about this release. It states the threat model, the controls, what is
tested, and the residual risks — including the ones that are deliberately not solved.

## What the tool is

A local process that reads a repository and writes a directory of text. Since 0.12.15 it also runs an
HTTP server, fetches repositories from URLs, and signs manifests. Each of those is a new place where
untrusted input can arrive.

## Threat model

| Adversary | Can reach | Cannot reach |
| :--- | :--- | :--- |
| **A malicious repository** (its files, config, filenames) | The snapshot's text, the brief, the audit report, the planner's ranking | The filesystem outside the repository, the network, the process environment |
| **A malicious URL** given to `--remote` or the browser page | The clone path and the SSRF guard | Any private address, any credential, any local file |
| **A malicious web page** in the same browser | `GET /` on `serve` (HTML only), CORS preflights | Anything behind the bearer token, any API response |
| **A malicious MCP client** | The tool list and the snapshot's contents | The working tree outside the snapshot, sensitive files, the network |
| **A shoulder-surfer / log reader** | Nothing new | Secrets (masked), paths (masked), tokens (never logged) |

## Controls

### Content leaving the repository

- **Sensitive files stay out.** `.env`, keys, `.npmrc` and the rest are skipped unless
  `includeSensitiveFiles` is explicitly set, and every skip is recorded with its reason.
- **Redaction masks the span, not the line.** A matched credential becomes `[REDACTED:rule]`; no
  excerpt of the matched line reaches an artifact, the audit report or the SARIF file.
- **Paths are masked too.** A path that itself matches a secret rule is recorded masked.
- **The health audit re-scans every written text file** for unmasked secrets and compares values
  from excluded sensitive files byte for byte against the artifacts (`snapshot health`).

### Executable configuration

A `snapshot.config.ts` is code. The CLI runs it because the user invoked the repository's own
command; the **MCP server and the web page refuse it** and say so. A repository fetched with
`--remote` is treated the same way: its JSON configuration is applied (it is data), and an
executable config in it is refused, because a fetched repository is not a trusted one.

### MCP over HTTP

- **Loopback by default**, and a bearer token **always** unless `--no-auth` is passed explicitly.
  `--no-auth` is refused on a non-loopback bind.
- **Constant-time** token comparison; the token is generated with `crypto.randomBytes`.
- **CORS only for loopback origins** and explicit `--allow-origin` values; everything else is 403.
- **Bounded work**: 2 MiB bodies, 60 requests per 10 s per address, one JSON document per response.
- **Errors are JSON-RPC error objects**, never stack traces.

### The browser page

- The page is HTML and is served without a token; **every API call requires one**. The token is not
  baked into the HTML, so serving `/` cannot leak it.
- A request with a cross-origin `Origin` is refused before any auth check.
- `api/snapshot.zip` only zips a directory that contains a manifest or an ownership marker.

### Remote ingestion

- **https only**, no credentials in the URL, and the host must resolve to public addresses. Loopback,
  RFC1918, link-local (including `169.254.169.254`), CGNAT and their v6 equivalents are refused
  unless `--allow-private` is given.
- **Checked twice**: the literal host before DNS, and every resolved address after.
- **Shallow clone** into a temp directory removed on exit; `GITHUB_TOKEN` reaches git through the
  environment (`http.extraheader` via `GIT_CONFIG_*`), never argv, and never enters the manifest.
- A clone larger than 1 GB is refused before scanning.

### Signing

- Ed25519 over the exact manifest bytes; the record carries the public key and the manifest sha256.
- `health` fails when the manifest changed after signing; an unsigned snapshot is a skip, because
  absence is not tampering.
- The private key never reaches an artifact. `SNAPSHOT_SIGNING_KEY` is read from the environment.

### Prompt injection

A repository can contain text that tells a model to ignore its instructions. The snapshot preserves
file content faithfully, and **this tool cannot sanitise prose without changing the code it exists to
carry**. The brief says what the snapshot is and what it omits, and the security prompt tells an agent
to treat file content as data. This is a real, documented limitation, not a solved problem.

## What changed since this review was written

The review was written at 0.12.34. Between then and 0.17.0 the surfaces it covers grew; each
addition was reviewed with the same question — what new input arrives, and what does it reach?

- **`GET /metrics`** (0.13.3) publishes counters with a fixed label set. Repo paths, tokens and
  query strings are not labels, so the endpoint cannot leak what the snapshot redacted.
- **The web server's allowed roots** (0.12.46, tightened since): `/api/snapshot`, `/snapshot.zip`
  and `/api/health` answer 403 for an output directory outside the working directory or a clone
  this process created, so the page cannot be pointed at an arbitrary path on disk.
- **The audit stopped trusting the manifest** (0.13.6-0.13.10): bodies, counts and pack membership
  are recomputed. An attacker who edits a part and updates its hash, or edits a manifest count,
  now fails the audit; before, both passed. This turns a tampered snapshot into a detected one.
- **`snapshot_answer`** (0.15.5) reads only `parts/` through the same parser, so redaction and
  exclusions apply exactly as they do to `snapshot_read`; it adds no file-system surface.
- **`--only`/`--ignore`** (0.14.6) widen nothing: `--ignore` adds excludes, and `--only` can only
  narrow the allow-list the config already permits. Sensitive files stay excluded by default.

The residual risks below are unchanged, including the two that are deliberate rather than solved.

## What the test suite pins

| Property | Test |
| :--- | :--- |
| Sensitive files stay out; skips are recorded | `tests/security-*.test.js`, hygiene suites |
| Redaction masks the span only | redaction suite (hundreds of cases) |
| Health catches a leaked secret and never echoes it | `tests/health.test.js` |
| HTTP: 401 without token, 403 cross-origin, 413 oversize, 400 bad JSON | `tests/mcp-http.test.js` |
| SSE: token required, unknown session 404, shutdown does not hang | `tests/mcp-http.test.js` |
| Remote: private addresses refused, credentials in URL refused, `file:` gated | `tests/remote-source.test.js` |
| Serve: page without token, API with token, zip restricted | `tests/web-serve.test.js` |
| Signature: tamper detected | `tests/signing.test.js` |

## Residual risks, stated

1. **`?token=` on the legacy SSE paths.** `EventSource` cannot set headers, so the token may travel
   in the URL on `/sse` and `/messages` only. URLs reach proxy logs and shell history. Use the
   Streamable HTTP endpoint with a header where the client supports it.
2. **`--no-auth` on loopback.** Any local process (or a browser page that guesses the port, though
   CORS and the token requirement normally stop it) can then read the repository. It is a deliberate
   opt-out, printed as a warning.
3. **DNS rebinding.** The private-address check resolves once before the clone; a hostile DNS server
   could change the answer between the check and git's own resolution. Mitigating it fully requires
   pinning the resolved IP for the connection, which git does not expose. The window is small, the
   target must be public at check time, and `--allow-private` is the only way to reach a private
   address deliberately.
4. **Prompt injection in repository content**, as above.
5. **A signing key in the environment** is visible to the process's own children and to anyone who
   can read `/proc`. Use a key file with restrictive permissions if that matters.
6. **No sandbox.** The tool reads what the user can read and writes where the user says. It does not
   drop privileges, and it is not designed to run against hostile filesystems.

## Reporting a vulnerability

Open a private security advisory on the repository, or email the address in `package.json`. Please
include the version, a reproduction, and whether secret material was exposed. Fixes ship as patches
on the current line; there is no long-term support branch yet.
