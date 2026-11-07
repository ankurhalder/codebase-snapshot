/**
 * Makes this process look like Node 18 on Linux, for one test.
 *
 * `fs.watch(dir, { recursive: true })` arrived on Linux in Node 20.13, and the package declares
 * `engines: >=18` — so the state where a supported Node cannot honour `--watch` is real, and it was
 * shipped broken because the only machine that ever ran the watcher was a Windows one. Forcing the
 * two values is how the refusal is exercised on every platform instead of only on the one CI job
 * that happens to have it.
 *
 * `--require` (rather than `--import`) because it exists on every Node the package supports.
 */

Object.defineProperty(process, "platform", { value: "linux" });
Object.defineProperty(process.versions, "node", { value: "18.20.4" });
