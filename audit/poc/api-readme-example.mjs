import { generateSnapshot, validateSnapshot, resolveConfig } from "@ankurhalder/codebase-snapshot";
const cwd = process.argv[2];
const manifest = await generateSnapshot({ cwd, maxPartBytes: 300 * 1024 });
console.log(`Generated ${manifest.counts.partsCount} parts for ${manifest.counts.totalFiles} files.`);
const validation = validateSnapshot(resolveConfig(null, { cwd }));
if (!validation.valid) { console.error("Drift detected:", validation.errors); }
console.log("validation.valid =", validation.valid);
