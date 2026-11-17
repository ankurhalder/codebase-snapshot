
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = path.resolve('.');
const api = await import(pathToFileURL(path.join(ROOT, 'dist/index.js')).href);

const files = Array.from({ length: 6 }, (_, i) => ({
  relativePath: 'src/module-' + i + '.ts',
  body: ('export const value' + i + ' = "' + 's'.repeat(240) + '";\n').repeat(6),
  language: 'typescript',
  layer: 'src',
  kind: 'source',
}));

for (const budget of [20, 46, 100, 1000, 2600, 3000, 4096, 8192]) {
  try {
    const parts = api.partitionFiles(files, budget);
    const reported = parts.map(p => p.budgetBytes);
    const sizes = parts.map(p => p.byteSize);
    const over = sizes.filter(s => s > budget).length;
    console.log(
      String(budget).padStart(5) + ' -> parts ' + String(parts.length).padStart(2) +
      ' | budgetBytes ' + JSON.stringify(reported.slice(0, 3)) +
      ' | byteSize ' + JSON.stringify(sizes.slice(0, 3)) +
      ' | parts over requested budget: ' + over
    );
  } catch (err) {
    console.log(String(budget).padStart(5) + ' -> THREW: ' + String(err.message).slice(0, 110));
  }
}
