// api-trace-writes.cjs - preload that records every fs write performed by the CLI
const fs = require("node:fs");
const path = require("node:path");
const LOG = process.env.TRACE_LOG || "audit/poc/api-writes.log";
const origWrite = fs.writeFileSync;
const origRename = fs.renameSync;
const origRm = fs.rmSync;
function log(line) { origWrite.call(fs, LOG, line + "\n", { flag: "a" }); }
try { origWrite.call(fs, LOG, ""); } catch {}
fs.writeFileSync = function (file, data, opts) {
  const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : (data && data.length) || 0;
  log(`WRITE ${path.basename(String(file))} ${bytes}B`);
  return origWrite.call(fs, file, data, opts);
};
fs.renameSync = function (a, b) { log(`RENAME ${path.basename(String(a))} -> ${path.basename(String(b))}`); return origRename.call(fs, a, b); };
fs.rmSync = function (p, o) { log(`RM ${path.basename(String(p))}`); return origRm.call(fs, p, o); };
