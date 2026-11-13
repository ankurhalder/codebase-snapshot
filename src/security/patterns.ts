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
 * `maxTokens` (the tail must end at the separator), `id`. `accessKey`/`access_key` is present:
 * it is a credential on its own, unlike the AWS compound form which is already listed.
 */
const STRONG_CREDENTIAL_NAME =
  "(?:password|passwd|passphrase|pwd|api[_-]?key|api[_-]?secret|access[_-]?key|" +
  "secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret[_-]?key|client[_-]?secret|" +
  "private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|" +
  "auth[_-]?token|session[_-]?token|session[_-]?key|secret|token)";

/**
 * Names that are only a credential when the value is unmistakably a credential.
 *
 * `{ pass: 3 }` is an object literal and `…not credentials: none of them…` is prose —
 * treating any of those as an unquoted assignment corrupted ordinary code. They stay
 * matched, but only against a quoted value of at least eight characters.
 *
 * `id-token` is deliberately absent: it is a GitHub Actions **permission** name whose value is
 * `read`/`write`/`none`, and masking `{"id-token": "write"}` destroyed a declaration the
 * repository needs to keep. A real credential under the key is still caught by the rule for its
 * shape (JWT, `ghp_…`), and `idToken` — the OIDC camelCase spelling — is still a credential
 * name because it has no separator before `token`.

 */
const WEAK_CREDENTIAL_NAME = "(?:pass|credentials?)";

/**
 * Values that are not credentials: type annotations, JS literals and
 * `process.env` references. Without this, `token: string` in an interface and
 * `password: null` in a config object were masked — over-redaction that makes
 * the snapshot harder to read for no security gain.
 *
 * Reserved words are here for the same reason: in `token = await refreshToken(…)`
 * the first token after the separator is `await`, and masking it emitted
 * `token = [REDACTED] refreshToken(client)` — a statement that no longer parses.
 * A keyword is never a credential literal.
 */
const NOT_A_LITERAL_VALUE =
  "(?!(?:string|number|boolean|bigint|symbol|unknown|any|never|void|null|undefined|true|false|" +
  "await|async|new|this|typeof|delete|yield|function|return|process\\.env|Buffer|Record|object)\\b)";

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
/**
 * The value must **begin** with a word character.
 *
 * `[A-Za-z0-9_+=/%:~-]` includes `/`, so a regex literal assigned to a name ending in
 * `token` had its opening slash masked: this repository's own snapshot emitted
 * `const SINGLE_TOKEN = [REDACTED: …][^\sA-Za-z0-9_]/g;` — the pattern destroyed and the
 * line no longer parseable. `/`, `+`, `-` and `%` can only *continue* a value here.
 *
 * The trailing lookahead also refuses `[` and `{`: in `const accessToken = tokens[0]`
 * the value is a reference, and masking `tokens` left `[REDACTED][0]`.
 *
 * These two rules are necessary but not sufficient — a bareword initializer
 * (`const token = someVar`) still begins with a word character. `redact.ts` refuses
 * values that sit in a declaration for exactly that reason.
 *
 * The value is at least two characters long ({@link UNQUOTED_MIN_LENGTH}). One-character
 * values bought nothing and cost real meaning: prose ending `…is indistinguishable from a
 * secret: a` was emitted with the `a` masked, which is the sentence the documentation reads.
 * A lone character is not a credential, and the *quoted* rule keeps its one-character floor —
 * quotes are evidence that somebody meant to write a value, which a bare word is not.
 */
const UNQUOTED_MIN_LENGTH = 2;

/**
 * A space and a lowercase word after the value means the value was not the whole value.
 *
 * `.env`, YAML, TOML and compose never put an unquoted space inside a value, so
 * `secret: a value` is a sentence and `PASSWORD: hunter2` is an assignment. Without this,
 * any prose that happened to contain the word `secret: ` or `token: ` had its next word
 * masked — including this repository's own documentation and test comments.
 */
const PROSE_CONTINUATION = String.raw`(?!\s+[a-z])`;

/**
 * Characters a literal credential value may continue with.
 *
 * `$`, `!`, `@`, `^`, `*` and `?` are in every "must contain a symbol" password policy and
 * in URL-safe tokens. Leaving them out did not make the unquoted rules safer: the value stopped at
 * the first one and the artifact carried a mask followed by the rest of the password
 * (`db_password: [REDACTED]$$w0rdSecr3t`, `api_token: [REDACTED]!en$value`), which claims
 * coverage the snapshot does not have. A rule must mask the whole value or not fire at all.
 *
 * The characters kept out are the ones that end a value in the formats these rules serve:
 * whitespace, quotes, `,` and `;` (separators) and the openers `(`, `[` and `{`. `#` is kept
 * *in*: a leading `#` opens a comment, but a `#` in the middle of a token is part of the password —
 * `Sup3r!Secret#Pass` used to stop at the `#` and emit `#Pass` beside the marker. The trailing
 * lookahead below refuses a match that stops at an opener, so a call expression is never
 * truncated into a credential — the failure mode above was a truncated *literal*.
 */
const UNQUOTED_VALUE_CHARS = String.raw`A-Za-z0-9_+=/%:~$!@#^*?-`;
/** The value alphabet plus `.`, which continues a dotted path and therefore ends this token. */
const UNQUOTED_VALUE_END = String.raw`[A-Za-z0-9_+=/%:.~$!@#^*?-]`;
/**
 * Punctuation a credential may **begin** with.
 *
 * Passwords made by a generator start with \`$\`, \`!\`, \`@\` or \`#\` at least as often as with a letter,
 * and the literal class below begins with a word character — so \`api_token: !en$value\` and
 * \`secret: $$w0rdSecr3t\` were emitted whole, with no match and therefore no marker. The value's
 * first character may therefore be any of these; the token must also show one digit or a second
 * punctuation character somewhere, which is what keeps a YAML/CloudFormation tag (\`!Ref\`,
 * \`!GetAtt\`, \`!Sub\`) and a bare operator from looking like a credential.
 *
 * Quoted and backtick-wrapped values are already covered by the quoted rules; an *opener*-led
 * value (\`(hunter2)\`, \`[hunter2]\`) is matched only when it closes, and \`redact.ts\` masks it only
 * in a data/shell file because in source code the same shape is an expression.
 */
const UNQUOTED_VALUE_START = String.raw`[$!@#%^&*~+]`;
const UNQUOTED_LITERAL =
  String.raw`(` + // one capture, whichever branch matched: valueGroup is 1
    String.raw`(?![0-9]+(?!${UNQUOTED_VALUE_END}))[A-Za-z0-9_][${UNQUOTED_VALUE_CHARS}]{${UNQUOTED_MIN_LENGTH - 1},511}(?!${UNQUOTED_VALUE_END}|[({[]|[<>|\\])` +
    String.raw`|(?=${UNQUOTED_VALUE_START}[^ \t]{0,62}(?:[0-9]|${UNQUOTED_VALUE_START}))${UNQUOTED_VALUE_START}[${UNQUOTED_VALUE_CHARS}]{2,511}(?!${UNQUOTED_VALUE_END}|[({[]|[<>|\\])` +
    String.raw`|\([^()\s]{1,510}\)|\[[^\[\]\s]{1,510}\]|\{[^{}\s]{1,510}\}` +
    String.raw`)` +
  PROSE_CONTINUATION;
const UNQUOTED_AMBIGUOUS_LITERAL =
  String.raw`(?![0-9]+(?!${UNQUOTED_VALUE_END}))([A-Za-z0-9_][${UNQUOTED_VALUE_CHARS}]{7,511})(?!${UNQUOTED_VALUE_END}|[({[]|[<>|\\])` +
  PROSE_CONTINUATION;

/**
 * The assignment separator, and only the assignment separator.
 *
 * `[:=]` alone matches the first `=` of `===`, and the unquoted-value rules then
 * read the remaining `==` as a credential — the sighting in this repository's own
 * snapshot was `clause.token === ts.SyntaxKind…` emitted as
 * `clause.token =[REDACTED…]`, and `if (token === "--")` likewise. The lookbehind
 * rules out the second character of a comparison operator (`==`, `===`, `!=`,
 * `<=`, `>=`), the lookahead rules out the first one, so a comparison is never an
 * assignment.
 */
const ASSIGN = String.raw`(?<![=!<>])[:=](?!=)`;

/**
 * A credential *name* may be the tail of a longer identifier (`dbPassword`,
 * `awsSecret`), which is why the name itself cannot refuse a preceding word
 * character. A preceding **quote** is different: in `["awsSecret:", "apiKey:"]`
 * — a list of key names, not an assignment — the unquoted branch matched
 * `awsSecret:` and then took the next string's opening quote as this value's
 * opening quote, masking `, ` and welding two list elements together. A name
 * that starts immediately after a quote is inside a string literal, never a key,
 * so the unquoted branches refuse it. The quoted branch (`"dbPassword":`) still
 * matches at the quote itself.
 */
const NOT_AFTER_QUOTE = String.raw`(?<!["'])`;

/**
 * A reverse-domain identifier (`io.modelcontextprotocol/progressToken`) is a
 * protocol namespace, not a credential. No real secret starts with
 * `word(.word)+/`, and the MCP server's own field-name constants do.
 */
const NOT_A_NAMESPACED_IDENTIFIER = String.raw`(?![a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+/)`;

/**
 * A quoted key whose name ENDS in a credential word.
 *
 * JSON and YAML quote their keys, and the credential word is normally a suffix of a longer
 * camelCase name: `"dbPassword"`, `"discordToken"`, `"awsSecret"`, `"sessionKey"`. The old
 * alternative required the whole quoted string to be exactly the credential word, so only
 * `"password"` matched and every prefixed key — the spelling essentially every JSON config uses for
 * the same field — reached `parts/*.md` with its value in clear. The bounded prefix is word
 * characters only and cannot contain a quote, so a list of key *names* (`["awsSecret:", "apiKey:"]`)
 * still does not match: there the quoted string contains the separator and is followed by a comma.
 */
const QUOTED_CREDENTIAL_KEY = `["'](?!id[-_]token["'])[A-Za-z0-9_$-]{0,64}${STRONG_CREDENTIAL_NAME}["']`;

/**
 * The value of a quoted assignment, escaped pairs included.
 *
 * `[^"'\n]{1,512}` stopped at the first backslash, so
 * `{"password": "p\"ssw0rd"}` was masked to `"[REDACTED…]"ssw0rd"` — most of the value left in
 * clear, and the line left syntactically broken. `\\.` consumes the escaped pair, so the match
 * ends at the real closing quote.
 *
 * **Doubly-escaped quote.** One case defeats `\\.`: a quoted value *inside* a quoted string,
 * which is how every test fixture and every code sample that embeds JSON is written —
 * `JSON.parse('{"password": "p@\\"ssw0rd"}' )`. There the backslash before the inner quote is
 * itself escaped, so `\\.` consumes `\\` and the `"` that follows reads as the closing quote.
 * The value was emitted as `"[REDACTED…]"ssw0rdINVENTED"`: a fragment of the credential in
 * clear, and a line that no longer parses. A run of two backslashes followed by a quote that
 * is followed by a value character is an escaped quote inside a deeper literal, not the end of
 * this one, so it is consumed as three characters and the match continues to the real close.
 * `password: "C:\\temp"` and `password: "abc\\"` are unaffected: there the quote after `\\`
 * is followed by end-of-line, `,` or `}`, not by another value character.
 */
/**
 * The value of a quoted assignment, escaped pairs included, bounded by its own delimiter.
 *
 * The class used to exclude **both** quote characters, so a double-quoted value containing an
 * apostrophe (`"hunter'2"`) — or a single-quoted value containing a double quote (`'abc"def'`) —
 * stopped before that character, the closing-delimiter backreference never matched, and the rule
 * did not fire at all. Generated passwords and passphrases contain both characters routinely, and
 * the whole value reached `parts/*.md` in clear.
 *
 * The delimiter captured by `delimiterGroup` is the only quote the value may not contain, so the
 * negative lookahead is `(?!\<group>)`. The group number is a parameter rather than a hardcoded
 * `\1`: every rule embedding this today captures the delimiter in group 1, and a future rule that
 * captures it elsewhere must not be silently changed.
 *
 * Both escape behaviours the class had are preserved: `\\.` consumes an escaped pair, and the
 * doubly-escaped `\\\\["']` case (a quoted value inside a quoted string) is consumed as three
 * characters when the quote is followed by another value character.
 */
function quotedValueFor(delimiterGroup: number): string {
  return (
    "((?:(?!\\" + delimiterGroup + String.raw`)[^\\\n]|\\\\["'](?=[A-Za-z0-9_])|\\.){1,512})`
  );
}
const QUOTED_VALUE = quotedValueFor(1);

/**
 * `id-token` / `id_token` is a GitHub Actions permission, not a credential: the
 * bare `token` tail must not match it. (`authToken`, `accessToken` and friends
 * keep working; the lookbehind is exactly three characters wide.)
 */
const UNQUOTED_STRONG_NAME = `(?<!id[-_])${STRONG_CREDENTIAL_NAME}`;

/**
 * Does a **key** name a credential? The pattern catalogue matches names as tails
 * (`dbPassword` contains `password`), and callers that must decide whether a whole
 * `KEY=value` line is an assignment use the same test, so the rule set and the guards can never
 * disagree. Case-insensitive: data files spell these lowercase (`password=`, `api_key=`).
 */
export const CREDENTIAL_KEY_TAIL = new RegExp(`(?:${STRONG_CREDENTIAL_NAME})$`, "i");

export const DEFAULT_SECRET_PATTERNS: SecretRule[] = [
  {
    rule: "private-key-header",
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|-----BEGIN (?:RSA |OPENSSH |EC |PGP |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    // A base64-encoded PEM header. `-----BEGIN ` base64-encodes to `LS0tLS1CRUdJTi`, so a blob
    // that starts with that prefix and continues as base64 is a wrapped key. No decoder is
    // needed, and the prefix cannot occur in ordinary text — ripgrep's fixture passed through
    // untouched before this rule existed.
    rule: "base64-private-key",
    pattern: /LS0tLS1CRUdJTi[A-Za-z0-9+/]{40,}={0,2}/,
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
    // masked whole instead of half-matched, and a dot written as `%2E` — the form
    // a URL encoder produces, which used to walk straight past this rule — is
    // accepted as a separator. Quantifiers stay bounded (1024, as before) so an
    // `eyJ`-dense line cannot go quadratic.
    rule: "jwt-token",
    pattern:
      /eyJ[A-Za-z0-9_-]{8,1024}={0,2}(?:\.|%2[eE])eyJ[A-Za-z0-9_-]{8,1024}={0,2}(?:(?:\.|%2[eE])[A-Za-z0-9_-]{1,1024}={0,2})?/,
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
      `(?:["']${STRONG_CREDENTIAL_NAME}["']|${NOT_AFTER_QUOTE}${STRONG_CREDENTIAL_NAME})\\s{0,8}${ASSIGN}\\s{0,8}["']?([A-Za-z0-9/+=]{40})["']?`,
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
    // Known vendor token shapes: prefix-unique tokens, plus the few fixed layouts whose format is
    // documented and cannot collide with an ordinary identifier.
    //
    // Each prefix below is globally unique, which is what makes a bare prefix rule cheap and
    // safe: `glpat-` (GitLab), `hvs.`/`s.` (Vault service and batch tokens), `whsec_`
    // (Stripe webhook secret), `dckr_pat_` (Docker Hub), `hf_` (HuggingFace), `ya29.`
    // (Google OAuth access token), `shpat_`/`shpca_`/`shppa_`/`shpss_` (Shopify admin and
    // storefront tokens).
    //
    // The fixed shapes have no prefix to anchor on and were each emitted in clear:
    // - Telegram bot token: `<8-10 digit bot id>:<35-character secret>`.
    // - Discord bot token: `<base64 user id>.<6-8 char hmac>.<25-45 char signature>`; demanding
    //   all three segments keeps ordinary dotted identifiers out.
    // - Azure DevOps personal access token: exactly 52 alphanumerics that always mix case and
    //   digits, so a hash, a UUID or a plain identifier — all single-case or a different length —
    //   does not match.
    //
    // The rule name still says "prefix" because that is how the catalogue began; it is the
    // vendor-token rule, and growing a new named rule per vendor would make the documented
    // pattern count drift on every release.
    rule: "known-vendor-token-prefix",
    pattern:
      /\b(?:glpat-[A-Za-z0-9_-]{20,64}|glrt-[A-Za-z0-9_-]{20,64}|hvs\.[A-Za-z0-9_-]{20,128}|hvb\.[A-Za-z0-9_-]{20,128}|s\.[A-Za-z0-9]{20,64}|whsec_[A-Za-z0-9]{20,64}|dckr_pat_[A-Za-z0-9_-]{20,64}|hf_[A-Za-z0-9]{30,64}|ya29\.[A-Za-z0-9_-]{20,128}|sk_test_[A-Za-z0-9]{16,64}|1\/\/0[A-Za-z0-9_-]{20,64}|shpat_[A-Za-z0-9]{20,64}|shpca_[A-Za-z0-9]{20,64}|shppa_[A-Za-z0-9]{20,64}|shpss_[A-Za-z0-9]{20,64}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|[A-Za-z0-9]{20,30}\.[A-Za-z0-9_-]{5,8}\.[A-Za-z0-9_-]{25,45}|(?=[A-Za-z0-9]{0,51}[a-z])(?=[A-Za-z0-9]{0,51}[A-Z])(?=[A-Za-z0-9]{0,51}[0-9])[A-Za-z0-9]{52})(?![A-Za-z0-9])/,
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
    //
    // Three shapes joined it, all the same fact — a URL carries the credential in plain sight —
    // and each cost a leak while it was elsewhere:
    // - The user part may be **empty**: Redis, SMTP, AMQP and FTP URLs routinely omit the username
    //   (`redis://:password@host`), and a `{1,128}` prefix made every one of those invisible.
    // - `curl -u user:password` sends the same userinfo without a scheme; the lookbehind
    //   consumes the flag so the match is the credential alone.
    // - An Azure SAS link authenticates with `?sig=`; the signature *is* the credential.
    rule: "uri-credentials",
    pattern:
      /\/\/[^\s:/@"'`;()<>,]{0,128}:[^\s:/@"'`;()<>,]{1,256}@[^\s/"'`;()<>,]{1,256}|(?<=(?:^|[\s;|&(])--?u(?:ser)?[ \t=]{1,8})["']?[A-Za-z0-9._~-][A-Za-z0-9._~-]{0,127}:[^\s"'%$()+]{1,256}["']?|(?<=[?&])sig=[A-Za-z0-9%._=~-]{20,300}(?![A-Za-z0-9%._=~-])/,
  },
  {
    // The host tail stops at quotes, `;`, `)`, `<`, `>` and `,`: an unbounded
    // `[^\s/]` used to swallow the closing quote and the statement separator of
    // the string the URL was written in.
    // The user part may be empty here too: `redis://:password@host` and `amqp://:password@host`
    // are how those services are configured when the account is the server's default.
    rule: "database-uri-credentials",
    pattern:
      /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|maria(?:db)?|redis(?:s)?|amqp(?:s)?|clickhouse|mssql|sqlserver|oracle):\/\/[^\s:@/"'`;()<>,]{0,128}:[^\s@/"'`;()<>,]{1,256}@[^\s/"'`;()<>,]{1,256}/,
  },
  {
    // An empty user part is valid userinfo (`smtp://:password@host`: the account is the server's
    // default), and it used to be the one shape every scheme-listed rule refused.
    rule: "basic-auth-url",
    pattern:
      /(?:https?|ftp|sftp|ssh|git|smtp|smtps|ldap|ldaps):\/\/[^\s:@/"'`;()<>,]{0,128}:[^\s@/"'`;()<>,]{1,256}@[^\s/"'`;()<>,]{1,256}/i,
  },
  {
    // Quoted credentials in any common key spelling. The value may be as short
    // as one character: `password: "hunter2"` is a credential whatever its
    // entropy, and a length floor was exactly how it survived into `parts`.
    //
    // The key is bare (`dbPassword:`), wholly quoted (`"password":`), or quoted with a
    // camelCase prefix (`"dbPassword":`) — the last one is {@link QUOTED_CREDENTIAL_KEY}.
    // There is deliberately no optional quote *before* the separator: that let a
    // previous string's closing quote stand in for the key's, so
    // ``${pass ? "  PASS" : "  FAIL"}`` had `"  FAIL"` masked as if `PASS` were
    // the key name.
    rule: "credential-assignment",
    pattern: new RegExp(
      `(?:${QUOTED_CREDENTIAL_KEY}|${NOT_AFTER_QUOTE}(?<!id[-_])${STRONG_CREDENTIAL_NAME})\\s{0,8}${ASSIGN}\\s{0,8}${NOT_A_NAMESPACED_IDENTIFIER}(["'\`])${QUOTED_VALUE}\\1`,
      "i"
    ),
    valueGroup: 2,
  },
  {
    // `pass` and `credentials` are ambiguous on their own, so they
    // are accepted only against a quoted value long enough to be a credential.
    rule: "credential-assignment-weak",
    pattern: new RegExp(
      `(?:["']${WEAK_CREDENTIAL_NAME}["']|${NOT_AFTER_QUOTE}${WEAK_CREDENTIAL_NAME})\\s{0,8}${ASSIGN}\\s{0,8}(["'\`])${QUOTED_VALUE}\\1`,
      "i"
    ),
    valueGroup: 2,
  },
  {
    // The unquoted twin for YAML, docker-compose and `.env`: those formats never
    // quote their values, so the rules above cannot see them. `valueGroup` keeps
    // `POSTGRES_PASSWORD:` in the output.
    //
    // This is the one unquoted rule without `NOT_AFTER_QUOTE`, and the lookbehind is a
    // string-literal guard rather than a precision rule: a credential assignment *inside* a
    // literal — `const dsn = "password=hunter2;host=db"`, `curl -d "password=hunter2"` — was
    // rejected before it could be considered, and a DSN is a credential in a string. What made the
    // lookbehind redundant is the shape of `UNQUOTED_LITERAL`: a value has to start with a word
    // character, so `["awsSecret:", "apiKey:"]` — the list of key names the lookbehind was added
    // for — cannot match here anyway. `redact.ts` still refuses a match whose separator is inside
    // the literal, which is the case that list actually is.
    //
    // The name may also be a *quoted* key: YAML allows `"dbPassword": hunter2`, and JSON cannot
    // spell a key any other way, so the same {@link QUOTED_CREDENTIAL_KEY} fragment is used here.
    // Without it a quoted key whose value was not quoted emitted the value in clear.
    //
    // A colon-form assignment in a data file masks the whole remainder of the value to
    // end-of-line, whatever punctuation it holds. A strong credential name is the evidence that
    // the thing after it is a value, and the character classes above cannot cover every symbol a
    // password may contain — `password: pa&ss` used to stop at the `&`. This branch is a
    // lookbehind, so the match is the value alone, and `redact.ts` only applies it to a data or
    // shell file: in source code the same shape is an expression and stays untouched, and an `URL`
    // query string keeps its `&` separators because they are not a colon form.
    //
    // The `KEY=value` twin does the same for the `=` form, which INI, .properties and shell files
    // use: with a credential key the whole value is masked whatever symbols it contains
    // (`password=pa&ss`, `token=a<b`, `client_secret=x|y`). The value is bounded by whitespace
    // (end of line, or the space before a `# comment`), not by a symbol class — `envpass!@#$%^&*()` used
    // to stop before the parenthesis and leave the tail in clear. The lookbehind matches the value
    // alone and `redact.ts` decides, from the file and from the key, whether the line is an
    // assignment (it must be a data/shell file, the key must end in a credential name, and a URL
    // query parameter or `$VARIABLE` reference is not an assignment).
    rule: "credential-assignment-unquoted",
    pattern: new RegExp(
      `(?:${QUOTED_CREDENTIAL_KEY}|${UNQUOTED_STRONG_NAME})\\s{0,8}${ASSIGN}\\s{0,8}${NOT_A_LITERAL_VALUE}${UNQUOTED_LITERAL}|(?<=${UNQUOTED_STRONG_NAME}\\s{0,8}=(?!=)\\s{0,8})(?![\\s#$"'\`])[^\\s]{1,512}|(?<=${UNQUOTED_STRONG_NAME}\\s{0,8}:[ \t]{1,8})(?![ \t]*["'\`])(?![ \t]*[|>])${NOT_A_LITERAL_VALUE}[^\r\n#]{1,300}`,
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
      `${NOT_AFTER_QUOTE}${WEAK_CREDENTIAL_NAME}\\s{0,8}${ASSIGN}\\s{0,8}${NOT_A_LITERAL_VALUE}${UNQUOTED_AMBIGUOUS_LITERAL}`,
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
    //
    // A fourth shape was leaking: `Basic dXNlcjpwYXNz` is the base64 of `user:pass` — 12
    // characters, no digit, no padding — and the three tests above all said "not a
    // credential", so it reached the parts in clear. Mixed case is the discriminator: a base64
    // rendering of textual userinfo mixes cases, while the prose the earlier rules were
    // protecting (`Bearer authentication`) is a lowercase word.
    rule: "authorization-header",
    pattern:
      /(?<=[Aa]uthorization["']?\s*[:=]\s*["']?[A-Za-z][A-Za-z0-9._~+/-]{0,31}\s{1,8})(?:[A-Za-z0-9_.+/-]{0,31}[0-9][A-Za-z0-9_.+/-]{0,1024}|[A-Za-z0-9_.+/-]{32,1024}|[A-Za-z0-9_.+/-]{8,1024}={1,2}|(?=[A-Za-z0-9_.+/-]{0,1023}[A-Z])(?=[A-Za-z0-9_.+/-]{0,1023}[a-z])[A-Za-z0-9_.+/-]{12,1024})(?![A-Za-z0-9_.+/=-])/,
  },
  {
    // Broader names than before (`apiKey`, `clientSecret`, `privateKey` were
    // invisible to it) and value-only masking. Kept alongside the two rules
    // above because it also matches a *quoted key* followed by an unquoted
    // value, e.g. `"client_secret": abc123`.
    rule: "generic-secret-assignment",
    pattern:
      /(?<!["'])(?:api[_-]?key|secret[_-]?key|auth[_-]?token|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|password|passwd|pwd)["']?\s*(?<![=!<>])[:=](?!=)\s*["']([^"'\s]{8,256})["']/i,
    valueGroup: 1,
  },
  {
    // `${VAR:-fallback}` — a default value in a shell script, a `.env`, docker-compose or a
    // GitHub Actions workflow.
    //
    // This shape defeated every rule above it, and each refusal was individually reasonable:
    // the quoted rules need a quote after the separator, and the unquoted ones need the value to
    // begin with a word character — a fallback begins with `$`. So
    // `POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-MyProdPassword123!}` was emitted whole, `.env` files
    // and compose files included, which is where that idiom is the norm.
    //
    // The **fallback** is what gets masked, not the whole expansion: the variable name is the
    // readable context, exactly as `POSTGRES_PASSWORD:` is kept by the rule above. A single
    // interpolation with no operator (`${DB_PASSWORD}`) still does not match — there is nothing
    // between the braces to mask, and `isTemplateInterpolation` keeps such a value readable.
    rule: "interpolation-fallback-secret",
    pattern: new RegExp(
      // The operator set deliberately omits `?`: `${VAR:?message}` is an error message in shell
      // and Compose, not a fallback value, and masking it hid the sentence a user is meant to read.
      `(?:["']${STRONG_CREDENTIAL_NAME}["']|${NOT_AFTER_QUOTE}${STRONG_CREDENTIAL_NAME})\\s{0,8}${ASSIGN}\\s{0,8}["'\`]?\\$\\{[A-Za-z_][A-Za-z0-9_]*:?[-=+]([^}"'\`\\r\\n]{2,512})\\}["'\`]?`,
      "i"
    ),
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
    //
    // The name is now required to be uppercase. With `/i`, a reassignment inside a
    // function — `  key = fs.realpathSync(stagingRoot)` — matched `key`…`KEY` and
    // was emitted as `key = [REDACTED](stagingRoot)`, which corrupted this
    // repository's own `src/index.ts`. Shell and `.env` names are uppercase by
    // convention and a lowercase `key = …` at an indent is a variable, so the case
    // of the name is the discriminator that separates the two. The value must end
    // at end-of-line, whitespace or a comment: that is what stops a call expression
    // (`NAME=f(x)`) from being read as an assigned literal.
    rule: "env-secret-assignment",
    pattern:
      /^\s{0,64}(?:export\s{1,8})?(?=[A-Z][A-Z0-9_]{0,191}\s{0,8}=)[A-Z0-9_]{0,96}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIAL)[A-Z0-9_]{0,96}\s{0,8}=(?!=)\s{0,8}(?!["'`$<{[\]\s])([^\s#;"'`()]{1,512})(?=$|[\s#;])/,
    valueGroup: 1,
  },
];

/**
 * A PEM private-key block spanning one or more lines. Applied as a whole-text
 * pass because the per-line rules can only see the `BEGIN` header, which left
 * every body line of a real key in the snapshot.
 *
 * The body may not contain another `-----BEGIN`. `[\s\S]*?` has no opinion about what lies
 * between a `BEGIN` and the next `END`, so a file holding an *unterminated* header — a truncated
 * key, a fixture, a half-written file — followed later by a properly terminated block had
 * everything between the two headers replaced by blank lines: the first `BEGIN` bridged 36 lines
 * of test source to the second block's `END` and erased them. With the lookahead, a `BEGIN` that
 * has no `END` before the next `BEGIN` simply does not match, and `PEM_UNTERMINATED_PATTERN`
 * handles the header and its own base64 body instead.
 *
 * The newline after the header is deliberately **not** required. A PEM block inside a JSON or
 * `.env` value is written with escaped `\n` — two characters, not a line break — and a rule that
 * insisted on a real line break would mask the header alone and leave the whole base64 body in
 * clear, which is strictly worse than the bridging bug.
 */
export const PEM_BLOCK_PATTERN =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:(?!-----BEGIN)[\s\S])*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;

/**
 * A private key whose `END` marker was cut off — either truncated by the
 * preview budget or still being written. Constrained to the header plus the
 * base64-ish lines that immediately follow, so a stray header cannot swallow
 * the rest of the file.
 *
 * Two shapes it used to miss, and both of them leaked the whole key:
 *
 * - **Indented bodies.** The base64 lines had to start at column 0, so a key
 *   inside a YAML block scalar (`privateKey: |`) or an indented template literal
 *   never matched. Pass 2 then masked the `-----BEGIN…-----` line alone and every
 *   body line stayed in the snapshot.
 * - **RFC 1421 header lines.** `Proc-Type: 4,ENCRYPTED` and
 *   `DEK-Info: AES-128-CBC,…` sit between the marker and the body of an encrypted
 *   key, and their `:` ended the match at the marker.
 *
 * Body lines are required to be a run of base64 characters (8 or more, no inner
 * spaces) rather than "anything base64-ish", so a `BEGIN` line in a comment or a
 * test fixture is not followed into the prose after it.
 */
export const PEM_UNTERMINATED_PATTERN =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:\r\n|\n|\r)(?:(?:[ \t]*(?:Proc-Type|DEK-Info|Comment|Version):[^\r\n]*|[ \t]*)(?:\r\n|\n|\r))*(?:[ \t]*[A-Za-z0-9+/=]{8,}[ \t]*(?:\r\n|\n|\r|$))+/g;
