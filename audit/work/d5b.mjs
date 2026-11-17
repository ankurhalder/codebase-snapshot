
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = path.resolve('.');
const api = await import(pathToFileURL(path.join(ROOT, 'dist/index.js')).href);
const cwd = process.cwd();

for (const value of [1, 20, 100, 1000, 4095, 4096, 4097]) {
  try {
    const cfg = api.resolveConfig({ cwd, maxPartBytes: value }, {}, cwd);
    console.log(String(value).padStart(5) + ' -> accepted, maxPartBytes = ' + cfg.maxPartBytes +
      ', budgets.default = ' + cfg.budgets.default);
  } catch (err) {
    console.log(String(value).padStart(5) + ' -> THREW: ' + String(err.message).slice(0, 120));
  }
}

console.log('\n--- via budgets.default ---');
for (const value of [1000, 3000]) {
  try {
    const cfg = api.resolveConfig({ cwd, budgets: { default: value } }, {}, cwd);
    console.log(String(value).padStart(5) + ' -> accepted, maxPartBytes = ' + cfg.maxPartBytes +
      ', budgets.default = ' + cfg.budgets.default);
  } catch (err) {
    console.log(String(value).padStart(5) + ' -> THREW: ' + String(err.message).slice(0, 120));
  }
}

console.log('\n--- per-layer budget below the floor ---');
try {
  const cfg = api.resolveConfig({ cwd, budgets: { default: '64k', byLayer: { src: 1000 } } }, {}, cwd);
  console.log('byLayer.src 1000 -> accepted, byLayer.src = ' + JSON.stringify(cfg.budgets.byLayer.src) +
    ' (requested 1000)');
} catch (err) {
  console.log('byLayer.src 1000 -> THREW: ' + String(err.message).slice(0, 140));
}
