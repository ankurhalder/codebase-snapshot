#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { PromptCancelled, runInit } from "codebase-snapshot";

/**
 * `npm create codebase-snapshot`
 *
 * A thin shim over the same wizard the main package exposes, so there is exactly
 * one prompt implementation to keep working. Everything it does is available as
 * `npx codebase-snapshot init`; this entry point only exists because
 * `npm create <x>` is the convention developers reach for first.
 *
 * The shim used to carry its own `devDependencies` writer, because `init` wrote the
 * scripts and no dependency at all. The wizard records the dependency itself now, so
 * this file reports what happened and names the next command — a second writer is a
 * second source of truth, and the two drift.
 */

const PACKAGE_NAME = "codebase-snapshot";

/** True when the package's own binary is already installed in the project. */
function hasLocalBinary() {
  const names =
    process.platform === "win32"
      ? ["codebase-snapshot.cmd", "codebase-snapshot"]
      : ["codebase-snapshot"];
  return names.some((name) =>
    fs.existsSync(path.join(process.cwd(), "node_modules", ".bin", name))
  );
}

/** True when the project's package.json already carries the `snapshot` script. */
function hasSnapshotScript() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    return typeof pkg?.scripts?.snapshot === "string";
  } catch {
    return false;
  }
}

/**
 * The command the developer should run next.
 *
 * `npm run snapshot` is only meaningful when the project has that script, which
 * needs a `package.json`: the old text promised it unconditionally, so the
 * documented next step failed with ENOENT in exactly the case that needs help
 * most. A pre-existing script counts even when this run added nothing, hence the
 * check is against `package.json` rather than against what the wizard wrote. The
 * remaining forms are executable as printed, and `init` has already declared the
 * devDependency by now — so `npm install` really does put the package in
 * `node_modules`.
 */
function nextStep() {
  if (!hasSnapshotScript()) return `npx ${PACKAGE_NAME} generate`;
  return hasLocalBinary() ? "npm run snapshot" : "npm install && npm run snapshot";
}

const HELP_TEXT = [
  "create-codebase-snapshot",
  "",
  "  Sets up codebase-snapshot in the current directory.",
  "",
  "  Usage:",
  "    npm create codebase-snapshot",
  "",
  "  Options:",
  "    --preset <name>   Force a project preset instead of detecting one",
  "    --yes             Accept every default without prompting",
  "    --force           Overwrite an existing config",
  "",
].join("\n");

/**
 * Arguments, parsed by the platform rather than by hand.
 *
 * The hand-rolled version used `argv.indexOf(flag)`, which has three silent failures that all
 * matter here, and rule 1 of this repository says none of them may be silent:
 *
 * - `--preset=nextjs` — the form `npm create x -- --flag=value` makes natural — was never found,
 *   so the requested preset was ignored and auto-detection ran instead.
 * - `--preset` with no value was accepted and treated as "no preset", with the same result.
 * - an unknown flag, including a typo for a real one (`--forse`), was ignored outright. A user who
 *   typed `--forse` believed the overwrite had been forced.
 *
 * `parseArgs` with `strict: true` rejects all three by name, before any wizard code runs.
 */
let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      preset: { type: "string" },
      yes: { type: "boolean" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: true,
  });
} catch (error) {
  process.stderr.write(`\n❌ ${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(`\n${HELP_TEXT}\n`);
  process.exit(2);
}

if (parsed.values.help) {
  process.stderr.write(HELP_TEXT);
  process.exit(0);
}

const preset = parsed.values.preset;
// `--preset=` parses as an empty string, which is not "no preset": somebody asked for a preset and
// named nothing.
if (preset !== undefined && preset.trim() === "") {
  process.stderr.write("\n❌ --preset requires a name (it received an empty string).\n");
  process.exit(2);
}

try {
  const result = await runInit({
    cwd: process.cwd(),
    preset: preset?.trim(),
    yes: parsed.values.yes === true,
    force: parsed.values.force === true,
  });

  if (!result.written) {
    process.exit(0);
  }

  process.stderr.write(`\n✅ Created ${result.configPath} (preset: ${result.preset})\n`);
  if (result.scripts.length > 0) {
    process.stderr.write(`   Added npm scripts: ${result.scripts.join(", ")}\n`);
  }
  if (result.dependency.added) {
    process.stderr.write(
      `   Added devDependency: ${result.dependency.name} ${result.dependency.range}\n`
    );
  }
  if (result.gitignoreEntries.length > 0) {
    process.stderr.write(`   Added to .gitignore: ${result.gitignoreEntries.join(", ")}\n`);
  }
  for (const note of result.notes) process.stderr.write(`   ⚠ ${note}\n`);
  process.stderr.write(`\n   Next:  ${nextStep()}\n\n`);
} catch (err) {
  if (err instanceof PromptCancelled) {
    process.stderr.write("\n❌ Cancelled.\n");
    process.exit(1);
  }
  process.stderr.write(`\n❌ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
