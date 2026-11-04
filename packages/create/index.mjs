#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { PromptCancelled, runInit } from "@ankurhalder/codebase-snapshot";

/**
 * `npm create codebase-snapshot`
 *
 * A thin shim over the same wizard the main package exposes, so there is exactly
 * one prompt implementation to keep working. Everything it does is available as
 * `npx @ankurhalder/codebase-snapshot init`; this entry point only exists because
 * `npm create <x>` is the convention developers reach for first.
 *
 * The shim used to carry its own `devDependencies` writer, because `init` wrote the
 * scripts and no dependency at all. The wizard records the dependency itself now, so
 * this file reports what happened and names the next command — a second writer is a
 * second source of truth, and the two drift.
 */

const PACKAGE_NAME = "@ankurhalder/codebase-snapshot";

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
    force: argv.includes("--force"),
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
