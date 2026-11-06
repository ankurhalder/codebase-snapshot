import * as fs from "node:fs";
import * as path from "node:path";
import { ARTIFACT_NAMES, parseByteSize, supportsTypeScriptImports } from "../config.js";
import { appendGitignoreEntries } from "../gitignore.js";
import { detectPreset, listPresetNames } from "../presets/index.js";
import { getGitInfo } from "../scanner/files.js";
import type { ArtifactSelection, ByteSize } from "../types.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "../version.js";
import {
  DEFAULT_ANSWERS,
  renderConfig,
  type WizardAnswers,
} from "./config-template.js";
import {
  confirm,
  defaultIO,
  isInteractive,
  multiSelect,
  PromptBack,
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
  /** Overwrite an existing config. */
  force?: boolean;
  /**
   * Keep an existing config instead of refusing.
   *
   * `setup` writes a config only when the repository has none; when it has one, the rest of the
   * setup work (scripts, devDependency, `.gitignore`) still happens and the file is left exactly as
   * it is. `init` on its own keeps refusing — a user who typed `init` expects to be told the file
   * already exists.
   */
  reuseConfig?: boolean;
  /** Render the config without writing anything. */
  dryRun?: boolean;
  outDir?: string;
  io?: PromptIO;
}

/** What happened to the `devDependencies` entry that makes the npm scripts self-contained. */
export interface InitDependency {
  name: string;
  /** The range now present in package.json, or a pre-existing declaration. */
  range: string | null;
  /** True when this run wrote the entry. */
  added: boolean;
}

export interface InitResult {
  configPath: string;
  configText: string;
  written: boolean;
  /** True when an existing config was kept instead of being written. */
  reused: boolean;
  preset: string;
  /** The signal the detector matched, e.g. `next.config.ts`; null when nothing detected it. */
  reason: string | null;
  /** True when no preset matched and the fallback was used. */
  fallback: boolean;
  scripts: string[];
  gitignoreEntries: string[];
  dependency: InitDependency;
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
    // `typeof [] === "object"`: an array is a wrong type like a string or a number, not a config.
    return typeof parsed.snapshot === "object" && parsed.snapshot !== null && !Array.isArray(parsed.snapshot);
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

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** The range already declared for this package, in whichever dependency field it appears. */
function declaredRange(parsed: Record<string, unknown>): string | null {
  for (const field of DEPENDENCY_FIELDS) {
    const block = parsed[field];
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    const value = (block as Record<string, unknown>)[GENERATOR_NAME];
    if (typeof value === "string") return value;
  }
  return null;
}

interface PackageJsonUpdate {
  scripts: string[];
  dependency: InitDependency;
}

/**
 * Keeps the file's own indentation and line endings when rewriting `package.json`.
 *
 * A 4-space file rewritten as 2-space JSON is a whole-file diff whose only real change is two
 * scripts and one dependency: it buries the change in review and buries `git blame`. The
 * scaffolder used to do this itself, because `init` wrote no dependency; that write moved here,
 * so the rule has to live here too.
 */
function serializePackageJson(raw: string, value: unknown): string {
  const indent = /^[{[]\r?\n([ \t]+)/.exec(raw)?.[1];
  const spacing = raw.includes("\n") ? (indent ?? "  ") : undefined;
  const crlf = raw.includes("\r\n");
  const body = JSON.stringify(value, null, spacing);
  const text = crlf ? body.replace(/\n/g, "\r\n") : body;
  return `${text}${raw.endsWith("\n") ? (crlf ? "\r\n" : "\n") : ""}`;
}

/**
 * Adds the npm scripts and the devDependency in a single write of `package.json`.
 *
 * The scripts alone were not enough. `init` used to leave the package undeclared, so
 * `npm install` never put a copy in `node_modules`: every `npm run snapshot` resolved
 * `@latest` from the registry instead, the version could drift under the user, and the
 * "npm install && npm run snapshot" this printed as the next step could not have fixed it.
 * A range already declared in any dependency field is left exactly as it is — a pin to
 * `4.0.0` is a decision, not a mistake.
 */
function updatePackageJson(cwd: string, notes: string[]): PackageJsonUpdate {
  const packagePath = path.join(cwd, "package.json");
  const unchanged: PackageJsonUpdate = {
    scripts: [],
    dependency: { name: GENERATOR_NAME, range: null, added: false },
  };
  if (!fs.existsSync(packagePath)) {
    notes.push("No package.json found, so npm scripts and the devDependency were not added.");
    return unchanged;
  }

  let raw: string;
  let parsed: Record<string, unknown>;
  try {
    raw = fs.readFileSync(packagePath, "utf8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    notes.push("Could not parse package.json; npm scripts and the devDependency were not added.");
    return unchanged;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    notes.push("package.json is not a JSON object, so npm scripts and the devDependency were not added.");
    return unchanged;
  }

  // `scripts` must be an object. A string, array or number used to be replaced
  // with `{}` while the run still reported plain success — a silent data
  // replacement. Say what happened instead.
  const declaredScripts = parsed.scripts;
  let scripts: Record<string, unknown>;
  let scriptsWereBroken = false;
  if (declaredScripts === undefined) {
    scripts = {};
  } else if (typeof declaredScripts === "object" && declaredScripts !== null && !Array.isArray(declaredScripts)) {
    scripts = declaredScripts as Record<string, unknown>;
  } else {
    notes.push(
      `package.json "scripts" was ${describeJsonValue(declaredScripts)}, not an object; it was replaced with an ` +
        "object holding the snapshot scripts."
    );
    scripts = {};
    scriptsWereBroken = true;
  }

  const added: string[] = [];
  if (!scripts.snapshot) {
    scripts.snapshot = `npx ${GENERATOR_NAME} generate`;
    added.push("snapshot");
  }
  if (!scripts["snapshot:validate"]) {
    scripts["snapshot:validate"] = `npx ${GENERATOR_NAME} validate`;
    added.push("snapshot:validate");
  }

  const declared = declaredRange(parsed);
  let dependency: InitDependency;
  if (declared !== null) {
    dependency = { name: GENERATOR_NAME, range: declared, added: false };
  } else {
    const range = `^${GENERATOR_VERSION}`;
    const declaration = parsed.devDependencies;
    let devDependencies: Record<string, unknown>;
    if (declaration === undefined) {
      devDependencies = {};
    } else if (typeof declaration === "object" && declaration !== null && !Array.isArray(declaration)) {
      devDependencies = declaration as Record<string, unknown>;
    } else {
      notes.push(
        `package.json "devDependencies" was ${describeJsonValue(declaration)}, not an object; it was replaced ` +
          `with an object that declares ${GENERATOR_NAME}.`
      );
      devDependencies = {};
    }
    devDependencies[GENERATOR_NAME] = range;
    parsed.devDependencies = devDependencies;
    dependency = { name: GENERATOR_NAME, range, added: true };
  }

  if (added.length === 0 && !dependency.added && !scriptsWereBroken) {
    return { scripts: [], dependency };
  }

  parsed.scripts = scripts;
  writeFileOrExplain(packagePath, serializePackageJson(raw, parsed));
  return { scripts: added, dependency };
}

/**
 * The directories `init` keeps out of git.
 *
 * The snapshot itself and the scratch copy it is swapped from. Both are build output, and leaving
 * them untracked is what makes `init` produce two file changes rather than a dirty tree.
 */
const GITIGNORE_ENTRIES = ["snapshot/", "snapshot.tmp/"];

/**
 * One entry in the preset list.
 *
 * `detectedName` is null when nothing was detected — the fallback preset was reached, not
 * chosen — so no entry may claim to be `detected` in that case.
 */
function resolvePresetChoice(detectedName: string | null, presetName: string): Choice<string> {
  return {
    value: presetName,
    label: presetName,
    hint: presetName === detectedName ? "detected" : undefined,
  };
}

/**
 * Runs the interactive setup, or writes a config from flags.
 *
 * Interactive only when both ends are a TTY and `--yes` was not passed; every
 * other path uses the flag values and the detected preset, and prints what it
 * decided rather than prompting.
 *
 * Every question starts on its answer, so pressing enter through the whole wizard
 * produces the recommended configuration — and the first question is a single
 * "use the recommended setup" for a project that was recognised, which is what makes
 * `snapshot` alone a complete command.
 */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const io = options.io ?? defaultIO();
  const detected = detectPreset(options.cwd, options.preset);
  // Reported back so the CLI can say *why* it chose a preset. A preset the developer picked,
  // or one forced with --preset, has nothing to report and is not a fallback.
  let reason = detected.reason;
  let fallback = detected.fallback;
  const notes: string[] = [];

  const answers: WizardAnswers = {
    preset: detected.presetName,
    // The repository's own branch, read the same way the generator reads it.
    // `getGitInfo` already falls back to "main" when git cannot report one, so a
    // directory that is not a repository, or a detached HEAD, still gets the
    // documented default. Writing "main" unconditionally made every later
    // `validate` warn about a mismatch the user never caused.
    branch: getGitInfo(options.cwd).branch,
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
    io.output.write("\n  codebase-snapshot\n");
    io.output.write("  Turn this repository into an LLM-ready, redacted, byte-bounded snapshot.\n\n");
    if (fallback) {
      // Naming what was looked for is the difference between "it failed" and "it needs an
      // answer": the developer can see immediately that this is not a project type the tool
      // knows, rather than suspecting a bug.
      io.output.write("  ⚠ Could not tell what kind of project this is.\n");
      io.output.write("    No package.json, go.mod, Cargo.toml, pyproject.toml, Gemfile,\n");
      io.output.write("    composer.json, pom.xml, *.csproj, next.config.*, vite.config.*, *.tf\n");
      io.output.write("    or workspace marker was found here.\n\n");
    } else {
      io.output.write(`  Detected   ${detected.presetName}\n`);
      io.output.write(`  Because    ${reason}\n\n`);
    }
    io.output.write(`  Directory  ${options.cwd}\n\n`);

    const paceChoices: Array<Choice<string>> = fallback
      ? [
          { value: "choose", label: "Pick the closest preset", hint: "then generate with the defaults" },
          { value: "recommended", label: "Use the defaults", hint: "generic · everything the scanner finds" },
          { value: "walk", label: "Go through each setting", hint: "every question starts on its default" },
        ]
      : [
          {
            value: "recommended",
            label: "Use the recommended setup",
            hint: `${detected.presetName} · config · npm scripts · install · generate`,
          },
          { value: "walk", label: "Go through each setting", hint: "every question starts on its default" },
          { value: "choose", label: "Pick a different preset", hint: "everything else stays at the defaults" },
        ];

    // The walk is reversible. A question that a later answer can invalidate may be revisited,
    // and `Review → No` steps back instead of aborting the way Ctrl+C does.
    const baseInclude = [...answers.include];
    const baseExclude = [...answers.excludePatterns];
    let lastScope = "all";

    const artifactChoices: Array<Choice<keyof ArtifactSelection>> = [
      { value: "readme", label: "README.md", hint: "orientation page" },
      { value: "manifest", label: "manifest.json", hint: "required by validate and report" },
      { value: "parts", label: "parts/", hint: "the code payload" },
      { value: "navigation", label: "reports/navigation.md", hint: "file → part index" },
      { value: "projectTree", label: "reports/project-tree.md", hint: "ASCII tree" },
      { value: "audit", label: "reports/audit.md", hint: "security and health findings" },
      { value: "monolith", label: "full-codebase.json + .md", hint: "roughly doubles output" },
    ];

    const scopeStep = async (): Promise<void> => {
      for (;;) {
        const scope = await select(
          io,
          "What should go into the snapshot?",
          [
            { value: "all", label: "Everything the scanner finds", hint: "recommended · respects .gitignore" },
            { value: "folders", label: "Only specific folders…" },
            { value: "no-tests", label: "Everything, but skip tests" },
            { value: "custom", label: "Let me write glob patterns" },
          ],
          { defaultValue: lastScope, allowBack: true }
        );
        lastScope = scope;
        // Re-entry starts from the flags the caller passed, so going back and choosing
        // differently never leaves the previous answer's globs behind in the config.
        answers.include = [...baseInclude];
        answers.excludePatterns = [...baseExclude];

        try {
          if (scope === "folders") {
            const dirs = topLevelDirs(options.cwd).slice(0, 40);
            if (dirs.length === 0) {
              notes.push("No top-level directories found; the snapshot will include everything.");
            } else {
              const chosen = await multiSelect(
                io,
                "Select folders",
                dirs.map((name) => ({ value: name, label: `${name}/` })),
                { defaults: dirs, allowBack: true }
              );
              answers.include = chosen.map((name) => `${name}/**`);
            }
          } else if (scope === "no-tests") {
            answers.excludePatterns = [...baseExclude, "**/*.test.*", "**/*.spec.*", "tests", "test"];
          } else if (scope === "custom") {
            const raw = await text(io, "Glob patterns to include (comma separated)", {
              defaultValue: baseInclude.join(", "),
              allowBack: true,
            });
            answers.include = raw
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean);
          }
          return;
        } catch (error) {
          // Back inside a sub-question returns to the question that opened it.
          if (error instanceof PromptBack) continue;
          throw error;
        }
      }
    };

    const sizeStep = async (): Promise<void> => {
      for (;;) {
        // The recommended budget belongs to the preset, so the selector starts on it rather than
        // on a fixed "120k" that silently overrode a 300k Next.js recommendation.
        const currentBudget = String(answers.maxPartBytes);
        const sizeChoice = await select(io, "How large should each part be?", SIZE_CHOICES, {
          defaultValue: SIZE_CHOICES.some((choice) => choice.value === currentBudget)
            ? currentBudget
            : "custom",
          allowBack: true,
        });

        if (sizeChoice !== "custom") {
          answers.maxPartBytes = sizeChoice;
          return;
        }
        try {
          const raw = await text(io, "Part size (e.g. 150k, 1.5mb, 900000)", {
            defaultValue: currentBudget,
            validate: (value) => (parseByteSize(value) === undefined ? "Not a valid size." : null),
            allowBack: true,
          });
          answers.maxPartBytes = parseByteSize(raw) ?? answers.maxPartBytes;
          return;
        } catch (error) {
          if (error instanceof PromptBack) continue;
          throw error;
        }
      }
    };

    const artifactsStep = async (): Promise<void> => {
      const enabled = ARTIFACT_NAMES.filter((name) => answers.artifacts[name]);
      const selectedArtifacts = await multiSelect(
        io,
        "Which artifacts should be generated?",
        artifactChoices,
        { defaults: enabled, allowBack: true }
      );
      for (const name of ARTIFACT_NAMES) answers.artifacts[name] = selectedArtifacts.includes(name);
    };

    const credentialsStep = async (): Promise<void> => {
      answers.includeSensitiveFiles = await confirm(
        io,
        "Include credential files (.env, *.pem, *.npmrc, *.ssh/)?",
        { defaultValue: answers.includeSensitiveFiles, allowBack: true }
      );
    };

    const reviewStep = async (): Promise<void> => {
      const enabledCount = ARTIFACT_NAMES.filter((name) => answers.artifacts[name]).length;
      io.output.write("\n  Review\n\n");
      io.output.write(`  project          ${answers.preset}\n`);
      io.output.write(`  include          ${answers.include.length ? answers.include.join(", ") : "everything"}\n`);
      io.output.write(`  part size        ${String(answers.maxPartBytes)}\n`);
      io.output.write(`  artifacts        ${enabledCount} of ${ARTIFACT_NAMES.length}\n`);
      io.output.write(`  credentials      ${answers.includeSensitiveFiles ? "included" : "skipped"}\n\n`);
      io.output.write("  Will write snapshot.config with your answers, plus every other setting\n");
      io.output.write("  at its default — so nothing is hidden behind the docs.\n\n");

      const proceed = await confirm(io, "Write this and continue?", {
        defaultValue: true,
        allowBack: true,
      });
      // "No" means "not like this", which is a step back. Ctrl+C is how you say stop.
      if (!proceed) throw new PromptBack();
    };

    /** Runs the walk, returning false when the developer backs out of its first question. */
    const walk = async (): Promise<boolean> => {
      const steps = [scopeStep, sizeStep, artifactsStep, credentialsStep, reviewStep];
      let index = 0;
      while (index < steps.length) {
        try {
          await steps[index]();
          index += 1;
        } catch (error) {
          if (!(error instanceof PromptBack)) throw error;
          if (index === 0) return false;
          index -= 1;
          io.output.write("\n");
        }
      }
      return true;
    };

    // Re-entered when the first walk step asks to go back, so "go through each setting" is not
    // a one-way door.
    for (;;) {
      const pace = await select(io, "How should I set this up?", paceChoices, {
        defaultValue: fallback ? "choose" : "recommended",
      });

      if (pace === "choose") {
        try {
          answers.preset = await select(
            io,
            "What kind of project is this?",
            listPresetNames().map((name) =>
              resolvePresetChoice(fallback ? null : detected.presetName, name)
            ),
            { defaultValue: answers.preset, allowBack: true }
          );
        } catch (error) {
          if (error instanceof PromptBack) continue;
          throw error;
        }
        const chosen = detectPreset(options.cwd, answers.preset);
        answers.preset = chosen.presetName;
        // The developer made the decision, so there is no detection to report and this is not
        // a fallback any more.
        reason = null;
        fallback = false;
      }

      if (pace === "walk" && !(await walk())) continue;
      break;
    }

  }

  const configText = renderConfig(answers);
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

  // `setup` keeps a config it finds: it is the repository's, and rewriting it would silently
  // discard whatever the user changed. The rest of the setup still runs.
  const reused = present !== null && options.force !== true && options.reuseConfig === true;
  if (reused) notes.push(`Kept the existing ${present} instead of writing a new one.`);

  if (options.dryRun) {
    return {
      configPath,
      configText,
      written: false,
      reused,
      preset: answers.preset,
      reason,
      fallback,
      scripts: [],
      gitignoreEntries: [],
      dependency: { name: GENERATOR_NAME, range: `^${GENERATOR_VERSION}`, added: false },
      notes,
    };
  }

  if (present !== null && present !== preferredName && !options.force && !reused) {
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
  if (packageJsonHasConfig(options.cwd) && !options.force && !reused) {
    throw new Error(
      'package.json already defines a "snapshot" config. Remove that key, or re-run with --force ' +
        "to write a config file that takes precedence over it."
    );
  }
  if (fs.existsSync(configPath) && !options.force && !reused) {
    throw new Error(`${configName} already exists. Re-run with --force to replace it.`);
  }

  if (!reused) writeFileOrExplain(configPath, configText);
  const { scripts, dependency } = updatePackageJson(options.cwd, notes);
  const ignore = appendGitignoreEntries(options.cwd, GITIGNORE_ENTRIES);
  if (ignore.note !== null) notes.push(ignore.note);

  return {
    configPath,
    configText,
    written: true,
    reused,
    preset: answers.preset,
    reason,
    fallback,
    scripts,
    gitignoreEntries: ignore.added,
    dependency,
    notes,
  };
}
