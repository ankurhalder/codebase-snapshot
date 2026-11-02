import type { SecretRule } from "../types.js";

export const DEFAULT_SECRET_PATTERNS: SecretRule[] = [
  {
    rule: "private-key-header",
    pattern: /-----BEGIN (?:RSA |OPENSSH |EC |PGP )?PRIVATE KEY-----/,
  },
  {
    rule: "jwt-token",
    pattern: /eyJ[A-Za-z0-9-_]{10,}\.eyJ[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}/,
  },
  {
    rule: "aws-access-key-id",
    pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/,
  },
  {
    rule: "aws-secret-access-key",
    pattern: /(?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/i,
  },
  {
    rule: "github-token",
    pattern: /gh[pousr]_[A-Za-z0-9_]{36,255}/,
  },
  {
    rule: "slack-token",
    pattern: /xox[baprs]-[0-9A-Za-z]{10,48}/,
  },
  {
    rule: "stripe-secret-key",
    pattern: /[sr]k_live_[0-9a-zA-Z]{24}/,
  },
  {
    rule: "google-api-key",
    pattern: /AIza[0-9A-Za-z-_]{35}/,
  },
  {
    rule: "database-uri-credentials",
    pattern: /(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis(?:s)?):\/\/[^\s:]+:[^\s@]+@[^\s\/]+/,
  },
  {
    rule: "generic-secret-assignment",
    pattern: /(?:api_?key|secret_?key|auth_?token|client_?secret|access_?token|refresh_?token)\s*[:=]\s*["'][A-Za-z0-9-_]{16,}["']/i,
  },
];
