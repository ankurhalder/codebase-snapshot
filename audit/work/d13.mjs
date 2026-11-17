
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const BIN = path.resolve('dist/bin.js');

function run(label, pkgText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-d13-'));
  fs.writeFileSync(path.join(dir, 'package.json'), pkgText);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  const r = spawnSync(process.execPath, [BIN, 'generate', '--cwd', dir, '--format', 'json'], { encoding: 'utf8' });
  const all = (r.stdout || '') + (r.stderr || '');
  const m = /Generator:\s*([^\n]*)/.exec(all);
  console.log(label.padEnd(34) + '-> ' + (m ? m[1].trim() : '(no Generator line; exit ' + r.status + ')'));
  fs.rmSync(dir, { recursive: true, force: true });
}

const body = JSON.stringify({ name: 'x', version: '1.0.0', devDependencies: { 'codebase-snapshot': '^0.10.1' } }, null, 2);
run('plain package.json', body);
run('BOM + package.json', '\uFEFF' + body);
run('package.json with a // comment', body.replace('"name": "x",', '"name": "x", // ours'));
