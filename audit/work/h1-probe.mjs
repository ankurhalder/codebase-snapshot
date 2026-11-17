
import { DEFAULT_SECRET_PATTERNS, scanAndRedactSecrets } from "../../dist/index.js";
const cases = [
  ["env balanced",        'API_KEY="zq7Xk2nvalue"',   ".env"],
  ["env unbalanced dq",   'API_KEY="zq7Xk2nvalue',    ".env"],
  ["env unbalanced sq",   "API_KEY='zq7Xk2nvalue",    ".env"],
  ["src unbalanced",      'const API_KEY = "zq7Xk2nv', "src/a.ts"],
  ["escaped quote",       'API_KEY="zq7Xk2nvalue\\"', ".env"],
  ["prose no key",        'The password: "changed last week', "docs/a.md"],
  ["balanced later quote", 'password: "abc" and "def"', ".env"],
  ["json unterminated",   '{"password": "hunter2', ".json"],
  ["yaml unterminated",   'dbPassword: "hunter2', ".yml"],
];
for (const [name, line, file] of cases) {
  const r = scanAndRedactSecrets(line, DEFAULT_SECRET_PATTERNS, file);
  console.log(name.padEnd(22), JSON.stringify(r.redacted), "findings:", r.findings.length, r.findings[0]?.rules.join(",") ?? "");
}
