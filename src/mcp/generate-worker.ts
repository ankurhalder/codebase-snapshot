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
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { releaseAbandonedRun } from "../index.js";
import type { Manifest } from "../types.js";
import type { WorkspaceCliOptions } from "./workspace.js";

/** What the caller needs from a finished run; the whole manifest can be megabytes. */
export interface GenerateSummary {
  fingerprint: string;
  totalFiles: number;
  skippedCount: number;
  partsCount: number;
  parts: Array<{ filename: string; byteSize: number }>;
  totalSizeBytes: number;
  totalContentBytes: number;
  preset: string;
  layers: Record<string, number>;
  /**
   * The most common skip reasons, ranked.
   *
   * `snapshot_plan` prints these, and it now runs off-thread too — so the ranking is computed
   * where the manifest is, and the whole `skipped[]` array (one record per path, thousands of
   * them) does not cross the thread boundary to be counted here.
   */
  skipReasons: Array<{ reason: string; count: number }>;
  warnings: string[];
}

export type WorkerResults =
  | { ok: true; summary: GenerateSummary }
  | { ok: false; message: string };

/**
 * Where the worker finds this package's entry: the path, and the URL the worker imports.
 *
 * Exported so the URL can be tested directly. The defect it fixes only shows up for an install
 * path that contains a `#`, `?` or `%`, or on a Windows drive letter, and no test can move the
 * package's own `dist/` to such a path.
 *
 * `pathToFileURL` rather than `` `file://${path}` ``: the interpolation form turns a Windows path
 * into `file://C:/…`, whose **host** is the drive letter, reads a `#` as a fragment and a `?` as
 * a query, and leaves a space unescaped. `config.ts` already carries this note for the same
 * reason.
 */
export function workerEntry(
  directory: string,
  isCjs: boolean
): { path: string; url: string } {
  const entry = path.join(directory, isCjs ? "index.cjs" : "index.js");
  return { path: entry, url: pathToFileURL(entry).href };
}

/**
 * The worker body.
 *
 * It loads the package entry by URL, resolves exactly as the calling thread did, generates, and
 * posts back the summary. Anything thrown becomes a `{ ok: false }` message rather than an
 * `error` event, so the caller gets the same text a synchronous call would have produced.
 *
 * `hooks` are stripped from the loaded config, and that is a documented contract rather than an
 * optimisation: `docs/mcp.md` tells the reader that `hooks.afterGenerate` does not run for a
 * generation started from MCP. It did. The worker called `generateSnapshot` with the config file's
 * hooks intact, so shell commands and scripts the user attached to a *CLI* run executed from inside
 * an MCP tool call — and a hook that was still running when the worker posted its result kept the
 * thread alive, or was cut off before it could finish re-shipping the marker it was written to
 * re-ship.
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
    // \`hooks: {}\` is a value, not an absence: the config is applied with the hook list emptied,
    // so the run is the documented MCP run rather than the CLI run with one setting removed.
    const base = loaded.config ? { ...loaded.config, hooks: {} } : null;
    const config = mod.resolveConfig(base, workerData.cliOptions, workerData.cwd);
    const manifest = mod.generateSnapshot(config, {
      dryRun: workerData.dryRun === true,
      ...(workerData.narrow ?? {}),
      ...(workerData.runId === undefined ? {} : { runId: workerData.runId }),
    });
    const skipCounts = new Map();
    for (const record of manifest.skipped) {
      skipCounts.set(record.reason, (skipCounts.get(record.reason) || 0) + 1);
    }
    const skipReasons = Array.from(skipCounts.entries())
      .sort(function (a, b) {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      })
      .slice(0, 8)
      .map(function (entry) {
        return { reason: entry[0], count: entry[1] };
      });
    parentPort.postMessage({
      ok: true,
      summary: {
        fingerprint: manifest.fingerprint,
        totalFiles: manifest.counts.totalFiles,
        skippedCount: manifest.counts.skippedCount,
        partsCount: manifest.counts.partsCount,
        parts: manifest.parts.map((part) => ({ filename: part.filename, byteSize: part.byteSize })),
        totalSizeBytes: manifest.counts.totalSizeBytes,
        totalContentBytes: manifest.totals.totalContentBytes,
        preset: manifest.config.preset,
        layers: manifest.layers,
        skipReasons: skipReasons,
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
  cliOptions: WorkspaceCliOptions,
  options: {
    dryRun?: boolean;
    signal?: AbortSignal;
    /** `--slice` / `--budget-tokens`: narrowing is a generate option, not a config setting. */
    narrow?: { slice?: { question: string; maxTokens?: number }; budgetTokens?: number };
    /** Identity the parent can name when the worker is terminated mid-run. */
    runId?: string;
    /** Directories whose locks/staging this run may own; used only for abandoned-worker cleanup. */
    lockRoots?: readonly string[];
  } = {}
): Promise<WorkerResults> {
  return new Promise<WorkerResults>((resolve) => {
    let settled = false;
    let worker: Worker | null = null;
    const finish = (result: WorkerResults): void => {
      if (settled) return;
      settled = true;
      // The snapshot is on disk by the time a message arrives, so nothing of value is lost by
      // ending the thread here — and leaving it alive is the cost: a config module that opened a
      // socket, started an interval or kept a file handle would hold the thread (and this process's
      // event loop, through the listener below) for as long as the MCP server runs.
      const terminated = worker === null ? Promise.resolve(undefined) : worker.terminate();
      void terminated
        .catch(() => undefined)
        .then(() => {
          // A worker that was terminated could not run its own finally. The parent knows the run
          // token, so it removes only that run's lock and staging, and the next call can start.
          if (!result.ok && options.runId !== undefined && options.lockRoots !== undefined) {
            releaseAbandonedRun(options.lockRoots, options.runId);
          }
          resolve(result);
        });
    };

    const isCjs = typeof __dirname !== "undefined";
    const directory = isCjs ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          entryUrl: workerEntry(directory, isCjs).url,
          cwd,
          cliOptions,
          dryRun: options.dryRun === true,
          narrow: options.narrow ?? {},
          ...(options.runId === undefined ? {} : { runId: options.runId }),
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

    // A cancelled request terminates the worker rather than waiting: the call it was answering has
    // already been abandoned, and a generation that keeps writing after that is work nobody asked for.
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        finish({ ok: false, message: "The generation was cancelled." });
        return;
      }
      options.signal.addEventListener(
        "abort",
        () => finish({ ok: false, message: "The generation was cancelled." }),
        { once: true }
      );
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
