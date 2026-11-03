import type { SecretRule } from "../types.js";

/**
 * Default secret rules.
 *
 * Design notes:
 * - Every quantifier is bounded. An unbounded `[A-Za-z0-9_-]{10,}` followed by
 *   `\.` backtracks to the end of the line at every start position, which made
 *   `jwt-token` quadratic (measured: 1.22 s for a 200 KB line). JWT segments are
 *   never longer than a few KB, so bounding at 1024 keeps the match linear in
 *   practice while still matching every realistic token.
 * - Rules are line-oriented; the whole-block private-key scan lives in
 *   `redact.ts` because it spans lines.
 * - Names are matched case-insensitively only where a value is anchored by
 *   quotes or a length, to keep false positives at zero on ordinary source.
 * - Rules that must match context (`password: "…"`) declare `valueGroup`, so
 *   redaction masks only the credential and keeps the key: the snapshot is read
 *   by humans and models, and `dbPassword: [REDACTED…]` stays parseable.
 */

/**
 * Names that are a credential on their own: `dbPassword`, `apiSecret`,
 * `secretKey`, `authToken`.
 *
 * Matched as a literal tail (the engine finds `Password` inside `dbPassword`),
 * with `[_-]?` so snake_case and kebab-case spellings work, and with no
 * surrounding quantifiers so the scan stays linear on a long identifier.
 * Deliberately absent: bare `key` (`key: "…"` is React's prop), `publicKey`,
 * `maxTokens` (the tail must end at the separator), `id`.
 */
const STRONG_CREDENTIAL_NAME =
  "(?:password|passwd|passphrase|pwd|api[_-]?key|api[_-]?secret|" +
  "secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret[_-]?key|client[_-]?secret|" +
  "private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|" +
  "auth[_-]?token|session[_-]?token|secret|token)";

/**
 * Names that are only a credential when the value is unmistakably a credential.
 *
 * `id-token: write` is a GitHub Actions permission, `{ pass: 3 }` is an object
 * literal and `…not credentials: none of them…` is prose — treating any of those
 * as an unquoted assignment corrupted ordinary code. They stay matched, but only
 * against a quoted value of at least eight characters.
 */
const WEAK_CREDENTIAL_NAME = "(?:pass|id[_-]?token|credentials?)";

/**
 * Values that are not credentials: type annotations, JS literals and
 * `process.env` references. Without this, `token: string` in an interface and
 * `password: null` in a config object were masked — over-redaction that makes
 * the snapshot harder to read for no security gain.
 */
const NOT_A_LITERAL_VALUE =
  "(?!(?:string|number|boolean|bigint|symbol|unknown|any|never|void|null|undefined|true|false|process\\.env|Buffer|Record|object)\\b)";

/**
 * An unquoted value must be a literal, not an expression: `hunter2` is a
 * credential, while `req.body.password`, `getToken()` and `process.env.SECRET`
 * are references to one and must survive untouched — rewriting those made the
 * emitted statement (and its AST summary) wrong.
 *
 * A STRONG name (above) carries no length floor: `POSTGRES_PASSWORD: hunter2`
 * is a password whether or not it is long. Only the ambiguous WEAK names get the
 * eight-character, non-digit floor, because that is what keeps `pass: 3` and
 * `id-token: write` readable.
 */
const UNQUOTED_LITERAL =
  "(?![0-9]+(?![A-Za-z0-9_+=/.-]))([A-Za-z0-9_+=/-]{1,512})(?![A-Za-z0-9_+=/.-]|\\()";
const UNQUOTED_AMBIGUOUS_LITERAL =
  "(?![0-9]+(?![A-Za-z0-9_+=/.-]))([A-Za-z0-9_+=/-]{8,512})(?![A-Za-z0-9_+=/.-]|\\()";

/**
 * `id-token` / `id_token` is a GitHub Actions permission, not a credential: the
 * bare `token` tail must not match it. (`authToken`, `accessToken` and friends
 * keep working; the lookbehind is exactly three characters wide.)
 */
const UNQUOTED_STRONG_NAME = `(?<!id[-_])${STRONG_CREDENTIAL_NAME}`;

export const DEFAULT_SECRET_PATTERNS: SecretRule[] = [
  {
    rule: "private-key-header",
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|-----BEGIN (?:RSA |OPENSSH |EC |PGP |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    // JWT: `header.payload[.signature]`, base64url, optionally `=`-padded.
    //
    // Both the header and the payload of a real JWT start with `eyJ` — the
    // base64url of `{"` — and requiring that twice is the discriminator that
    // keeps this rule away from ordinary source: a lone `eyJ…` header in prose, an
    // `eyJ`-prefixed identifier and plain base64 all stay untouched.
    //
    // The signature is optional (an `alg: none` token has none) and may be much
    // shorter than ten characters — `eyJ….eyJ….abc123` is the shape that used to
    // reach `parts/*.md` unwrapped. Padding is accepted so a padded token is
    // masked whole instead of half-matched. Quantifiers stay bounded (1024, as
    // before) so an `eyJ`-dense line cannot go quadratic.
    rule: "jwt-token",
    pattern:
      /eyJ[A-Za-z0-9_-]{8,1024}={0,2}\.eyJ[A-Za-z0-9_-]{8,1024}={0,2}(?:\.[A-Za-z0-9_-]{1,1024}={0,2})?/,
  },
  {
    rule: "aws-access-key-id",
    pattern: /(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA|ABIA)[0-9A-Z]{16}/,
  },
  {
    // The name is no longer limited to the three snake_case spellings: an
    // `awsSecret` / `secretAccessKey` property leaked verbatim because only the
    // literal words matched. The value is masked alone, so the key survives.
    rule: "aws-secret-access-key",
    pattern: new RegExp(
      `${STRONG_CREDENTIAL_NAME}["']?\\s{0,8}[:=]\\s{0,8}["']?([A-Za-z0-9/+=]{40})["']?`,
      "i"
    ),
    valueGroup: 1,
  },
  {
    // A 40-character base64 value with no key name in sight. A key-independent
    // rule is the only thing that catches `new AWS.SecretKey(…)` arguments and
    // pasted `~/.aws/credentials` fragments, but a bare length test also matches
    // every 40-char git SHA-1, so the value must mix case and digits and must
    // not be pure hex.
    rule: "aws-secret-access-key-value",
    pattern:
      /(?<![A-Za-z0-9/+=])(?![0-9a-fA-F]{40}(?![A-Za-z0-9/+=]))(?=[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=]))(?=[A-Za-z0-9/+=]{0,39}[A-Z])(?=[A-Za-z0-9/+=]{0,39}[a-z])(?=[A-Za-z0-9/+=]{0,39}[0-9])[A-Za-z0-9/+=]{40}/,
  },
  {
    rule: "github-token",
    pattern:
      /gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{22,251}|ghs_[A-Za-z0-9]{36,251}/,
  },
  {
    // `xoxc-`/`xoxd-` are the user and refresh tokens, `xoxb`/`xoxp` the bot and
    // user tokens; the whole Slack family shares one prefix shape.
    rule: "slack-token",
    pattern: /xox[baprsdc]-[0-9A-Za-z-]{10,250}/,
  },
  {
    // Prefix-only vendors. Each prefix below is documented, globally unique and
    // cannot collide with an ordinary identifier, which is what makes a bare
    // prefix rule cheap and safe: `glpat-` (GitLab), `hvs.`/`s.` (Vault service
    // and batch tokens), `whsec_` (Stripe webhook secret), `dckr_pat_` (Docker
    // Hub), `hf_` (HuggingFace), `ya29.` (Google OAuth access token).
    rule: "known-vendor-token-prefix",
    pattern:
      /\b(?:glpat-[A-Za-z0-9_-]{20,64}|glrt-[A-Za-z0-9_-]{20,64}|hvs\.[A-Za-z0-9_-]{20,128}|hvb\.[A-Za-z0-9_-]{20,128}|s\.[A-Za-z0-9]{20,64}|whsec_[A-Za-z0-9]{20,64}|dckr_pat_[A-Za-z0-9_-]{20,64}|hf_[A-Za-z0-9]{30,64}|ya29\.[A-Za-z0-9_-]{20,128}|sk_test_[A-Za-z0-9]{16,64}|1\/\/0[A-Za-z0-9_-]{20,64})/,
  },
  {
    rule: "slack-webhook-url",
    pattern: /hooks\.slack\.com\/services\/T[A-Z0-9]{6,12}\/B[A-Z0-9]{6,12}\/[A-Za-z0-9]{20,32}/,
  },
  {
    rule: "stripe-secret-key",
    pattern: /[sr]k_live_[0-9a-zA-Z]{20,247}/,
  },
  {
    rule: "google-api-key",
    pattern: /AIza[0-9A-Za-z_-]{35}/,
  },
  {
    rule: "google-oauth-client-secret",
    pattern: /GOCSPX-[A-Za-z0-9_-]{20,64}/,
  },
  {
    rule: "openai-anthropic-key",
    pattern: /\bsk-(?:ant-[a-z0-9]+-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}_?[A-Za-z0-9_-]{0,20}\b/,
  },
  {
    rule: "npm-token",
    pattern: /npm_[A-Za-z0-9]{36}/,
  },
  {
    rule: "pypi-token",
    pattern: /pypi-[A-Za-z0-9_-]{50,180}/,
  },
  {
    rule: "sendgrid-key",
    pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/,
  },
  {
    rule: "twilio-api-key",
    pattern: /SK[0-9a-fA-F]{32}/,
  },
  {
    rule: "digitalocean-token",
    pattern: /dop_v1_[0-9a-f]{64}/,
  },
  {
    rule: "azure-storage-account-key",
    pattern: /AccountKey=[A-Za-z0-9+/=]{80,100}/,
  },
  {
    // Scheme-less userinfo: `//user:password@host`.
    //
    // Enumerating schemes is a losing game — `mysqlx`, `svn`, `telnet`, `imap`,
    // `pop3`, `nntp`, `kafka`, `elasticsearch` each leaked a password while the
    // list grew by hand. This rule matches the shape instead, so any scheme
    // (including one invented tomorrow) is covered, provided the `//` is followed
    // immediately by the userinfo: `// see the docs` and a bare reminder comment
    // never match, because a space or the comment wording breaks the shape.
    rule: "uri-credentials",
    pattern:
      /\/\/[^\s:/@"'`;()<>,]{1,128}:[^\s:/@"'`;()<>,]{1,256}@[^\s/"'`;()<>,]{1,256}/,
  },
  {
    // The host tail stops at quotes, `;`, `)`, `<`, `>` and `,`: an unbounded
    // `[^\s/]` used to swallow the closing quote and the statement separator of
    // the string the URL was written in.
    rule: "database-uri-credentials",
    pattern:
      /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|maria(?:db)?|redis(?:s)?|amqp(?:s)?|clickhouse|mssql|sqlserver|oracle):\/\/[^\s:@/"'`;()<>,]{1,128}:[^\s@/"'`;()<>,]{1,256}@[^\s/"'`;()<>,]{1,256}/,
  },
  {
    rule: "basic-auth-url",
    pattern:
      /(?:https?|ftp|sftp|ssh|git|smtp|smtps|ldap|ldaps):\/\/[^\s:@/"'`;()<>,]{1,128}:[^\s@/"'`;()<>,]{1,256}@[^\s/"'`;()<>,]{1,256}/i,
  },
  {
    // Quoted credentials in any common key spelling. The value may be as short
    // as one character: `password: "hunter2"` is a credential whatever its
    // entropy, and a length floor was exactly how it survived into `parts`.
    //
    // The key is either bare (`dbPassword:`) or wholly quoted (`"dbPassword":`).
    // There is deliberately no optional quote *before* the separator: that let a
    // previous string's closing quote stand in for the key's, so
    // ``${pass ? "  PASS" : "  FAIL"}`` had `"  FAIL"` masked as if `PASS` were
    // the key name.
    rule: "credential-assignment",
    pattern: new RegExp(
      `(?:["']${STRONG_CREDENTIAL_NAME}["']|${STRONG_CREDENTIAL_NAME})\\s{0,8}[:=]\\s{0,8}(["'\`])([^"'\`\\n]{1,512})\\1`,
      "i"
    ),
    valueGroup: 2,
  },
  {
    // `pass`, `id-token` and `credentials` are ambiguous on their own, so they
    // are accepted only against a quoted value long enough to be a credential.
    rule: "credential-assignment-weak",
    pattern: new RegExp(
      `(?:["']${WEAK_CREDENTIAL_NAME}["']|${WEAK_CREDENTIAL_NAME})\\s{0,8}[:=]\\s{0,8}(["'\`])([^"'\`\\n]{8,512})\\1`,
      "i"
    ),
    valueGroup: 2,
  },
  {
    // The unquoted twin for YAML, docker-compose and `.env`: those formats never
    // quote their values, so the rules above cannot see them. `valueGroup` keeps
    // `POSTGRES_PASSWORD:` in the output.
    rule: "credential-assignment-unquoted",
    pattern: new RegExp(
      `${UNQUOTED_STRONG_NAME}\\s{0,8}[:=]\\s{0,8}${NOT_A_LITERAL_VALUE}${UNQUOTED_LITERAL}`,
      "i"
    ),
    valueGroup: 1,
  },
  {
    // `pass: hunter2hunter2` and `credentials: hunter2hunter2`: the ambiguous
    // names, unquoted, with the length and non-digit floor that keeps
    // `pass: 3` / `credentials: none` readable.
    rule: "credential-assignment-unquoted-weak",
    pattern: new RegExp(
      `${WEAK_CREDENTIAL_NAME}\\s{0,8}[:=]\\s{0,8}${NOT_A_LITERAL_VALUE}${UNQUOTED_AMBIGUOUS_LITERAL}`,
      "i"
    ),
    valueGroup: 1,
  },
  {
    // `Authorization: Bearer <token>` and `Authorization: Basic <base64>`.
    //
    // The scheme is consumed by a lookbehind so the match is the token alone and
    // needs no `valueGroup`. A lone `Bearer`/`Basic`, and a word after it that
    // cannot be a credential (`Bearer authentication`), stay readable: the value
    // must contain a digit, be at least 32 chars, or carry base64 `=` padding.
    rule: "authorization-header",
    pattern:
      /(?<=(?:Bearer|Basic)\s{1,8})(?:[A-Za-z0-9_.+/-]{0,31}[0-9][A-Za-z0-9_.+/-]{0,1024}|[A-Za-z0-9_.+/-]{32,1024}|[A-Za-z0-9_.+/-]{8,1024}={1,2})(?![A-Za-z0-9_.+/=-])/,
  },
  {
    // Broader names than before (`apiKey`, `clientSecret`, `privateKey` were
    // invisible to it) and value-only masking. Kept alongside the two rules
    // above because it also matches a *quoted key* followed by an unquoted
    // value, e.g. `"client_secret": abc123`.
    rule: "generic-secret-assignment",
    pattern:
      /(?:api[_-]?key|secret[_-]?key|auth[_-]?token|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|password|passwd|pwd)["']?\s*[:=]\s*["']([^"'\s]{8,256})["']/i,
    valueGroup: 1,
  },
  {
    // Covers `.env` / shell assignment syntax, which never quotes its values and
    // was therefore invisible to the rule above. Anchored to the line start and
    // limited to secret-looking names to stay at zero false positives.
    //
    // The name is matched with BOUNDED quantifiers on purpose: an unbounded
    // `[A-Za-z0-9_]*` on both sides of the keyword alternation backtracks at
    // every offset of a long identifier, which made this rule quadratic
    // (measured 5.6 s for a single 240 KB line before bounding).
    // The value is matched on its own — `=\s*(value)` — and masked alone.
    // Anchoring the value to end-of-line (`[^\s#]{6,512}$`) meant ANY trailing
    // comment or space disabled the rule, so `TOKEN=secret # rotate` and
    // `TOKEN=secret   ` were emitted in clear; a CRLF file disabled it wholesale.
    rule: "env-secret-assignment",
    pattern:
      /^\s{0,64}(?:export\s{1,8})?[A-Za-z0-9_]{0,96}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIAL)[A-Za-z0-9_]{0,96}\s{0,8}=\s{0,8}(?!["'`$<{[\]\s])([^\s#;"'`)]{1,512})/i,
    valueGroup: 1,
  },
];

/**
 * A PEM private-key block spanning one or more lines. Applied as a whole-text
 * pass because the per-line rules can only see the `BEGIN` header, which left
 * every body line of a real key in the snapshot.
 */
export const PEM_BLOCK_PATTERN =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;

/**
 * A private key whose `END` marker was cut off — either truncated by the
 * preview budget or still being written. Constrained to the header plus the
 * base64-ish lines that immediately follow, so a stray header cannot swallow
 * the rest of the file.
 */
export const PEM_UNTERMINATED_PATTERN =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:\r?\n[A-Za-z0-9+/=]{4,}[ A-Za-z0-9+/=]*)+/g;
