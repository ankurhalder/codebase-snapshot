/**
 * "A newer version is published."
 *
 * The tool's whole claim is that you can prove a thing is current, so it should answer that about
 * itself. The rules that make a network call acceptable in a tool advertised as offline-capable:
 *
 *  - **It is one GET to the npm registry and nothing else.** No query string, no telemetry, no
 *    identifier. The only thing the registry learns is that some machine ran this version.
 *  - **It never runs in CI, in a pipe, or in a JSON invocation**, and never in the MCP server,
 *    which documents that it makes no outbound connections. Those are the cases where a network
 *    call costs something and buys nothing.
 *  - **It cannot fail loudly.** Every error path returns null; a wrong clock, a captive portal or
 *    an air-gapped machine must never affect a command that would otherwise have worked.
 *  - **It is cached for a day**, so the cost is one request per machine per day at most.
 *
 * The request is started at the top of the command and awaited at the end, so on real work it
 * overlaps entirely and adds no wall time.
 */
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";

/** The one endpoint this package will ever request. */
export const PACKAGE_LATEST_URL = "https://registry.npmjs.org/codebase-snapshot/latest";

/** A result younger than this is trusted without asking again. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a *failed* check is remembered.
 *
 * Shorter than the success interval on purpose: one offline moment must not hide a release for a
 * day, and one hostile network must not cause a retry on every single run.
 */
export const FAILURE_INTERVAL_MS = 60 * 60 * 1000;

/** Bounds the whole request. A slow registry is not the user's problem. */
export const REQUEST_TIMEOUT_MS = 1200;

export interface UpdateNotice {
  current: string;
  latest: string;
}

export interface UpdateCheckOptions {
  current: string;
  /** Absolute path to the cache file. */
  cacheFile: string;
  /** Milliseconds since the epoch. Injectable so tests do not sleep. */
  now?: () => number;
  /** Returns the published version, or null when it could not be determined. */
  fetchLatest?: (url: string, timeoutMs: number) => Promise<string | null>;
  enabled?: boolean;
}

interface CacheEntry {
  checkedAt: number;
  latest: string | null;
}

/** Splits `1.2.3-beta.1` into `[1, 2, 3]`. A prerelease compares equal to its release. */
function versionParts(value: string): number[] {
  const core = value.trim().replace(/^v/i, "").split("-")[0];
  return core.split(".").map((part) => {
    const parsed = Number(part);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

/** True when `candidate` is a strictly higher release than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(current);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

/** The per-user cache directory, following each platform's convention. */
export function cacheDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "codebase-snapshot");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "codebase-snapshot");
  }
  const base = env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(base, "codebase-snapshot");
}

export function cacheFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDirectory(env), "update-check.json");
}

/**
 * Whether this invocation should ask at all.
 *
 * Conservative by design: anything it does not recognise as an interactive, human-facing run is
 * skipped. Being wrong in that direction costs a feature nobody sees; being wrong the other way
 * spends a CI job's network and pollutes a machine-readable stream.
 */
export function shouldCheck(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  const disabled = ["1", "true", "yes"].includes(
    String(env.CODEBASE_SNAPSHOT_NO_UPDATE_CHECK ?? "").toLowerCase()
  );
  if (disabled) return false;
  // CI is anonymous and unattended: the notice reaches no one and costs the owner minutes.
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "false" && env.CI !== "0") return false;

  const args = argv.map((argument) => argument.toLowerCase());
  if (args.includes("--no-update-check")) return false;
  // Commands that are not a human watching a terminal.
  for (const skip of ["mcp", "describe", "skill", "--version", "-v", "--help", "-h"]) {
    if (args.includes(skip)) return false;
  }
  // A JSON payload owns stdout; `json` anywhere in argv means we must not risk it.
  if (args.some((argument) => argument.includes("json"))) return false;

  return true;
}

function readCache(file: string): CacheEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // No cache yet is the normal first run.
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.checkedAt !== "number") return null;
    const latest = typeof candidate.latest === "string" ? candidate.latest : null;
    return { checkedAt: candidate.checkedAt, latest };
  } catch {
    // A corrupt cache is a cache miss, never an error.
    return null;
  }
}

function writeCache(file: string, entry: CacheEntry): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // A read-only cache directory means the check simply repeats next time.
  }
}

/** One HTTPS GET with a hard timeout. Resolves null for every failure. */
export function fetchLatestVersion(
  url: string = PACKAGE_LATEST_URL,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = https.get(
      url,
      {
        headers: {
          accept: "application/json",
          "user-agent": "codebase-snapshot (update check)",
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(null);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 64 * 1024) {
            request.destroy();
            finish(null);
          }
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { version?: unknown };
            finish(typeof parsed.version === "string" ? parsed.version : null);
          } catch {
            finish(null);
          }
        });
      }
    );

    request.on("error", () => finish(null));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(null);
    });
  });
}

/**
 * Returns a notice when a newer version is published, or null.
 *
 * Never throws: the caller runs this alongside a real command and must not be affected by it.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateNotice | null> {
  if (options.enabled === false) return null;
  const now = options.now ?? (() => Date.now());
  const fetchLatest = options.fetchLatest ?? fetchLatestVersion;

  let latest: string | null = null;

  try {
    const cached = readCache(options.cacheFile);
    let needsFetch = cached === null;

    if (cached) {
      const age = now() - cached.checkedAt;
      if (cached.latest === null) {
        // A remembered failure: retried on the shorter interval, never on every run.
        needsFetch = age >= FAILURE_INTERVAL_MS;
      } else {
        latest = cached.latest;
        needsFetch = age >= CHECK_INTERVAL_MS;
      }
    }

    if (needsFetch) {
      const fetched = await fetchLatest(PACKAGE_LATEST_URL, REQUEST_TIMEOUT_MS);
      writeCache(options.cacheFile, { checkedAt: now(), latest: fetched });
      latest = fetched;
    }
  } catch {
    // A check must never be the reason a command fails.
    return null;
  }

  if (!latest) return null;
  return isNewer(latest, options.current) ? { current: options.current, latest } : null;
}

/** The two lines a user sees, or an empty string when there is nothing to say. */
export function formatUpdateNotice(notice: UpdateNotice): string {
  return (
    `↑ codebase-snapshot ${notice.latest} is available — you have ${notice.current}.\n` +
    "  npm install -g codebase-snapshot"
  );
}
