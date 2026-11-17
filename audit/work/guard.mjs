
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const BIN = path.resolve('dist/bin.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-guard-'));
fs.mkdirSync(path.join(dir, 'src'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"g","version":"1.0.0"}');
fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
const gen = run(['generate', '--no-config', '--cwd', dir]);
if (gen.status !== 0) { console.log('generate failed', gen.stderr.slice(0, 300)); process.exit(1); }
const mp = path.join(dir, 'snapshot', 'manifest.json');
const pristine = fs.readFileSync(mp, 'utf8');
const m = JSON.parse(pristine);
delete m.fingerprint;
fs.writeFileSync(mp, JSON.stringify(m, null, 2));

const show = (label, r) => {
  const all = (r.stdout || '') + (r.stderr || '');
  const hit = all.split('\n').map(l => l.trim()).filter(l => l && !/^\s*$/.test(l));
  const shape = hit.find(l => /is not a (usable )?snapshot manifest/.test(l)) || '(no shape message)';
  const undefinedOut = /undefined/.test(all) ? '  <-- prints undefined' : '';
  console.log(label.padEnd(10) + 'exit ' + r.status + '  ' + shape.slice(0, 100) + undefinedOut);
};
show('validate', run(['validate', '--cwd', dir]));
show('report',   run(['report', '--cwd', dir]));
show('diff',     run(['diff', path.join(dir, 'snapshot'), mp]));
fs.writeFileSync(mp, pristine);
show('control',  run(['validate', '--cwd', dir]));
fs.rmSync(dir, { recursive: true, force: true });
