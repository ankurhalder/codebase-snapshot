
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = path.resolve('.');
const api = await import(pathToFileURL(path.join(ROOT, 'dist/index.js')).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-summary-'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"f","version":"1.0.0"}');
fs.mkdirSync(path.join(dir, 'src'));
fs.writeFileSync(path.join(dir, 'src/small.ts'), 'export const s = 1;\n');
fs.writeFileSync(path.join(dir, 'src/big.ts'), Array.from({length: 4000}, (_, i) => 'export const b' + i + ' = ' + i + ';').join('\n') + '\n');
fs.mkdirSync(path.join(dir, 'logs'));
fs.writeFileSync(path.join(dir, 'logs/huge.log'), 'line\n'.repeat(50000));

const m = api.generateSnapshot({ cwd: dir, outDir: 'snapshot', largeFileBytes: 4096 });
for (const p of ['src/small.ts', 'src/big.ts', 'logs/huge.log']) {
  const e = m.files.find(f => f.relativePath === p);
  if (!e) { console.log(p.padEnd(16) + '-> not in files[]'); continue; }
  const keys = Object.keys(e).filter(k => /summar/i.test(k));
  console.log(p.padEnd(16) + '| mode ' + String(e.inclusionMode).padEnd(8) +
    '| summary ' + (e.summary ? 'present' : 'absent').padEnd(7) +
    '| summary-ish keys: ' + JSON.stringify(keys) +
    '| summaryOmitted = ' + JSON.stringify(e.summaryOmitted));
}
console.log('\nwarnings containing "preview":');
for (const w of m.warnings.filter(w => /preview/i.test(w))) console.log('  ' + w.slice(0, 120));
fs.rmSync(dir, { recursive: true, force: true });
