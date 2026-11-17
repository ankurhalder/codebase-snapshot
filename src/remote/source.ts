import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { fileURLToPath } from "node:url";

/**
 * Remote ingestion.
 *
 * A snapshot is only as trustworthy as the thing it describes. Fetching a repository from a URL is
 * therefore a security boundary, not a convenience: the URL decides which machine this process
 * talks to. The rules here are the ones that keep a "paste a repo URL" box from becoming a way to
 * read a cloud metadata endpoint or a service on the local network.
 *
 *  - https only, and only for hosts that resolve to public addresses. Loopback, RFC1918,
 *    link-local (including 169.254.169.254), CGNAT, multicast and their v6 equivalents are
 *    refused unless --allow-private is given explicitly.
 *  - No userinfo in the URL. Credentials belong in GITHUB_TOKEN, which is passed to git through
 *    the environment, never through argv or a provenance record.
 *  - A shallow clone: depth 1, one branch, no tags, no submodules, no LFS. A snapshot needs the
 *    tree a reader would see, not the history.
 *  - The provenance records where it came from and which commit was fetched, so a snapshot can
 *    always be traced back.
 */

export interface RemoteSource {
  kind: "https" | "file";
  /** The URL as given, with any credentials removed (there are none by policy). */
  url: string;
  host: string;
  owner: string;
  repo: string;
  /** The ref in the URL, when it names one (#branch), else null. */
  ref: string | null;
}

export type ParsedSource = { ok: true; source: RemoteSource } | { ok: false; message: string };

const HOST_PATTERN = /^[a-z0-9.-]+$/i;

/** Hosts that are never a public repository, by literal form. DNS is checked separately. */
export function isPrivateHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local")) return true;
  if (value === "::1" || value === "0.0.0.0" || value === "::") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (value.startsWith("fe80")) return true;
  const parts = value.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
    const octets = parts.map(Number);
    if (octets.some((octet) => octet > 255)) return true;
    if (octets[0] === 127) return true;
    if (octets[0] === 10) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
    if (octets[0] === 0) return true;
  }
  return false;
}

export function parseRemoteSource(input: string, options: { allowPrivate?: boolean } = {}): ParsedSource {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, message: "the source is empty" };

  if (trimmed.startsWith("file:")) {
    if (options.allowPrivate !== true) {
      return {
        ok: false,
        message:
          "file: URLs are refused: a local path is not a remote, and reading files through a URL " +
          "bypasses the prompt that names a directory. Pass --allow-private if that is what you mean.",
      };
    }
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { ok: false, message: "not a URL: " + trimmed };
    }
    const directory = fileURLToPath(url);
    return {
      ok: true,
      source: { kind: "file", url: trimmed, host: "file", owner: "", repo: path.basename(directory), ref: null },
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: "not a URL: " + trimmed + " (expected https://host/owner/repo)" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, message: "only https URLs are accepted (received " + url.protocol + ")" };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      message: "URLs with credentials are refused; set GITHUB_TOKEN instead, which never reaches argv.",
    };
  }
  if (!HOST_PATTERN.test(url.hostname)) return { ok: false, message: "not a valid host: " + url.hostname };
  if (isPrivateHost(url.hostname) && options.allowPrivate !== true) {
    return {
      ok: false,
      message:
        url.hostname + " is a private address. A repository URL must not reach the machine or the " +
        "network it runs on. Pass --allow-private to override, deliberately.",
    };
  }
  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length < 2 || segments[0] === "" || segments[1] === "") {
    return { ok: false, message: "the URL must name a repository: https://host/owner/repo" };
  }
  const ref = url.hash.length > 1 ? url.hash.slice(1) : null;
  return {
    ok: true,
    source: {
      kind: "https",
      url: url.origin + url.pathname.replace(/\.git$/, "").replace(/\/$/, ""),
      host: url.hostname,
      owner: segments[0],
      repo: segments[1].replace(/\.git$/, ""),
      ref,
    },
  };
}

/** Every address a public host resolves to; refused when any is private. */
export async function assertPublicHost(host: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  if (isPrivateHost(host)) throw new Error(host + " is a private address");
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0) throw new Error(host + " did not resolve");
  for (const address of addresses) {
    if (isPrivateHost(address.address)) {
      throw new Error(host + " resolves to " + address.address + ", a private address");
    }
  }
}

export interface CloneOptions {
  dest: string;
  token?: string | null;
  ref?: string | null;
  allowPrivate?: boolean;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface CloneResult {
  directory: string;
  commit: string;
  provenance: {
    url: string;
    host: string;
    owner: string;
    repo: string;
    ref: string | null;
    commit: string;
    fetchedAt: string;
  };
}

function gitEnvironment(token: string | null | undefined, host: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  if (token !== undefined && token !== null && token !== "") {
    // The header is passed through the environment, so the token never appears in argv (which
    // `ps` exposes) or in the provenance this function returns.
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://" + host + "/.extraheader";
    env.GIT_CONFIG_VALUE_0 = "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64");
  }
  return env;
}

/**
 * Shallow-clones a repository into `dest`.
 *
 * `git` is the only tool this product invokes, and it is invoked as an argument array with no
 * shell. A clone that fails says which command failed and why; it never leaves a half directory
 * that a later run might mistake for a snapshot.
 */
export async function cloneRepository(source: RemoteSource, options: CloneOptions): Promise<CloneResult> {
  const log = options.log ?? (() => {});
  const dest = path.resolve(options.dest);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const args = ["clone", "--depth", "1", "--single-branch", "--no-tags", "--quiet"];
  if (options.ref !== undefined && options.ref !== null && options.ref !== "") {
    args.push("--branch", options.ref);
  }
  args.push(source.url, dest);

  log("clone: " + source.url + (options.ref ? " (" + options.ref + ")" : ""));
  const started = Date.now();
  const result = spawnSync("git", args, {
    env: gitEnvironment(options.token, source.host === "file" ? "localhost" : source.host),
    timeout: options.timeoutMs ?? 180_000,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error !== undefined && result.error !== null) {
    throw new Error("git clone could not run: " + result.error.message);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim().split("\n").slice(-3).join(" ");
    throw new Error("git clone failed (exit " + result.status + "): " + (detail || "no output"));
  }

  const head = spawnSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  const commit = head.status === 0 ? (head.stdout ?? "").trim() : "";
  if (commit === "") throw new Error("the clone has no HEAD; refusing to describe it");

  const bytes = directorySize(dest);
  log("clone: " + (bytes / 1024 / 1024).toFixed(1) + " MB in " + ((Date.now() - started) / 1000).toFixed(1) + "s");
  if (bytes > 1_000_000_000) {
    throw new Error("the clone is larger than 1 GB (" + Math.round(bytes / 1024 / 1024) + " MB); refusing to scan it");
  }

  return {
    directory: dest,
    commit,
    provenance: {
      url: source.url,
      host: source.host,
      owner: source.owner,
      repo: source.repo,
      ref: options.ref !== undefined && options.ref !== null && options.ref !== "" ? options.ref : source.ref,
      commit,
      fetchedAt: new Date().toISOString(),
    },
  };
}

/** Total bytes of regular files, used only to refuse an absurd clone. */
export function directorySize(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // A file that vanished mid-walk is not part of the clone any more.
        }
      }
    }
  }
  return total;
}

/** A temp directory for one clone, removed by the caller. */
export function makeCloneDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codebase-snapshot-clone-"));
}
