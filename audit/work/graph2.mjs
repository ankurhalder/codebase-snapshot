
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && p.endsWith('.ts')) out.push(path.relative(root, p).split(path.sep).join('/'));
  }
  return out;
}
const srcFiles = walk(path.join(root, 'src')).sort();
const text = new Map(srcFiles.map(r => [r, fs.readFileSync(r, 'utf8')]));
console.log('src modules:', srcFiles.length);

const modOf = (from, spec) => {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const cands = [];
  if (base.endsWith('.js')) cands.push(base.slice(0, -3) + '.ts');
  cands.push(base + '.ts', base + '/index.ts');
  for (const cand of cands) if (text.has(cand)) return cand;
  return null;
};

const inbound = new Map();
const namesUsed = new Map();
const addName = (mod, n) => { const s = namesUsed.get(mod) ?? new Set(); s.add(n); namesUsed.set(mod, s); };

for (const [file, src] of text) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const t = modOf(file, st.moduleSpecifier.text); if (!t) continue;
      inbound.set(t, (inbound.get(t) ?? 0) + 1);
      const c = st.importClause;
      if (c) {
        if (c.name) addName(t, 'default');
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) addName(t, '*');
          else for (const el of c.namedBindings.elements) addName(t, el.propertyName ? el.propertyName.text : el.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const t = modOf(file, st.moduleSpecifier.text); if (!t) continue;
      inbound.set(t, (inbound.get(t) ?? 0) + 1);
      if (!st.exportClause) addName(t, '*');
      else if (ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) addName(t, el.propertyName ? el.propertyName.text : el.name.text);
      else if (ts.isNamespaceExport(st.exportClause)) addName(t, '*');
    }
  }
}

const orphans = srcFiles.filter(f => !f.endsWith('bin.ts') && !f.endsWith('index.ts') && !inbound.has(f));
console.log('ORPHANS (export-from counted):', orphans.length ? orphans.join(', ') : 'none');
console.log('run.ts inbound count:', inbound.get('src/mcp/run.ts'));

const dead = [];
for (const [file, src] of text) {
  if (file === 'src/index.ts' || file === 'src/mcp/index.ts') continue;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const used = namesUsed.get(file);
  if (used && used.has('*')) continue;
  for (const st of sf.statements) {
    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
    if (!mods || !mods.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const names = [];
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) names.push(st.name.text);
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
    for (const n of names) if (!used || !used.has(n)) dead.push(file + ':' + n);
  }
}
console.log('\nDEAD EXPORTS (export-from counted):', dead.length, '(was 139)');
console.log('  ' + dead.slice(0, 50).join('\n  '));