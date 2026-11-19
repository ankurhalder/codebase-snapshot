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

/** Parses a dotted-quad without trusting `Number` to reject leading signs or spaces. */
function parseIPv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

/** Every IPv4 range that is not a public unicast destination. */
function isPrivateIPv4(octets: readonly number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && octets[2] === 0) ||
    (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

/**
 * Parses an IPv6 literal into eight 16-bit groups.
 *
 * `URL.hostname` keeps the brackets off, but it can still produce an IPv4-mapped address
 * (`::ffff:127.0.0.1`), a hex-compressed mapped address (`::ffff:7f00:1`), a zone id, or a
 * NAT64/6to4 form. String prefixes missed all of those, so the guard was one spelling away from
 * being bypassed.
 */
function parseIPv6(value: string): number[] | null {
  const withoutZone = value.split("%")[0] ?? value;
  if (!withoutZone.includes(":")) return null;
  const halves = withoutZone.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right = halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : [];
  const groups: string[] = [...left, ...right];
  if (halves.length === 1 && groups.length !== 8) return null;
  if (halves.length === 2 && groups.length > 7) return null;

  const expand = (group: string): string[] | null => {
    if (group.includes(".")) {
      const octets = parseIPv4(group);
      if (octets === null) return null;
      return [
        ((octets[0] << 8) | octets[1]).toString(16),
        ((octets[2] << 8) | octets[3]).toString(16),
      ];
    }
    return [group];
  };
  const expanded: string[] = [];
  for (const group of groups) {
    const next = expand(group);
    if (next === null) return null;
    expanded.push(...next);
  }
  if (halves.length === 1 && expanded.length !== 8) return null;
  if (halves.length === 2 && expanded.length > 8) return null;
  const missing = 8 - expanded.length;
  const full =
    halves.length === 2
      ? [...expanded.slice(0, left.length), ...Array<string>(missing).fill("0"), ...expanded.slice(left.length)]
      : expanded;
  if (full.length !== 8) return null;
  const numbers: number[] = [];
  for (const group of full) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    numbers.push(Number.parseInt(group, 16));
  }
  return numbers;
}

function isPrivateIPv6(groups: readonly number[]): boolean {
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = groups as [
    number, number, number, number, number, number, number, number,
  ];
  const allZeroThrough = (count: number): boolean => groups.slice(0, count).every((group) => group === 0);
  if (groups.every((group) => group === 0)) return true;
  if (allZeroThrough(7) && eighth === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && second === 0x0db8) return true; // documentation

  const mapped = (offset: number): boolean =>
    isPrivateIPv4([
      (groups[offset] as number) >> 8,
      (groups[offset] as number) & 0xff,
      (groups[offset + 1] as number) >> 8,
      (groups[offset + 1] as number) & 0xff,
    ]);

  // ::ffff:0:0/96, ::/96 (IPv4-compatible), and 64:ff9b::/96 (NAT64).
  if (allZeroThrough(5) && sixth === 0xffff) return mapped(6);
  if (allZeroThrough(6) && (seventh !== 0 || eighth !== 0)) return mapped(6);
  // RFC 2765 IPv4-translated: ::ffff:0:a.b.c.d. Its IPv4 address is in the last two groups,
  // after a zero sixth group, so the mapped check above does not see it.
  if (allZeroThrough(4) && fifth === 0xffff && sixth === 0) return mapped(6);
  if (first === 0x0064 && second === 0xff9b && third === 0 && fourth === 0 && fifth === 0 && sixth === 0) {
    return mapped(6);
  }
  // RFC 8215 local-use NAT64: 64:ff9b:1::/48. The public NAT64 prefix is the /96 checked above;
  // the local-use prefix is a separate /48 and was missed by the exact-prefix comparison.
  if (first === 0x0064 && second === 0xff9b && third === 0x0001) return mapped(6);
  // 2002::/16 embeds the public IPv4 address in groups 1 and 2 (6to4).
  if (first === 0x2002) return mapped(1);
  return false;
}

/** Hosts that are never a public repository, by literal form. DNS is checked separately. */
export function isPrivateHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local")) return true;
  if (value === "::1" || value === "0.0.0.0" || value === "::") return true;
  const ipv4 = parseIPv4(value);
  if (ipv4 !== null) return isPrivateIPv4(ipv4);
  const ipv6 = parseIPv6(value);
  if (ipv6 !== null) return isPrivateIPv6(ipv6);
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

/**
 * Hosts that may receive the ambient GitHub token.
 *
 * Scoping the header to the URL host only prevents cross-host leakage; it does not decide whether
 * the host is GitHub. A URL for attacker.example therefore received the runner GitHub token,
 * which is standard in CI and developer shells. The default is the public host; a GitHub
 * Enterprise deployment opts in explicitly with a comma-separated env var.
 */
function tokenHosts(): string[] {
  const configured = process.env.CODEBASE_SNAPSHOT_GITHUB_HOSTS;
  if (configured === undefined || configured.trim() === "") return ["github.com"];
  return configured
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** True when this host is allowed to receive the ambient GitHub token. */
export function tokenAllowedForHost(host: string): boolean {
  return tokenHosts().includes(host.toLowerCase().replace(/^\[|\]$/g, ""));
}

function gitEnvironment(token: string | null | undefined, host: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  if (token !== undefined && token !== null && token !== "") {
    // The header is passed through the environment, so the token never appears in argv (which
    // ps exposes) or in the provenance this function returns.
    const normalizedHost = host.toLowerCase().replace(/^\[|\]$/g, "");
    if (tokenAllowedForHost(normalizedHost)) {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.https://" + normalizedHost + "/.extraheader";
      env.GIT_CONFIG_VALUE_0 = "Authorization: Basic " + Buffer.from("x-access-token:" + token).toString("base64");
    }
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

  try {
  // A redirect is a second URL the public-host check never saw: a public HTTPS host could answer
  // 302 Location: http://169.254.169.254/ and git would follow it. The ref may also come from the
  // URL fragment, which the old code recorded in provenance but never passed to git.
  const ref = options.ref ?? source.ref;
  const args = [
    "-c", "http.followRedirects=false",
    ...(source.kind === "https" ? ["-c", "protocol.file.allow=never", "-c", "protocol.ssh.allow=never"] : []),
    "clone", "--depth", "1", "--single-branch", "--no-tags", "--quiet",
  ];
  if (ref !== undefined && ref !== null && ref !== "") {
    args.push("--branch", ref);
  }
  args.push(source.url, dest);

  log("clone: " + source.url + (ref ? " (" + ref + ")" : ""));
  const started = Date.now();
  const result = spawnSync("git", args, {
    env: {
      ...gitEnvironment(options.token, source.host === "file" ? "localhost" : source.host),
      ...(source.kind === "https" ? { GIT_ALLOW_PROTOCOL: "https" } : {}),
    },
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
      ref: ref !== undefined && ref !== null && ref !== "" ? ref : null,
      commit,
      fetchedAt: new Date().toISOString(),
    },
  };
  } catch (error) {
    // A failed shallow clone can still be hundreds of megabytes, and both callers treat a throw as
    // the end of the run. The directory was created by this function and was empty before it, so
    // deleting it on every failure is safe and is the only cleanup a caller would otherwise have
    // to remember.
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      // The clone failure is the one that explains the run; a cleanup error must not mask it.
    }
    throw error;
  }
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
