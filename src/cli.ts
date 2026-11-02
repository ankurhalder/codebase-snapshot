import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfigFile, resolveConfig } from "./config.js";
import { generateSnapshot } from "./index.js";
import { validateSnapshot } from "./validator/validate.js";
import type { CliOptions, Mode, MonolithContentMode, OutputFormat } from "./types.js";

const VERSION = "1.0.0";

function printHelp() {
  console.log(`
@ankurhalder/codebase-snapshot v${VERSION}
Production-grade LLM codebase snapshot generator, auditor, and AST partitioner

Usage:
  codebase-snapshot [command] [options]
  snap [command] [options]

Commands:
  generate (default)   Generate a complete partitioned codebase snapshot
  validate, check      Validate snapshot integrity and check for drift
  init                 Generate a starter snapshot.config.ts file
  report               Print codebase health, layer metrics, and secret audit

Options:
  --cwd <path>             Target repository directory (defaults to current dir)
  --include-monolith       Also generate full-codebase.json and full-codebase.md
  --max-part-bytes <n>     Maximum byte budget per markdown part (default: 307200)
  --large-file-bytes <n>   Threshold for head/tail truncation (default: 204800)
  --format <text|json>     CLI output format (default: text)
  -h, --help               Display this help message
  -v, --version            Display version
`);
}

function parseArgs(args: string[]): CliOptions {
  let mode: Mode = "generate";
  let format: OutputFormat = "text";
  let dryRun = false;
  let force = false;
  let cwd: string | undefined = undefined;
  let includeMonolith = false;
  let monolithContent: MonolithContentMode = "full";
  let maxMonolithBytes: number | null = null;
  let maxPartBytes: number | undefined = undefined;
  let largeFileBytes: number | undefined = undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "-v" || arg === "--version") {
      console.log(`v${VERSION}`);
      process.exit(0);
    }

    if (arg === "generate") {
      mode = "generate";
    } else if (arg === "validate" || arg === "check") {
      mode = "validate";
    } else if (arg === "report") {
      mode = "report";
    } else if (arg === "init") {
      runInit();
      process.exit(0);
    } else if (arg === "--cwd" && args[i + 1]) {
      cwd = path.resolve(args[++i]);
    } else if (arg === "--include-monolith") {
      includeMonolith = true;
    } else if (arg === "--max-part-bytes" && args[i + 1]) {
      maxPartBytes = parseInt(args[++i], 10);
    } else if (arg === "--large-file-bytes" && args[i + 1]) {
      largeFileBytes = parseInt(args[++i], 10);
    } else if (arg === "--format" && args[i + 1]) {
      const f = args[++i];
      if (f === "json" || f === "text") format = f;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--force") {
      force = true;
    }
  }

  return {
    mode,
    format,
    dryRun,
    force,
    cwd,
    includeMonolith,
    monolithContent,
    maxMonolithBytes,
    maxPartBytes,
    largeFileBytes,
  };
}

function runInit() {
  const targetPath = path.join(process.cwd(), "snapshot.config.ts");
  if (fs.existsSync(targetPath)) {
    console.error("❌ snapshot.config.ts already exists in the current directory.");
    process.exit(1);
  }

  const starterConfig = `import { defineConfig } from "@ankurhalder/codebase-snapshot";

export default defineConfig({
  branch: "main",
  outDir: "snapshot",
  maxPartBytes: 300 * 1024,
  largeFileBytes: 200 * 1024,
  excludePatterns: [],
});
`;

  fs.writeFileSync(targetPath, starterConfig, "utf8");
  console.log("✅ Created snapshot.config.ts");
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  const targetCwd = cliOptions.cwd || process.cwd();

  const userConfig = await loadConfigFile(targetCwd);
  const resolved = resolveConfig(userConfig, cliOptions);

  if (cliOptions.mode === "validate") {
    const result = validateSnapshot(resolved);
    if (cliOptions.format === "json") {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.valid) {
        console.log("✅ Snapshot is valid and up to date with disk.");
      } else {
        console.error("❌ Snapshot validation failed with drift:");
        for (const err of result.errors) {
          console.error(`  - ${err}`);
        }
      }
    }
    process.exit(result.valid ? 0 : 1);
  }

  const start = performance.now();
  console.log(`📸 Generating snapshot for: ${resolved.cwd}`);
  console.log(`   Branch: ${resolved.branch} | Part budget: ${(resolved.maxPartBytes / 1024).toFixed(0)} KB`);

  try {
    const manifest = await generateSnapshot(resolved);
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);

    if (cliOptions.format === "json") {
      console.log(JSON.stringify(manifest, null, 2));
    } else {
      console.log(`\n✅ Snapshot generated in ${elapsed}s:`);
      console.log(`   - Tracked files: ${manifest.counts.totalFiles}`);
      console.log(`   - Total lines:   ${manifest.counts.totalLines.toLocaleString()}`);
      console.log(`   - Total size:    ${(manifest.counts.totalSizeBytes / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`   - Parts written: ${manifest.counts.partsCount} under ${resolved.outDir}/parts/`);
      console.log(`   - Reports:       ${resolved.outDir}/reports/ (project-tree, navigation, audit)`);
      console.log(`   - Manifest:      ${resolved.outDir}/manifest.json`);
    }
  } catch (err: any) {
    console.error(`❌ Failed to generate snapshot: ${err.message}`);
    process.exit(1);
  }
}

main();
