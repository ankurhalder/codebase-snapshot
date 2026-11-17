
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const ROOT = path.resolve('.');
const { generateSnapshot, resolveConfig } = await import(pathToFileURL(path.join(ROOT, 'dist/index.js')).href);
const { buildTools } = await import(pathToFileURL(path.join(ROOT, 'dist/mcp.js')).href);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-d20-'));
const w = (rel, c) => { const t = path.join(dir, rel); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, c); };
w('package.json', '{"name":"d20","version":"1.0.0"}');
const filler = Array.from({ length: 4000 }, (_v, i) => 'export const pad' + i + ' = ' + i + ';').join('\n');
w('src/changed.ts', 'export const changed = 1;\n');
w('src/big-consumer.ts', 'import { changed } from "./changed.js";\n' + filler + '\nexport const total = changed;\n');
w('src/untouched.ts', 'export const untouched = 1;\n');
const git = (a) => execFileSync('git', ['-c','user.email=a@b','-c','user.name=a', ...a], { cwd: dir, stdio: 'ignore' });
git(['init','-q']); git(['add','-A']); git(['commit','-qm','base']);

w('src/changed.ts', 'export const changed = 2;\n');
const cfg = resolveConfig({ cwd: dir, outDir: 'snapshot', tmpDir: 'snapshot.tmp', changedSince: 'HEAD', withDependents: true, largeFileBytes: 2048 }, {}, dir);
const m = generateSnapshot(cfg);

console.log('files[] contains big-consumer :', m.files.some(f => f.relativePath === 'src/big-consumer.ts'));
const big = m.files.find(f => f.relativePath === 'src/big-consumer.ts');
console.log('big-consumer has a summary    :', Boolean(big && big.summary));
const byFile = m.indexes.imports.byFile.map(f => f.path);
console.log('byFile lists big-consumer     :', byFile.includes('src/big-consumer.ts'));
console.log('byFile =', JSON.stringify(byFile));
console.log('centralFiles =', JSON.stringify(m.indexes.imports.centralFiles));

const tools = new Map(buildTools().map(t => [t.name, t]));
const ctx = { cwd: dir, roots: [dir], log: () => {} };
const answer = await tools.get('snapshot_dependents').handler({ path: 'src/changed.ts', direction: 'imported-by' }, ctx);
console.log('snapshot_dependents importedBy:', JSON.stringify((answer.structured || {}).importedBy));
console.log('text:', String(answer.text).split('\n')[0]);
fs.rmSync(dir, { recursive: true, force: true });
