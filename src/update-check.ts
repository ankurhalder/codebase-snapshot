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
import * as http from "node:http";
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

/** How the running copy of the tool was reached, which decides how to replace it. */
export type InstallKind = "global" | "local" | "npx";

/**
 * Classifies the script path Node is running.
 *
 * The notice used to tell everybody to run `npm install -g codebase-snapshot`, and that is wrong
 * for two of the three ways people run this. A repository that added it as a devDependency —
 * which is exactly what `setup` does — does not want a second global copy shadowing its pinned
 * one, and an `npx` invocation is a cache entry that the next `@latest` run replaces by itself.
 *
 * The path is the evidence, because it is available without asking npm anything: `_npx` is npm's
 * own cache directory name, and a local dependency lives under the project's `node_modules`.
 */
export function installKind(
  scriptPath: string = process.argv[1] ?? "",
  cwd: string = process.cwd()
): InstallKind {
  const normalise = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const script = normalise(scriptPath);
  if (script === "") return "global";
  // Windows paths are case-insensitive, so the comparison is too.
  const scriptKey = script.toLowerCase();
  if (scriptKey.includes("/_npx/")) return "npx";
  const root = normalise(cwd).toLowerCase();
  // `node_modules` under the working directory is a dependency of the project being worked in;
  // the same folder somewhere else is the global prefix's own storage, which is not.
  if (scriptKey.includes("/node_modules/") && root !== "" && scriptKey.startsWith(`${root}/`)) {
    return "local";
  }
  return "global";
}

/** The command that replaces this copy with the published latest. */
export function updateCommand(kind: InstallKind): string {
  if (kind === "npx") return "npx -y codebase-snapshot@latest";
  // npm rewrites the entry where it already is, so a devDependency stays a devDependency.
  if (kind === "local") return "npm install codebase-snapshot@latest";
  return "npm install -g codebase-snapshot";
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

/**
 * A version split into its numeric core and its prerelease tag.
 *
 * `0.9.13-alpha.1` sorts *below* `0.9.13`, which is what semver says and what the update notice has
 * to say too: stripping the tag made the check recommend an unstable prerelease to everyone on a
 * stable release, and hid a stable release from anyone running a beta.
 */
function parseSemver(value: string): { core: number[]; prerelease: string | null } {
  const cleaned = value.trim().replace(/^v/i, "").split("+")[0] ?? "";
  const dash = cleaned.indexOf("-");
  const corePart = dash === -1 ? cleaned : cleaned.slice(0, dash);
  const prerelease = dash === -1 ? null : cleaned.slice(dash + 1);
  const core = corePart.split(".").map((part) => {
    const parsed = Number(part);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return { core, prerelease };
}

/**
 * True when `candidate` is a version worth telling somebody about.
 *
 * A prerelease is never announced — being offered `1.0.0-rc.1` while running `0.9.12` is not an
 * upgrade, and a check that says so is wrong every time it fires. A stable release *is* newer than
 * the prerelease of itself, so somebody on `0.9.12-beta.1` is told about `0.9.12`.
 */
export function isNewer(candidate: string, current: string): boolean {
  const left = parseSemver(candidate);
  const right = parseSemver(current);
  if (left.prerelease !== null && right.prerelease === null) return false;
  const length = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.core[index] ?? 0;
    const b = right.core[index] ?? 0;
    if (a !== b) return a > b;
  }
  if (left.prerelease === null && right.prerelease !== null) return true;
  // Two prereleases of the same core are not ordered here: the notice exists to point at releases.
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
  // A JSON payload owns stdout, so the check is skipped when the output *format* is JSON —
  // and only then. Matching the substring "json" anywhere in argv meant
  // `snapshot explain package.json` and `snapshot diff a/manifest.json b/manifest.json`
  // never asked, even though both write plain text.
  //
  // The parser is last-wins, so this scan has to be as well. It used to `break` at the first
  // `--format`, which read `--format text --format json` as text (an unnecessary request and a
  // stray stderr line in machine-read mode) and `--format json --format text` as json (no notice
  // for a text run). `--` ends option parsing, exactly as it does for the CLI parser.
  let format: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--") break;
    if (argument === "--format") {
      format = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (argument.startsWith("--format=")) format = argument.slice("--format=".length);
  }
  if (format === "json") return false;

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

/**
 * One GET with a hard deadline. Resolves null for every failure.
 *
 * The deadline is a **wall clock**, not an idle-socket timeout. `request.setTimeout` only fires
 * when the socket goes quiet, so a slow or trickling proxy — one that sends a byte every second —
 * kept the CLI process alive long past `REQUEST_TIMEOUT_MS`. The timer below is absolute: when it
 * fires the request is destroyed and the answer is "could not determine", which is what the notice
 * already treats as "say nothing".
 *
 * The scheme picks the transport so the deadline can be exercised against a local server; the
 * default URL is https either way.
 */
export function fetchLatestVersion(
  url: string = PACKAGE_LATEST_URL,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let request: ReturnType<typeof https.get> | null = null;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };

    // `unref` so a pending update check never keeps the process alive on its own; the socket it is
    // waiting on keeps the loop alive for as long as there is one.
    const deadline = setTimeout(() => {
      request?.destroy();
      finish(null);
    }, timeoutMs);
    deadline.unref();

    const transport = url.startsWith("http:") ? http : https;
    request = transport.get(
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
            request?.destroy();
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
export function formatUpdateNotice(notice: UpdateNotice, kind: InstallKind): string {
  return (
    `↑ codebase-snapshot ${notice.latest} is available — you have ${notice.current}.\n` +
    `  ${updateCommand(kind)}`
  );
}
