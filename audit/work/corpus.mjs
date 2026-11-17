
import { scanAndRedactSecrets, DEFAULT_SECRET_PATTERNS } from '../../dist/index.js';

const D = String.fromCharCode(36);   // $
const BT = String.fromCharCode(96);  // backtick

const CASES = [
  ['src/a.ts', 'const apiKey = "sk-live-abcdefghijklmnopqrstuvwx1234";', 'sk-live-abcdefghijklmnopqrstuvwx1234', true],
  ['src/a.ts', 'const DB_PASSWORD = "supersecretvalue123";', 'supersecretvalue123', true],
  ['config/.env', 'DB_PASSWORD=envpass!@#%^&*()', 'envpass!@#%^&*()', true],
  ['config/.env', 'DB_PASSWORD=correct horse battery staple', 'horse battery', true],
  ['config/.env', 'DB_PASSWORD=secret && echo done', 'secret', true],
  ['deploy/Dockerfile', 'ENV API_KEY sk-live-abcdefghijklmnopqrstuvwx1234', 'sk-live-abcdefghijklmnopqrstuvwx1234', true],
  ['config/app.yaml', 'dbPassword:\n  "hunter2-Correct-Horse"\n', 'hunter2-Correct-Horse', true],
  ['config/app.yaml', 'dbPassword: |\n  -----BEGIN-----\n  MIIEowIBAAKCAQEA1234567890abcdef\n', 'MIIEowIBAAKCAQEA1234567890abcdef', true],
  ['src/a.ts', 'const key = "X-Api-Key=" + "sk-live-abcdefghijklmnopqrstuvwx1234";', 'sk-live-abcdefghijklmnopqrstuvwx1234', true],
  ['src/a.ts', 'url = "postgres://user:hunter2db@db.internal:5432/app"', 'hunter2db', true],
  ['src/a.ts', 'fetch("https://api.example.com?access_token=abcd1234efgh&scope=read")', 'abcd1234efgh', true],
  ['src/a.ts', 'const dsn = "password=hunter2;host=db";', 'hunter2', true],
  ['src/a.ts', 'curl -d "password=hunter2" https://x', 'hunter2', true],
  ['shell/deploy.sh', 'export api_key=hunter2secret', 'hunter2secret', true],
  ['shell/deploy.sh', 'readonly api_key=hunter2secret', 'hunter2secret', true],
  ['config/app.ini', 'password = pa&&ss123', 'pa&&ss123', true],
  ['config/app.properties', 'db.password=s3cr3tValue', 's3cr3tValue', true],
  ['src/a.ts', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE', true],
  ['src/a.ts', 'token: ghp_0123456789abcdefghijklmnopqrstuvwxyzAB', 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB', true],
  ['src/a.ts', 'const header = ' + BT + 'X-Token: ' + D + '{appliesTo}' + BT + ';', 'appliesTo', false],
  ['src/a.ts', 'progressToken: "progressToken"', 'progressToken', false],
  ['src/a.ts', 'const SINGLE_TOKEN = /[^\\sA-Za-z0-9_]/g;', '[^\\sA-Za-z0-9_]/g', false],
  ['config/app.yaml', 'POSTGRES_PASSWORD: "' + D + '{POSTGRES_PASSWORD:-MyProdPassword123!}"', 'MyProdPassword123!', true],
  ['.env.example', 'API_KEY=replace-me-with-the-real-key', 'replace-me-with-the-real-key', false],
  ['docs/readme.md', 'Set \x60password: "your-secret-here"\x60 before deploying.', 'your-secret-here', false],
  ['src/a.ts', 'const token = tokens[0];', 'tokens[0]', false],
  ['src/a.ts', 'private readonly apiKey = process.env.X;', 'process.env.X', false],
  ['config/app.env', 'STRIPE=sk_live_abcdefghijklmnopqrstuvwx1234', 'sk_live_abcdefghijklmnopqrstuvwx1234', true],
  ['src/a.ts', 'password = "a" + realPassword + "b";', 'realPassword', false],
  ['src/b.ts', 'const apiKey = "sk-live-abcdefghijklmnopqrstuvwx1234";\r\nconst x = 1;', 'sk-live-abcdefghijklmnopqrstuvwx1234', true],
  ['keys/id.pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----\n', 'MIIEowIBAAKCAQEA1234567890', true],
  ['src/a.ts', 'const k = "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkq\\n-----END PRIVATE KEY-----";', 'MIIEvQIBADANBgkq', true],
  ['src/a.ts', "const apiKey = 'sk-live-abcdefghijklmnopqrstuvwx1234", 'sk-live-abcdefghijklmnopqrstuvwx1234', true],
  ['src/a.ts', "it('x'); const apiKey = \"sk-live-abcdefghijklmnopqrstuvwx1234", 'sk-live-abcdefghijklmnopqrstuvwx1234', true],
  ['config/app.env', 'DB_PASSWORD=ab"cd"ef', 'cd', true],
  ['src/t.ts', 'const re = /^password=([a-z]+)\$/;', '([a-z]+)', false],
];

let leaks = 0, silentLeaks = 0, missedFindings = 0, overRedactions = 0, shown = 0;
for (const [file, src, needle, expectFinding] of CASES) {
  const { redacted, findings } = scanAndRedactSecrets(src, DEFAULT_SECRET_PATTERNS, file);
  const survived = redacted.includes(needle);
  const hasFinding = findings.length > 0;
  const tags = [];
  if (survived) { leaks++; tags.push('LEAK'); if (!hasFinding) { silentLeaks++; tags.push('SILENT'); } }
  if (expectFinding && !hasFinding && !survived) { missedFindings++; tags.push('NO-FINDING'); }
  if (!expectFinding && !survived) { overRedactions++; tags.push('OVER-REDACT'); }
  if (tags.length && shown < 14) {
    shown++;
    console.log(tags.join(' ') + '  [' + file + ']');
    console.log('   in : ' + JSON.stringify(src));
    console.log('   out: ' + JSON.stringify(redacted));
    console.log('   findings: ' + JSON.stringify(findings.map(function (f) { return f.rules; })));
  }
}
console.log('\ncorpus ' + CASES.length + ' | leaks ' + leaks + ' | silent ' + silentLeaks + ' | missing findings ' + missedFindings + ' | over-redactions ' + overRedactions);
