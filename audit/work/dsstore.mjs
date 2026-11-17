
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve('dist/bin.js');
const run = (cwd) => spawnSync(process.execPath, [BIN, 'generate'], { cwd, encoding: 'utf8' });

const make = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ds-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  const first = run(dir);
  if (first.status !== 0) { console.log('baseline failed', first.stderr.slice(0, 400)); process.exit(1); }
  return dir;
};

// Case 1: top-level .DS_Store
{
  const dir = make();
  fs.writeFileSync(path.join(dir, 'snapshot', '.DS_Store'), 'finder noise');
  const r = run(dir);
  console.log('top-level snapshot/.DS_Store        -> exit ' + r.status +
    (r.status !== 0 ? '  ' + (r.stderr.trim().split('\n').pop() || '').slice(0, 120) : '  (replaced)'));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Case 2: nested .DS_Store inside reports/
{
  const dir = make();
  fs.writeFileSync(path.join(dir, 'snapshot', 'reports', '.DS_Store'), 'finder noise');
  const r = run(dir);
  const msg = (r.stderr.trim().split('\n').filter(Boolean).pop() || '');
  console.log('nested snapshot/reports/.DS_Store   -> exit ' + r.status + '  ' + msg.slice(0, 160));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Case 3: control — a nested FOREIGN file
{
  const dir = make();
  fs.writeFileSync(path.join(dir, 'snapshot', 'reports', 'notes.md'), 'mine');
  const r = run(dir);
  console.log('nested snapshot/reports/notes.md    -> exit ' + r.status);
  fs.rmSync(dir, { recursive: true, force: true });
}
