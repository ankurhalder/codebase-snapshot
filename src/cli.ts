import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { compareManifests, loadManifest, renderDiffText } from "./diff.js";
import { explainPath, renderExplainText } from "./explain.js";
import {
  ARTIFACT_NAMES,
  findConfigFile,
  loadConfigFileDetailed,
  parseByteSize,
  resolveConfig,
} from "./config.js";
import { runInit } from "./wizard/init.js";
import {
  firstRunMessage,
  hasPriorSnapshot,
  isEffectivelyEmpty,
  planFirstRun,
} from "./wizard/autopilot.js";
import { DEFAULT_ANSWERS } from "./wizard/config-template.js";
import { defaultIO, isInteractive, PromptCancelled } from "./wizard/prompts.js";
import {
  GENERATOR_NAME,
  GENERATOR_VERSION,
  MIN_MAX_PART_BYTES,
  MIN_MAX_PART_TOKENS,
  generateSnapshot,
} from "./index.js";
import {
  describeManifestShapeProblem,
  validateSnapshot,
} from "./validator/validate.js";
import { getPreset, unknownPresetMessage } from "./presets/index.js";
import { getGitInfo, isDiscoveryMode, type DiscoveryMode } from "./scanner/files.js";
import { buildAgentContract, renderContractText } from "./agent/contract.js";
import { runWithStdoutCapture } from "./stdout.js";
import { stripJsonComments } from "./ast/structured.js";

// Exported so the contract-completeness test can hold `describe` to the parser. A test that
// re-states the option list by hand cannot notice a flag the parser gained and the contract
// did not — which is exactly how the seven 0.9.10 flags went missing.
export { buildAgentContract } from "./agent/contract.js";
import type { SkillTarget } from "./agent/install-skill.js";
import { SKILL_TARGETS, installSkill, isSkillTarget } from "./agent/install-skill.js";
import { SKILL_NAME, renderSkill } from "./agent/skill.js";
import { runStdioServer } from "./mcp/index.js";
import { buildTools } from "./mcp/tools.js";
import { startHttpTransport } from "./mcp/http.js";
import { startWebServer } from "./web/server.js";
import { loadSigningKey, SIGNATURE_FILE } from "./signing.js";
import { assertPublicHost, cloneRepository, makeCloneDirectory, parseRemoteSource } from "./remote/source.js";
import {
  cacheFilePath,
  checkForUpdate,
  formatUpdateNotice,
  installKind,
  isNewer,
  resolveLatest,
  shouldCheck,
  updateCommand,
} from "./update-check.js";
import { installPreCommitHook } from "./agent/hook.js";
import type { CommandName } from "./agent/option-scope.js";
import { COMMAND_OPTION_SCOPE, commandsForOption } from "./agent/option-scope.js";
import type {
  CliOptions,
  Manifest,
  Mode,
  OutputFormat,
  PromptTask,
  ResolvedSnapshotConfig,
} from "./types.js";
import { auditSnapshot, type HealthReport } from "./auditor/health.js";
import { escapeControls, formatNumber } from "./terminal.js";

const VERSION = GENERATOR_VERSION;

/** How long `setup` waits for the dependency install before reporting it as failed. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

type Command =
  | "generate"
  | "validate"
  | "health"
  | "report"
  | "init"
  | "setup"
  | "explain"
  | "diff"
  | "describe"
  | "skill"
  | "mcp"
  | "update"
  | "serve";

const COMMAND_ALIASES = new Map<string, Command>([
  ["generate", "generate"],
  ["validate", "validate"],
  ["check", "validate"],
  ["health", "health"],
  ["report", "report"],
  ["init", "init"],
  ["setup", "setup"],
  ["explain", "explain"],
  ["diff", "diff"],
  ["describe", "describe"],
  ["skill", "skill"],
  ["mcp", "mcp"],
  ["update", "update"],
  ["serve", "serve"],
]);

/** How many positional arguments each command accepts after its name. */
const COMMAND_ARITY: Record<Command, number> = {
  generate: 0,
  validate: 0,
  health: 0,
  report: 0,
  init: 0,
  setup: 0,
  explain: 1,
  diff: 2,
  describe: 0,
  skill: 0,
  mcp: 0,
  update: 0,
  serve: 0,
};

export const CLI_OPTIONS = {
  cwd: { type: "string" },
  "out-dir": { type: "string" },
  "max-part-bytes": { type: "string" },
  "large-file-bytes": { type: "string" },
  "max-monolith-bytes": { type: "string" },
  "attachment-slots": { type: "string" },
  "max-parts": { type: "string" },
  brief: { type: "string" },
  "prompt-task": { type: "string" },
  "include-monolith": { type: "boolean" },
  "include-sensitive-files": { type: "boolean" },
  "skip-artifacts": { type: "string" },
  "only-artifacts": { type: "string" },
  format: { type: "string" },
  mode: { type: "string" },
  "dry-run": { type: "boolean" },
  watch: { type: "boolean" },
  "no-config": { type: "boolean" },
  discovery: { type: "string" },
  "max-part-tokens": { type: "string" },
  preset: { type: "string" },
  include: { type: "string" },
  exclude: { type: "string" },
  yes: { type: "boolean" },
  force: { type: "boolean" },
  autopilot: { type: "boolean" },
  install: { type: "boolean" },
  "no-install": { type: "boolean" },
  target: { type: "string" },
  "no-update-check": { type: "boolean" },
  "install-hook": { type: "boolean" },
  "changed-since": { type: "string" },
  "with-dependents": { type: "boolean" },
  staged: { type: "boolean" },
  skeleton: { type: "boolean" },
  sarif: { type: "boolean" },
  strict: { type: "boolean" },
  http: { type: "boolean" },
  port: { type: "string" },
  host: { type: "string" },
  token: { type: "string" },
  "no-auth": { type: "boolean" },
  "allow-origin": { type: "string" },
  remote: { type: "string" },
  ref: { type: "string" },
  "allow-private": { type: "boolean" },
  "keep-clone": { type: "boolean" },
  "include-diffs": { type: "boolean" },
  "include-logs": { type: "string" },
  "token-tree": { type: "boolean" },
  delta: { type: "string" },
  slice: { type: "string" },
  "slice-tokens": { type: "string" },
  pack: { type: "string" },
  sign: { type: "boolean" },
  "budget-tokens": { type: "string" },
  workspace: { type: "string" },
  "strip-comments": { type: "boolean" },
  "remove-empty-lines": { type: "boolean" },
  only: { type: "string" },
  ignore: { type: "string" },
  "all-members": { type: "boolean" },
  deep: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

/** A user-input problem: printed without a stack trace, exits 2. */
export class UsageError extends Error {}

const USAGE = `
${GENERATOR_NAME} v${VERSION}
Production-grade LLM codebase snapshot generator, auditor, and AST partitioner

Usage:
  codebase-snapshot [command] [options]

First run:
  codebase-snapshot                No config yet: asks once, sets the project up, generates.
                                   A configured project just generates. It never falls back
                                   to defaults it was not given.
  codebase-snapshot --autopilot    The same without questions: detect the preset, write the
                                   config, add the npm scripts and devDependency, install,
                                   then generate.

Commands:
  setup                Everything at once: config, scripts, dependency, install, generate
  generate (default)   Generate a complete partitioned codebase snapshot
  validate, check      Validate snapshot integrity and check for drift
  health               Audit a snapshot for leaks, lies and wasted tokens (--strict, --format json)
  init                 Generate a starter snapshot.config file
  report               Print codebase health, layer metrics, and secret audit
  explain <path>       Show how one path would be treated: layer, kind, part, skips
  diff <a> <b>         Compare two snapshots (directories or manifest.json files)
  describe             Print the machine-readable contract (--format json for agents)
  update               Ask the registry whether a newer release exists (exit 1 if one does)
  skill                Print the bundled agent skill; --install writes it into the repo
  mcp                  Serve this repository to an MCP client (stdio, or --http for the web)
  serve                Open a browser UI: generate, preview, download a zip; MCP at /mcp

Options:
  --cwd <path>                  Target repository directory (default: current directory)
  --out-dir <path>              Snapshot output directory (default: snapshot)
  --include-monolith            Also generate full-codebase.json and full-codebase.md
  --max-monolith-bytes <n>      Skip monolith artefacts larger than n bytes
  --max-part-bytes <n>          Maximum byte budget per markdown part (default: 307200).
                                Accepts units: 120k, 1.5mb
  --max-part-tokens <n>         Per-part budget in tokens; narrows --max-part-bytes
  --large-file-bytes <n>        Preview threshold (default: the part budget; never above it)
  --changed-since <ref>         Only files changed since this git ref, plus untracked ones
  --staged                      Only files staged for the next commit
  --with-dependents             With the two above: also include their importers
  --skeleton                    Emit TypeScript signatures instead of bodies
  --sarif                       Also write reports/audit.sarif for GitHub Code Scanning
  --include-sensitive-files     Emit .env / *.pem / .npmrc / credential files
  --attachment-slots <n>        Files the destination takes in one message (default: 10,
                                0 = no limit); PROMPT.md plans the delivery to fit
  --max-parts <n>               Experimental: grow the part budget until the snapshot has at
                                most n parts, instead of adding parts as the code grows
  --slice <question>            Keep only what the planner picks for this question
  --slice-tokens <n>            Budget for --slice (default 30000)
  --delta <path>                Only what changed since this snapshot (plus its importers)
  --sign                        Sign manifest.json (ed25519; SNAPSHOT_SIGNING_KEY or a fresh key)
  --budget-tokens <n>           Fit the snapshot into n tokens, highest value per token first
  --workspace <a,b>             One snapshot per member, plus WORKSPACE.json
  --strip-comments              Remove comment text from JS/TS bodies (line numbers preserved)
  --pack <single|xml|json>      Also write one full-repository file in that shape
  --include-diffs               Write reports/diff.md from the uncommitted diff
  --include-logs <n>            Write reports/log.md with the last n commits (1-500)
  --token-tree                  Write reports/tokens.md with per-file token estimates
  --brief <path>                Owner-written half of PROMPT.md (stakes, system, history,
                                bar, calibration); merged at fixed slots
  --prompt-task <task>          audit | review | explain - which job the brief is for
  --skip-artifacts <names>      Comma-separated artifacts to omit
                                (readme, manifest, parts, navigation,
                                 projectTree, audit, monolith)
  --only-artifacts <names>      Write *only* these artifacts
  --format <text|json>          CLI output format (default: text)
  --dry-run                     Compute the snapshot without writing anything
  --watch                       Re-generate whenever the repository changes
  --no-config                   Ignore snapshot.config.* and use the built-in defaults
  --discovery <mode>            auto | git | walk — how files are discovered.
                                auto: git when usable. git: require git. walk: read
                                .gitignore directly (escape hatch for a broken .git)

  mcp --http:
  --port <n>                    Port to bind (default 4789; 0 picks a free one)
  --host <addr>                 Bind address (default 127.0.0.1). Non-loopback requires a token
  --token <value>               Bearer token clients must send (generated per run by default)
  --no-auth                     Accept unauthenticated requests; refused on a non-loopback bind
  --allow-origin <origins>      Extra CORS origins, comma-separated (loopback always allowed)

  generate only:
  --autopilot                   Set the project up without asking, then generate: write the
                                config and .gitignore, add the npm scripts and devDependency,
                                and install with the project's own package manager.
  --no-install                  With --autopilot: skip the dependency install.

  init only:
  --preset <name>               Force a project preset instead of detecting one
  --include <globs>             Comma-separated allow-list
  --exclude <globs>             Comma-separated exclude patterns
  --yes                         Accept every default without prompting
  --force                       Overwrite an existing config
  --install-hook                Write .git/hooks/pre-commit so a stale snapshot cannot be
                                committed. An existing hook is never replaced.

  setup only:
  --no-install                  Skip installing the dependency before generating
  --install-hook                As for init
  --preset / --include / --exclude / --force   As for init

  health only:
  --strict                      Treat warnings as failures (exit 2 on a critical failure)
  --all-members                 Audit every snapshot a --workspace run wrote
  --deep                        Replay every full body against the source on disk

  skill only:
  --install                     Write the skill into the repository instead of printing
  --target <name>               claude | cursor | all (default: all)

  --no-update-check             Skip the check for a newer published version

  -h, --help                    Display this help message
  -v, --version                 Display version

All value-taking options also accept the --option=value form.
Human-readable progress is written to stderr; payloads (--format json) go to stdout.
Agents with no prior knowledge of this tool should start with: describe --format json
`.trim();

interface ParsedInvocation {
  command: Command;
  /**
   * True when the command was named on the command line rather than defaulted to.
   *
   * `snapshot` alone is the guided entry point: in an unconfigured project it sets the
   * project up. `snapshot generate` names the command, which means "do exactly this" — and
   * that path keeps behaving as it always has, on the built-in defaults.
   */
  explicitCommand: boolean;
  /** Positional arguments that follow the command name. */
  args: string[];
  format: OutputFormat;
  dryRun: boolean;
  watch: boolean;
  /** Ignore any config file and run on the built-in defaults. */
  noConfig: boolean;
  preset?: string;
  /** The size exactly as typed, so the generated config can keep `120k`. */
  maxPartBytesRaw?: string;
  include?: string;
  exclude?: string;
  yes: boolean;
  force: boolean;
  /** `generate` only: set the project up without prompting, then generate. */
  autopilot: boolean;
  /** `setup` only: skip the dependency install. */
  noInstall: boolean;
  /** `skill` only: write the skill into the repository instead of printing it. */
  install: boolean;
  /** `skill` only: which location(s) to write. */
  target?: string;
  cwd: string;
  outDir?: string;
  includeMonolith?: boolean;
  includeSensitiveFiles?: boolean;
  maxPartBytes?: number;
  /** A per-part ceiling in tokens; resolved into `maxPartBytes` by `resolveConfig`. */
  maxPartTokens?: number;
  largeFileBytes?: number;
  maxMonolithBytes?: number | null;
  /** `--attachment-slots`: files the destination accepts in one message, 0 for no limit. */
  attachmentSlots?: number;
  /** `--max-parts`: the experimental part-count ceiling. */
  maxParts?: number;
  /** `--brief`: path to the owner-written half of the brief. */
  brief?: string;
  /** `--prompt-task`: audit, review or explain. */
  promptTask?: PromptTask;
  skipArtifacts?: string[];
  /**
   * The artifacts named by `--only-artifacts`, kept separately from the derived
   * `skipArtifacts`.
   *
   * `--only-artifacts monolith` means "the six others off, the monolith on", which cannot
   * be expressed by `skipArtifacts` alone: the monolith is off by default, so turning the
   * others off left *everything* off and `init`/`setup` wrote a config that generated
   * nothing. The wizard resolves this list itself.
   */
  onlyArtifacts?: string[];
  /** How candidates are discovered; `auto` when unset. */
  discovery?: DiscoveryMode;
  /** The user asked not to be told about newer releases. */
  noUpdateCheck?: boolean;
  /** `init` and `setup` only: write a pre-commit hook that gates on `validate`. */
  installHook?: boolean;
  /** Only files changed since this git ref. */
  changedSince?: string;
  /** Only files staged for the next commit. */
  staged?: boolean;
  /** With the two above: also include the files that import a changed one. */
  withDependents?: boolean;
  /** Emit signatures instead of bodies for TypeScript and TSX. */
  skeleton?: boolean;
  /** Also write reports/audit.sarif for a CI security gate. */
  sarif?: boolean;
  /** `health`: treat warnings as failures and exit 2 on a critical check. */
  strict?: boolean;
  /** `mcp`: serve over HTTP instead of stdio. */
  http?: boolean;
  port?: number;
  host?: string;
  token?: string | null;
  noAuth?: boolean;
  allowOrigins?: string[];
  /** `generate`: fetch this repository instead of scanning the current directory. */
  remote?: string;
  /** `--remote`: branch or tag to clone. */
  ref?: string;
  /** `--remote`: allow private addresses and file: URLs. */
  allowPrivate?: boolean;
  /** `--remote`: keep the clone after the run. */
  keepClone?: boolean;
  /** `--include-diffs`: write reports/diff.md. */
  includeDiffs?: boolean;
  /** `--include-logs <n>`: write reports/log.md with the last n commits. */
  includeLogs?: number;
  /** `--token-tree`: write reports/tokens.md. */
  tokenTree?: boolean;
  /** `--delta`: base snapshot directory or manifest.json. */
  delta?: string;
  /** `--slice`: the question the snapshot is narrowed for. */
  slice?: string;
  /** `--slice-tokens`: the budget the slice is planned within. */
  sliceTokens?: number;
  /** `--pack`: single | xml | json. */
  pack?: "single" | "xml" | "json";
  /** `--sign`: sign the manifest with Ed25519. */
  sign?: boolean;
  /** `--budget-tokens`: fit the snapshot into this token budget. */
  budgetTokens?: number;
  /** `--workspace`: comma-separated members, one snapshot each plus WORKSPACE.json. */
  workspace?: string;
  /** `--strip-comments`: remove comment text from JS/TS bodies. */
  stripComments?: boolean;
  /** `--remove-empty-lines`: drop blank lines from emitted bodies (line numbers move). */
  removeEmptyLines?: boolean;
  /** `--only <globs>`: override the include allow-list for this run. */
  only?: string[];
  /** `--ignore <globs>`: add to the exclude list for this run. */
  ignore?: string[];
  /** `--all-members` (health): audit every snapshot a `--workspace` run wrote. */
  allMembers?: boolean;
  /** `health`: replay every full body against the source on disk. */
  deep?: boolean;
}

export function parsePositiveInteger(
  raw: string | undefined,
  optionName: string,
  minimum: number
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new UsageError(`--${optionName} expects a whole number, received "${raw}".`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new UsageError(`--${optionName} must be at least ${minimum}, received "${raw}".`);
  }
  return value;
}

/**
 * Parses a byte-budget option, accepting human-readable units (`120k`, `1.5mb`)
 * as well as raw byte counts.
 */
export function parseByteOption(
  raw: string | undefined,
  optionName: string,
  minimum: number,
  unit = "byte count"
): number | undefined {
  if (raw === undefined) return undefined;
  const value = parseByteSize(raw);
  if (value === undefined || !Number.isSafeInteger(value)) {
    throw new UsageError(
      `--${optionName} expects a ${unit} such as 120000 or "120k", received "${raw}".`
    );
  }
  if (value < minimum) {
    throw new UsageError(`--${optionName} must be at least ${minimum}, received "${raw}".`);
  }
  return value;
}

/** Parses a TCP port, where 0 is the documented "pick an ephemeral port" value. */
export function parsePort(raw: string | undefined): number | undefined {
  const value = parsePositiveInteger(raw, "port", 0);
  if (value !== undefined && value > 65535) {
    throw new UsageError(`--port must be at most 65535, received "${raw}".`);
  }
  return value;
}

/**
 * Parses a whole-number option such as `--attachment-slots 20`.
 *
 * Not `parseByteOption`: "20" here means twenty files, and a size suffix would be meaningless.
 * `0` is meaningful — it says the destination imposes no limit — so the floor is zero rather
 * than one, and a negative or fractional value is refused instead of rounded.
 */
export function parseCountOption(
  raw: string | undefined,
  optionName: string,
  minimum = 0
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    throw new UsageError(
      `--${optionName} expects a whole number such as 10 or 20, received "${raw}".`
    );
  }
  const value = Number(trimmed);
  if (value < minimum) {
    throw new UsageError(`--${optionName} must be at least ${minimum}, received "${raw}".`);
  }
  return value;
}

/** `--prompt-task`: an unknown job is a usage error, never a silent default. */
function parsePromptTask(value: string | undefined): PromptTask | undefined {
  if (value === undefined) return undefined;
  if (value === "audit" || value === "review" || value === "explain") return value;
  throw new UsageError(
    '--prompt-task expects audit, review or explain, received "' + value + '".'
  );
}

/** Parses and validates a comma-separated artifact list. */
function parseArtifactList(raw: string, flag: string): string[] {
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    throw new UsageError(
      `${flag} expects at least one artifact name (${ARTIFACT_NAMES.join(", ")}).`
    );
  }
  const unknown = names.filter((name) => !(ARTIFACT_NAMES as ReadonlyArray<string>).includes(name));
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown artifact(s): ${unknown.join(", ")}. Expected one of: ${ARTIFACT_NAMES.join(", ")}.`
    );
  }
  return names;
}

/** Short flags this CLI actually has, e.g. `-v` and `-h`. */
const SHORT_FLAGS: ReadonlySet<string> = new Set(
  Object.values(CLI_OPTIONS)
    .map((spec) => (spec as { short?: string }).short)
    .filter((short): short is string => typeof short === "string")
    .map((short) => `-${short}`)
);

/**
 * The first token that writes a long option with one dash, e.g. `-version`.
 *
 * `parseArgs` reads that as the short-flag cluster `-v -e -r -s -i -o -n` and reports
 * `Unknown option '-e'` — naming a character the caller never typed, and burying the real mistake.
 * A developer who types `-version` is trying to ask for the version; that deserves to be answered
 * rather than parsed.
 *
 * A cluster of short flags that do exist (`-vh`) is legitimate and returns null.
 */
function misdashedLongOption(argv: readonly string[]): string | null {
  for (const token of argv) {
    if (token === "--") break;
    // `-v` is two characters and fine; this needs a dash, a letter and at least one more character.
    if (!/^-[A-Za-z][A-Za-z0-9-]+$/.test(token)) continue;
    if ([...token.slice(1)].every((character) => SHORT_FLAGS.has(`-${character}`))) continue;
    return token;
  }
  return null;
}

/**
 * Parses argv.
 *
 * Uses `node:util.parseArgs` in strict mode, so `--option=value` works, unknown
 * flags are rejected instead of silently ignored, and a typo can no longer fall
 * through to the writable `generate` command.
 */
export function parseCliArgs(argv: string[]): ParsedInvocation {
  const misdashed = misdashedLongOption(argv);
  if (misdashed !== null) {
    const long = `--${misdashed.slice(1)}`;
    const known = Object.prototype.hasOwnProperty.call(CLI_OPTIONS, misdashed.slice(1));
    throw new UsageError(
      known
        ? `Unknown option '${misdashed}'. Options start with two dashes — did you mean '${long}'?`
        : `Unknown option '${misdashed}'. Options start with two dashes; if '${misdashed}' is a ` +
            `path or an argument, put it after '--'.`
    );
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    // Repeated value options follow Node parseArgs' last-wins rule; repeated boolean flags are
    // idempotent. This is intentional and deliberately not rejected as a usage error.
    parsed = parseArgs({
      args: argv,
      options: CLI_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    const message = (err as Error).message;

    // `--max-part-bytes -5` reads as an ambiguous option to the parser, which
    // then talks about `=--XYZ`. Say what actually happened instead.
    const ambiguous = /^Option '(--[^']+)' argument is ambiguous/i.exec(message);
    if (ambiguous) {
      throw new UsageError(
        `${ambiguous[1]} received a value that looks like another flag (for example a ` +
          `negative number). Use the "--option=value" form, and note that sizes must be positive.`
      );
    }
    throw new UsageError(message);
  }

  const values = parsed.values as Record<string, string | boolean | undefined>;

  // An unset shell variable expands to "", which used to be accepted as "use the
  // default" — `--out-dir "$UNSET"` silently wrote to ./snapshot instead of
  // failing. Every string option now requires a real value.
  for (const [name, spec] of Object.entries(CLI_OPTIONS)) {
    if (spec.type !== "string") continue;
    const raw = values[name];
    if (raw !== undefined && String(raw).trim() === "") {
      throw new UsageError(`--${name} requires a value (received an empty string).`);
    }
  }

  // A bad path is a usage error (exit 2), not a generation failure, so check it
  // here rather than letting resolveConfig fail later with exit 1.
  if (values.cwd !== undefined) {
    const target = String(values.cwd);
    if (!fs.existsSync(target)) {
      throw new UsageError(`--cwd directory does not exist: ${target}`);
    }
    if (!fs.statSync(target).isDirectory()) {
      throw new UsageError(`--cwd is not a directory: ${target}`);
    }
  }

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    throw new HelpRequested();
  }
  if (values.version) {
    process.stdout.write(`v${VERSION}\n`);
    throw new HelpRequested();
  }

  const positionals = parsed.positionals;
  let command: Command = "generate";
  let args: string[] = [];

  const explicitMode = values.mode ? String(values.mode) : undefined;
  const firstPositional = positionals[0];

  // `--mode` names the command, so with it the positionals are that command's arguments rather
  // than a command word to resolve. Resolving them first made `--mode explain src/a.ts` answer
  // `Unknown command "src/a.ts"`, which left the documented `--mode` form of the two commands
  // that take positionals (`explain`, `diff`) unable to run at all. A positional that *is* a
  // different command is still the contradiction the error below reports; one that aliases the
  // same command (`--mode validate check`) is accepted.
  const modeCommand = explicitMode === undefined ? undefined : COMMAND_ALIASES.get(explicitMode);
  if (explicitMode !== undefined && modeCommand === undefined) {
    throw new UsageError(
      `Unknown --mode "${explicitMode}". Expected one of: ${Array.from(COMMAND_ALIASES.keys()).join(", ")}.`
    );
  }
  if (modeCommand !== undefined) {
    command = modeCommand;
    if (firstPositional !== undefined) {
      const named = COMMAND_ALIASES.get(firstPositional);
      if (named !== undefined && named !== modeCommand) {
        throw new UsageError(
          `--mode ${explicitMode} contradicts the command "${firstPositional}". Pass one or the other.`
        );
      }
      args = named !== undefined ? positionals.slice(1) : positionals;
    }
  } else if (firstPositional !== undefined) {
    const resolved = COMMAND_ALIASES.get(firstPositional);
    if (!resolved) {
      throw new UsageError(
        `Unknown command "${firstPositional}". Expected one of: ${Array.from(COMMAND_ALIASES.keys()).join(", ")}.`
      );
    }
    command = resolved;
    args = positionals.slice(1);
  }
  const expectedArgs = COMMAND_ARITY[command];
  if (args.length !== expectedArgs) {
    if (command === "explain") {
      throw new UsageError("explain expects exactly one path.");
    }
    if (command === "diff") {
      throw new UsageError(
        "diff expects exactly two arguments: two snapshot directories or manifest.json files."
      );
    }
    throw new UsageError(
      `Unexpected argument(s): ${args.join(" ")}. ${command} takes no positional arguments.`
    );
  }

  const rawFormat = values.format === undefined ? "text" : String(values.format);
  if (rawFormat !== "text" && rawFormat !== "json") {
    throw new UsageError(`--format must be "text" or "json", received "${rawFormat}".`);
  }

  // An unusable discovery mode is a usage error naming the three valid values:
  // silently falling back to `auto` would turn the escape hatch into a no-op for
  // exactly the user who needs it.
  const rawDiscovery = values.discovery === undefined ? undefined : String(values.discovery);
  if (rawDiscovery !== undefined && !isDiscoveryMode(rawDiscovery)) {
    throw new UsageError(
      `--discovery must be one of: auto, git, walk (received "${rawDiscovery}").`
    );
  }

  let onlyNamesMonolith = false;
  const rawSkip = values["skip-artifacts"];
  const rawOnly = values["only-artifacts"];
  if (rawSkip !== undefined && rawOnly !== undefined) {
    throw new UsageError("--skip-artifacts and --only-artifacts cannot be combined.");
  }
  let skipArtifacts: string[] | undefined;
  let onlyArtifacts: string[] | undefined;
  if (rawOnly !== undefined) {
    const keep = parseArtifactList(String(rawOnly), "--only-artifacts");
    onlyArtifacts = keep;
    // Asking to write only the monolith used to write nothing at all: the artifact was
    // not enabled, so it was skipped like everything else. Naming it enables it.
    onlyNamesMonolith = keep.includes("monolith");
    skipArtifacts = (ARTIFACT_NAMES as ReadonlyArray<string>).filter(
      (name) => !keep.includes(name)
    );
  } else if (rawSkip !== undefined) {
    skipArtifacts = parseArtifactList(String(rawSkip), "--skip-artifacts");
  }

  // Reject every option that has no effect for this command. A flag that parses
  // but changes nothing is the command-line form of a silent fallback: the user
  // believes the override applied and the run used the default. The scope table
  // is the same one `describe` publishes as `appliesTo`, so the contract and the
  // parser cannot disagree.
  const scope = COMMAND_OPTION_SCOPE[command as CommandName];
  const ignored: string[] = [];
  for (const name of Object.keys(CLI_OPTIONS)) {
    if (scope.includes(name)) continue;
    const value = values[name];
    if (value === undefined || value === false) continue;
    ignored.push(`--${name}`);
  }
  if (ignored.length > 0) {
    const owners = Array.from(
      new Set(
        ignored.flatMap((flag) =>
          commandsForOption(flag.replace(/^--/, "")).map((owner) => `\`${owner}\``)
        )
      )
    );
    // `generate --autopilot` runs the setup wizard in non-interactive mode, and the setup flags
    // it cannot take are the ones a user is most likely to try. Name the reason instead of
    // listing what they could have typed elsewhere.
    const setupOnly = ["--preset", "--include", "--exclude", "--install-hook"];
    const autopilotChose = values.autopilot === true && ignored.some((flag) => setupOnly.includes(flag));
    const hint = autopilotChose
      ? " --autopilot chooses the preset and takes none of these: name them with `setup` (or `init`) instead."
      : ignored.some((flag) => ["--preset", "--include", "--exclude"].includes(flag))
        ? " To scope a run, set include/excludePatterns/preset in snapshot.config.ts " +
          "(or run `codebase-snapshot init` to generate one)."
        : "";
    throw new UsageError(
      `${ignored.join(", ")} ${ignored.length === 1 ? "does" : "do"} not apply to \`${command}\` and ` +
        `${ignored.length === 1 ? "was" : "were"} not applied. ${ignored.length === 1 ? "It is" : "They are"} ` +
        `accepted by: ${owners.join(", ")}.${hint}`
    );
  }

  // `init --preset <typo>` used to fall back to detection and write a config for
  // a preset nobody asked for, while still exiting 0. The docs promise a usage
  // error listing every valid preset, so validate the name here (exit 2) rather
  // than letting it surface later as a generic failure.
  //
  // `setup` takes `--preset` too and had no check here at all, so a typo there fell through to
  // `runInit` and surfaced as an ordinary error — exit 1, no list of valid presets, and two
  // commands documenting the same flag that answered a bad value differently.
  if ((command === "init" || command === "setup") && values.preset !== undefined) {
    const requested = String(values.preset);
    if (!getPreset(requested)) throw new UsageError(unknownPresetMessage(requested));
  }

  if (command === "skill" && values.target !== undefined && !isSkillTarget(String(values.target))) {
    throw new UsageError(
      `--target must be one of: ${SKILL_TARGETS.join(", ")} (received "${String(values.target)}").`
    );
  }

  // `--no-install` is the one part of the setup a run can opt out of, and it only means
  // something while `--autopilot` is setting that setup up. Accepting it on a plain
  // `generate` would be a flag that parses and changes nothing.
  if (
    values["no-install"] === true &&
    command === "generate" &&
    values.autopilot !== true
  ) {
    throw new UsageError("--no-install only applies to `setup`, or to `generate --autopilot`.");
  }

  // `--autopilot` writes a config; `--no-config` promises to ignore configs. Honouring one
  // means silently dropping the other, so the pair is a contradiction rather than a tie.
  if (values.autopilot === true && values["no-config"] === true) {
    throw new UsageError(
      "--autopilot sets a project up and writes a config; --no-config ignores config files. " +
        "Pass one or the other."
    );
  }

  return {
    command,
    explicitCommand: firstPositional !== undefined || explicitMode !== undefined,
    args,
    format: rawFormat as OutputFormat,
    dryRun: values["dry-run"] === true,
    watch: values.watch === true,
    noConfig: values["no-config"] === true,
    preset: values.preset === undefined ? undefined : String(values.preset),
    maxPartBytesRaw:
      values["max-part-bytes"] === undefined ? undefined : String(values["max-part-bytes"]),
    include: values.include === undefined ? undefined : String(values.include),
    exclude: values.exclude === undefined ? undefined : String(values.exclude),
    yes: values.yes === true,
    force: values.force === true,
    autopilot: values.autopilot === true,
    install: values.install === true,
    noInstall: values["no-install"] === true,
    target: values.target === undefined ? undefined : String(values.target),
    cwd: values.cwd === undefined ? process.cwd() : path.resolve(String(values.cwd)),
    outDir: values["out-dir"] === undefined ? undefined : String(values["out-dir"]),
    includeMonolith:
      values["include-monolith"] === true || onlyNamesMonolith === true ? true : undefined,
    includeSensitiveFiles: values["include-sensitive-files"] === true ? true : undefined,
    maxPartBytes: parseByteOption(
      values["max-part-bytes"] as string | undefined,
      "max-part-bytes",
      MIN_MAX_PART_BYTES
    ),
    // Tokens are counted, so `32k` is a shorthand a context window is often named with; the
    // same parser accepts a bare integer. The floor is the byte floor rewritten in tokens —
    // clamping a smaller budget up to it accepted the flag and then applied a different number.
    maxPartTokens: parseByteOption(
      values["max-part-tokens"] as string | undefined,
      "max-part-tokens",
      MIN_MAX_PART_TOKENS,
      "token count"
    ),
    largeFileBytes: parseByteOption(
      values["large-file-bytes"] as string | undefined,
      "large-file-bytes",
      1
    ),
    maxMonolithBytes: parseByteOption(
      values["max-monolith-bytes"] as string | undefined,
      "max-monolith-bytes",
      1
    ),
    attachmentSlots: parseCountOption(
      values["attachment-slots"] as string | undefined,
      "attachment-slots"
    ),
    maxParts: parseCountOption(values["max-parts"] as string | undefined, "max-parts", 1),
    brief: values.brief === undefined ? undefined : String(values.brief as string | boolean),
    promptTask: parsePromptTask(values["prompt-task"] as string | undefined),
    skipArtifacts,
    onlyArtifacts,
    discovery: isDiscoveryMode(rawDiscovery) ? rawDiscovery : undefined,
    noUpdateCheck: values["no-update-check"] === true,
    installHook: values["install-hook"] === true,
    changedSince: values["changed-since"] === undefined ? undefined : String(values["changed-since"]),
    // `undefined` when the flag was not given, never `false`.
    //
    // `resolveConfig` reads these as `cliOptions.x ?? config.x`, so a `false` here is an
    // *explicit override* — it beat `skeleton: true` in a `snapshot.config.ts` and turned the
    // setting off without a word. Every run that did not pass the flag sent `false`, so a config
    // file could not turn any of these four on at all, and a snapshot generated with `--skeleton`
    // could never be validated against the config that describes it.
    staged: values.staged === true ? true : undefined,
    withDependents: values["with-dependents"] === true ? true : undefined,
    skeleton: values.skeleton === true ? true : undefined,
    sarif: values.sarif === true ? true : undefined,
    strict: values.strict === true ? true : undefined,
    http: values.http === true ? true : undefined,
    port: parsePort(values.port as string | undefined),
    host: values.host === undefined ? undefined : String(values.host),
    token: values.token === undefined ? undefined : String(values.token),
    noAuth: values["no-auth"] === true ? true : undefined,
    remote: values.remote === undefined ? undefined : String(values.remote),
    ref: values.ref === undefined ? undefined : String(values.ref),
    allowPrivate: values["allow-private"] === true ? true : undefined,
    keepClone: values["keep-clone"] === true ? true : undefined,
    includeDiffs: values["include-diffs"] === true ? true : undefined,
    includeLogs:
      values["include-logs"] === undefined
        ? undefined
        : parsePositiveInteger(values["include-logs"] as string, "include-logs", 1),
    tokenTree: values["token-tree"] === true ? true : undefined,
    sign: values.sign === true ? true : undefined,
    workspace: values.workspace === undefined ? undefined : String(values.workspace),
    stripComments: values["strip-comments"] === true ? true : undefined,
    removeEmptyLines: values["remove-empty-lines"] === true ? true : undefined,
    only: values.only === undefined ? undefined : String(values.only).split(",").map((item) => item.trim()).filter(Boolean),
    ignore: values.ignore === undefined ? undefined : String(values.ignore).split(",").map((item) => item.trim()).filter(Boolean),
    allMembers: values["all-members"] === true ? true : undefined,
    deep: values.deep === true ? true : undefined,
    budgetTokens:
      values["budget-tokens"] === undefined
        ? undefined
        : parsePositiveInteger(values["budget-tokens"] as string, "budget-tokens", 500),
    delta: values.delta === undefined ? undefined : String(values.delta),
    slice: values.slice === undefined ? undefined : String(values.slice),
    pack:
      values.pack === undefined
        ? undefined
        : values.pack === "single" || values.pack === "xml" || values.pack === "json"
          ? (values.pack as "single" | "xml" | "json")
          : (() => {
              throw new UsageError("--pack must be one of: single, xml, json (received " + String(values.pack) + ").");
            })(),
    sliceTokens:
      values["slice-tokens"] === undefined
        ? undefined
        : parsePositiveInteger(values["slice-tokens"] as string, "slice-tokens", 500),
    allowOrigins:
      values["allow-origin"] === undefined
        ? undefined
        : String(values["allow-origin"])
            .split(",")
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0),
  };
}

class HelpRequested extends Error {}

/**
 * Escape repository-derived text at the terminal boundary.
 *
 * `escapeControls` rewrites every C0/C1/bidi control, including `\n`; split on
 * newlines first so multi-line renderers keep their layout and only the
 * interpolated values are re-spelled. Already-escaped text is unchanged.
 */
function escapeForTerminal(message: string): string {
  return message
    .split("\n")
    .map((line) => escapeControls(line))
    .join("\n");
}

function info(message: string): void {
  process.stderr.write(`${escapeForTerminal(message)}\n`);
}

function warn(message: string): void {
  process.stderr.write(`${escapeForTerminal(message)}\n`);
}

function emit(format: OutputFormat, payload: unknown, textRenderer: () => void): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  textRenderer();
}

/**
 * Reports a failure and returns the exit code.
 *
 * The human line goes to stderr, as always. In `--format json` mode a parseable error document also
 * goes to stdout, because "stdout is empty" is not an answer an agent can act on: it would have to
 * parse stderr prose and guess. Every JSON-mode invocation now returns exactly one JSON document —
 * a payload on success, `{ error: { message, exitCode } }` on failure.
 */
function fail(format: OutputFormat, message: string, exitCode = 1): number {
  warn(`❌ ${message}`);
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ error: { message, exitCode } }, null, 2)}\n`);
  }
  return exitCode;
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Renders a path inside the output directory for the summary.
 *
 * `--out-dir` accepts an absolute path, and the summary used to print
 * `<absolute>/manifest.json` — a Windows path with a forward slash welded to it.
 * Paths inside `cwd` are shown relative; anything else keeps its native form.
 */
function displayOutPath(cwd: string, outDir: string, ...segments: string[]): string {
  const absolute = path.resolve(cwd, outDir, ...segments);
  const relative = path.relative(cwd, absolute);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return absolute;
}

/**
 * The first command the user should run after `init`.
 *
 * It has to be runnable exactly as printed. `npm run snapshot` needs the script *and*
 * installed dependencies, so an uninstalled project gets the install too; without a
 * package.json (or without the script after a re-run) the only form that works from a
 * clean checkout is `npx <package> generate`. A bare package name is not a command.
 */
function nextStepHint(cwd: string, scriptsAddedNow: boolean): string {
  let hasScript = scriptsAddedNow;
  if (!hasScript) {
    try {
      // `stripJsonComments` first: a UTF-8 BOM is what a Windows editor writes, and `JSON.parse`
      // refuses it — so a project whose `package.json` begins with one was told to run
      // `npx codebase-snapshot generate`, which resolves the *published* package instead of the
      // one this very run had just put in `node_modules`.
      const parsed = JSON.parse(
        stripJsonComments(fs.readFileSync(path.join(cwd, "package.json"), "utf8"))
      ) as { scripts?: Record<string, unknown> };
      hasScript = typeof parsed.scripts?.snapshot === "string";
    } catch {
      hasScript = false;
    }
  }
  if (!hasScript) return `npx ${GENERATOR_NAME} generate`;

  const bin = path.join(cwd, "node_modules", ".bin", "codebase-snapshot");
  const installed = fs.existsSync(bin) || fs.existsSync(`${bin}.cmd`);
  return installed ? "npm run snapshot" : "npm install && npm run snapshot";
}

/**
 * How the chosen preset is announced.
 *
 * The reason travels with the choice: `preset: nextjs, because next.config.ts` is checkable,
 * `preset: nextjs` is not. When the developer picked the preset themselves there is nothing to
 * explain, and when nothing matched the setup said so before asking.
 */
function presetSummary(init: { preset: string; reason: string | null }): string {
  return init.reason === null ? `preset: ${init.preset}` : `preset: ${init.preset}, because ${init.reason}`;
}

async function runInitCommand(invocation: ParsedInvocation): Promise<number> {
  try {
    const result = await runInit({
      cwd: invocation.cwd,
      preset: invocation.preset,
      outDir: invocation.outDir,
      maxPartBytes: invocation.maxPartBytesRaw ?? invocation.maxPartBytes,
      include: splitList(invocation.include),
      exclude: splitList(invocation.exclude),
      skipArtifacts: invocation.skipArtifacts,
      onlyArtifacts: invocation.onlyArtifacts,
      includeMonolith: invocation.includeMonolith,
      includeSensitiveFiles: invocation.includeSensitiveFiles,
      yes: invocation.yes,
      force: invocation.force,
      dryRun: invocation.dryRun,
    });

    // The hook is installed after the config exists: it gates on `validate`, which needs a
    // config and a snapshot, and `init` writes the config. A separate `hook` command would
    // have to re-derive everything this run already knows. The output directory comes from the
    // config that was just written, so a project using `outDir: ".context"` gets a hook that
    // actually finds the snapshot.
    const hook =
      invocation.installHook === true
        ? installPreCommitHook(invocation.cwd, result.outDir)
        : null;

    if (invocation.format === "json") {
      process.stdout.write(
        `${JSON.stringify(hook === null ? result : { ...result, hook }, null, 2)}\n`
      );
      return 0;
    }

    if (!result.written) {
      info(result.configText);
      if (hook) for (const note of hook.notes) info(`   ${note}`);
      return 0;
    }

    info(`✅ Created ${path.basename(result.configPath)} (${presetSummary(result)})`);
    if (result.scripts.length > 0) info(`   Added npm scripts: ${result.scripts.join(", ")}`);
    if (result.dependency.added && result.dependency.range !== null) {
      info(`   Added devDependency: ${result.dependency.name} ${result.dependency.range}`);
    }
    if (result.gitignoreEntries.length > 0) {
      info(`   Added to .gitignore: ${result.gitignoreEntries.join(", ")}`);
    }
    // The one file `init` writes that asks for the user rather than telling them: say so, or
    // it is a scaffold nobody opens.
    if (result.briefWritten) {
      info(
        `   Wrote ${path.basename(result.briefPath)}: a scaffold for the half of PROMPT.md only ` +
          "you can write. Fill it in, then set brief: " +
          `${JSON.stringify(path.basename(result.briefPath))} in the config to merge it.`
      );
    } else if (fs.existsSync(result.briefPath)) {
      info(`   Kept ${path.basename(result.briefPath)}: it already exists, and is never overwritten.`);
    }
    for (const note of result.notes) info(`   ⚠ ${note}`);
    if (hook) for (const note of hook.notes) info(`   ${note}`);
    info("");
    info(`   Next:  ${nextStepHint(invocation.cwd, result.scripts.length > 0)}`);
    return 0;
  } catch (err) {
    if (err instanceof PromptCancelled) {
      return fail(invocation.format, "Cancelled.");
    }
    return fail(invocation.format, (err as Error).message);
  }
}

/**
 * The health report, for a terminal.
 *
 * Every line names what was measured and the result, because a score without the checks behind it
 * is a number nobody can act on. Failures come first.
 */
function renderHealthText(report: HealthReport): void {
  const icon = (status: string): string =>
    status === "pass" ? "✅" : status === "warn" ? "⚠️ " : status === "fail" ? "❌" : "•";
  const order = { fail: 0, warn: 1, skip: 2, pass: 3 } as Record<string, number>;
  const sorted = [...report.checks].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  info(`🩺 Snapshot health: ${report.score}/100`);
  info(`   ${report.counts.pass} passed, ${report.counts.warn} warning(s), ${report.counts.fail} failed, ${report.counts.skip} skipped`);
  info("");
  for (const item of sorted) {
    info(`   ${icon(item.status)} ${item.title}`);
    info(`      ${escapeControls(item.detail)}`);
  }
  info("");
  if (report.counts.fail > 0) {
    info("   A failed check means this snapshot is not safe to hand to a model as it stands.");
  } else if (report.counts.warn > 0) {
    info("   Warnings are judgement calls; read them before trusting the snapshot.");
  } else {
    info("   Nothing found: the snapshot matches its manifest and carries no unmasked secret.");
  }
}

/** One package manager and the command that installs the declared dependencies. */
interface PackageManager {
  name: string;
  command: string;
  args: string[];
}

/**
 * How this binary was reached, for the run banner.
 *
 * The generator version alone does not say whether the snapshot came from the project's own pin
 * or from whatever `npx`/global install was first on PATH — and a snapshot whose behaviour
 * depends on the machine is exactly what a pinned project dependency exists to prevent. The
 * origin is printed rather than written into an artefact: an artefact naming an absolute install
 * path would stop being byte-identical across machines.
 */
function generatorOrigin(cwd: string): string {
  try {
    // `stripJsonComments` first, for the same reason `nextStepHint` does it 115 lines above: a
    // UTF-8 BOM is a valid way to save `package.json` and an invalid first byte for `JSON.parse`.
    // The bare parse threw, the catch below swallowed it, and a project that pins this package
    // was told it had a "global or direct install" — the exact warning a pin exists to prevent.
    const pkg = JSON.parse(
      stripJsonComments(fs.readFileSync(path.join(cwd, "package.json"), "utf8"))
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const spec = pkg.dependencies?.["codebase-snapshot"] ?? pkg.devDependencies?.["codebase-snapshot"];
    if (typeof spec === "string") return `project dependency ${spec}`;
  } catch {
    // No manifest, or not JSON: the other two answers cover it.
  }
  const entry = process.argv[1] ?? "";
  if (entry.includes("_npx") || entry.includes(`${path.sep}npx${path.sep}`)) return "via npx";
  return "global or direct install";
}
/**
 * The package manager this repository already uses, read from its lockfile.
 *
 * A lockfile is the only honest signal: running `npm install` inside a pnpm workspace rewrites a
 * lockfile the project's own tooling owns, and the snapshot is not worth that.
 */
function detectPackageManager(cwd: string): PackageManager {
  const has = (name: string): boolean => fs.existsSync(path.join(cwd, name));
  if (has("bun.lockb") || has("bun.lock")) return { name: "bun", command: "bun", args: ["install"] };
  if (has("pnpm-lock.yaml")) return { name: "pnpm", command: "pnpm", args: ["install"] };
  if (has("yarn.lock")) return { name: "yarn", command: "yarn", args: ["install"] };
  return { name: "npm", command: "npm", args: ["install"] };
}

interface InstallOutcome {
  manager: string;
  /** The command as printed, so a failure can be reproduced by hand. */
  command: string;
  ok: boolean;
  /** Elapsed time, or the failure reason. */
  detail: string;
}

/**
 * npm settings a child install may inherit.
 *
 * npm writes `npm_config_*` into the environment of every lifecycle script, and inheriting all
 * of them lets a parent's `npm_config_prefix` or `npm_config_global` change what the child
 * installs where. Stripping *every* one also removed the settings the user chose deliberately:
 * an install behind a proxy or a private registry failed with "network unreachable" because
 * `npm_config_registry`, the proxy and the CA file had been deleted from its environment.
 */
const INHERITED_NPM_SETTINGS = new Set([
  "npm_config_registry",
  "npm_config_proxy",
  "npm_config_https_proxy",
  "npm_config_noproxy",
  "npm_config_cafile",
  "npm_config_ca",
  "npm_config_strict_ssl",
]);

/**
 * The environment a nested package-manager run gets: the caller's, minus npm's own config.
 *
 * Running `setup` through `npx`/`npm exec` puts the parent npm's resolved config into
 * `npm_config_*` variables, and a child that inherits them is not the `npm install` a user would
 * type — with an npm that supports an `allowScripts` switch, the child aborted with
 * `EALLOWSCRIPTS: --allow-scripts is not allowed in project-scoped installs`. Stripping them makes
 * the child read the project's own `.npmrc` and flags, which is the whole point of using the
 * project's package manager.
 */
export function cleanInstallEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_config_/i.test(key) && !INHERITED_NPM_SETTINGS.has(key.toLowerCase())) continue;
    if (key === "npm_lifecycle_event" || key === "npm_lifecycle_script") continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/** Installs the repository's dependencies, turning any failure into a reportable outcome. */
function installDependencies(cwd: string): InstallOutcome {
  const manager = detectPackageManager(cwd);
  const command = `${manager.command} ${manager.args.join(" ")}`;
  const started = performance.now();
  // On Windows the package managers are `.cmd` shims that only run through a shell, and Node
  // deprecates that combination with an args array (DEP0190): the arguments are concatenated, not
  // escaped. Handing the shell one pre-formed string avoids the deprecated form, and both halves
  // are fixed literals from `detectPackageManager`, so there is nothing here to escape. Everywhere
  // else the command is spawned directly, with no shell involved at all.
  const spawnOptions = {
    cwd,
    encoding: "utf8" as const,
    timeout: INSTALL_TIMEOUT_MS,
    env: cleanInstallEnv(),
  };
  const result =
    process.platform === "win32"
      ? spawnSync(command, { ...spawnOptions, shell: true })
      : spawnSync(manager.command, manager.args, spawnOptions);
  const seconds = `${((performance.now() - started) / 1000).toFixed(1)}s`;
  if (result.error) {
    return { manager: manager.name, command, ok: false, detail: `${result.error.message} (${seconds})` };
  }
  if (result.status !== 0) {
    const tail = `${result.stderr ?? ""}${result.stdout ?? ""}`
      .trim()
      .split(/\r?\n/)
      .slice(-3)
      .join(" | ");
    return { manager: manager.name, command, ok: false, detail: `exit ${result.status}: ${tail} (${seconds})` };
  }
  return { manager: manager.name, command, ok: true, detail: seconds };
}

/**
 * The output directory a `setup` run's own generation will use, for the pre-commit hook.
 *
 * `init.outDir` is the directory the wizard's answers name, which is the right answer when setup
 * has just written the config from those answers. A reused config was not written from them:
 * baking that answer put `SNAPSHOT_DIR="snapshot"` into a project whose config names `ctx`, so the
 * hook found no manifest there and skipped the staleness check on every commit — a gate that
 * silently never ran, which is the one failure mode a commit gate must not have. Resolving the
 * kept config is the only way to know the directory the hook has to guard.
 */
async function setupHookOutDir(
  invocation: ParsedInvocation,
  init: { outDir: string; reused: boolean }
): Promise<string> {
  if (!init.reused || invocation.outDir !== undefined) return init.outDir;
  const loaded = await loadConfigFileDetailed(invocation.cwd);
  if (loaded.errors.length > 0) {
    // The generation below is about to fail with the same reason; failing here first keeps a hook
    // for a directory that will never receive a snapshot out of the user's .git.
    throw new Error(
      `The config file could not be read: ${loaded.errors.join("; ")}. ` +
        "Fix it, or delete it to use the defaults."
    );
  }
  return resolveConfig(loaded.config, {}, invocation.cwd).outDir;
}

/**
 * Runs `fn` with stdout captured.
 *
 * `setup` generates through the normal `generate` command so every guard, summary line and JSON
 * document is byte-for-byte what a plain generate produces; capturing lets it merge that document
 * into the one `setup` owes a machine consumer instead of printing two.
 *
 * The capture is an `AsyncLocalStorage` scope consulted by the one router in `stdout.ts`, not a
 * replacement of `process.stdout.write` held for a time window. The replacement approach broke
 * both ways round when the nested generate ran an async `hooks.afterGenerate`: the hook's write
 * escaped to the real stdout (corrupting this document) and this function's restore overwrote the
 * hook's diversion, leaving a dead closure as `process.stdout.write` for the rest of the process.
 */
async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; text: string }> {
  const { value, text } = await runWithStdoutCapture(fn);
  return { code: value, text };
}

/**
 * `setup` — the whole first-run experience in one command.
 *
 * Writes the config (only when the repository has none), adds the npm scripts, the devDependency
 * and the `.gitignore` entries, installs the dependency with the project's own package manager,
 * and generates the first snapshot. Every step reports itself; a failed install is a warning rather
 * than a dead end, because the snapshot can still be generated through `npx`, and `--no-install`
 * exists for CI and offline machines.
 */
async function runSetupCommand(
  invocation: ParsedInvocation,
  options: { interactive?: boolean } = {}
): Promise<number> {
  try {
    // `setup` is a one-command command: it never asks. A bare `snapshot` in an unconfigured
    // project shares this implementation and does ask, which is the only difference between
    // the two paths — everything after the questions is the same work.
    const interactive = options.interactive === true;
    const init = await runInit({
      cwd: invocation.cwd,
      preset: invocation.preset,
      outDir: invocation.outDir,
      maxPartBytes: invocation.maxPartBytesRaw ?? invocation.maxPartBytes,
      // Written into the config, not just forwarded to the generation below. A setting that
      // reaches the snapshot but not the file beside it is drift the very next run reports:
      // `setup --discovery walk --large-file-bytes 100000` used to exit 0 and then fail its own
      // `validate` with three configuration mismatches.
      maxPartTokens: invocation.maxPartTokens,
      largeFileBytes: invocation.largeFileBytes,
      maxMonolithBytes: invocation.maxMonolithBytes ?? undefined,
      discovery: invocation.discovery,
      skeleton: invocation.skeleton === true ? true : undefined,
      sarif: invocation.sarif === true ? true : undefined,
      include: splitList(invocation.include),
      exclude: splitList(invocation.exclude),
      skipArtifacts: invocation.skipArtifacts,
      onlyArtifacts: invocation.onlyArtifacts,
      includeMonolith: invocation.includeMonolith,
      includeSensitiveFiles: invocation.includeSensitiveFiles,
      yes: !interactive,
      force: invocation.force,
      reuseConfig: true,
      dryRun: invocation.dryRun,
    });

    // `runInit`'s answers describe the config it would write. When it keeps an existing file they
    // name a path and a preset that are not on disk: setup used to print "Keeping
    // snapshot.config.mjs" for a kept snapshot.config.json, and claim the requested `--preset`
    // while the generation used the kept config's own one. Report the file that was actually
    // kept, and claim a preset only when this run wrote one down.
    const keptConfigPath = init.reused
      ? findConfigFile(invocation.cwd) ?? init.configPath
      : init.configPath;
    const appliedPreset = init.reused ? null : init.preset;
    if (init.reused && invocation.preset !== undefined) {
      // A kept config is the repository's own file, so the flag cannot be written anywhere.
      // Saying nothing about it would be the silent fallback rule 1 forbids.
      init.notes.push(
        `--preset ${invocation.preset} was not applied: the existing config is kept. ` +
          "Edit its preset setting, or run `init --force` to write a new one."
      );
    }

    if (invocation.dryRun) {
      const manager = invocation.noInstall ? null : detectPackageManager(invocation.cwd).name;
      if (invocation.format === "json") {
        process.stdout.write(
          `${JSON.stringify(
            {
              dryRun: true,
              configPath: keptConfigPath,
              configReused: init.reused,
              preset: appliedPreset,
              install: manager,
              configText: init.configText,
            },
            null,
            2
          )}\n`
        );
        return 0;
      }
      info("\n🧪 Dry run — setup would:");
      info(
        `   1. ${init.reused ? `keep ${path.basename(keptConfigPath)}` : `write ${path.basename(keptConfigPath)} (preset: ${appliedPreset})`}`
      );
      info("   2. add the npm scripts, the devDependency and the .gitignore entries");
      if (manager !== null) info(`   3. install with ${manager}`);
      info("   4. generate the snapshot");
      info("");
      info(init.configText);
      return 0;
    }

    // Installed after the config exists and before the first generate, so the very first commit of
    // the setup is already gated. The dry-run branch returned above on purpose: a dry run writes
    // nothing, and that includes the hook — this block used to sit before the branch and did write
    // it. The directory comes from the config the generation will actually load, not from the
    // wizard's answers, which describe a file setup may have deliberately kept.
    const hook =
      invocation.installHook === true
        ? installPreCommitHook(invocation.cwd, await setupHookOutDir(invocation, init))
        : null;

    if (invocation.format !== "json") {
      // The interactive path already introduced itself and printed the directory, so the
      // banner would be a second header for the same run.
      if (!interactive) info(`🚀 Setup for: ${invocation.cwd}`);
      if (init.reused) {
        info(`♻  Keeping ${path.basename(keptConfigPath)}`);
      } else {
        info(`✅ Created ${path.basename(keptConfigPath)} (${presetSummary(init)})`);
      }
      if (init.scripts.length > 0) info(`   Added npm scripts: ${init.scripts.join(", ")}`);
      if (init.dependency.added && init.dependency.range !== null) {
        info(`   Added devDependency: ${init.dependency.name} ${init.dependency.range}`);
      }
      if (init.gitignoreEntries.length > 0) {
        info(`   Added to .gitignore: ${init.gitignoreEntries.join(", ")}`);
      }
      // Same line as `init`, for the same reason: a scaffold nobody opens is a file for nothing.
      if (init.briefWritten) {
        info(
          `   Wrote ${path.basename(init.briefPath)}: a scaffold for the half of PROMPT.md only ` +
            "you can write. Fill it in, then set brief: " +
            `${JSON.stringify(path.basename(init.briefPath))} in the config to merge it.`
        );
      }
      if (hook) for (const note of hook.notes) info(`   ${note}`);
      if (init.reused && invocation.preset !== undefined) {
        info(`   ⚠ --preset ${invocation.preset} was not applied: the existing config is kept.`);
      }
    }

    // A directory with no `package.json` is not an npm project, and running `npm install` there
    // answered ENOENT — then npm left an empty `package-lock.json` at the repository root, a file
    // the user never asked for and the tool never mentioned. There is nothing to install into, so
    // the install is skipped and said out loud instead of attempted.
    const hasManifest = fs.existsSync(path.join(invocation.cwd, "package.json"));
    let install: InstallOutcome | null = null;
    if (invocation.noInstall) {
      if (invocation.format !== "json") info("   Skipped the install (--no-install)");
    } else if (!hasManifest) {
      if (invocation.format !== "json") {
        info("   Skipped the install: no package.json here, so there is no dependency to add.");
      }
    } else {
      if (invocation.format !== "json") info("⏳ Installing dependencies…");
      install = installDependencies(invocation.cwd);
      if (invocation.format !== "json") {
        if (install.ok) info(`✅ Installed dependencies (${install.command}, ${install.detail})`);
        else info(`⚠ ${install.command} failed (${install.detail}); generating anyway`);
      }
    }

    // Generate through the real command: every guard, warning and JSON field is the same one a
    // plain `generate` produces, which is the point of a one-command setup.
    const generateArgs = ["generate", "--cwd", invocation.cwd, "--format", invocation.format];
    if (invocation.outDir !== undefined) generateArgs.push("--out-dir", invocation.outDir);
    if (invocation.includeSensitiveFiles === true) generateArgs.push("--include-sensitive-files");
    const budget = invocation.maxPartBytesRaw ?? invocation.maxPartBytes;
    if (budget !== undefined) generateArgs.push("--max-part-bytes", String(budget));
    // `--only-artifacts` has to travel as itself, not only as the derived suppression list:
    // suppression cannot switch an artifact back on, so a reused config that turned the named
    // artifact off left the run with *nothing* to write. This is the same bug `runCommand` had
    // for a plain generate. Forwarding both spellings would make the nested generate reject the
    // pair as a contradiction, so it is one or the other.
    if ((invocation.onlyArtifacts ?? []).length > 0) {
      generateArgs.push("--only-artifacts", (invocation.onlyArtifacts ?? []).join(","));
    } else if ((invocation.skipArtifacts ?? []).length > 0) {
      generateArgs.push("--skip-artifacts", (invocation.skipArtifacts ?? []).join(","));
    }
    // Every explicit choice the caller made has to survive the hop into `generate`, or
    // `setup` silently runs with a different configuration than the one it just wrote and
    // reported. These five used to be dropped here.
    if (invocation.includeMonolith === true) generateArgs.push("--include-monolith");
    if (invocation.discovery !== undefined) generateArgs.push("--discovery", invocation.discovery);
    if (invocation.largeFileBytes !== undefined) {
      generateArgs.push("--large-file-bytes", String(invocation.largeFileBytes));
    }
    if (invocation.maxMonolithBytes !== undefined && invocation.maxMonolithBytes !== null) {
      generateArgs.push("--max-monolith-bytes", String(invocation.maxMonolithBytes));
    }
    if (invocation.maxPartTokens !== undefined) {
      generateArgs.push("--max-part-tokens", String(invocation.maxPartTokens));
    }
    if (invocation.attachmentSlots !== undefined) {
      generateArgs.push("--attachment-slots", String(invocation.attachmentSlots));
    }
    if (invocation.maxParts !== undefined) {
      generateArgs.push("--max-parts", String(invocation.maxParts));
    }
    if (invocation.brief !== undefined) generateArgs.push("--brief", invocation.brief);
    if (invocation.promptTask !== undefined) {
      generateArgs.push("--prompt-task", invocation.promptTask);
    }
    if (invocation.skeleton === true) generateArgs.push("--skeleton");
    if (invocation.sarif === true) generateArgs.push("--sarif");
    // `main` runs the update check per invocation, so without this the nested `generate`
    // would ask again after the caller said not to be asked.
    if (invocation.noUpdateCheck) generateArgs.push("--no-update-check");
    // `--watch` reaches setup only from a first-run `snapshot --watch`, where dropping it would
    // silently downgrade the run to a single generation.
    if (invocation.watch) generateArgs.push("--watch");

    if (invocation.format === "json") {
      const generated = await captureStdout(() => main(generateArgs));
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(generated.text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      const setup = {
        configPath: keptConfigPath,
        configReused: init.reused,
        preset: appliedPreset,
        scripts: init.scripts,
        dependency: init.dependency,
        gitignoreEntries: init.gitignoreEntries,
        install,
        notes: init.notes,
        hook,
      };
      // A nested `generate` that failed puts its failure in its own document — and this used to
      // merge that document in as `manifest`, so `{ setup, manifest: { error: … } }` came out with
      // exit code 1 and no top-level `error` key. A machine consumer reads the top level: every
      // JSON-mode invocation returns exactly one document, `{ error: { message, exitCode } }` on
      // failure, and "the payload has an error field somewhere in it" is not that contract.
      if (generated.code !== 0) {
        const inner =
          parsed && typeof parsed.error === "object" && parsed.error !== null
            ? parsed.error
            : { message: "Snapshot generation failed during setup.", exitCode: generated.code };
        process.stdout.write(
          `${JSON.stringify({ error: inner, setup, manifest: null }, null, 2)}\n`
        );
        return generated.code;
      }
      process.stdout.write(
        `${JSON.stringify({ setup, manifest: parsed }, null, 2)}\n`
      );
      return generated.code;
    }

    const code = await main(generateArgs);
    info("");
    info(`   Next:  ${nextStepHint(invocation.cwd, false)}`);
    return code;
  } catch (err) {
    if (err instanceof PromptCancelled) return fail(invocation.format, "Cancelled.");
    return fail(invocation.format, (err as Error).message);
  }
}

/**
 * Decides what a `generate` with no configuration should do.
 *
 * Returns null when the run should proceed: an existing config, an existing snapshot, or a
 * project that has been generated before all mean there is nothing to set up. Otherwise it
 * asks (or, with `--autopilot`, decides), runs the setup, and generates — or refuses with the
 * command that would have worked, because a first run that silently used settings nobody
 * chose produces a snapshot nobody can trust.
 */
async function firstRun(invocation: ParsedInvocation): Promise<number | null> {
  const plan = planFirstRun({
    hasConfig: findConfigFile(invocation.cwd) !== null,
    hasPriorSnapshot: hasPriorSnapshot(invocation.cwd, invocation.outDir ?? DEFAULT_ANSWERS.outDir),
    // A machine must never be asked a question, and `--format json` is how a machine says so.
    interactive: invocation.format === "text" && isInteractive(defaultIO()),
    autopilot: invocation.autopilot,
    emptyTarget: isEffectivelyEmpty(invocation.cwd),
  });

  if (plan.action === "generate") return null;
  if (plan.action === "refuse") {
    return fail(invocation.format, firstRunMessage(plan.reason, invocation.cwd), plan.exitCode);
  }
  info(
    plan.interactive
      ? "⚙  This project has no snapshot configuration yet."
      : "⚙  --autopilot: setting this project up before generating."
  );
  return await runSetupCommand(invocation, { interactive: plan.interactive });
}

/**
 * Prints the bundled agent skill, or installs it into the repository.
 *
 * Printing goes to **stdout** (not the usual stderr progress stream) so an agent
 * can capture the skill directly: `codebase-snapshot skill > SKILL.md`.
 */
/**
 * `snapshot update`: ask the registry now, and say what was compared.
 *
 * The passive notice is silent in CI and in machine formats, and it can be silent for five
 * minutes after a failed check. This is the explicit question, so it bypasses the cache, works
 * without a terminal and prints the answer even when it is "you are current". Exit 0 when
 * current, 1 when a newer release exists (so a script can branch on it), 2 when the registry
 * could not be reached.
 */
async function runUpdateCommand(invocation: ParsedInvocation): Promise<number> {
  const current = GENERATOR_VERSION;
  const latestUrl = process.env.CODEBASE_SNAPSHOT_REGISTRY_URL;
  const latest = await resolveLatest({
    current,
    cacheFile: cacheFilePath(),
    force: true,
    ...(latestUrl === undefined || latestUrl === "" ? {} : { latestUrl }),
  });
  if (latest === null) {
    emit(invocation.format, { current, latest: null, updateAvailable: false }, () => {
      info(
        "Could not reach the npm registry, so the installed version could not be compared. " +
          "Nothing was changed; try again when the network is available."
      );
    });
    return 2;
  }
  const kind = installKind();
  const updateAvailable = isNewer(latest, current);
  const command = updateCommand(kind);
  emit(invocation.format, { current, latest, updateAvailable, command }, () => {
    if (updateAvailable) {
      info(formatUpdateNotice({ current, latest }, kind));
    } else {
      info(
        `You are on codebase-snapshot ${current}, and the registry publishes ${latest}. ` +
          "No update is available."
      );
    }
  });
  return updateAvailable ? 1 : 0;
}

function runSkillCommand(invocation: ParsedInvocation): number {
  if (!invocation.install) {
    // `--format json` used to print markdown anyway, which silently produced a
    // non-JSON payload on a flag whose only promise is machine readability.
    if (invocation.format === "json") {
      process.stdout.write(
        `${JSON.stringify({ name: SKILL_NAME, version: GENERATOR_VERSION, skill: renderSkill() }, null, 2)}\n`
      );
      return 0;
    }
    process.stdout.write(renderSkill());
    return 0;
  }

  try {
    const result = installSkill(invocation.cwd, invocation.target as SkillTarget | undefined);
    if (invocation.format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    info(`✅ Agent skill installed (${SKILL_NAME}):`);
    for (const item of result.written) {
      const shown = path.relative(invocation.cwd, item.path) || item.path;
      info(`   - ${item.action.padEnd(9)} ${shown}`);
    }
    if (result.gitignored.length > 0) {
      info("");
      info(`   Added to .gitignore: ${result.gitignored.join(", ")}`);
      info("   These files are this tool's own documentation, so they stay out of git.");
    }
    for (const note of result.notes) info(`   ⚠ ${note}`);
    info("");
    info("   Agents that read .claude/skills or .cursor/rules will pick this up automatically.");
    return 0;
  } catch (err) {
    return fail(invocation.format, `Could not install the skill: ${(err as Error).message}`);
  }
}

function renderValidateText(result: ReturnType<typeof validateSnapshot>): void {
  if (result.valid) {
    info("✅ Snapshot is valid and up to date with disk.");
  } else if (
    result.errors.length === 1 &&
    result.errors[0].includes(" is not a snapshot manifest: ")
  ) {
    // A manifest that is not a snapshot manifest is a refusal, not a drift report. It was
    // printed as the first bullet under a generic header, so the same malformed file read
    // `❌ <path> is not a snapshot manifest: …` from `report` and `diff`, and `  - <path> …`
    // from `validate`. One sentence, one prefix, in all three.
    warn(`❌ ${result.errors[0]}`);
  } else {
    warn("❌ Snapshot validation failed:");
    for (const error of result.errors) warn(`  - ${error}`);
    // Every other drift class listed its paths; this one printed only a count,
    // so a terminal user could not tell which file was unreadable without
    // switching to --format json.
    for (const unreadable of result.drift.unreadable.slice(0, 20)) {
      warn(`  - unreadable: ${unreadable}`);
    }
    for (const drift of result.drift.hashMismatches.slice(0, 20)) {
      warn(`  - modified: ${drift.path}`);
    }
    for (const issue of result.drift.partIssues.slice(0, 20)) {
      warn(`  - part: ${issue.part} (${issue.issue})`);
    }
    for (const mismatch of result.drift.configMismatches.slice(0, 20)) {
      warn(`  - config: ${mismatch}`);
    }
    for (const missing of result.drift.missingInSnapshot.slice(0, 20)) {
      warn(`  - new file: ${missing}`);
    }
    for (const missing of result.drift.missingOnDisk.slice(0, 20)) {
      warn(`  - deleted: ${missing}`);
    }
    // Bookkeeping mismatches were counted but never listed, so the text output
    // said "1 value disagrees" without saying which one.
    for (const mismatch of result.drift.totalsMismatches.slice(0, 20)) {
      warn(`  - counts: ${mismatch}`);
    }
  }
  for (const warning of result.warnings) warn(`  ⚠ ${warning}`);
}

/**
 * Effective `--format` from raw argv, read before parsing can reject the rest.
 *
 * Usage errors used to bypass `fail()` and leave stdout empty in JSON mode. This mirrors the
 * parser's own last-wins rule for repeated value options and stops at `--`, where a format-looking
 * token is a positional argument rather than an option.
 */
function requestsJsonFormat(argv: readonly string[]): boolean {
  let format: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") break;
    if (argument === "--format") {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        format = next;
        index += 1;
      }
      continue;
    }
    if (argument.startsWith("--format=")) format = argument.slice("--format=".length);
  }
  return format === "json";
}

/** Whether the closed-stdout guard has already been installed for this process. */
let closedStdoutGuarded = false;

/**
 * Treats a downstream reader that closed the pipe as a normal early exit.
 *
 * `codebase-snapshot generate --format json | head` leaves the payload half-written, and the next
 * write to stdout reports `EPIPE`. With no `error` listener Node treats that as an unhandled
 * event and kills the process with a stack trace *after* the snapshot was already written — a
 * crash the caller cannot act on, for a decision the reader made. The run therefore ends quietly
 * with status 0. Every other stdout error is a real error and is re-thrown unchanged.
 *
 * Installed only when `main` runs, so importing this module (the documented side-effect-free
 * surface) still installs nothing.
 */
function guardClosedStdout(): void {
  if (closedStdoutGuarded) return;
  closedStdoutGuarded = true;
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE" || error.code === "ECONNRESET") {
      process.exit(0);
    }
    throw error;
  });
}

/**
 * Runs one invocation, and mentions a newer release when there is one.
 *
 * The check is *started* before the command and awaited after it, so on any real work the request
 * overlaps the command entirely and adds no wall time. The notice goes to stderr: stdout belongs
 * to the payload, and a JSON consumer must never have to parse a suggestion.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  guardClosedStdout();

  // `stdout.isTTY` is the honest gate for "a person is watching": a pipe, a file or a CI job has
  // nobody to tell, and those are exactly the cases where a network call costs something.
  const pending =
    process.stdout.isTTY === true && shouldCheck(argv, process.env)
      ? checkForUpdate({ current: GENERATOR_VERSION, cacheFile: cacheFilePath() })
      : null;

  const code = await runCommand(argv);

  if (pending) {
    const notice = await pending;
    if (notice) process.stderr.write(`\n${formatUpdateNotice(notice, installKind())}\n`);
  }
  return code;
}

/** The command itself. Every early return here is a finished invocation. */
/**
 * The generate-scoped options a CLI invocation carries.
 *
 * runCommand built this object by hand and runWatchLoop built a second, shorter copy. Every flag
 * added after the watch loop was written worked once and disappeared on the first file edit:
 * --only, --strip-comments, --token-tree, --include-diffs, --include-logs, --pack and --sign.
 * One builder makes the two paths agree by construction.
 */
export function generateCliOptions(
  invocation: ParsedInvocation
): Partial<CliOptions> & { discovery?: DiscoveryMode } {
  return {
    mode: invocation.command as Mode,
    format: invocation.format,
    dryRun: invocation.dryRun,
    cwd: invocation.cwd,
    outDir: invocation.outDir,
    includeMonolith: invocation.includeMonolith,
    includeSensitiveFiles: invocation.includeSensitiveFiles,
    maxPartBytes: invocation.maxPartBytes,
    maxPartTokens: invocation.maxPartTokens,
    largeFileBytes: invocation.largeFileBytes,
    maxMonolithBytes: invocation.maxMonolithBytes,
    attachmentSlots: invocation.attachmentSlots,
    maxParts: invocation.maxParts,
    ...(invocation.includeDiffs === true ? { includeDiffs: true } : {}),
    ...(invocation.includeLogs === undefined ? {} : { includeLogs: invocation.includeLogs }),
    ...(invocation.tokenTree === true ? { tokenTree: true } : {}),
    ...(invocation.stripComments === true ? { stripComments: true } : {}),
    ...(invocation.removeEmptyLines === true ? { removeEmptyLines: true } : {}),
    ...(invocation.only === undefined ? {} : { only: invocation.only }),
    ...(invocation.ignore === undefined ? {} : { ignore: invocation.ignore }),
    ...(invocation.pack === undefined ? {} : { pack: invocation.pack }),
    ...(invocation.sign === true ? { sign: true } : {}),
    brief: invocation.brief,
    promptTask: invocation.promptTask,
    skipArtifacts: invocation.skipArtifacts,
    onlyArtifacts: invocation.onlyArtifacts,
    discovery: invocation.discovery,
    changedSince: invocation.changedSince,
    staged: invocation.staged,
    withDependents: invocation.withDependents,
    skeleton: invocation.skeleton,
    sarif: invocation.sarif,
  };
}

async function runCommand(argv: string[]): Promise<number> {
  let invocation: ParsedInvocation;
  try {
    invocation = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof HelpRequested) return 0;
    if (err instanceof UsageError) {
      process.stderr.write(`❌ ${err.message}\n\n${USAGE}\n`);
      if (requestsJsonFormat(argv)) {
        process.stdout.write(
          `${JSON.stringify({ error: { message: err.message, exitCode: 2 } }, null, 2)}\n`
        );
      }
      return 2;
    }
    throw err;
  }

  // A container should pass the bearer token in the environment, not argv where `ps` can read
  // it. --no-auth still wins; an explicit --token still wins over the environment.
  const environmentToken = process.env.SNAPSHOT_TOKEN?.trim();
  const tokenOption =
    invocation.noAuth === true
      ? { token: null }
      : invocation.token !== undefined
        ? { token: invocation.token }
        : environmentToken !== undefined && environmentToken !== ""
          ? { token: environmentToken }
          : {};

  if (invocation.command === "init") {
    return await runInitCommand(invocation);
  }

  // Agent-facing commands run before config discovery on purpose: an agent must
  // be able to read the contract and install the skill even when the repository's
  // config is broken, which is exactly when it needs help.
  if (invocation.command === "describe") {
    const contract = buildAgentContract();
    emit(invocation.format, contract, () => info(renderContractText(contract)));
    return 0;
  }

  if (invocation.command === "skill") {
    return runSkillCommand(invocation);
  }

  if (invocation.command === "update") {
    return runUpdateCommand(invocation);
  }

  // `mcp` speaks JSON-RPC on stdout and resolves the repository configuration per tool call, so it
  // starts before config discovery. A config that cannot be read must reach the client as a tool
  // error it can act on, not as a process that dies before it answers its first message.
  if (invocation.command === "serve") {
    const server = await startWebServer({
      cwd: path.resolve(invocation.cwd),
      ...(invocation.host === undefined ? {} : { host: invocation.host }),
      ...(invocation.port === undefined ? {} : { port: invocation.port }),
      ...tokenOption,
      ...(invocation.allowPrivate === true ? { allowPrivate: true } : {}),
      log: (line) => warn(line),
    });
    info("Serving " + server.url);
    info("  MCP endpoint: " + server.url + "mcp");
    if (server.token !== null) {
      info("  Token: " + server.token);
      info("  Open the page and paste the token once; it is kept in this browser only.");
    } else {
      warn("  WARNING: --no-auth is on. Any page on this machine can read the repository.");
    }
    await new Promise<void>((resolve) => {
      const stop = (): void => { void server.close().then(resolve); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  }

  if (invocation.command === "mcp") {
    if (invocation.http === true) {
      const transport = await startHttpTransport({
        cwd: path.resolve(invocation.cwd),
        ...(invocation.host === undefined ? {} : { host: invocation.host }),
        ...(invocation.port === undefined ? {} : { port: invocation.port }),
        ...tokenOption,
        ...(invocation.allowOrigins === undefined ? {} : { allowedOrigins: invocation.allowOrigins }),
        log: (line) => warn(line),
      });
      info("MCP over HTTP: " + transport.url);
      info("  tools: " + buildTools().length + " (see describe --format json)");
      if (transport.token !== null) {
        info("  Authorization: Bearer " + transport.token);
        info("  (generated for this run; pass --token to choose one)");
      } else {
        warn("  WARNING: --no-auth is on. Any page on this machine can read the repository.");
      }
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          void transport.close().then(resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }
    return await runStdioServer({ cwd: path.resolve(invocation.cwd) });
  }

  // `setup` runs before config discovery because it may be the run that *creates* the config: it
  // writes the file, then generates through the normal command, which loads it.
  if (invocation.command === "setup") {
    return runSetupCommand(invocation);
  }

  // The first run of a bare `snapshot` is decided before the config is loaded: there is no config
  // yet, and the decision is whether to write one. Naming the command (`snapshot generate`) is an
  // instruction to do exactly that, so it keeps running on the defaults; `--autopilot` is the way
  // to ask for the setup from an explicit command. `--no-config` is an explicit "run on the
  // built-in defaults", so it never sets anything up.
  if (
    invocation.command === "generate" &&
    !invocation.noConfig &&
    (!invocation.explicitCommand || invocation.autopilot)
  ) {
    const decided = await firstRun(invocation);
    if (decided !== null) return decided;
  }

  // `--remote` fetches the tree before anything reads it. The clone is the repository for the
  // rest of this run: the config file it may contain is deliberately not loaded (a fetched
  // repository is not a trusted one), and the output directory stays where the user ran the
  // command, which is where they will look for it.
  let sourceProvenance: Manifest["source"] | undefined;
  if (invocation.remote !== undefined) {
    if (invocation.command !== "generate") {
      return fail(invocation.format, "--remote is accepted by generate only.");
    }
    const parsed = parseRemoteSource(invocation.remote, { allowPrivate: invocation.allowPrivate === true });
    if (!parsed.ok) return fail(invocation.format, parsed.message);
    try {
      if (parsed.source.kind === "https") {
        await assertPublicHost(parsed.source.host, invocation.allowPrivate === true);
      }
      const clone = await cloneRepository(parsed.source, {
        dest: makeCloneDirectory(),
        token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null,
        ref: invocation.ref ?? null,
        allowPrivate: invocation.allowPrivate === true,
        log: (line) => info("   " + line),
      });
      sourceProvenance = clone.provenance;
      const outDir = path.resolve(invocation.cwd, invocation.outDir ?? "snapshot");
      invocation = { ...invocation, cwd: clone.directory, outDir, noConfig: true };
      info(
        "   Source: " + parsed.source.owner + "/" + parsed.source.repo + "@" + clone.commit.slice(0, 12) +
          " (fetched " + clone.provenance.fetchedAt + ")"
      );
      if (invocation.keepClone === true) {
        info("   Clone kept at: " + clone.directory);
      } else {
        // Every exit path, including a fail() after this point, leaves the temp tree behind unless
        // this runs. rmSync on exit is synchronous and the process is already ending, so nothing
        // is waiting on it.
        const directory = clone.directory;
        process.once("exit", () => {
          try {
            fs.rmSync(directory, { recursive: true, force: true });
          } catch {
            // Best effort: a locked file must not turn a successful run into a crash.
          }
        });
      }
    } catch (error) {
      return fail(invocation.format, "Remote fetch failed: " + (error as Error).message);
    }
  }

  // `diff` compares two manifests and never needs a repository config; importing one would
  // execute repository code to answer a question about files. --no-config also skips it.
  const skipConfig = invocation.noConfig || invocation.command === "diff";
  const loaded = skipConfig
    ? { config: null, warnings: [], errors: [], file: null }
    : await loadConfigFileDetailed(invocation.cwd);
  if (invocation.noConfig) info("⚙  --no-config: using built-in defaults, config file ignored");
  // A config that exists but cannot be read must not silently fall back to the defaults: the
  // resulting snapshot would ignore every setting the developer wrote and still report success.
  // The fatal entries are also in `loaded.warnings`, so they are not printed twice: they go into
  // one message through `fail`, which is what keeps a `--format json` invocation from answering
  // with an empty stdout. The non-fatal warnings are still listed as they are discovered.
  if (loaded.errors.length > 0) {
    return fail(
      invocation.format,
      `The config file could not be read: ${loaded.errors.join("; ")}. ` +
        "Fix it, or delete it to use the defaults."
    );
  }
  for (const warning of loaded.warnings) warn(`⚠ Config: ${warning}`);
  if (loaded.file) info(`⚙  Using config ${path.relative(process.cwd(), loaded.file) || loaded.file}`);

  let resolved: ResolvedSnapshotConfig;
  try {
    resolved = resolveConfig(
      loaded.config,
      generateCliOptions(invocation),
      invocation.cwd
    );
  } catch (err) {
    // An unusable setting is a hard error, never a fallback — and a JSON consumer still receives
    // exactly one document rather than a stack trace on stderr and an empty stdout.
    return fail(invocation.format, (err as Error).message);
  }

  if (invocation.command === "validate") {
    // `validateSnapshot` already shape-checks the manifest — `describeManifestShapeProblem` runs
    // before any drift is computed, and a manifest that fails it comes back `valid: false` with
    // that reason as its only error. The CLI read and re-parsed `manifest.json` here to run the
    // same check again for a result that claimed to be valid, which on a large repository meant
    // parsing a multi-megabyte document a second time to re-answer a question that had already
    // been answered.
    const result = validateSnapshot(resolved);
    emit(invocation.format, result, () => renderValidateText(result));
    return result.valid ? 0 : 1;
  }

  if (invocation.command === "health") {
    if (invocation.allMembers === true) {
      // A workspace is one generate run that wrote one snapshot per member. Auditing only the
      // first would be a health report about a repository nobody asked about.
      const outRoot = path.resolve(resolved.cwd, resolved.outDir);
      const indexPath = path.join(outRoot, "WORKSPACE.json");
      if (!fs.existsSync(indexPath)) {
        return fail(
          invocation.format,
          `No workspace index at ${indexPath}. Run generate --workspace <a,b> first, or drop --all-members.`
        );
      }
      let index: { members?: Array<{ name?: string; path?: string }> };
      try {
        index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as typeof index;
      } catch (error) {
        return fail(invocation.format, `Could not read ${indexPath}: ${(error as Error).message}`);
      }
      const rows: Array<{ name: string; score: number; counts: { pass: number; warn: number; fail: number }; failed: string[]; error?: string }> = [];
      const insidePath = (parent: string, child: string): boolean => {
        const relative = path.relative(parent, child);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      };
      for (const member of index.members ?? []) {
        const name = member.name ?? "?";
        // The workspace index is repository-controlled input. Joining `name` or `path` without a
        // containment check let a crafted WORKSPACE.json point health at any directory on disk.
        const snapshotDir = path.resolve(outRoot, name);
        const repoPath = member.path ?? name;
        const repoDir = path.resolve(resolved.cwd, repoPath);
        if (
          name.length === 0 ||
          path.isAbsolute(name) ||
          name.split("/").includes("..") ||
          !insidePath(outRoot, snapshotDir) ||
          path.isAbsolute(repoPath) ||
          repoPath.split(/[\\/]/).includes("..") ||
          !insidePath(resolved.cwd, repoDir)
        ) {
          rows.push({
            name,
            score: 0,
            counts: { pass: 0, warn: 0, fail: 1 },
            failed: [],
            error: "the workspace index names a path outside the workspace",
          });
          continue;
        }
        if (!fs.existsSync(path.join(snapshotDir, "manifest.json"))) {
          rows.push({ name, score: 0, counts: { pass: 0, warn: 0, fail: 1 }, failed: [], error: "no snapshot at " + snapshotDir });
          continue;
        }
        const report = auditSnapshot({
          snapshotDir,
          repoDir,
          ...(invocation.deep === true ? { deep: true } : {}),
        });
        rows.push({
          name,
          score: report.score,
          counts: report.counts,
          failed: report.checks.filter((check) => check.status === "fail").map((check) => check.id),
        });
      }
      const score = rows.length === 0 ? 100 : Math.min(...rows.map((row) => row.score));
      const totals = rows.reduce(
        (sum, row) => ({ pass: sum.pass + row.counts.pass, warn: sum.warn + row.counts.warn, fail: sum.fail + row.counts.fail }),
        { pass: 0, warn: 0, fail: 0 }
      );
      emit(invocation.format, { outRoot, score, totals, members: rows }, () => {
        info(`\n🏥 Workspace health (${outRoot})`);
        for (const row of rows) {
          info(
            "   - " +
              row.name.padEnd(20) +
              (row.error !== undefined ? "ERROR   " + row.error : row.score + "/100  " + row.counts.pass + " passed, " + row.counts.warn + " warning(s), " + row.counts.fail + " failed")
          );
        }
        info(`\n   Combined score: ${score}/100 (the weakest member)`);
      });
      if (totals.fail > 0) return invocation.strict === true ? 2 : 1;
      if (invocation.strict === true && totals.warn > 0) return 1;
      return 0;
    }
    const snapshotDir = path.resolve(resolved.cwd, resolved.outDir);
    const report = auditSnapshot({
      snapshotDir,
      repoDir: resolved.cwd,
      ...(invocation.deep === true ? { deep: true } : {}),
    });
    emit(invocation.format, report, () => renderHealthText(report));
    if (report.counts.fail > 0) return invocation.strict === true ? 2 : 1;
    if (invocation.strict === true && report.counts.warn > 0) return 1;
    return 0;
  }

  if (invocation.command === "report") {
    // `path.resolve`, not `path.join`: generate resolves outDir against cwd, so a
    // reader using join would look for "<cwd>\<absolute path>" and report a
    // missing manifest after a successful generate.
    const manifestPath = path.resolve(resolved.cwd, resolved.outDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      return fail(invocation.format, `Manifest not found at ${manifestPath}. Run generate first.`);
    }
    let manifest: Manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
    } catch (err) {
      return fail(invocation.format, `Could not read ${manifestPath}: ${(err as Error).message}`);
    }

    // A parseable file is not necessarily a snapshot: reading a foreign or
    // truncated manifest used to fail with a raw `TypeError: Cannot read
    // properties of undefined (reading 'totalFiles')` instead of a message.
    const shapeError = describeManifestShapeProblem(manifest);
    if (shapeError) {
      return fail(invocation.format, `${manifestPath} is not a snapshot manifest: ${shapeError}`);
    }

    // `report` describes the snapshot that exists; it does not re-scan the
    // repository. It used to call validateSnapshot, which re-reads every file to
    // prove there is no drift — 4.5 s on a 20 000-file repository to print a
    // summary that was already on disk. Drift is `validate`'s job.
    emit(invocation.format, { manifest, validation: null }, () => {
      info(`\n📊 Codebase Snapshot Report (${resolved.cwd})`);
      info(`   - Generated at:   ${manifest.generatedAt}`);
      info(`   - Schema:         ${manifest.schemaVersion}`);
      info(`   - Fingerprint:    ${manifest.fingerprint}`);
      info(`   - Files included: ${manifest.counts.totalFiles}`);
      info(`   - Total lines:    ${formatNumber(manifest.counts.totalLines)}`);
      info(
        `   - Total size:     ${(manifest.counts.totalSizeBytes / (1024 * 1024)).toFixed(2)} MB`
      );
      info(`   - Total parts:    ${manifest.counts.partsCount}`);
      info("   - Integrity:      not checked (run `codebase-snapshot validate`)");
      info(`   - Warnings:       ${manifest.warnings?.length ?? 0}`);
      // A manifest written by 4.1.1 or earlier has no `redactedLines`, and those versions kept
      // every masked line inside `warnings` — so read absence as "nothing to add", not as zero leaks.
      if ((manifest.totals.redactedLines ?? 0) > 0) {
        info(`   - Redacted:       ${manifest.totals.redactedLines} line(s)`);
      }
      info("\n   Layers:");
      for (const [layer, count] of Object.entries(manifest.layers)) {
        info(`     - ${layer.padEnd(16)}: ${count} files`);
      }
      // A snapshot can be a selection, and the summary is where a reader looks first. Which
      // selection, and what it cost, belongs here rather than only in the manifest.
      if (manifest.slice !== undefined) {
        info("\n   Selection (slice):");
        info(`     - Question:       ${manifest.slice.question}`);
        info(`     - Used:           ${formatNumber(manifest.slice.usedTokens)} of ${formatNumber(manifest.slice.budgetTokens)} tokens`);
        info(`     - Not selected:   ${manifest.slice.dropped} path(s)`);
      }
      if (manifest.budget !== undefined) {
        info("\n   Selection (budget):");
        info(`     - Used:           ${formatNumber(manifest.budget.usedTokens)} of ${formatNumber(manifest.budget.maxTokens)} tokens`);
        info(`     - Not selected:   ${manifest.budget.dropped} path(s)`);
        if (manifest.budget.coverage !== undefined) {
          const coverage = manifest.budget.coverage;
          info(`     - Entry points:   ${coverage.entryPoints.kept} of ${coverage.entryPoints.total}`);
          info(`     - Symbols:        ${coverage.symbols.kept} of ${coverage.symbols.total}`);
        }
        if (manifest.budget.headroomTokens !== undefined) {
          info(`     - Headroom:       ${formatNumber(manifest.budget.headroomTokens)} tokens`);
        }
        if (manifest.budget.nextInLine !== undefined && manifest.budget.nextInLine.length > 0) {
          const next = manifest.budget.nextInLine.slice(0, 5);
          info(
            "     - Next in line:   " +
              next.map((item) => item.path + " (" + formatNumber(item.tokens) + ")").join(", ") +
              (manifest.budget.nextInLine.length > next.length ? ", …" : "")
          );
        }
      }
      if (manifest.delta !== undefined) {
        const delta = manifest.delta;
        info("\n   Selection (delta):");
        info(`     - Against:        ${path.basename(delta.base.path)} (${delta.base.fingerprint.slice(0, 12)})`);
        info(
          `     - Changed:        ${delta.changed.length} changed, ${delta.added.length} added, ` +
            `${delta.removed.length} removed, ${delta.unchanged.length} unchanged`
        );
      }
    });

    // Reading the manifest is the whole job, so a readable, well-shaped manifest
    // is a success. Whether the snapshot is still true is `validate`'s answer.
    return 0;
  }

  if (invocation.command === "explain") {
    const result = explainPath(resolved, invocation.args[0]);
    emit(invocation.format, result, () => info(renderExplainText(result)));
    // Explaining a file that *would be skipped* is a successful explanation, not
    // a failure: exit 1 is reserved for drift and refusals, so an agent asking
    // about `.env` must read `included: false` rather than infer it from an
    // exit code that also means "the snapshot is stale".
    return 0;
  }

  if (invocation.command === "diff") {
    // Comparing two snapshots reads two manifests; a repository config is irrelevant,
    // and importing one would execute repository code to answer a question about files.
    try {
      const [beforePath, afterPath] = invocation.args;
      // The resolved rules are passed even though `diff` deliberately does not read the project
      // configuration: a caller that supplies rules gets them applied to both manifests, and this
      // call site cannot drift from the rest of the tool if that decision ever changes. Without
      // the config the list is the built-ins — which is why `docs/cli.md` says so.
      const diff = compareManifests(
        loadManifest(beforePath),
        loadManifest(afterPath),
        resolved.secretRules
      );
      emit(invocation.format, diff, () => info(renderDiffText(diff)));
      return 0;
    } catch (err) {
      return fail(invocation.format, (err as Error).message);
    }
  }

  // `--watch` asks for something the runtime may be unable to do at all, so it is answered before
  // the run writes anything. It is a failure rather than a usage error for the reason
  // `--changed-since` on a non-repository is one: the command line is valid and this machine
  // cannot honour it. Reported through `fail` so `--format json` still gets one parseable
  // document.
  if (invocation.slice !== undefined && invocation.delta !== undefined) {
    return fail(invocation.format, "--slice and --delta narrow in two different directions; pass one.");
  }
  if (invocation.slice !== undefined && invocation.budgetTokens !== undefined) {
    return fail(
      invocation.format,
      "--slice and --budget-tokens both narrow the selection; pass one, or use --slice-tokens for the slice budget."
    );
  }

  if (invocation.watch) {
    const problem = watchSupportProblem();
    if (problem !== null) return fail(invocation.format, problem);
    // A delta base is a fixed comparison point, and the watch loop would otherwise regenerate
    // against it while silently ignoring the flag. Refuse the combination instead of pretending.
    if (invocation.delta !== undefined) {
      return fail(
        invocation.format,
        "--watch cannot track a fixed --delta base; run a one-shot generate --delta, or watch without it."
      );
    }
  }

  if (invocation.workspace !== undefined) {
    const members = invocation.workspace
      .split(",")
      .map((member) => member.trim())
      .filter((member) => member.length > 0);
    if (members.length === 0) return fail(invocation.format, "--workspace needs at least one path.");
    if (
      invocation.remote !== undefined ||
      invocation.delta !== undefined ||
      invocation.slice !== undefined ||
      invocation.budgetTokens !== undefined ||
      invocation.sign === true
    ) {
      return fail(
        invocation.format,
        "--workspace writes one snapshot per member; --remote, --delta, --slice, --budget-tokens and --sign do not combine with it."
      );
    }
    const outRoot = path.resolve(invocation.cwd, invocation.outDir ?? "snapshot");
    const workspaceCwd = path.resolve(invocation.cwd);
    const outRootRelative = path.relative(outRoot, workspaceCwd);
    if (
      outRootRelative === "" ||
      (!outRootRelative.startsWith("..") && !path.isAbsolute(outRootRelative))
    ) {
      return fail(
        invocation.format,
        `--workspace refuses --out-dir ${outRoot}: it is the working directory or one of its ancestors.`
      );
    }
    // Two members with the same basename would write one snapshot over the other and leave one
    // member missing from the index. Refuse before the first member is generated, not after a
    // partial workspace has already been written.
    const plannedNames = new Map<string, string>();
    for (const member of members) {
      const directory = path.resolve(invocation.cwd, member);
      const name = path.basename(directory);
      const previous = plannedNames.get(name);
      if (previous !== undefined) {
        return fail(
          invocation.format,
          `--workspace members "${previous}" and "${member}" share the basename "${name}"; ` +
            "each member needs a distinct directory name."
        );
      }
      plannedNames.set(name, member);
    }
    const records: Array<{
      name: string;
      path: string;
      fingerprint: string;
      files: number;
      parts: number;
      tokens: number;
      imports: Array<{ path: string; imports: string[] }>;
    }> = [];
    let failed = 0;
    for (const member of members) {
      const directory = path.resolve(invocation.cwd, member);
      const name = path.basename(directory);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(directory);
      } catch {
        warn("⚠ Workspace member missing: " + member);
        failed += 1;
        continue;
      }
      if (!stat.isDirectory()) {
        warn("⚠ Workspace member is not a directory: " + member);
        failed += 1;
        continue;
      }
      try {
        // Each member is generated on the defaults: a member may contain a config that runs code,
        // and a workspace is a set of repositories the caller named, not one they configured.
        const manifest = generateSnapshot(
          { cwd: directory, outDir: path.join(outRoot, name) },
          { dryRun: invocation.dryRun }
        );
        records.push({
          name,
          path: directory,
          fingerprint: manifest.fingerprint,
          files: manifest.counts.totalFiles,
          parts: manifest.counts.partsCount,
          tokens: manifest.totals.estimatedTokens ?? 0,
          imports: manifest.indexes.imports.byFile.map((entry) => ({ path: entry.path, imports: entry.imports })),
        });
        info("   " + name + ": " + manifest.counts.totalFiles + " files, " + manifest.counts.partsCount + " part(s)");
      } catch (error) {
        warn("⚠ " + name + ": " + (error as Error).message);
        failed += 1;
      }
    }
    if (!invocation.dryRun) fs.mkdirSync(outRoot, { recursive: true });
    /**
     * Cross-member edges: a relative import in one member that resolves inside another.
     *
     * This is the one thing a per-member snapshot cannot see, and it is exactly what a reader of a
     * monorepo needs first: which member depends on which. The edge is recorded from the specifier
     * text, so it is a static link, not proof that the target exists in the other member's snapshot.
     */
    const links: Array<{ from: string; to: string; specifiers: number; examples: string[] }> = [];
    for (const record of records) {
      const counts = new Map<string, { count: number; examples: string[] }>();
      for (const entry of record.imports) {
        for (const specifier of entry.imports) {
          if (!specifier.startsWith(".")) continue;
          const resolved = path.resolve(record.path, path.dirname(entry.path), specifier);
          for (const other of records) {
            if (other === record) continue;
            const prefix = other.path + path.sep;
            if (!resolved.startsWith(prefix) && resolved !== other.path) continue;
            const bucket = counts.get(other.name) ?? { count: 0, examples: [] };
            bucket.count += 1;
            if (bucket.examples.length < 5) bucket.examples.push(entry.path);
            counts.set(other.name, bucket);
          }
        }
      }
      for (const [to, bucket] of counts) {
        links.push({ from: record.name, to, specifiers: bucket.count, examples: bucket.examples });
      }
    }
    links.sort((left, right) => {
      const a = left.from + ">" + left.to;
      const b = right.from + ">" + right.to;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const document = {
      generatedAt: new Date().toISOString(),
      generator: GENERATOR_VERSION,
      // The index is published; an absolute host path in it names the author's home directory.
      // Store the member path relative to the workspace cwd, as manifest paths already are.
      members: records.map(({ imports: _imports, ...rest }) => ({
        ...rest,
        path: path.relative(workspaceCwd, rest.path).split(path.sep).join("/") || ".",
      })),
      links,
    };
    if (!invocation.dryRun) {
      const workspacePath = path.join(outRoot, "WORKSPACE.json");
      try {
        const stats = fs.lstatSync(workspacePath);
        if (stats.isSymbolicLink() || !stats.isFile()) {
          return fail(invocation.format, `${workspacePath} is not a regular file; refusing to replace it.`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const tempPath = `${workspacePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(tempPath, JSON.stringify(document, null, 2) + "\n", "utf8");
        fs.renameSync(tempPath, workspacePath);
      } catch (error) {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          // Report the write failure, not the cleanup failure.
        }
        throw error;
      }
    }
    emit(invocation.format, document, () => {
      info(
        "\n🗂 Workspace: " +
          records.length +
          " of " +
          members.length +
          (invocation.dryRun ? " member(s) planned; nothing was written." : " member(s) written under " + outRoot)
      );
      for (const record of records) {
        info("   - " + record.name + " (" + record.fingerprint.slice(0, 12) + ")");
      }
      for (const link of links) {
        info("   → " + link.from + " imports " + link.to + " (" + link.specifiers + " specifier(s))");
      }
    });
    return failed === 0 ? 0 : 1;
  }

  const started = performance.now();
  info(`📸 ${invocation.dryRun ? "Planning snapshot (dry run)" : "Generating snapshot"} for: ${resolved.cwd}`);
  // The header used to print the configured fallback as if it were a branch: in a directory that is
  // not a repository it read "Branch: main". Ask git once and say so when the answer is a fallback.
  const headerGit = getGitInfo(resolved.cwd, resolved.branch);
  info(
    `   Branch: ${resolved.branch}${headerGit.branchFromGit ? "" : " (fallback)"} | Part budget: ${(resolved.maxPartBytes / 1024).toFixed(0)} KB | ` +
      `Generator: ${GENERATOR_VERSION} (${generatorOrigin(resolved.cwd)})`
  );

  try {
    let deltaBase: { manifest: Manifest; path: string } | undefined;
    if (invocation.delta !== undefined) {
      const basePath = path.resolve(invocation.cwd, invocation.delta);
      const manifestPath = fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()
        ? path.join(basePath, "manifest.json")
        : basePath;
      if (!fs.existsSync(manifestPath)) {
        return fail(invocation.format, "No manifest at " + manifestPath + ". Point --delta at a snapshot directory or its manifest.json.");
      }
      let base: Manifest;
      try {
        base = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
      } catch (error) {
        return fail(invocation.format, "Could not read " + manifestPath + ": " + (error as Error).message);
      }
      const shape = describeManifestShapeProblem(base);
      if (shape !== null) {
        return fail(invocation.format, manifestPath + " is not a snapshot manifest: " + shape);
      }
      const relativeBase = path.relative(invocation.cwd, manifestPath).split(path.sep).join("/");
      const recordedBase =
        relativeBase === "" || relativeBase.startsWith("..") || path.isAbsolute(relativeBase)
          ? path.basename(manifestPath)
          : relativeBase;
      deltaBase = { manifest: base, path: recordedBase };
      info("   Delta base: " + recordedBase + " (" + base.files.length + " files, fingerprint " + base.fingerprint.slice(0, 12) + ")");
    }
    const manifest = generateSnapshot(resolved, {
      dryRun: invocation.dryRun,
      ...(sourceProvenance === undefined ? {} : { source: sourceProvenance }),
      ...(deltaBase === undefined ? {} : { deltaBase }),
      ...(invocation.budgetTokens === undefined ? {} : { budgetTokens: invocation.budgetTokens }),
      ...(invocation.slice === undefined
        ? {}
        : {
            slice: {
              question: invocation.slice,
              ...(invocation.sliceTokens === undefined
                ? {}
                : { maxTokens: invocation.sliceTokens }),
            },
          }),
      ...(invocation.sign === true && !invocation.dryRun
        ? { sign: { key: loadSigningKey() } }
        : {}),
    });
    if (invocation.sign === true && !invocation.dryRun) {
      const signaturePath = path.resolve(resolved.cwd, resolved.outDir, SIGNATURE_FILE);
      try {
        const record = JSON.parse(fs.readFileSync(signaturePath, "utf8")) as {
          keyOrigin?: string;
          fingerprint?: string;
        };
        info(
          "   Signature: ed25519, " + (record.keyOrigin ?? "unknown") + " key, " +
            (record.fingerprint ?? manifest.fingerprint).slice(0, 12)
        );
      } catch (error) {
        return fail(invocation.format, "The snapshot was written but its signature could not be read: " + (error as Error).message);
      }
    }
    const elapsed = ((performance.now() - started) / 1000).toFixed(2);

    if (invocation.dryRun) {
      info("\n🧪 Dry run — nothing was written:");
      info(`   - Would track:  ${manifest.counts.totalFiles} files`);
      info(
        `   - Would write:  ${manifest.counts.partsCount} part(s) under ${displayOutPath(resolved.cwd, resolved.outDir, "parts")}`
      );
      info(`   - Skipped:      ${manifest.counts.skippedCount} file(s)`);
      info(`   - Warnings:     ${manifest.warnings.length}`);
      if ((manifest.totals.redactedLines ?? 0) > 0) {
        info(
          `   - Redacted:     ${manifest.totals.redactedLines} line(s) — a real run lists them in ` +
            displayOutPath(resolved.cwd, resolved.outDir, "reports/audit.md")
        );
      }
      const incomplete = manifest.incomplete ?? [];
      if (incomplete.length > 0) {
        const byReason = new Map<string, number>();
        for (const record of incomplete) {
          byReason.set(record.reason, (byReason.get(record.reason) ?? 0) + 1);
        }
        const detail = [...byReason.entries()]
          .map(([reason, count]) => `${count} ${reason}`)
          .join(", ");
        info(`   - Incomplete:   ${incomplete.length} file(s) — ${detail}; see manifest.json incomplete[]`);
      }
      info(`   - Integrity:    ${manifest.validation.status}`);
      for (const error of manifest.validation.errors.slice(0, 10)) info(`     - ${error}`);
    } else {
      // A run that writes a snapshot it then fails to verify is not a success: printing a tick
      // above "Integrity: failed" made the summary contradict itself in two adjacent lines while
      // the exit code was already 1.
      info(
        manifest.validation.status === "passed"
          ? `\n✅ Snapshot generated in ${elapsed}s:`
          : `\n❌ Snapshot written, but it failed verification (${manifest.validation.errors.length} problem(s)):`
      );
      // The included count alone read as "the whole repository" while 155 tracked files went
      // out the window. The breakdown is the number the manifest already had, printed where a
      // reader forms the impression: one line, with the reasons that took the rest.
      const skipCounts = new Map<string, number>();
      for (const record of manifest.skipped) {
        skipCounts.set(record.reason, (skipCounts.get(record.reason) ?? 0) + 1);
      }
      const skipBreakdown = [...skipCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([reason, count]) => `${reason} ${formatNumber(count)}`);
      const shownReasons = skipBreakdown.slice(0, 3);
      const reasons =
        skipBreakdown.length > shownReasons.length
          ? `${shownReasons.join(", ")}, +${skipBreakdown.length - shownReasons.length} more`
          : shownReasons.join(", ");
      // "found" is the number of **paths** the scan accounted for, and a skipped directory is one
      // of them: the line used to call them files, so a repository with gitignored directories
      // reported more files than it contains. The count is right; the noun was not.
      const candidates = manifest.counts.totalFiles + manifest.counts.skippedCount;
      info(
        manifest.counts.skippedCount === 0
          ? `   - Tracked files: ${formatNumber(manifest.counts.totalFiles)}`
          : `   - Tracked files: ${formatNumber(manifest.counts.totalFiles)} included of ` +
              `${formatNumber(candidates)} paths found — ${formatNumber(manifest.counts.skippedCount)} skipped ` +
              `(${reasons}); every one is listed in ` +
              `${displayOutPath(resolved.cwd, resolved.outDir, "reports/audit.md")}`
      );
      info(`   - Total lines:   ${formatNumber(manifest.counts.totalLines)}`);
      info(
        `   - Total size:    ${(manifest.counts.totalSizeBytes / (1024 * 1024)).toFixed(2)} MB`
      );
      // Only claim what this run actually wrote: `--skip-artifacts`/`--only-artifacts`
      // used to leave the summary naming reports and a manifest that do not exist.
      const { artifacts } = resolved;
      if (artifacts.parts) {
        info(
          `   - Parts written: ${manifest.counts.partsCount} under ${displayOutPath(resolved.cwd, resolved.outDir, "parts")}`
        );
      }
      const reports = [
        artifacts.projectTree && "project-tree",
        artifacts.navigation && "navigation",
        artifacts.audit && "audit",
        // `--sarif` writes beside the audit rather than inside `artifacts`, so it is listed
        // here by hand. Without it a run that produced `reports/audit.sarif` still reported
        // that every artifact was disabled and only the ownership marker had been written.
        resolved.sarif === true && "audit.sarif",
      ].filter(Boolean);
      if (reports.length > 0) {
        info(
          `   - Reports:       ${displayOutPath(resolved.cwd, resolved.outDir, "reports")} (${reports.join(", ")})`
        );
      }
      if (artifacts.manifest) {
        info(`   - Manifest:      ${displayOutPath(resolved.cwd, resolved.outDir, "manifest.json")}`);
      }
      if (artifacts.monolith) {
        const monolithFiles = [
          manifest.artifacts?.fullJson ? "full-codebase.json" : null,
          manifest.artifacts?.fullMarkdown ? "full-codebase.md" : null,
        ].filter((name): name is string => name !== null);
        // `--max-monolith-bytes` can skip one or both files, and the summary used
        // to promise both regardless: it may only list what is on disk.
        if (monolithFiles.length === 2) {
          info(
            `   - Monolith:      ${displayOutPath(resolved.cwd, resolved.outDir, "full-codebase.{json,md}")}`
          );
        } else if (monolithFiles.length === 1) {
          info(
            `   - Monolith:      ${displayOutPath(resolved.cwd, resolved.outDir, monolithFiles[0])} ` +
              "(the other was skipped by --max-monolith-bytes)"
          );
        }
      }
      // README.md and PROMPT.md are prose, not payload, so they were never listed — which meant
      // a run that wrote both and nothing else reported that it had written only the marker.
      const orientation = [
        artifacts.readme ? "README.md" : null,
        artifacts.prompt ? "PROMPT.md" : null,
      ].filter((name): name is string => name !== null);
      if (orientation.length > 0) {
        info(
          `   - Orientation:   ${orientation
            .map((name) => displayOutPath(resolved.cwd, resolved.outDir, name))
            .join(", ")}`
        );
      }
      if (
        reports.length === 0 &&
        !artifacts.parts &&
        !artifacts.manifest &&
        !artifacts.monolith &&
        orientation.length === 0
      ) {
        info(`   - Artifacts:     all disabled (only the ownership marker was written)`);
      }
      info(`   - Fingerprint:   ${manifest.fingerprint}`);
      info(`   - Integrity:     ${manifest.validation.status}`);
      // Redaction is the tool working, not something to fix, so it is not counted as a warning —
      // and the count alone is useless without saying where the per-line detail went.
      if ((manifest.totals.redactedLines ?? 0) > 0) {
        const where = artifacts.audit
          ? `see ${displayOutPath(resolved.cwd, resolved.outDir, "reports/audit.md")}`
          : "reports/audit.md is disabled";
        info(`   - Redacted:      ${manifest.totals.redactedLines} line(s) — values masked; ${where}`);
      }
      if (manifest.warnings.length > 0) {
        info(`   - Warnings:      ${manifest.warnings.length}`);
        for (const warning of manifest.warnings.slice(0, 10)) info(`     - ${warning}`);
        // The summary shows ten; the rest are in the manifest under the same key. Printing the
        // count and ten rows without this line is what made 156 findings look unexplained.
        if (manifest.warnings.length > 10) {
          info(`     … and ${manifest.warnings.length - 10} more in manifest.warnings[]`);
        }
      }
    }

    if (invocation.format === "json") {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    }

    if (invocation.watch) {
      return await runWatchLoop(invocation, resolved, { generatedAlready: true });
    }

    return manifest.validation.status === "passed" ? 0 : 1;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      return fail(
        invocation.format,
        `Cannot write the snapshot: permission denied under ${resolved.outDir}. ` +
          `Check the directory's permissions or choose another --out-dir. ` +
          `(${(err as Error).message})`
      );
    }
    return fail(invocation.format, `Failed to generate snapshot: ${(err as Error).message}`);
  }
}

/** Coalesce bursts of filesystem events into one run. */
export const WATCH_DEBOUNCE_MS = 250;
/**
 * Unattributed watcher events (no filename) are ignored this long after a run.
 * Named source events are never ignored: that is how an edit in the quiet
 * window or during a run reaches the loop.
 */
export const WATCH_SETTLE_MS = 1500;

/** Version-control metadata is written by our own git probes; ignore it. */
const VCS_SEGMENTS = new Set([".git", ".hg", ".svn", ".bzr"]);

export interface WatchState {
  running: boolean;
  pending: boolean;
  settleUntil: number;
}

export interface WatchPaths {
  cwd: string;
  outDir: string;
  tmpDir: string;
}

export interface WatchEvent {
  /** Absolute path, or null when `fs.watch` did not attribute the event. */
  path: string | null;
  /** `performance.now()` at delivery. */
  now: number;
}

export type WatchAction = "ignore" | "pending" | "schedule";

export interface WatchDecision {
  state: WatchState;
  action: WatchAction;
}

export function initialWatchState(): WatchState {
  return { running: false, pending: false, settleUntil: 0 };
}

export function beginWatchRun(state: WatchState): WatchState {
  return { ...state, running: true, pending: false };
}

/**
 * Finish one run. `schedule` is true when a source event arrived while the run
 * was in flight, so exactly one follow-up run is owed.
 */
export function finishWatchRun(
  state: WatchState,
  now: number
): { state: WatchState; schedule: boolean } {
  return {
    state: { running: false, pending: false, settleUntil: now + WATCH_SETTLE_MS },
    schedule: state.pending,
  };
}

function comparablePath(value: string): string {
  const absolute = path.resolve(value);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isSameOrInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * True only for the resolved output/staging paths and their contents.
 *
 * This deliberately does not match a directory just because its basename is
 * `docs`: a source directory `src/docs` is not the output directory `docs`.
 */
export function isGeneratedWatchPath(candidate: string, paths: WatchPaths): boolean {
  const absolute = comparablePath(path.resolve(paths.cwd, candidate));
  const outDir = comparablePath(path.resolve(paths.cwd, paths.outDir));
  const tmpDir = comparablePath(path.resolve(paths.cwd, paths.tmpDir));

  if (isSameOrInside(outDir, absolute) || isSameOrInside(tmpDir, absolute)) return true;

  // The atomic swap renames the previous output to `<outDir>.backup-<pid>-<time>` before installing
  // the new directory, and on a cross-device swap it copies the staging tree to
  // `<outDir>.partial-<pid>-<time>` first. Both are this tool's own writes. Two things were wrong
  // here: the `.partial-` form was not recognised at all, and the test only looked at the candidate
  // path itself, so an event for `part-001.md` *inside* the copy was never matched — which is
  // exactly the event `cpSync` produces. `--watch` saw its own copy being filled, called it a source
  // edit, and regenerated on every pass. The names come from the resolved output/staging
  // directories, so a custom `outDir` is covered too.
  const offsets = [path.basename(outDir), path.basename(tmpDir)].filter((name) => name.length > 0);
  const leftover = absolute.split(/[\\/]+/).some((segment) =>
    offsets.some(
      (name) => segment.startsWith(`${name}.backup-`) || segment.startsWith(`${name}.partial-`)
    )
  );
  if (leftover) return true;

  return absolute
    .split(/[\\/]+/)
    .some((segment) => VCS_SEGMENTS.has(segment));
}

/**
 * Decide what one watcher event means.
 *
 * - generated paths are always ignored;
 * - a named source event is `pending` during a run and `schedule` otherwise,
 *   including inside the settle window (an edit is never swallowed);
 * - an unattributed event is ignored during a run and for the settle window,
 *   because Windows does not always name the path our own writes produced.
 */
export function decideWatchEvent(
  state: WatchState,
  event: WatchEvent,
  paths: WatchPaths
): WatchDecision {
  if (event.path !== null) {
    if (isGeneratedWatchPath(event.path, paths)) return { state, action: "ignore" };
  } else if (state.running || event.now < state.settleUntil) {
    return { state, action: "ignore" };
  }

  if (state.running) {
    return { state: { ...state, pending: true }, action: "pending" };
  }
  return { state, action: "schedule" };
}

/**
 * The directories the watcher must ignore, derived from a resolved config.
 *
 * A function rather than an inline literal because the loop now recomputes it after every config
 * reload: a watcher that keeps the `outDir` it started with treats the new one as user content,
 * regenerates, writes, sees that write, and never settles.
 */
export function watchPathsFor(config: ResolvedSnapshotConfig): WatchPaths {
  return {
    cwd: config.cwd,
    outDir: path.resolve(config.cwd, config.outDir),
    tmpDir: path.resolve(config.cwd, config.tmpDir),
  };
}

/**
 * Why `--watch` cannot work here, or `null` when it can.
 *
 * `fs.watch(dir, { recursive: true })` is only available on Linux from Node 20.13: before that it
 * throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. The package declares `engines: >=18`, so a user can
 * legitimately be running a Node that cannot honour this flag — and what they got was an uncaught
 * exception *after* the first snapshot had been written and "Watching for changes" printed, which
 * reads as a broken tool rather than as a version requirement.
 *
 * The platform and version are parameters so the boundary is testable off the machine that happens
 * to run the tests: this is the kind of check that is written on one OS and shipped broken to
 * another, which is precisely how it went unnoticed.
 */
export function watchSupportProblem(
  platform: string = process.platform,
  version: string = process.versions.node
): string | null {
  // macOS and Windows have had a recursive watcher for years.
  if (platform !== "linux") return null;
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major)) return null;
  if (major > 20 || (major === 20 && (minor ?? 0) >= 13)) return null;
  return (
    "--watch needs recursive directory watching, which Node only provides on Linux from 20.13 " +
    `(this is ${version}). Re-run \`generate\` after each change, or upgrade to Node 20.13 or ` +
    "later."
  );
}

/**
 * Re-generates on every change under `cwd`.
 *
 * Events inside the resolved output and temporary directories are ignored, so
 * writing a snapshot cannot feed the watcher. A source event that arrives while
 * a run is in flight sets a pending flag and gets exactly one follow-up run;
 * the settle window only suppresses unattributed events.
 */
async function runWatchLoop(
  invocation: ParsedInvocation,
  resolved: ResolvedSnapshotConfig,
  options: { generatedAlready: boolean }
): Promise<number> {
  // Reassigned by every regeneration. The directories are resolved again from the freshly
  // loaded config, because `isGeneratedWatchPath` uses them to ignore this tool's own output —
  // and a watcher that keeps pointing at the *old* `outDir` after the config moved it sees the
  // new one as user content, regenerates, writes, sees that write, regenerates again, and never
  // stops. `cwd` cannot move: the watcher is rooted there.
  let paths: WatchPaths = watchPathsFor(resolved);
  let state = initialWatchState();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = (delay = WATCH_DEBOUNCE_MS): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void regenerate();
    }, delay);
  };

  const regenerate = async (): Promise<void> => {
    if (state.running) {
      state = { ...state, pending: true };
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return;
    }
    state = beginWatchRun(state);
    const started = performance.now();
    try {
      // A watcher that keeps the config it started with regenerates with stale
      // settings: editing snapshot.config above a watched repository appeared to
      // work (the run happened, the config file's own hash updated) while the
      // budget and scoping stayed at the old values. Reload on every run.
      // `--no-config` promises the config is ignored. The watch loop reloaded it anyway,
      // executing repository code and applying its filters while printing that it did not.
      const loaded = invocation.noConfig
        ? { config: null, warnings: [], errors: [], file: null }
        : await loadConfigFileDetailed(invocation.cwd);
      if (loaded.errors.length > 0) {
        for (const error of loaded.errors) warn(`⚠ Config: ${error}`);
        warn("❌ The config file could not be read. Fix it, or delete it to use the defaults.");
        return;
      }
      for (const warning of loaded.warnings) warn(`⚠ Config: ${warning}`);
      const next = resolveConfig(
        loaded.config,
        generateCliOptions(invocation),
        invocation.cwd
      );
      const manifest = generateSnapshot(next, {
        dryRun: invocation.dryRun,
        ...(invocation.budgetTokens === undefined
          ? {}
          : { budgetTokens: invocation.budgetTokens }),
        ...(invocation.slice === undefined
          ? {}
          : {
              slice: {
                question: invocation.slice,
                ...(invocation.sliceTokens === undefined
                  ? {}
                  : { maxTokens: invocation.sliceTokens }),
              },
            }),
        ...(invocation.sign === true && !invocation.dryRun
          ? { sign: { key: loadSigningKey() } }
          : {}),
      });
      // The output directories may have moved in the config that was just reloaded.
      paths = watchPathsFor(next);
      const elapsed = ((performance.now() - started) / 1000).toFixed(2);
      info(
        `♻️  ${new Date().toISOString()}  ${manifest.counts.totalFiles} file(s), ` +
          `${manifest.counts.partsCount} part(s), ${manifest.validation.status} (${elapsed}s)`
      );
    } catch (err) {
      warn(`❌ ${(err as Error).message}`);
    } finally {
      const finished = finishWatchRun(state, performance.now());
      state = finished.state;
      if (finished.schedule) schedule(0);
    }
  };

  info("👀 Watching for changes. Press Ctrl+C to stop.");
  // `generate --watch` has already produced the snapshot before entering the loop. Regenerating
  // here ran the whole scan a second time before any file had changed, which doubled the startup
  // cost of the command and printed two summaries for one invocation.
  if (!options.generatedAlready) void regenerate();

  // The watcher can refuse to start at all. `fs.watch` throws rather than emitting `error` for a
  // missing feature (see `watchSupportProblem`) and for ENOSPC — the Linux inotify watch limit,
  // which a large repository or a busy machine can reach on a Node that *does* support the
  // feature. Both used to arrive as an uncaught exception after the snapshot had been written.
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(resolved.cwd, { recursive: true }, (_event, filename) => {
      const decision = decideWatchEvent(
        state,
        {
          path: filename ? path.resolve(resolved.cwd, filename.toString()) : null,
          now: performance.now(),
        },
        paths
      );
      state = decision.state;
      if (decision.action === "pending") {
        // The run that is in flight will schedule the single follow-up when it
        // finishes; a debounce timer now would be consumed by the early return.
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
      if (decision.action === "schedule") schedule();
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const detail =
      code === "ENOSPC"
        ? "the operating system's file-watch limit is exhausted; raise it " +
          "(`fs.inotify.max_user_watches` on Linux) or run `generate` by hand"
        : code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"
          ? (watchSupportProblem() ?? "this platform has no recursive directory watching")
          : (err as Error).message;
    warn(`❌ Could not start watching ${resolved.cwd}: ${detail}`);
    warn("   The snapshot that was just written is complete and valid.");
    return 1;
  }

  // An `fs.watch` handle emits `error` instead of throwing: EPERM when a watched
  // directory is removed on Windows, ENOSPC when the Linux inotify watch limit is hit.
  // With no listener, Node treats that as an unhandled event and kills the process — so
  // a watch that had been running fine stopped with a stack trace and no snapshot, which
  // is the one thing a long-running watcher must not do. The loop keeps running and says
  // what happened; a later event still triggers a regeneration.
  watcher.on("error", (err: Error) => {
    info(`⚠ Watch error: ${err.message}`);
    info("   The watcher may have missed changes. Restart with Ctrl+C if they stop arriving.");
  });

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      stopped = true;
      if (timer) clearTimeout(timer);
      watcher.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  return 0;
}

/**
 * This module has no side effects: importing `codebase-snapshot/cli`
 * exposes `main` and the argument parser without running anything. The
 * executable entry point is `src/bin.ts`.
 */

/**
 * Run when this file is executed directly.
 *
 * `dist/bin.js` calls `main()`, but a stale `node_modules/.bin` shim from an earlier
 * install can point at `dist/cli.js`. Importing that module to do nothing and exit 0
 * looked exactly like a successful run with no output.
 */
const entryFile = process.argv[1] ?? "";
const entryName = path.basename(entryFile).toLowerCase();
const invokedDirectly = entryName === "cli.js" || entryName === "cli.cjs";

if (invokedDirectly) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`❌ ${(err as Error).message}` + "\n");
      process.exitCode = 1;
    }
  );
}
