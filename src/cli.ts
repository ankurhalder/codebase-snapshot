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
import { GENERATOR_NAME, GENERATOR_VERSION, MIN_MAX_PART_BYTES, generateSnapshot } from "./index.js";
import {
  describeManifestShapeProblem,
  validateSnapshot,
} from "./validator/validate.js";
import { getPreset, unknownPresetMessage } from "./presets/index.js";
import { isDiscoveryMode, type DiscoveryMode } from "./scanner/files.js";
import { buildAgentContract, renderContractText } from "./agent/contract.js";
import type { SkillTarget } from "./agent/install-skill.js";
import { SKILL_TARGETS, installSkill, isSkillTarget } from "./agent/install-skill.js";
import { SKILL_NAME, renderSkill } from "./agent/skill.js";
import type { CommandName } from "./agent/option-scope.js";
import { COMMAND_OPTION_SCOPE, commandsForOption } from "./agent/option-scope.js";
import type { CliOptions, Manifest, Mode, OutputFormat, ResolvedSnapshotConfig } from "./types.js";
import { escapeControls, formatNumber } from "./terminal.js";

const VERSION = GENERATOR_VERSION;

/** How long `setup` waits for the dependency install before reporting it as failed. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

type Command =
  | "generate"
  | "validate"
  | "report"
  | "init"
  | "setup"
  | "explain"
  | "diff"
  | "describe"
  | "skill";

const COMMAND_ALIASES = new Map<string, Command>([
  ["generate", "generate"],
  ["validate", "validate"],
  ["check", "validate"],
  ["report", "report"],
  ["init", "init"],
  ["setup", "setup"],
  ["explain", "explain"],
  ["diff", "diff"],
  ["describe", "describe"],
  ["skill", "skill"],
]);

/** How many positional arguments each command accepts after its name. */
const COMMAND_ARITY: Record<Command, number> = {
  generate: 0,
  validate: 0,
  report: 0,
  init: 0,
  setup: 0,
  explain: 1,
  diff: 2,
  describe: 0,
  skill: 0,
};

const CLI_OPTIONS = {
  cwd: { type: "string" },
  "out-dir": { type: "string" },
  "max-part-bytes": { type: "string" },
  "large-file-bytes": { type: "string" },
  "max-monolith-bytes": { type: "string" },
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
  preset: { type: "string" },
  include: { type: "string" },
  exclude: { type: "string" },
  yes: { type: "boolean" },
  force: { type: "boolean" },
  autopilot: { type: "boolean" },
  install: { type: "boolean" },
  "no-install": { type: "boolean" },
  target: { type: "string" },
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
  init                 Generate a starter snapshot.config file
  report               Print codebase health, layer metrics, and secret audit
  explain <path>       Show how one path would be treated: layer, kind, part, skips
  diff <a> <b>         Compare two snapshots (directories or manifest.json files)
  describe             Print the machine-readable contract (--format json for agents)
  skill                Print the bundled agent skill; --install writes it into the repo

Options:
  --cwd <path>                  Target repository directory (default: current directory)
  --out-dir <path>              Snapshot output directory (default: snapshot)
  --include-monolith            Also generate full-codebase.json and full-codebase.md
  --max-monolith-bytes <n>      Skip monolith artefacts larger than n bytes
  --max-part-bytes <n>          Maximum byte budget per markdown part (default: 307200).
                                Accepts units: 120k, 1.5mb
  --large-file-bytes <n>        Threshold for head/tail truncation (default: 204800)
  --include-sensitive-files     Emit .env / *.pem / .npmrc / credential files
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

  setup only:
  --no-install                  Skip installing the dependency before generating
  --preset / --include / --exclude / --force   As for init

  skill only:
  --install                     Write the skill into the repository instead of printing
  --target <name>               claude | cursor | all (default: all)

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
  largeFileBytes?: number;
  maxMonolithBytes?: number | null;
  skipArtifacts?: string[];
  /** How candidates are discovered; `auto` when unset. */
  discovery?: DiscoveryMode;
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
  minimum: number
): number | undefined {
  if (raw === undefined) return undefined;
  const value = parseByteSize(raw);
  if (value === undefined || !Number.isSafeInteger(value)) {
    throw new UsageError(
      `--${optionName} expects a byte count such as 120000 or "120k", received "${raw}".`
    );
  }
  if (value < minimum) {
    throw new UsageError(`--${optionName} must be at least ${minimum}, received "${raw}".`);
  }
  return value;
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

/**
 * Parses argv.
 *
 * Uses `node:util.parseArgs` in strict mode, so `--option=value` works, unknown
 * flags are rejected instead of silently ignored, and a typo can no longer fall
 * through to the writable `generate` command.
 */
export function parseCliArgs(argv: string[]): ParsedInvocation {
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

  if (firstPositional !== undefined) {
    const resolved = COMMAND_ALIASES.get(firstPositional);
    if (!resolved) {
      throw new UsageError(
        `Unknown command "${firstPositional}". Expected one of: ${Array.from(COMMAND_ALIASES.keys()).join(", ")}.`
      );
    }
    command = resolved;
    args = positionals.slice(1);
  } else if (explicitMode !== undefined) {
    const resolved = COMMAND_ALIASES.get(explicitMode);
    if (!resolved) {
      throw new UsageError(
        `Unknown --mode "${explicitMode}". Expected one of: ${Array.from(COMMAND_ALIASES.keys()).join(", ")}.`
      );
    }
    command = resolved;
  }

  // `generate --mode validate` used to run generate and ignore the flag; `--mode bogus`
  // with a command word was accepted too. A mode that contradicts the command is a
  // usage error, and an unknown mode is an error either way.
  if (explicitMode !== undefined) {
    const resolvedMode = COMMAND_ALIASES.get(explicitMode);
    if (!resolvedMode) {
      throw new UsageError(
        `Unknown --mode "${explicitMode}". Expected one of: ${Array.from(COMMAND_ALIASES.keys()).join(", ")}.`
      );
    }
    if (firstPositional !== undefined && resolvedMode !== command) {
      throw new UsageError(
        `--mode ${explicitMode} contradicts the command "${firstPositional}". Pass one or the other.`
      );
    }
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
  if (rawOnly !== undefined) {
    const keep = parseArtifactList(String(rawOnly), "--only-artifacts");
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
    const hint = ignored.some((flag) => ["--preset", "--include", "--exclude"].includes(flag))
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
  if (command === "init" && values.preset !== undefined) {
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
    skipArtifacts,
    discovery: isDiscoveryMode(rawDiscovery) ? rawDiscovery : undefined,
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
      const parsed = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as {
        scripts?: Record<string, unknown>;
      };
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

async function runInitCommand(invocation: ParsedInvocation): Promise<number> {  try {
    const result = await runInit({
      cwd: invocation.cwd,
      preset: invocation.preset,
      outDir: invocation.outDir,
      maxPartBytes: invocation.maxPartBytesRaw ?? invocation.maxPartBytes,
      include: splitList(invocation.include),
      exclude: splitList(invocation.exclude),
      skipArtifacts: invocation.skipArtifacts,
      includeSensitiveFiles: invocation.includeSensitiveFiles,
      yes: invocation.yes,
      force: invocation.force,
      dryRun: invocation.dryRun,
    });

    if (invocation.format === "json") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    if (!result.written) {
      info(result.configText);
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
    for (const note of result.notes) info(`   ⚠ ${note}`);
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

/** One package manager and the command that installs the declared dependencies. */
interface PackageManager {
  name: string;
  command: string;
  args: string[];
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
    if (/^npm_config_/i.test(key)) continue;
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
  const result = spawnSync(manager.command, manager.args, {
    cwd,
    encoding: "utf8",
    // npm, pnpm and yarn ship as `.cmd` shims on Windows, which spawnSync cannot exec directly.
    shell: process.platform === "win32",
    timeout: INSTALL_TIMEOUT_MS,
    env: cleanInstallEnv(),
  });
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
 * Runs `fn` with stdout captured.
 *
 * `setup` generates through the normal `generate` command so every guard, summary line and JSON
 * document is byte-for-byte what a plain generate produces; capturing lets it merge that document
 * into the one `setup` owes a machine consumer instead of printing two.
 */
async function captureStdout(fn: () => Promise<number>): Promise<{ code: number; text: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let text = "";
  process.stdout.write = ((chunk: unknown): boolean => {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await fn();
    return { code, text };
  } finally {
    process.stdout.write = original;
  }
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
      include: splitList(invocation.include),
      exclude: splitList(invocation.exclude),
      skipArtifacts: invocation.skipArtifacts,
      includeSensitiveFiles: invocation.includeSensitiveFiles,
      yes: !interactive,
      force: invocation.force,
      reuseConfig: true,
      dryRun: invocation.dryRun,
    });

    if (invocation.dryRun) {
      const manager = invocation.noInstall ? null : detectPackageManager(invocation.cwd).name;
      if (invocation.format === "json") {
        process.stdout.write(
          `${JSON.stringify(
            {
              dryRun: true,
              configPath: init.configPath,
              configReused: init.reused,
              preset: init.preset,
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
        `   1. ${init.reused ? `keep ${path.basename(init.configPath)}` : `write ${path.basename(init.configPath)} (preset: ${init.preset})`}`
      );
      info("   2. add the npm scripts, the devDependency and the .gitignore entries");
      if (manager !== null) info(`   3. install with ${manager}`);
      info("   4. generate the snapshot");
      info("");
      info(init.configText);
      return 0;
    }

    if (invocation.format !== "json") {
      // The interactive path already introduced itself and printed the directory, so the
      // banner would be a second header for the same run.
      if (!interactive) info(`🚀 Setup for: ${invocation.cwd}`);
      if (init.reused) {
        info(`♻  Keeping ${path.basename(init.configPath)} (${presetSummary(init)})`);
      } else {
        info(`✅ Created ${path.basename(init.configPath)} (${presetSummary(init)})`);
      }
      if (init.scripts.length > 0) info(`   Added npm scripts: ${init.scripts.join(", ")}`);
      if (init.dependency.added && init.dependency.range !== null) {
        info(`   Added devDependency: ${init.dependency.name} ${init.dependency.range}`);
      }
      if (init.gitignoreEntries.length > 0) {
        info(`   Added to .gitignore: ${init.gitignoreEntries.join(", ")}`);
      }
    }

    let install: InstallOutcome | null = null;
    if (invocation.noInstall) {
      if (invocation.format !== "json") info("   Skipped the install (--no-install)");
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
    if ((invocation.skipArtifacts ?? []).length > 0) {
      generateArgs.push("--skip-artifacts", (invocation.skipArtifacts ?? []).join(","));
    }
    // `--watch` reaches setup only from a first-run `snapshot --watch`, where dropping it would
    // silently downgrade the run to a single generation.
    if (invocation.watch) generateArgs.push("--watch");

    if (invocation.format === "json") {
      const generated = await captureStdout(() => main(generateArgs));
      let manifest: unknown = null;
      try {
        manifest = JSON.parse(generated.text);
      } catch {
        manifest = null;
      }
      process.stdout.write(
        `${JSON.stringify(
          {
            setup: {
              configPath: init.configPath,
              configReused: init.reused,
              preset: init.preset,
              scripts: init.scripts,
              dependency: init.dependency,
              gitignoreEntries: init.gitignoreEntries,
              install,
              notes: init.notes,
            },
            manifest,
          },
          null,
          2
        )}\n`
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

function renderValidateText(result: ReturnType<typeof validateSnapshot>): void {  if (result.valid) {
    info("✅ Snapshot is valid and up to date with disk.");
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

/** Runs the CLI and returns the process exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
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

  // `diff` compares two manifests and never needs a repository config; importing one would
  // execute repository code to answer a question about files. --no-config also skips it.
  const skipConfig = invocation.noConfig || invocation.command === "diff";
  const loaded = skipConfig
    ? { config: null, warnings: [], errors: [], file: null }
    : await loadConfigFileDetailed(invocation.cwd);
  if (invocation.noConfig) info("⚙  --no-config: using built-in defaults, config file ignored");
  for (const warning of loaded.warnings) warn(`⚠ Config: ${warning}`);
  if (loaded.errors.length > 0) {
    // A config that exists but cannot be read must not silently fall back to the
    // defaults: the resulting snapshot would ignore every setting the developer
    // wrote and still report success.
    warn("❌ The config file could not be read. Fix it, or delete it to use the defaults.");
    return 1;
  }
  if (loaded.file) info(`⚙  Using config ${path.relative(process.cwd(), loaded.file) || loaded.file}`);

  const resolved = resolveConfig(
    loaded.config,
    {
      mode: invocation.command as Mode,
      format: invocation.format,
      dryRun: invocation.dryRun,
      cwd: invocation.cwd,
      outDir: invocation.outDir,
      includeMonolith: invocation.includeMonolith,
      includeSensitiveFiles: invocation.includeSensitiveFiles,
      maxPartBytes: invocation.maxPartBytes,
      largeFileBytes: invocation.largeFileBytes,
      maxMonolithBytes: invocation.maxMonolithBytes,
      skipArtifacts: invocation.skipArtifacts,
      discovery: invocation.discovery,
    } as Partial<CliOptions> & { discovery?: DiscoveryMode },
    invocation.cwd
  );

  if (invocation.command === "validate") {
    const result = validateSnapshot(resolved);
    // A manifest can parse, carry every array the validator needs, and still be nonsense in the
    // fields it treats as opaque: `fingerprint: "12345"` passed as "valid and up to date". The
    // shape check runs only for a result that claims to be valid, so an invalid result keeps the
    // more specific answer it already has.
    if (result.valid) {
      const manifestPath = path.resolve(resolved.cwd, resolved.outDir, "manifest.json");
      let manifest: unknown;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch {
        manifest = undefined; // unreadable or unparseable: `validateSnapshot` already said so
      }
      const shapeError = manifest === undefined ? null : describeManifestShapeProblem(manifest);
      if (shapeError) {
        return fail(invocation.format, `${manifestPath} is not a snapshot manifest: ${shapeError}`);
      }
    }
    emit(invocation.format, result, () => renderValidateText(result));
    return result.valid ? 0 : 1;
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
      const diff = compareManifests(loadManifest(beforePath), loadManifest(afterPath));
      emit(invocation.format, diff, () => info(renderDiffText(diff)));
      return 0;
    } catch (err) {
      return fail(invocation.format, (err as Error).message);
    }
  }

  const started = performance.now();
  info(`📸 ${invocation.dryRun ? "Planning snapshot (dry run)" : "Generating snapshot"} for: ${resolved.cwd}`);
  info(
    `   Branch: ${resolved.branch} | Part budget: ${(resolved.maxPartBytes / 1024).toFixed(0)} KB`
  );

  try {
    const manifest = generateSnapshot(resolved, { dryRun: invocation.dryRun });
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
      info(`   - Integrity:    ${manifest.validation.status}`);
      for (const error of manifest.validation.errors.slice(0, 10)) info(`     - ${error}`);
    } else {
      info(`\n✅ Snapshot generated in ${elapsed}s:`);
      info(`   - Tracked files: ${manifest.counts.totalFiles}`);
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
      if (reports.length === 0 && !artifacts.parts && !artifacts.manifest && !artifacts.monolith) {
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
      return await runWatchLoop(invocation, resolved);
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

  // The atomic swap renames the previous output to `<outDir>.backup-<pid>-<time>`
  // before installing the new directory.
  const parent = path.dirname(absolute);
  if (
    parent === path.dirname(outDir) &&
    path.basename(absolute).startsWith(`${path.basename(outDir)}.backup-`)
  ) {
    return true;
  }

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
 * Re-generates on every change under `cwd`.
 *
 * Events inside the resolved output and temporary directories are ignored, so
 * writing a snapshot cannot feed the watcher. A source event that arrives while
 * a run is in flight sets a pending flag and gets exactly one follow-up run;
 * the settle window only suppresses unattributed events.
 */
async function runWatchLoop(
  invocation: ParsedInvocation,
  resolved: ResolvedSnapshotConfig
): Promise<number> {
  const outDir = path.resolve(resolved.cwd, resolved.outDir);
  const tmpDir = path.resolve(resolved.cwd, resolved.tmpDir);

  const paths: WatchPaths = { cwd: resolved.cwd, outDir, tmpDir };
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
        {
          mode: invocation.command as Mode,
          format: invocation.format,
          dryRun: invocation.dryRun,
          cwd: invocation.cwd,
          outDir: invocation.outDir,
          includeMonolith: invocation.includeMonolith,
          includeSensitiveFiles: invocation.includeSensitiveFiles,
          maxPartBytes: invocation.maxPartBytes,
          largeFileBytes: invocation.largeFileBytes,
          maxMonolithBytes: invocation.maxMonolithBytes,
          skipArtifacts: invocation.skipArtifacts,
          discovery: invocation.discovery,
        } as Partial<CliOptions> & { discovery?: DiscoveryMode },
        invocation.cwd
      );
      const manifest = generateSnapshot(next, { dryRun: invocation.dryRun });
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
  void regenerate();

  const watcher = fs.watch(resolved.cwd, { recursive: true }, (_event, filename) => {
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
