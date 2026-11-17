
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve('dist/bin.js');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-val-'));
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"v","version":"1.0.0"}');
const lines = ['export const wide = ['];
for (let i = 0; i < 200; i++) lines.push("  '" + 'x'.repeat(380) + "',");
lines.push('];');
fs.writeFileSync(path.join(repo, 'src/wide.ts'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(repo, 'snapshot.config.json'), JSON.stringify({ maxPartBytes: '8k', largeFileBytes: '8k', previewHeadLines: 20, previewTailLines: 10 }, null, 2));

const gen = spawnSync(process.execPath, [BIN, 'generate'], { cwd: repo, encoding: 'utf8' });
console.log('generate exit', gen.status);

const manPath = path.join(repo, 'snapshot/manifest.json');

const validate = (label) => {
  const r = spawnSync(process.execPath, [BIN, 'validate'], { cwd: repo, encoding: 'utf8' });
  const m = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  console.log(label.padEnd(52) + ' -> exit ' + r.status + ' | incomplete:' + JSON.stringify(m.incomplete ?? 'MISSING') + ' | count:' + m.counts.incompleteCount + ' | ranges:' + JSON.stringify(m.files[0].omittedRanges ?? []));
  if (r.status !== 0) console.log('   stderr: ' + r.stderr.trim().split('\n').slice(0, 3).join(' / '));
  return r.status;
};

validate('baseline');

// T1: delete incomplete[] entirely, keep files[].omittedRanges
let m = JSON.parse(fs.readFileSync(manPath, 'utf8'));
delete m.incomplete;
fs.writeFileSync(manPath, JSON.stringify(m, null, 2));
validate('T1 incomplete[] deleted, ranges kept');

// T2: incomplete[] present but emptied, count left alone
m = JSON.parse(fs.readFileSync(manPath, 'utf8'));
m.incomplete = [];
fs.writeFileSync(manPath, JSON.stringify(m, null, 2));
validate('T2 incomplete[] emptied');

// T3: incompleteCount lies
m.incomplete = [{ relativePath: 'src/nope.ts', part: 'part-001.md', reason: 'part-budget', omittedRanges: [[1, 2]], omittedLines: 2, includedLines: 1, lines: 3 }];
m.counts.incompleteCount = 42;
fs.writeFileSync(manPath, JSON.stringify(m, null, 2));
validate('T3 incomplete[] fabricated + count 42');

// T4: omittedRanges is a string, truncationReason invalid
m = JSON.parse(fs.readFileSync(manPath, 'utf8'));
m.files[0].omittedRanges = 'not-an-array';
m.files[0].truncationReason = 'made-up-reason';
fs.writeFileSync(manPath, JSON.stringify(m, null, 2));
validate('T4 omittedRanges string + bogus reason');

// T5: fix everything back and confirm green
m = JSON.parse(fs.readFileSync(manPath, 'utf8'));
delete m.files[0].omittedRanges;
delete m.files[0].truncationReason;
fs.writeFileSync(manPath, JSON.stringify(m, null, 2));
validate('T5 ranges/reason removed from files[0]');
