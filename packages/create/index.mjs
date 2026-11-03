#!/usr/bin/env node
import { PromptCancelled, runInit } from "@ankurhalder/codebase-snapshot";

/**
 * `npm create codebase-snapshot`
 *
 * A thin shim over the same wizard the main package exposes, so there is exactly
 * one prompt implementation to keep working. Everything it does is available as
 * `npx @ankurhalder/codebase-snapshot init`; this entry point only exists because
 * `npm create <x>` is the convention developers reach for first.
 */

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  process.stderr.write(
    [
      "create-codebase-snapshot",
      "",
      "  Sets up @ankurhalder/codebase-snapshot in the current directory.",
      "",
      "  Usage:",
      "    npm create codebase-snapshot",
      "",
      "  Options:",
      "    --preset <name>   Force a project preset instead of detecting one",
      "    --yes             Accept every default without prompting",
      "    --minimal         Write only the settings that differ from defaults",
      "    --force           Overwrite an existing config",
      "",
    ].join("\n")
  );
  process.exit(0);
}

const takeValue = (flag) => {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
};

try {
  const result = await runInit({
    cwd: process.cwd(),
    preset: takeValue("--preset"),
    yes: argv.includes("--yes"),
    minimal: argv.includes("--minimal"),
    force: argv.includes("--force"),
  });

  if (!result.written) {
    process.exit(0);
  }

  process.stderr.write(`\n✅ Created ${result.configPath} (preset: ${result.preset})\n`);
  if (result.scripts.length > 0) {
    process.stderr.write(`   Added npm scripts: ${result.scripts.join(", ")}\n`);
  }
  if (result.gitignoreEntries.length > 0) {
    process.stderr.write(`   Added to .gitignore: ${result.gitignoreEntries.join(", ")}\n`);
  }
  for (const note of result.notes) process.stderr.write(`   ⚠ ${note}\n`);
  process.stderr.write("\n   Next:  npm run snapshot\n\n");
} catch (err) {
  if (err instanceof PromptCancelled) {
    process.stderr.write("\n❌ Cancelled.\n");
    process.exit(1);
  }
  process.stderr.write(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
