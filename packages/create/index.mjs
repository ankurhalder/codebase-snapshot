#!/usr/bin/env node
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { PromptCancelled, runInit } from "@ankurhalder/codebase-snapshot";

/**
 * `npm create codebase-snapshot`
 *
 * A thin shim over the same wizard the main package exposes, so there is exactly
 * one prompt implementation to keep working. Everything it does is available as
 * `npx @ankurhalder/codebase-snapshot init`; this entry point only exists because
 * `npm create <x>` is the convention developers reach for first.
 */

const PACKAGE_NAME = "@ankurhalder/codebase-snapshot";

const require = createRequire(import.meta.url);

/** The range this shim was published against, read from its own manifest. */
function dependencyRange() {
  try {
    const manifest = require("./package.json");
    const range = manifest?.dependencies?.[PACKAGE_NAME];
    return typeof range === "string" ? range : null;
  } catch {
    return null;
  }
}

/** Keeps the file's own indentation and trailing newline when rewriting JSON. */
function serializePackageJson(raw, value) {
  const indent = /^[{[]\r?\n([ \t]+)/.exec(raw)?.[1];
  const spacing = raw.includes("\n") ? (indent ?? "  ") : undefined;
  const body = JSON.stringify(value, null, spacing);
  return `${body}${raw.endsWith("\n") ? "\n" : ""}`;
}

/**
 * Records the runtime dependency the generated scripts need.
 *
 * The wizard writes `npx @ankurhalder/codebase-snapshot generate`, which resolves
 * the *latest* release when nothing is installed locally: the first run silently
 * downloaded @latest (observed pulling an older minor), failed behind a proxy and
 * could cross a major version. Naming the package in `devDependencies` makes
 * `npx` prefer that local copy, so the scripts become version-locked once the
 * project is installed — without this shim ever touching the network itself.
 */
function recordDependency(written) {
  if (!written) return { added: false };

  const range = dependencyRange();
  if (!range) {
    return {
      added: false,
      note: `Could not read ${PACKAGE_NAME}'s version from this package, so it was not added to devDependencies.`,
    };
  }

  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) return { added: false };

  let raw;
  try {
    raw = fs.readFileSync(pkgPath, "utf8");
  } catch {
    return {
      added: false,
      note: `package.json could not be read, so ${PACKAGE_NAME} was not added to devDependencies.`,
    };
  }

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return {
      added: false,
      note: `package.json could not be parsed, so ${PACKAGE_NAME} was not added to devDependencies.`,
    };
  }

  const declared = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some(
    (field) => pkg?.[field] && typeof pkg[field] === "object" && PACKAGE_NAME in pkg[field]
  );
  if (declared) return { added: false, range };

  pkg.devDependencies = { ...(pkg.devDependencies ?? {}), [PACKAGE_NAME]: range };
  try {
    fs.writeFileSync(pkgPath, serializePackageJson(raw, pkg));
  } catch {
    return {
      added: false,
      note: `package.json could not be written, so ${PACKAGE_NAME} was not added to devDependencies.`,
    };
  }
  return { added: true, range };
}

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
 * remaining forms are executable as printed.
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

  const dependency = recordDependency(result.written);
  if (dependency.added) {
    process.stderr.write(`   Added devDependency: ${PACKAGE_NAME} ${dependency.range}\n`);
  } else if (dependency.note) {
    process.stderr.write(`   ⚠ ${dependency.note}\n`);
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
