
import { scanAndRedactSecrets, DEFAULT_SECRET_PATTERNS } from '../../dist/index.js';
const cases = [
  'JWT_SECRET=replace-with-base64url-48-bytes',
  'API_KEY=replace-me-with-the-real-key',
  'JWT_SECRET=changeme',
  'JWT_SECRET=your-secret-here',
  'JWT_SECRET=hunter2RealValue99',
];
for (const line of cases) {
  const { redacted, findings } = scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, '.env.example');
  console.log((redacted === line ? 'NOT MASKED' : 'masked    ') + '  ' + JSON.stringify(line) + '  findings=' + findings.length);
}
