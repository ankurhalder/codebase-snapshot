
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const BIN = path.resolve('dist/bin.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-d16c-'));
fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}');
fs.writeFileSync(path.join(dir, 'big.md'), Array.from({length: 4000}, (_, i) => 'line ' + i + ' of a document').join('\n') + '\n');
const BUDGET = ['--max-part-bytes', '20000'];
const gen = spawnSync(process.execPath, [BIN, 'generate', '--cwd', dir, ...BUDGET], { encoding: 'utf8' });
if (gen.status !== 0) { console.log('generate failed', gen.stderr.slice(0, 400)); process.exit(1); }

const mp = path.join(dir, 'snapshot', 'manifest.json');
const pristine = fs.readFileSync(mp, 'utf8');
const base = JSON.parse(pristine);
console.log('baseline: incomplete.length =', base.incomplete.length,
  '| incompleteCount =', base.counts.incompleteCount,
  '| omittedRanges =', JSON.stringify(base.incomplete[0].omittedRanges),
  '| includedLines =', base.incomplete[0].includedLines, '| lines =', base.incomplete[0].lines);

const validate = () => {
  const r = spawnSync(process.execPath, [BIN, 'validate', '--cwd', dir, ...BUDGET], { encoding: 'utf8' });
  const all = ((r.stdout || '') + (r.stderr || ''));
  const verdict = /valid and up to date/.test(all) ? 'VALID' : 'INVALID';
  const errLine = (all.split('\n').find(l => /✖|❌|error|drift|missing|deleted|modified|new file/i.test(l)) || '').trim();
  return 'exit ' + r.status + '  ' + verdict + '  ' + errLine.slice(0, 88);
};

const variants = {
  'pristine (control)':                  () => {},
  'incomplete[] emptied, count kept':    (m) => { m.incomplete = []; },
  'incomplete[] and count emptied':      (m) => { m.incomplete = []; m.counts.incompleteCount = 0; },
  'incompleteCount = 42':                (m) => { m.counts.incompleteCount = 42; },
  'omittedRanges = "not-an-array"':      (m) => { m.incomplete[0].omittedRanges = 'not-an-array'; },
  'omittedRanges = [[1,1]]':             (m) => { m.incomplete[0].omittedRanges = [[1,1]]; },
  'incomplete[0].reason = "bogus"':      (m) => { m.incomplete[0].reason = 'bogus'; },
  'entry.truncationReason = "bogus"':    (m) => { m.files.find(f => f.truncationReason).truncationReason = 'bogus'; },
  'includedLines = 99999':               (m) => { m.incomplete[0].includedLines = 99999; },
  'omittedLines = 0':                    (m) => { m.incomplete[0].omittedLines = 0; },
  'relativePath = "../escape.ts"':       (m) => { m.incomplete[0].relativePath = '../escape.ts'; },
};

for (const [label, mutate] of Object.entries(variants)) {
  const m = JSON.parse(pristine);
  mutate(m);
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  console.log(label.padEnd(36) + '-> ' + validate());
}
fs.writeFileSync(mp, pristine);
fs.rmSync(dir, { recursive: true, force: true });
