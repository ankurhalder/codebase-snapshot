import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { compareManifests, loadManifest, renderDiffText } from "./diff.js";
import { explainPath, renderExplainText } from "./explain.js";
import { ARTIFACT_NAMES, loadConfigFileDetailed, parseByteSize, resolveConfig } from "./config.js";
import { runInit } from "./wizard/init.js";
import { PromptCancelled } from "./wizard/prompts.js";
import { GENERATOR_NAME, GENERATOR_VERSION, MIN_MAX_PART_BYTES, generateSnapshot } from "./index.js";
import { validateSnapshot } from "./validator/validate.js";
import { getPreset, unknownPresetMessage } from "./presets/index.js";
import { buildAgentContract, renderContractText } from "./agent/contract.js";
import type { SkillTarget } from "./agent/install-skill.js";
import { SKILL_TARGETS, installSkill, isSkillTarget } from "./agent/install-skill.js";
import { SKILL_NAME, renderSkill } from "./agent/skill.js";
import type { Manifest, Mode, OutputFormat, ResolvedSnapshotConfig } from "./types.js";

const VERSION = GENERATOR_VERSION;

type Command =
  | "generate"
  | "validate"
  | "report"
  | "init"
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
  preset: { type: "string" },
  include: { type: "string" },
  exclude: { type: "string" },
  yes: { type: "boolean" },
  minimal: { type: "boolean" },
  force: { type: "boolean" },
  install: { type: "boolean" },
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

Commands:
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

  init only:
  --preset <name>               Force a project preset instead of detecting one
  --include <globs>             Comma-separated allow-list
  --exclude <globs>             Comma-separated exclude patterns
  --minimal                     Write only the settings that differ from defaults
  --yes                         Accept every default without prompting
  --force                       Overwrite an existing config

  skill only:
  --install                     Write the skill into the repository instead of printing
  --target <name>               claude | agents | cursor | all (default: all)

  -h, --help                    Display this help message
  -v, --version                 Display version

All options also accept the --option=value form.
Human-readable progress is written to stderr; payloads (--format json) go to stdout.
Agents with no prior knowledge of this tool should start with: describe --format json
`.trim();

interface ParsedInvocation {
  command: Command;
  /** Positional arguments that follow the command name. */
  args: string[];
  format: OutputFormat;
  dryRun: boolean;
  watch: boolean;
  preset?: string;
  /** The size exactly as typed, so the generated config can keep `120k`. */
  maxPartBytesRaw?: string;
  include?: string;
  exclude?: string;
  yes: boolean;
  minimal: boolean;
  force: boolean;
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

  const rawSkip = values["skip-artifacts"];
  const rawOnly = values["only-artifacts"];
  if (rawSkip !== undefined && rawOnly !== undefined) {
    throw new UsageError("--skip-artifacts and --only-artifacts cannot be combined.");
  }
  let skipArtifacts: string[] | undefined;
  if (rawOnly !== undefined) {
    const keep = parseArtifactList(String(rawOnly), "--only-artifacts");
    skipArtifacts = (ARTIFACT_NAMES as ReadonlyArray<string>).filter(
      (name) => !keep.includes(name)
    );
  } else if (rawSkip !== undefined) {
    skipArtifacts = parseArtifactList(String(rawSkip), "--skip-artifacts");
  }

  // These configure `init`, which writes them into the config file. They are not
  // runtime overrides — `resolveConfig` reads scoping and presets from the config
  // file only. Accepting them silently here would leave the developer believing a
  // --preset or --include took effect when the run used the detected defaults.
  if (command !== "init") {
    const initOnly: string[] = [];
    if (values.preset !== undefined) initOnly.push("--preset");
    if (values.include !== undefined) initOnly.push("--include");
    if (values.exclude !== undefined) initOnly.push("--exclude");
    if (values.yes === true) initOnly.push("--yes");
    if (values.minimal === true) initOnly.push("--minimal");
    if (values.force === true) initOnly.push("--force");
    if (initOnly.length > 0) {
      throw new UsageError(
        `${initOnly.join(", ")} ${initOnly.length === 1 ? "is" : "are"} only valid with \`init\`. ` +
          `To scope \`${command}\`, set include/excludePatterns/preset in snapshot.config.ts ` +
          `(or run \`codebase-snapshot init\` to generate one).`
      );
    }
  }

  // `init --preset <typo>` used to fall back to detection and write a config for
  // a preset nobody asked for, while still exiting 0. The docs promise a usage
  // error listing every valid preset, so validate the name here (exit 2) rather
  // than letting it surface later as a generic failure.
  if (command === "init" && values.preset !== undefined) {
    const requested = String(values.preset);
    if (!getPreset(requested)) throw new UsageError(unknownPresetMessage(requested));
  }

  // `--install`/`--target` belong to `skill` only; accepting them silently
  // elsewhere would suggest they did something.
  if (command !== "skill" && (values.install !== undefined || values.target !== undefined)) {
    throw new UsageError("--install and --target are only valid with `skill`.");
  }
  if (values.target !== undefined && !isSkillTarget(String(values.target))) {
    throw new UsageError(
      `--target must be one of: ${SKILL_TARGETS.join(", ")} (received "${String(values.target)}").`
    );
  }

  return {
    command,
    args,
    format: rawFormat as OutputFormat,
    dryRun: values["dry-run"] === true,
    watch: values.watch === true,
    preset: values.preset === undefined ? undefined : String(values.preset),
    maxPartBytesRaw:
      values["max-part-bytes"] === undefined ? undefined : String(values["max-part-bytes"]),
    include: values.include === undefined ? undefined : String(values.include),
    exclude: values.exclude === undefined ? undefined : String(values.exclude),
    yes: values.yes === true,
    minimal: values.minimal === true,
    force: values.force === true,
    install: values.install === true,
    target: values.target === undefined ? undefined : String(values.target),
    cwd: values.cwd === undefined ? process.cwd() : path.resolve(String(values.cwd)),
    outDir: values["out-dir"] === undefined ? undefined : String(values["out-dir"]),
    includeMonolith: values["include-monolith"] === true ? true : undefined,
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
  };
}

class HelpRequested extends Error {}

function info(message: string): void {
  process.stderr.write(`${message}\n`);
}

function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

function emit(format: OutputFormat, payload: unknown, textRenderer: () => void): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  textRenderer();
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Describes why a parsed JSON file is not usable as a snapshot manifest.
 *
 * A parseable file is not necessarily a snapshot: rendering a foreign or
 * truncated manifest used to fail with a raw `TypeError: Cannot read properties
 * of undefined (reading 'totalFiles')` from inside the text formatter.
 */
function describeManifestShapeProblem(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return "not a JSON object";
  }
  const candidate = manifest as Record<string, unknown>;

  const counts = candidate.counts as Record<string, unknown> | undefined;
  if (!counts || typeof counts !== "object") return "missing `counts`";
  for (const key of ["totalFiles", "totalLines", "totalSizeBytes", "partsCount"]) {
    if (typeof counts[key] !== "number") return `missing numeric \`counts.${key}\``;
  }

  if (!candidate.layers || typeof candidate.layers !== "object") return "missing `layers`";
  if (!Array.isArray(candidate.files)) return "missing `files` array";
  return null;
}

async function runInitCommand(invocation: ParsedInvocation): Promise<number> {
  try {
    const result = await runInit({
      cwd: invocation.cwd,
      preset: invocation.preset,
      maxPartBytes: invocation.maxPartBytesRaw ?? invocation.maxPartBytes,
      include: splitList(invocation.include),
      exclude: splitList(invocation.exclude),
      skipArtifacts: invocation.skipArtifacts,
      includeSensitiveFiles: invocation.includeSensitiveFiles,
      yes: invocation.yes,
      minimal: invocation.minimal,
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

    info(`✅ Created ${path.basename(result.configPath)} (preset: ${result.preset})`);
    if (result.scripts.length > 0) info(`   Added npm scripts: ${result.scripts.join(", ")}`);
    if (result.gitignoreEntries.length > 0) {
      info(`   Added to .gitignore: ${result.gitignoreEntries.join(", ")}`);
    }
    for (const note of result.notes) info(`   ⚠ ${note}`);
    info("");
    info("   Next:  npm run snapshot");
    info(
      `   Tip:   \`${GENERATOR_NAME} skill --install\` makes this repo discoverable by AI agents.`
    );
    return 0;
  } catch (err) {
    if (err instanceof PromptCancelled) {
      warn("❌ Cancelled.");
      return 1;
    }
    warn(`❌ ${(err as Error).message}`);
    return 1;
  }
}

/**
 * Prints the bundled agent skill, or installs it into the repository.
 *
 * Printing goes to **stdout** (not the usual stderr progress stream) so an agent
 * can capture the skill directly: `codebase-snapshot skill > SKILL.md`.
 */
function runSkillCommand(invocation: ParsedInvocation): number {
  if (!invocation.install) {
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
    info("");
    info("   Agents that read AGENTS.md, .claude/skills or .cursor/rules will pick this up automatically.");
    return 0;
  } catch (err) {
    warn(`❌ Could not install the skill: ${(err as Error).message}`);
    return 1;
  }
}

function renderValidateText(result: ReturnType<typeof validateSnapshot>): void {  if (result.valid) {
    info("✅ Snapshot is valid and up to date with disk.");
  } else {
    warn("❌ Snapshot validation failed:");
    for (const error of result.errors) warn(`  - ${error}`);
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

/** Runs the CLI and returns the process exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let invocation: ParsedInvocation;
  try {
    invocation = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof HelpRequested) return 0;
    if (err instanceof UsageError) {
      process.stderr.write(`❌ ${err.message}\n\n${USAGE}\n`);
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

  const loaded = await loadConfigFileDetailed(invocation.cwd);
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
    },
    invocation.cwd
  );

  if (invocation.command === "validate") {
    const result = validateSnapshot(resolved);
    emit(invocation.format, result, () => renderValidateText(result));
    return result.valid ? 0 : 1;
  }

  if (invocation.command === "report") {
    // `path.resolve`, not `path.join`: generate resolves outDir against cwd, so a
    // reader using join would look for "<cwd>\<absolute path>" and report a
    // missing manifest after a successful generate.
    const manifestPath = path.resolve(resolved.cwd, resolved.outDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      warn(`❌ Manifest not found at ${manifestPath}. Run generate first.`);
      return 1;
    }
    let manifest: Manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
    } catch (err) {
      warn(`❌ Could not read ${manifestPath}: ${(err as Error).message}`);
      return 1;
    }

    // A parseable file is not necessarily a snapshot: reading a foreign or
    // truncated manifest used to fail with a raw `TypeError: Cannot read
    // properties of undefined (reading 'totalFiles')` instead of a message.
    const shapeError = describeManifestShapeProblem(manifest);
    if (shapeError) {
      warn(`❌ ${manifestPath} is not a snapshot manifest: ${shapeError}`);
      return 1;
    }

    const validation = validateSnapshot(resolved);

    emit(invocation.format, { manifest, validation }, () => {
      info(`\n📊 Codebase Snapshot Report (${resolved.cwd})`);
      info(`   - Generated at:   ${manifest.generatedAt}`);
      info(`   - Schema:         ${manifest.schemaVersion}`);
      info(`   - Fingerprint:    ${manifest.fingerprint}`);
      info(`   - Files included: ${manifest.counts.totalFiles}`);
      info(`   - Total lines:    ${manifest.counts.totalLines.toLocaleString()}`);
      info(
        `   - Total size:     ${(manifest.counts.totalSizeBytes / (1024 * 1024)).toFixed(2)} MB`
      );
      info(`   - Total parts:    ${manifest.counts.partsCount}`);
      info(`   - Integrity:      ${validation.valid ? "✅ Clean (no drift)" : "❌ Drift detected"}`);
      info(`   - Warnings:       ${manifest.warnings?.length ?? 0}`);
      info("\n   Layers:");
      for (const [layer, count] of Object.entries(manifest.layers)) {
        info(`     - ${layer.padEnd(16)}: ${count} files`);
      }
    });

    return validation.valid ? 0 : 1;
  }

  if (invocation.command === "explain") {
    const result = explainPath(resolved, invocation.args[0]);
    emit(invocation.format, result, () => info(renderExplainText(result)));
    return result.included ? 0 : 1;
  }

  if (invocation.command === "diff") {
    try {
      const [beforePath, afterPath] = invocation.args;
      const diff = compareManifests(loadManifest(beforePath), loadManifest(afterPath));
      emit(invocation.format, diff, () => info(renderDiffText(diff)));
      return 0;
    } catch (err) {
      warn(`❌ ${(err as Error).message}`);
      return 1;
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
      info(`   - Would write:  ${manifest.counts.partsCount} part(s) under ${resolved.outDir}/parts/`);
      info(`   - Skipped:      ${manifest.counts.skippedCount} file(s)`);
      info(`   - Warnings:     ${manifest.warnings.length}`);
      info(`   - Integrity:    ${manifest.validation.status}`);
      for (const error of manifest.validation.errors.slice(0, 10)) info(`     - ${error}`);
    } else {
      info(`\n✅ Snapshot generated in ${elapsed}s:`);
      info(`   - Tracked files: ${manifest.counts.totalFiles}`);
      info(`   - Total lines:   ${manifest.counts.totalLines.toLocaleString()}`);
      info(
        `   - Total size:    ${(manifest.counts.totalSizeBytes / (1024 * 1024)).toFixed(2)} MB`
      );
      // Only claim what this run actually wrote: `--skip-artifacts`/`--only-artifacts`
      // used to leave the summary naming reports and a manifest that do not exist.
      const { artifacts } = resolved;
      if (artifacts.parts) {
        info(`   - Parts written: ${manifest.counts.partsCount} under ${resolved.outDir}/parts/`);
      }
      const reports = [
        artifacts.projectTree && "project-tree",
        artifacts.navigation && "navigation",
        artifacts.audit && "audit",
      ].filter(Boolean);
      if (reports.length > 0) {
        info(`   - Reports:       ${resolved.outDir}/reports/ (${reports.join(", ")})`);
      }
      if (artifacts.manifest) info(`   - Manifest:      ${resolved.outDir}/manifest.json`);
      if (artifacts.monolith) info(`   - Monolith:      ${resolved.outDir}/full-codebase.{json,md}`);
      if (reports.length === 0 && !artifacts.parts && !artifacts.manifest && !artifacts.monolith) {
        info(`   - Artifacts:     all disabled (only the ownership marker was written)`);
      }
      info(`   - Fingerprint:   ${manifest.fingerprint}`);
      info(`   - Integrity:     ${manifest.validation.status}`);
      if (manifest.warnings.length > 0) {
        info(`   - Warnings:      ${manifest.warnings.length}`);
        for (const warning of manifest.warnings.slice(0, 10)) info(`     - ${warning}`);
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
      warn(
        `❌ Cannot write the snapshot: permission denied under ${resolved.outDir}. ` +
          `Check the directory's permissions or choose another --out-dir.`
      );
      warn(`   (${(err as Error).message})`);
      return 1;
    }
    warn(`❌ Failed to generate snapshot: ${(err as Error).message}`);
    return 1;
  }
}

/**
 * Re-generates on every change under `cwd`.
 *
 * Events inside the output and temporary directories are ignored, otherwise
 * writing a snapshot would immediately schedule the next run and loop forever.
 */
async function runWatchLoop(
  invocation: ParsedInvocation,
  resolved: ResolvedSnapshotConfig
): Promise<number> {
  const outDir = path.resolve(resolved.cwd, resolved.outDir);
  const tmpDir = path.resolve(resolved.cwd, resolved.tmpDir);

  // Compare case-insensitively on Windows, where the watcher can report a
  // different casing than `path.resolve` produced. Filtering by *segment* rather
  // than by prefix also survives the relative paths `fs.watch` emits. The
  // `<outDir>.backup-*` directories created by the atomic swap must be ignored
  // too, or each run schedules the next one forever.
  const outName = path.basename(outDir).toLowerCase();
  const tmpName = path.basename(tmpDir).toLowerCase();
  const isGenerated = (candidate: string): boolean =>
    candidate
      .toLowerCase()
      .split(/[\\/]/)
      .some(
        (segment) =>
          segment === outName ||
          segment === tmpName ||
          segment.startsWith(`${outName}.backup-`)
      );

  let running = false;
  const regenerate = (): void => {
    if (running) return;
    running = true;
    const started = performance.now();
    try {
      const manifest = generateSnapshot(resolved, { dryRun: invocation.dryRun });
      const elapsed = ((performance.now() - started) / 1000).toFixed(2);
      info(
        `♻️  ${new Date().toISOString()}  ${manifest.counts.totalFiles} file(s), ` +
          `${manifest.counts.partsCount} part(s), ${manifest.validation.status} (${elapsed}s)`
      );
    } catch (err) {
      warn(`❌ ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };

  info("👀 Watching for changes. Press Ctrl+C to stop.");
  regenerate();

  let timer: ReturnType<typeof setTimeout> | null = null;
  const watcher = fs.watch(resolved.cwd, { recursive: true }, (_event, filename) => {
    if (filename) {
      const changed = path.resolve(resolved.cwd, filename.toString());
      if (isGenerated(changed)) return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(regenerate, 250);
  });

  await new Promise<void>((resolve) => {
    const stop = (): void => {
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
 * This module has no side effects: importing `@ankurhalder/codebase-snapshot/cli`
 * exposes `main` and the argument parser without running anything. The
 * executable entry point is `src/bin.ts`.
 */
