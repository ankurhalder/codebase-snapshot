import * as fs from "node:fs";
import * as path from "node:path";
import { ARTIFACT_NAMES, parseByteSize, supportsTypeScriptImports } from "../config.js";
import { detectPreset, listPresetNames } from "../presets/index.js";
import type { ArtifactSelection, ByteSize } from "../types.js";
import {
  DEFAULT_ANSWERS,
  renderConfig,
  renderMinimalConfig,
  type WizardAnswers,
} from "./config-template.js";
import {
  confirm,
  defaultIO,
  isInteractive,
  multiSelect,
  PromptCancelled,
  select,
  text,
  type Choice,
  type PromptIO,
} from "./prompts.js";

export interface InitOptions {
  cwd: string;
  /** Force a preset instead of detecting one. */
  preset?: string;
  maxPartBytes?: ByteSize;
  include?: string[];
  exclude?: string[];
  skipArtifacts?: string[];
  onlyArtifacts?: string[];
  includeSensitiveFiles?: boolean;
  /** Accept every default without prompting. */
  yes?: boolean;
  /** Write only the settings that differ from the defaults. */
  minimal?: boolean;
  /** Overwrite an existing config. */
  force?: boolean;
  /** Render the config without writing anything. */
  dryRun?: boolean;
  outDir?: string;
  io?: PromptIO;
}

export interface InitResult {
  configPath: string;
  configText: string;
  written: boolean;
  preset: string;
  scripts: string[];
  gitignoreEntries: string[];
  /** Human-readable notes about anything that was skipped or could not be done. */
  notes: string[];
}

const CONFIG_CANDIDATES = [
  "snapshot.config.ts",
  "snapshot.config.js",
  "snapshot.config.mjs",
  "snapshot.config.cjs",
  "snapshot.config.json",
  ".snapshotrc.json",
  ".snapshotrc",
];

/**
 * Picks the config filename this project can actually load.
 *
 * A `.ts` config is only usable when Node can strip types *and* the package is an
 * ES module: Node applies the enclosing `package.json` `type` field to a `.ts`
 * file, so an `export default` config in a CommonJS project fails to load. That
 * made `codebase-snapshot init` write a file the next `codebase-snapshot generate` refused to read. `.mjs`
 * works everywhere, so it is the safe default.
 */
export function chooseConfigFileName(cwd: string): string {
  if (!supportsTypeScriptImports()) return "snapshot.config.mjs";

  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return "snapshot.config.mjs";
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { type?: unknown };
    return parsed.type === "module" ? "snapshot.config.ts" : "snapshot.config.mjs";
  } catch {
    return "snapshot.config.mjs";
  }
}

const SIZE_CHOICES: Array<{ value: string; label: string; hint: string }> = [
  { value: "60k", label: "Small", hint: "60 KB · ~15k tokens · tight context windows" },
  { value: "120k", label: "Medium", hint: "120 KB · ~30k tokens · recommended" },
  { value: "300k", label: "Large", hint: "300 KB · ~75k tokens · the default" },
  { value: "custom", label: "Custom…", hint: "type a size like 150k or 1.5mb" },
];

/**
 * True when `package.json` already carries a `"snapshot"` config block.
 *
 * `init` used to ignore it and write a file that then took precedence, silently
 * changing the effective settings of a repository that was already configured.
 */
function packageJsonHasConfig(cwd: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as {
      snapshot?: unknown;
    };
    return typeof parsed.snapshot === "object" && parsed.snapshot !== null;
  } catch {
    return false;
  }
}

function artifactAnswers(options: InitOptions): Required<ArtifactSelection> {
  const artifacts: Required<ArtifactSelection> = { ...DEFAULT_ANSWERS.artifacts };
  for (const name of options.skipArtifacts ?? []) {
    if ((ARTIFACT_NAMES as ReadonlyArray<string>).includes(name)) {
      artifacts[name as keyof ArtifactSelection] = false;
    }
  }
  if (options.onlyArtifacts && options.onlyArtifacts.length > 0) {
    const keep = new Set(options.onlyArtifacts);
    for (const name of ARTIFACT_NAMES) artifacts[name] = keep.has(name);
  }
  return artifacts;
}

function topLevelDirs(cwd: string): string[] {
  try {
    return fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Type-only description of a JSON value, so a note never echoes user data. */
function describeJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/**
 * Writes a file, turning an OS failure into the tool's own phrasing.
 *
 * A read-only target used to surface the raw `EPERM: operation not permitted,
 * open '…'` text, which reads like a crash rather than a refusal.
 */
function writeFileOrExplain(target: string, content: string): void {
  try {
    fs.writeFileSync(target, content, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === "EACCES" || code === "EPERM" || code === "EROFS"
        ? `permission denied (${code})`
        : code === "EISDIR"
          ? "it is a directory"
          : `${(err as Error).message}`;
    throw new Error(`Cannot write ${target}: ${reason}`);
  }
}

/**
 * True when the generated ES-module config text can be written to `name`.
 *
 * The wizard's template is `export default { … }`, so it is only valid in a
 * `.mjs` file, a `.ts` file, or a `.js` file inside a `"type": "module"` package.
 */
function canWriteModuleConfig(name: string, cwd: string): boolean {
  if (name.endsWith(".mjs") || name.endsWith(".ts")) return true;
  if (!name.endsWith(".js")) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as {
      type?: unknown;
    };
    return parsed.type === "module";
  } catch {
    return false;
  }
}

function configFormatLabel(name: string): string {
  if (name.endsWith(".js")) return 'CommonJS `.js` (package.json has no "type": "module")';
  if (name.endsWith(".cjs")) return "CommonJS `.cjs`";
  return "JSON";
}

function addScripts(cwd: string, notes: string[]): string[] {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) {
    notes.push("No package.json found, so npm scripts were not added.");
    return [];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Record<string, unknown>;
  } catch {
    notes.push("Could not parse package.json; npm scripts were not added.");
    return [];
  }

  // `scripts` must be an object. A string, array or number used to be replaced
  // with `{}` while the run still reported plain success — a silent data
  // replacement. Say what happened instead.
  const declared = parsed.scripts;
  let scripts: Record<string, unknown>;
  if (declared === undefined) {
    scripts = {};
  } else if (typeof declared === "object" && declared !== null && !Array.isArray(declared)) {
    scripts = declared as Record<string, unknown>;
  } else {
    notes.push(
      `package.json "scripts" was ${describeJsonValue(declared)}, not an object; it was replaced with an ` +
        "object holding the snapshot scripts."
    );
    scripts = {};
  }

  const added: string[] = [];
  if (!scripts.snapshot) {
    scripts.snapshot = "npx @ankurhalder/codebase-snapshot generate";
    added.push("snapshot");
  }
  if (!scripts["snapshot:validate"]) {
    scripts["snapshot:validate"] = "npx @ankurhalder/codebase-snapshot validate";
    added.push("snapshot:validate");
  }
  if (added.length === 0) return [];

  parsed.scripts = scripts;
  writeFileOrExplain(packagePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return added;
}

/**
 * Adds the snapshot directories to `.gitignore`, and never fails the run over it.
 *
 * `init` exists to produce a config; the `.gitignore` line is a convenience. When the entry is a
 * directory (or cannot be read or written) the previous behaviour was to exit 1 with a raw
 * `EISDIR` from the *read* — after the config had already been written, so the run both failed and
 * left state behind. It reports a warning instead, and `init` finishes what it promised.
 */
function addGitignore(cwd: string, notes: string[]): string[] {
  const ignorePath = path.join(cwd, ".gitignore");
  let existing = "";

  try {
    if (fs.existsSync(ignorePath)) {
      if (fs.statSync(ignorePath).isDirectory()) {
        notes.push(
          `${ignorePath} is a directory, so it was not updated. Add "snapshot/" and ` +
            `"snapshot.tmp/" to your .gitignore yourself.`
        );
        return [];
      }
      existing = fs.readFileSync(ignorePath, "utf8");
    }
  } catch (err) {
    notes.push(
      `${ignorePath} could not be read (${(err as Error).message}). Add "snapshot/" and ` +
        `"snapshot.tmp/" to your .gitignore yourself.`
    );
    return [];
  }

  const wanted = ["snapshot/", "snapshot.tmp/"];
  const added = wanted.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (added.length === 0) return [];

  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  try {
    writeFileOrExplain(ignorePath, `${existing}${prefix}${added.join("\n")}\n`);
  } catch (err) {
    notes.push(
      `${(err as Error).message}. Add ${added.map((entry) => `"${entry}"`).join(" and ")} to your ` +
        ".gitignore yourself."
    );
    return [];
  }
  return added;
}

function resolvePresetChoice(answers: WizardAnswers, presetName: string): Choice<string> {
  return {
    value: presetName,
    label: presetName,
    hint: presetName === answers.preset ? "detected" : undefined,
  };
}

/**
 * Runs the interactive setup, or writes a config from flags.
 *
 * Interactive only when both ends are a TTY and `--yes` was not passed; every
 * other path uses the flag values and the detected preset, and prints what it
 * decided rather than prompting.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const io = options.io ?? defaultIO();
  const detected = detectPreset(options.cwd, options.preset);
  const notes: string[] = [];

  const answers: WizardAnswers = {
    preset: detected.presetName,
    maxPartBytes:
      options.maxPartBytes ??
      detected.recommendedBudget ??
      DEFAULT_ANSWERS.maxPartBytes,
    largeFileBytes: DEFAULT_ANSWERS.largeFileBytes,
    include: options.include ?? [],
    excludePatterns: options.exclude ?? [],
    artifacts: artifactAnswers(options),
    includeSensitiveFiles: options.includeSensitiveFiles ?? DEFAULT_ANSWERS.includeSensitiveFiles,
    outDir: options.outDir ?? DEFAULT_ANSWERS.outDir,
  };

  const interactive = isInteractive(io) && options.yes !== true;

  if (interactive) {
    io.output.write("\n  @ankurhalder/codebase-snapshot\n");
    io.output.write("  Turn this repository into an LLM-ready, redacted, byte-bounded snapshot.\n\n");
    io.output.write(`  Detected   ${detected.presetName}\n`);
    io.output.write(`  Directory  ${options.cwd}\n\n`);

    const useDetected = await confirm(io, `Set up for ${detected.presetName}?`, {
      defaultValue: true,
    });

    if (!useDetected) {
      answers.preset = await select(
        io,
        "What kind of project is this?",
        listPresetNames().map((name) => resolvePresetChoice(answers, name))
      );
      const chosen = detectPreset(options.cwd, answers.preset);
      answers.preset = chosen.presetName;
    }

    const scope = await select(
      io,
      "What should go into the snapshot?",
      [
        { value: "all", label: "Everything the scanner finds", hint: "recommended · respects .gitignore" },
        { value: "folders", label: "Only specific folders…" },
        { value: "no-tests", label: "Everything, but skip tests" },
        { value: "custom", label: "Let me write glob patterns" },
      ],
      { defaultValue: "all" }
    );

    if (scope === "folders") {
      const dirs = topLevelDirs(options.cwd).slice(0, 40);
      if (dirs.length === 0) {
        notes.push("No top-level directories found; the snapshot will include everything.");
      } else {
        const chosen = await multiSelect(
          io,
          "Select folders",
          dirs.map((name) => ({ value: name, label: `${name}/` })),
          { defaults: dirs }
        );
        answers.include = chosen.map((name) => `${name}/**`);
      }
    } else if (scope === "no-tests") {
      answers.excludePatterns = [
        ...answers.excludePatterns,
        "**/*.test.*",
        "**/*.spec.*",
        "tests",
        "test",
      ];
    } else if (scope === "custom") {
      const raw = await text(io, "Glob patterns to include (comma separated)", {
        defaultValue: "",
      });
      answers.include = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }

    const sizeChoice = await select(io, "How large should each part be?", SIZE_CHOICES, {
      defaultValue: "120k",
    });

    if (sizeChoice === "custom") {
      const raw = await text(io, "Part size (e.g. 150k, 1.5mb, 900000)", {
        defaultValue: String(answers.maxPartBytes),
        validate: (value) => (parseByteSize(value) === undefined ? "Not a valid size." : null),
      });
      answers.maxPartBytes = parseByteSize(raw) ?? answers.maxPartBytes;
    } else {
      answers.maxPartBytes = sizeChoice;
    }

    const artifactChoices: Array<Choice<keyof ArtifactSelection>> = [
      { value: "readme", label: "README.md", hint: "orientation page" },
      { value: "manifest", label: "manifest.json", hint: "required by validate and report" },
      { value: "parts", label: "parts/", hint: "the code payload" },
      { value: "navigation", label: "reports/navigation.md", hint: "file → part index" },
      { value: "projectTree", label: "reports/project-tree.md", hint: "ASCII tree" },
      { value: "audit", label: "reports/audit.md", hint: "security and health findings" },
      { value: "monolith", label: "full-codebase.json + .md", hint: "roughly doubles output" },
    ];

    const presetEnabled = ARTIFACT_NAMES.filter((name) => answers.artifacts[name]);
    const selectedArtifacts = await multiSelect(
      io,
      "Which artifacts should be generated?",
      artifactChoices,
      { defaults: presetEnabled }
    );
    for (const name of ARTIFACT_NAMES) answers.artifacts[name] = selectedArtifacts.includes(name);
    const enabledCount = ARTIFACT_NAMES.filter((name) => answers.artifacts[name]).length;

    answers.includeSensitiveFiles = await confirm(
      io,
      "Include credential files (.env, *.pem, .npmrc, .ssh/)?",
      { defaultValue: false }
    );

    io.output.write("\n  Review\n\n");
    io.output.write(`  project          ${answers.preset}\n`);
    io.output.write(`  include          ${answers.include.length ? answers.include.join(", ") : "everything"}\n`);
    io.output.write(`  part size        ${String(answers.maxPartBytes)}\n`);
    io.output.write(`  artifacts        ${enabledCount} of ${ARTIFACT_NAMES.length}\n`);
    io.output.write(`  credentials      ${answers.includeSensitiveFiles ? "included" : "skipped"}\n\n`);
    io.output.write("  Will write snapshot.config with your answers, plus every other setting\n");
    io.output.write("  at its default — so nothing is hidden behind the docs.\n\n");

    const proceed = await confirm(io, "Write this and continue?", { defaultValue: true });
    if (!proceed) throw new PromptCancelled();
  }

  const configText = options.minimal ? renderMinimalConfig(answers) : renderConfig(answers);
  const preferredName = chooseConfigFileName(options.cwd);
  const presentConfigs = CONFIG_CANDIDATES.filter((name) =>
    fs.existsSync(path.join(options.cwd, name))
  );
  const present = presentConfigs[0] ?? null;

  // More than one config file means the loader silently ignores all but the first
  // in its own order; say which one wins so the user can delete the rest.
  if (presentConfigs.length > 1) {
    notes.push(
      `Multiple configuration files found (${presentConfigs.join(", ")}); ${present} is the one this ` +
        "tool loads, and the others are ignored. Delete the extras to avoid confusion."
    );
  }

  // With `--force` the file that already exists is the one to rewrite. Choosing a
  // fresh name beside it wrote a second config file, and the loader's order
  // (`.mjs` before `.json`, for instance) made the new one silently shadow the
  // user's: `--force` promised to replace it and instead disabled it.
  const configName = present !== null && options.force ? present : preferredName;
  const configPath = path.join(options.cwd, configName);

  if (options.dryRun) {
    return {
      configPath,
      configText,
      written: false,
      preset: answers.preset,
      scripts: [],
      gitignoreEntries: [],
      notes,
    };
  }

  if (present !== null && present !== preferredName && !options.force) {
    throw new Error(
      `A configuration already exists (${present}). Re-run with --force to replace it.`
    );
  }
  if (present !== null && options.force && !canWriteModuleConfig(present, options.cwd)) {
    throw new Error(
      `Refusing to replace ${present}: this wizard writes an ES-module config (.ts, .js, .mjs), and ` +
        `${present} is a ${configFormatLabel(present)} configuration. Writing a new file beside it would ` +
        `silently shadow it, so delete or rename ${present} yourself and re-run with --force.`
    );
  }
  if (packageJsonHasConfig(options.cwd) && !options.force) {
    throw new Error(
      'package.json already defines a "snapshot" config. Remove that key, or re-run with --force ' +
        "to write a config file that takes precedence over it."
    );
  }
  if (fs.existsSync(configPath) && !options.force) {
    throw new Error(`${configName} already exists. Re-run with --force to replace it.`);
  }

  writeFileOrExplain(configPath, configText);
  const scripts = addScripts(options.cwd, notes);
  const gitignoreEntries = addGitignore(options.cwd, notes);

  return {
    configPath,
    configText,
    written: true,
    preset: answers.preset,
    scripts,
    gitignoreEntries,
    notes,
  };
}
