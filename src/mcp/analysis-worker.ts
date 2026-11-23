/**
 * Validation, health and explain off the JSON-RPC thread.
 *
 * These are repository-wide scans. `snapshot_generate` already ran in a worker, but `validate`,
 * `health`, `review` and `explain` still ran synchronously: a 3,000-file audit stopped the server
 * answering ping and `notifications/cancelled` for seconds. The worker imports the package entry
 * and calls the same functions the handlers used, so there is no second implementation.
 *
 * The resolved config crosses the boundary. In MCP and serve it comes from a data-only config, so
 * it contains no functions; RegExp values (compiled secret rules) are structured-cloneable.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { workerEntry } from "./generate-worker.js";

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");

(async () => {
  try {
    const mod = await import(workerData.entryUrl);
    const reviveMatch = (match) => {
      if (match && typeof match === "object" && typeof match.__functionSource === "string") {
        return new Function("return (" + match.__functionSource + ")")();
      }
      return match;
    };
    const reviveConfig = (config) => {
      if (config === null || config === undefined) return config;
      return {
        ...config,
        hooks: {},
        layers: (config.layers || []).map((rule) => ({ ...rule, match: reviveMatch(rule.match) })),
        kinds: (config.kinds || []).map((rule) => ({ ...rule, match: reviveMatch(rule.match) })),
      };
    };
    if (workerData.task === "validate") {
      parentPort.postMessage({ ok: true, result: mod.validateSnapshot(reviveConfig(workerData.config)) });
      return;
    }
    if (workerData.task === "health") {
      parentPort.postMessage({ ok: true, result: mod.auditSnapshot(workerData.options) });
      return;
    }
    if (workerData.task === "review") {
      parentPort.postMessage({
        ok: true,
        result: {
          validation: mod.validateSnapshot(reviveConfig(workerData.config)),
          report: mod.auditSnapshot(workerData.options),
        },
      });
      return;
    }
    if (workerData.task === "explain") {
      parentPort.postMessage({
        ok: true,
        result: mod.explainPath(reviveConfig(workerData.config), workerData.path),
      });
      return;
    }
    parentPort.postMessage({ ok: false, message: "unknown analysis task" });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      message: error && error.message ? error.message : String(error),
    });
  }
})();
`;

export type AnalysisTask =
  | { task: "validate"; config: unknown }
  | { task: "health"; options: unknown }
  | { task: "review"; config: unknown; options: unknown }
  | { task: "explain"; config: unknown; path: string };

export type AnalysisResult =
  | { ok: true; result: unknown }
  | { ok: false; message: string };

export function analysisInWorker(request: AnalysisTask): Promise<AnalysisResult> {
  return new Promise<AnalysisResult>((resolve) => {
    let settled = false;
    let worker: Worker | null = null;
    const finish = (result: AnalysisResult): void => {
      if (settled) return;
      settled = true;
      const terminated = worker === null ? Promise.resolve(undefined) : worker.terminate();
      void terminated.catch(() => undefined).then(() => resolve(result));
    };

    const isCjs = typeof __dirname !== "undefined";
    const directory = isCjs ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          entryUrl: workerEntry(directory, isCjs).url,
          ...request,
        },
      });
    } catch (error) {
      finish({
        ok: false,
        message:
          "Could not start the analysis worker: " +
          (error instanceof Error ? error.message : String(error)),
      });
      return;
    }
    worker.on("message", (message: AnalysisResult) => finish(message));
    worker.on("error", (error: Error) => finish({ ok: false, message: error.message }));
    worker.on("exit", (code: number) => {
      if (!settled) {
        finish({ ok: false, message: "The analysis worker exited (code " + code + ") without a result." });
      }
    });
  });
}
