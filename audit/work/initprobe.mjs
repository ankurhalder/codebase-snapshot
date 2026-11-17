
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve('dist/bin.js');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-init-'));
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2));
fs.writeFileSync(path.join(repo, 'index.js'), 'export const a = 1;\n');
spawnSync('git', ['init', '-q'], { cwd: repo });

const r = spawnSync(process.execPath, [BIN, 'init', '--yes', '--out-dir', '.context'], { cwd: repo, encoding: 'utf8' });
console.log('init exit', r.status);
console.log(r.stdout.split('\n').filter(l => l.trim()).map(l => '  ' + l).join('\n'));
if (r.stderr.trim()) console.log('stderr:', r.stderr.trim().split('\n').slice(0, 4).join('\n  '));

const ignore = fs.existsSync(path.join(repo, '.gitignore')) ? fs.readFileSync(path.join(repo, '.gitignore'), 'utf8') : '(no .gitignore)';
console.log('\n.gitignore now:\n' + ignore.split('\n').map(l => '  | ' + l).join('\n'));

const cfgName = ['snapshot.config.ts', 'snapshot.config.mjs', 'snapshot.config.js'].find(n => fs.existsSync(path.join(repo, n)));
console.log('\nconfig written:', cfgName);
if (cfgName) {
  const cfg = fs.readFileSync(path.join(repo, cfgName), 'utf8');
  const m = cfg.match(/outDir:\s*([^\n]+)/);
  console.log('outDir in config:', m ? m[1].trim() : '(not found)');
}

// Now generate and ask git what it thinks of the output directory.
const g = spawnSync(process.execPath, [BIN, 'generate'], { cwd: repo, encoding: 'utf8' });
console.log('\ngenerate exit', g.status);
const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repo, encoding: 'utf8' });
console.log('git status after generate:\n' + status.stdout.split('\n').filter(Boolean).map(l => '  ' + l).join('\n'));
const ignored = spawnSync('git', ['check-ignore', '-v', '.context/manifest.json'], { cwd: repo, encoding: 'utf8' });
console.log('is .context/ ignored? exit ' + ignored.status + ' ' + JSON.stringify(ignored.stdout.trim()));
console.log('repo:', repo);
