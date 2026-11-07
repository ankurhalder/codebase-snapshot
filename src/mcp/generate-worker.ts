/**
 * `snapshot_generate` off the JSON-RPC thread.
 *
 * `CHANGELOG.md` for 0.9.4 has the measurement: a synchronous generate blocks the stdio server
 * for about 7.5 seconds on a 3,000-file repository. During that window the process cannot answer
 * `ping`, cannot acknowledge `notifications/cancelled`, and a client that puts a request timeout
 * on the socket reports the server as dead — for a tool call that is working perfectly.
 *
 * Why the worker resolves the configuration itself instead of receiving it: a resolved config
 * cannot cross a thread boundary. `layers[].match` may be a *function*, and
 * `hooks.afterGenerate` always is; structured cloning refuses both. Handing the worker the
 * resolved *values* as overrides would be worse than failing — every value would look
 * explicitly set, which changes how per-layer budgets resolve. So the worker loads the config
 * file and applies the same CLI options this thread did, and the two computations agree by
 * construction.
 *
 * The worker script is inline with `eval: true` rather than a second bundle entry: this package
 * ships an ESM and a CJS build, and a separate entry would need to be pointed at from both
 * formats. Inline code plus the resolved entry path works for either.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { Manifest } from "../types.js";

/** What the caller needs from a finished run; the whole manifest can be megabytes. */
export interface GenerateSummary {
  fingerprint: string;
  totalFiles: number;
  skippedCount: number;
  partsCount: number;
  parts: Array<{ filename: string; byteSize: number }>;
  totalContentBytes: number;
  warnings: string[];
}

export type WorkerResults =
  | { ok: true; summary: GenerateSummary }
  | { ok: false; message: string };

/**
 * The absolute path of the package entry this process is running from.
 *
 * `__dirname` exists in the CJS build and `import.meta.url` in the ESM one, and `typeof` on an
 * undeclared identifier does not throw — so this resolves correctly in both without a build-time
 * substitution.
 */
function entryPath(): string {
  const isCjs = typeof __dirname !== "undefined";
  const directory = isCjs ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  return path.join(directory, isCjs ? "index.cjs" : "index.js");
}

/**
 * The worker body.
 *
 * It loads the package entry by URL, resolves exactly as the calling thread did, generates, and
 * posts back the summary. Anything thrown becomes a `{ ok: false }` message rather than an
 * `error` event, so the caller gets the same text a synchronous call would have produced.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");

(async () => {
  try {
    const mod = await import(workerData.entryUrl);
    const loaded = await mod.loadConfigFileDetailed(workerData.cwd);
    if (loaded.errors.length > 0) {
      parentPort.postMessage({ ok: false, message: loaded.errors.join("; ") });
      return;
    }
    const config = mod.resolveConfig(loaded.config, workerData.cliOptions, workerData.cwd);
    const manifest = mod.generateSnapshot(config);
    parentPort.postMessage({
      ok: true,
      summary: {
        fingerprint: manifest.fingerprint,
        totalFiles: manifest.counts.totalFiles,
        skippedCount: manifest.counts.skippedCount,
        partsCount: manifest.counts.partsCount,
        parts: manifest.parts.map((part) => ({ filename: part.filename, byteSize: part.byteSize })),
        totalContentBytes: manifest.totals.totalContentBytes,
        warnings: manifest.warnings,
      },
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      message: error && error.message ? error.message : String(error),
    });
  }
})();
`;

/**
 * Generates in a worker and resolves with the summary.
 *
 * A worker that fails to start, exits without posting, or throws at the module level is reported
 * as a tool failure naming the reason — never silently retried on the calling thread, because a
 * quiet fallback would hide exactly the condition this exists to avoid.
 */
export function generateInWorker(
  cwd: string,
  cliOptions: { cwd: string; maxPartBytes?: number; outDir?: string }
): Promise<WorkerResults> {
  return new Promise<WorkerResults>((resolve) => {
    let settled = false;
    const finish = (result: WorkerResults): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          entryUrl: new URL(`file://${entryPath().replace(/\\/g, "/")}`).href,
          cwd,
          cliOptions,
        },
      });
    } catch (error) {
      finish({
        ok: false,
        message: `Could not start the generate worker: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }

    worker.on("message", (message: WorkerResults) => finish(message));
    worker.on("error", (error: Error) => {
      finish({ ok: false, message: `The generate worker failed: ${error.message}` });
    });
    worker.on("exit", (code: number) => {
      // A clean exit after a message has already settled this promise; an exit without one means
      // the worker died before it could report, which is a failure with no other explanation.
      if (!settled) {
        finish({ ok: false, message: `The generate worker exited (code ${code}) without a result.` });
      }
    });
  });
}

/** Narrowing helper for callers that only need the manifest-shaped fields. */
export type GenerateManifestProjection = Pick<
  Manifest,
  "fingerprint" | "counts" | "parts" | "totals" | "warnings"
>;
