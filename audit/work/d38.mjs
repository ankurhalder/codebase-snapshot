
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { scanAndRedactSecrets, DEFAULT_SECRET_PATTERNS } = await import(
  pathToFileURL(path.resolve('dist/index.js')).href
);
const scan = (line, file = 'config/app.env') =>
  scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, file);

const cases = [
  ['DOC example: JWT_SECRET=replace-with-base64url-48-bytes', 'JWT_SECRET=replace-with-base64url-48-bytes', '.env.example'],
  ['DOC example: process.env.X_SECRET = "test-value"',        'process.env.X_SECRET = "test-value"',        'a.ts'],
  ['TEST example: DATABASE_API_KEY=replace-me-with-the-read-tier-key', 'DATABASE_API_KEY=replace-me-with-the-read-tier-key', '.env.example'],
  ['TEST example: OPENAI_API_KEY=sk-...',                     'OPENAI_API_KEY=sk-...',                     '.env.example'],
  ['TEST example: QDRANT_API_KEY=...',                        'QDRANT_API_KEY=...',                        '.env.example'],
  ['TEST example: # REVALIDATE_SECRET=replace-me-with-a-fresh-secret', '# REVALIDATE_SECRET=replace-me-with-a-fresh-secret', '.env.example'],
];
for (const [label, line, file] of cases) {
  const { redacted, findings } = scan(line, file);
  const masked = redacted.includes('[REDACTED');
  console.log((masked ? 'MASKED  ' : 'UNTOUCHD') + ' | findings ' + findings.length + ' | ' + label);
}
