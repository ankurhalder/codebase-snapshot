
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cjs = require('../../dist/mcp.cjs');
console.log('mcp.cjs keys sample:', Object.keys(cjs).slice(0, 12).join(', '));
const esm = await import('../../dist/mcp.js');
console.log('mcp.js keys sample:', Object.keys(esm).slice(0, 12).join(', '));
console.log('both expose createServer:', typeof cjs.createServer, typeof esm.createServer);
console.log('both expose generateInWorker:', typeof cjs.generateInWorker, typeof esm.generateInWorker);
