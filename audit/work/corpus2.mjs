
import { scanAndRedactSecrets, DEFAULT_SECRET_PATTERNS } from '../../dist/index.js';

const D = String.fromCharCode(36);
const BT = String.fromCharCode(96);

// [file, source, secret that MUST NOT survive, label]
const MUST_MASK = [
  ['src/a.ts', 'const apiKey = "sk-live-abcdefghijklmnopqrstuvwx1234";', 'sk-live-abcdefghijklmnopqrstuvwx1234'],
  ['src/a.ts', 'const DB_PASSWORD = "supersecretvalue123";', 'supersecretvalue123'],
  ['config/.env', 'DB_PASSWORD=zq7Xk2nsecret!@#%^&*()', 'zq7Xk2nsecret!@#%^&*()'],
  ['config/.env', 'DB_PASSWORD=correct horse battery staple', 'horse battery'],
  ['config/.env', 'DB_PASSWORD=zq7Xk2nsecret && echo done', 'zq7Xk2nsecret'],
  ['deploy/Dockerfile', 'ENV API_KEY sk-live-abcdefghijklmnopqrstuvwx1234', 'sk-live-abcdefghijklmnopqrstuvwx1234'],
  ['config/app.yaml', 'dbPassword:\n  "hunter2-Correct-Horse"\n', 'hunter2-Correct-Horse'],
  ['config/app.yaml', 'dbPassword: |\n  -----BEGIN-----\n  MIIEowIBAAKCAQEA1234567890abcdef\n', 'MIIEowIBAAKCAQEA1234567890abcdef'],
  ['src/a.ts', 'const key = "X-Api-Key=" + "sk-live-abcdefghijklmnopqrstuvwx1234";', 'sk-live-abcdefghijklmnopqrstuvwx1234'],
  ['src/a.ts', 'url = "postgres://user:hunter2db@db.internal:5432/app"', 'hunter2db'],
  ['src/a.ts', 'fetch("https://api.example.com?access_token=abcd1234efgh&scope=read")', 'abcd1234efgh'],
  ['src/a.ts', 'const dsn = "password=hunter2;host=db";', 'hunter2'],
  ['src/a.ts', 'curl -d "password=hunter2" https://x', 'hunter2'],
  ['shell/deploy.sh', 'export api_key=hunter2secret', 'hunter2secret'],
  ['shell/deploy.sh', 'readonly api_key=hunter2secret', 'hunter2secret'],
  ['config/app.ini', 'password = pa&&ss123', 'pa&&ss123'],
  ['config/app.properties', 'db.password=s3cr3tValue', 's3cr3tValue'],
  ['src/a.ts', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  ['src/a.ts', 'token: ghp_0123456789abcdefghijklmnopqrstuvwxyzAB', 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'],
  ['config/app.yaml', 'POSTGRES_PASSWORD: "' + D + '{POSTGRES_PASSWORD:-MyProdPassword123!}"', 'MyProdPassword123!'],
  ['config/app.env', 'STRIPE=sk_live_abcdefghijklmnopqrstuvwx1234', 'sk_live_abcdefghijklmnopqrstuvwx1234'],
  ['src/b.ts', 'const apiKey = "sk-live-abcdefghijklmnopqrstuvwx1234";\r\nconst x = 1;', 'sk-live-abcdefghijklmnopqrstuvwx1234'],
  ['keys/id.pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----\n', 'MIIEowIBAAKCAQEA1234567890'],
  ['src/a.ts', "const apiKey = 'sk-live-abcdefghijklmnopqrstuvwx1234", 'sk-live-abcdefghijklmnopqrstuvwx1234'],
  ['src/a.ts', "it('x'); const apiKey = \"sk-live-abcdefghijklmnopqrstuvwx1234", 'sk-live-abcdefghijklmnopqrstuvwx1234'],
  ['config/app.env', 'DB_PASSWORD=zq7Xk2nab"cd"ef', 'zq7Xk2nab'],
  ['config/app.env', 'API_KEY="unbalanced zq7Xk2nvalue', 'zq7Xk2nvalue'],
  ['config/app.env', 'secret: "zq7Xk2nvalue with \\" quote"', 'zq7Xk2nvalue'],
];

// [file, source, text that MUST survive (documented non-redaction)]
const MUST_NOT_MASK = [
  ['src/a.ts', 'const header = ' + BT + 'X-Token: ' + D + '{appliesTo}' + BT + ';', 'appliesTo'],
  ['src/a.ts', 'progressToken: "progressToken"', 'progressToken'],
  ['src/a.ts', 'const SINGLE_TOKEN = /[^\\sA-Za-z0-9_]/g;', 'SINGLE_TOKEN'],
  ['.env.example', 'API_KEY=replace-me-with-the-real-key', 'replace-me-with-the-real-key'],
  ['docs/readme.md', 'Set \x60password: "your-secret-here"\x60 before deploying.', 'your-secret-here'],
  ['src/a.ts', 'const token = tokens[0];', 'tokens[0]'],
  ['src/a.ts', 'private readonly apiKey = process.env.X;', 'process.env.X'],
  ['src/t.ts', 'const re = /^password=([a-z]+)\$/;', '^password='],
];

let leaks = 0, silent = 0, over = 0, unreported = 0;
for (const [file, src, needle] of MUST_MASK) {
  const { redacted, findings } = scanAndRedactSecrets(src, DEFAULT_SECRET_PATTERNS, file);
  if (redacted.includes(needle)) {
    leaks++;
    if (findings.length === 0) silent++;
    console.log('LEAK ' + (findings.length === 0 ? '(silent)' : '') + ' [' + file + ']');
    console.log('   in : ' + JSON.stringify(src));
    console.log('   out: ' + JSON.stringify(redacted));
  } else if (findings.length === 0) {
    unreported++;
    console.log('MASKED-BUT-UNREPORTED [' + file + '] ' + JSON.stringify(src));
  }
}
for (const [file, src, needle] of MUST_NOT_MASK) {
  const { redacted, findings } = scanAndRedactSecrets(src, DEFAULT_SECRET_PATTERNS, file);
  if (!redacted.includes(needle)) {
    over++;
    console.log('OVER-REDACT [' + file + '] in: ' + JSON.stringify(src));
    console.log('                      out: ' + JSON.stringify(redacted));
  }
}
console.log('\nmust-mask ' + MUST_MASK.length + ' -> leaks ' + leaks + ' (silent ' + silent + '), masked-without-finding ' + unreported);
console.log('must-not-mask ' + MUST_NOT_MASK.length + ' -> over-redactions ' + over);
