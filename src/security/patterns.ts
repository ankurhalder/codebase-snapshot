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
 */
export const DEFAULT_SECRET_PATTERNS: SecretRule[] = [
  {
    rule: "private-key-header",
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|-----BEGIN (?:RSA |OPENSSH |EC |PGP |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    rule: "jwt-token",
    pattern: /eyJ[A-Za-z0-9_-]{10,1024}\.eyJ[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{10,1024}/,
  },
  {
    rule: "aws-access-key-id",
    pattern: /(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[0-9A-Z]{16}/,
  },
  {
    rule: "aws-secret-access-key",
    pattern:
      /(?:aws_secret_access_key|aws_secret_key|secret_access_key)["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/i,
  },
  {
    rule: "github-token",
    pattern:
      /gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{22,251}|ghs_[A-Za-z0-9]{36,251}/,
  },
  {
    rule: "slack-token",
    pattern: /xox[baprs]-[0-9A-Za-z-]{10,250}/,
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
    rule: "database-uri-credentials",
    pattern:
      /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|maria(?:db)?|redis(?:s)?|amqp(?:s)?|clickhouse):\/\/[^\s:@/]{1,128}:[^\s@/]{1,256}@[^\s/]{1,256}/,
  },
  {
    rule: "basic-auth-url",
    pattern: /(?:https?|ftp|sftp|ssh|git):\/\/[^\s:@/]{1,128}:[^\s@/]{1,256}@[^\s/]{1,256}/i,
  },
  {
    rule: "generic-secret-assignment",
    pattern:
      /(?:api[_-]?key|secret[_-]?key|auth[_-]?token|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|password|passwd|pwd)["']?\s*[:=]\s*["'][^"'\s]{8,256}["']/i,
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
    rule: "env-secret-assignment",
    pattern:
      /^\s{0,64}(?:export\s{1,8})?[A-Za-z0-9_]{0,96}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)[A-Za-z0-9_]{0,96}\s{0,8}=\s{0,8}(?![\s$<{[])[^\s#]{6,512}$/i,
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
