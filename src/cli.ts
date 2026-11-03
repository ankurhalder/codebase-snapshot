import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { loadConfigFileDetailed, resolveConfig, supportsTypeScriptImports } from "./config.js";
import { GENERATOR_NAME, GENERATOR_VERSION, MIN_MAX_PART_BYTES, generateSnapshot } from "./index.js";
import { validateSnapshot } from "./validator/validate.js";
import type { Manifest, Mode, OutputFormat } from "./types.js";

const VERSION = GENERATOR_VERSION;

type Command = "generate" | "validate" | "report" | "init";

const COMMAND_ALIASES = new Map<string, Command>([
  ["generate", "generate"],
  ["validate", "validate"],
  ["check", "validate"],
  ["report", "report"],
  ["init", "init"],
]);

const CLI_OPTIONS = {
  cwd: { type: "string" },
  "out-dir": { type: "string" },
  "max-part-bytes": { type: "string" },
  "large-file-bytes": { type: "string" },
  "max-monolith-bytes": { type: "string" },
  "include-monolith": { type: "boolean" },
  "include-sensitive-files": { type: "boolean" },
  format: { type: "string" },
  mode: { type: "string" },
  "dry-run": { type: "boolean" },
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
  snap [command] [options]

Commands:
  generate (default)   Generate a complete partitioned codebase snapshot
  validate, check      Validate snapshot integrity and check for drift
  init                 Generate a starter snapshot.config file
  report               Print codebase health, layer metrics, and secret audit

Options:
  --cwd <path>                  Target repository directory (default: current directory)
  --out-dir <path>              Snapshot output directory (default: snapshot)
  --include-monolith            Also generate full-codebase.json and full-codebase.md
  --max-monolith-bytes <n>      Skip monolith artefacts larger than n bytes
  --max-part-bytes <n>          Maximum byte budget per markdown part (default: 307200)
  --large-file-bytes <n>        Threshold for head/tail truncation (default: 204800)
  --include-sensitive-files     Emit .env / *.pem / .npmrc / credential files
  --format <text|json>          CLI output format (default: text)
  --dry-run                     Compute the snapshot without writing anything
  -h, --help                    Display this help message
  -v, --version                 Display version

All options also accept the --option=value form.
Human-readable progress is written to stderr; payloads (--format json) go to stdout.
`.trim();

interface ParsedInvocation {
  command: Command;
  format: OutputFormat;
  dryRun: boolean;
  cwd: string;
  outDir?: string;
  includeMonolith?: boolean;
  includeSensitiveFiles?: boolean;
  maxPartBytes?: number;
  largeFileBytes?: number;
  maxMonolithBytes?: number | null;
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
    throw new UsageError((err as Error).message);
  }

  const values = parsed.values as Record<string, string | boolean | undefined>;

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
  } else if (explicitMode !== undefined) {
    const resolved = COMMAND_ALIASES.get(explicitMode);
    if (!resolved) {
      throw new UsageError(
        `Unknown --mode "${explicitMode}". Expected one of: ${Array.from(COMMAND_ALIASES.keys()).join(", ")}.`
      );
    }
    command = resolved;
  }

  if (positionals.length > 1) {
    throw new UsageError(
      `Unexpected argument(s): ${positionals.slice(1).join(" ")}. Only one command may be given.`
    );
  }

  const rawFormat = values.format === undefined ? "text" : String(values.format);
  if (rawFormat !== "text" && rawFormat !== "json") {
    throw new UsageError(`--format must be "text" or "json", received "${rawFormat}".`);
  }

  return {
    command,
    format: rawFormat as OutputFormat,
    dryRun: values["dry-run"] === true,
    cwd: values.cwd === undefined ? process.cwd() : path.resolve(String(values.cwd)),
    outDir: values["out-dir"] === undefined ? undefined : String(values["out-dir"]),
    includeMonolith: values["include-monolith"] === true ? true : undefined,
    includeSensitiveFiles: values["include-sensitive-files"] === true ? true : undefined,
    maxPartBytes: parsePositiveInteger(
      values["max-part-bytes"] as string | undefined,
      "max-part-bytes",
      MIN_MAX_PART_BYTES
    ),
    largeFileBytes: parsePositiveInteger(
      values["large-file-bytes"] as string | undefined,
      "large-file-bytes",
      1
    ),
    maxMonolithBytes: parsePositiveInteger(
      values["max-monolith-bytes"] as string | undefined,
      "max-monolith-bytes",
      1
    ),
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

function runInit(cwd: string): number {
  const targetName = supportsTypeScriptImports() ? "snapshot.config.ts" : "snapshot.config.mjs";
  const targetPath = path.join(cwd, targetName);
  if (fs.existsSync(targetPath)) {
    warn(`❌ ${targetName} already exists in ${cwd}.`);
    return 1;
  }

  const importPath = JSON.stringify(GENERATOR_NAME);
  const starter = `import { defineConfig } from ${importPath};

export default defineConfig({
  branch: "main",
  outDir: "snapshot",
  maxPartBytes: 300 * 1024,
  largeFileBytes: 200 * 1024,
  excludePatterns: [],
});
`;

  fs.writeFileSync(targetPath, starter, "utf8");
  info(`✅ Created ${targetName} in ${cwd}`);
  if (targetName.endsWith(".mjs")) {
    info(
      "   (a .ts config needs Node >= 22.6 to import natively; this Node writes a .mjs instead)"
    );
  }
  return 0;
}

function renderValidateText(result: ReturnType<typeof validateSnapshot>): void {
  if (result.valid) {
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
    return runInit(invocation.cwd);
  }

  const loaded = await loadConfigFileDetailed(invocation.cwd);
  for (const warning of loaded.warnings) warn(`⚠ Config: ${warning}`);
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
    },
    invocation.cwd
  );

  if (invocation.command === "validate") {
    const result = validateSnapshot(resolved);
    emit(invocation.format, result, () => renderValidateText(result));
    return result.valid ? 0 : 1;
  }

  if (invocation.command === "report") {
    const manifestPath = path.join(resolved.cwd, resolved.outDir, "manifest.json");
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
      info(`   - Parts written: ${manifest.counts.partsCount} under ${resolved.outDir}/parts/`);
      info(`   - Reports:       ${resolved.outDir}/reports/ (project-tree, navigation, audit)`);
      info(`   - Manifest:      ${resolved.outDir}/manifest.json`);
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
    return manifest.validation.status === "passed" ? 0 : 1;
  } catch (err) {
    warn(`❌ Failed to generate snapshot: ${(err as Error).message}`);
    return 1;
  }
}

/**
 * This module has no side effects: importing `@ankurhalder/codebase-snapshot/cli`
 * exposes `main` and the argument parser without running anything. The
 * executable entry point is `src/bin.ts`.
 */
