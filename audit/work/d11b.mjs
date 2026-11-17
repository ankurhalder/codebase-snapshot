
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { scanAndRedactSecrets, DEFAULT_SECRET_PATTERNS } = await import(
  pathToFileURL(path.resolve('dist/index.js')).href
);
const scan = (line, file = 'config/app.env') =>
  scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, file);

const cases = [
  ['balanced double quote',        'API_KEY="zq7Xk2nvalue"'],
  ['unbalanced double quote',      'API_KEY="zq7Xk2nvalue'],
  ['unbalanced single quote',      "API_KEY='zq7Xk2nvalue"],
  ['balanced, escaped quote',      'API_KEY="zq7\\"Xk2nvalue"'],
  ['unbalanced in source file',    'const API_KEY = "zq7Xk2nvalue'],
  ['unquoted control',             'API_KEY=zq7Xk2nvalue'],
];
for (const [label, line] of cases) {
  const { redacted, findings } = scan(line);
  const leaked = redacted.includes('zq7Xk2nvalue') ? 'LEAKED' : 'masked';
  console.log(
    label.padEnd(28) + '| ' + leaked.padEnd(7) + '| findings ' + String(findings.length).padEnd(2) +
    '| ' + JSON.stringify(redacted).slice(0, 62)
  );
}
