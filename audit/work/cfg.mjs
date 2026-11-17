
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve('dist/bin.js');
const run = (config, label) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cfg-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2));
  fs.writeFileSync(path.join(repo, 'index.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'snapshot.config.json'), JSON.stringify(config, null, 2));
  const r = spawnSync(process.execPath, [BIN, 'generate', '--dry-run'], { cwd: repo, encoding: 'utf8' });
  const out = (r.stderr || '').trim().split('\n').filter(Boolean);
  console.log(label.padEnd(46) + ' exit ' + r.status + '  ' + (out[out.length - 1] || '').slice(0, 150));
};

run({ preset: 'detected' }, 'preset: "detected" (docs complete example)');
run({ preset: 'node-lib' }, 'preset: "node-lib"');
run({ maxPartTokens: null }, 'maxPartTokens: null (docs default)');
run({ largeFileBytes: '300k', maxPartBytes: '300k' }, 'largeFileBytes == maxPartBytes');
run({ largeFileBytes: '301k', maxPartBytes: '300k' }, 'largeFileBytes > maxPartBytes');
run({ artifact: { readme: false } }, 'unknown top-level key "artifact"');
run({ includeSensitiveFiles: false, secrets: { customPatterns: [], disableDefaultPatterns: false } }, 'docs secrets default shape');
