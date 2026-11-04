import { ARTIFACT_NAMES } from "../config.js";
import { GENERATOR_NAME, GENERATOR_VERSION, MIN_MAX_PART_BYTES, SCHEMA_VERSION } from "../index.js";
import { PRESETS } from "../presets/registry.js";
import { optionAppliesTo } from "./option-scope.js";

/** Version of the shape of this document, independent of the package version. */
export const CONTRACT_VERSION = "1.0.0";

const PACKAGE_NAME = "codebase-snapshot";

/**
 * Major version of the build that generates this contract.
 *
 * A step that probes the floating `@latest` tag may only compare this part: the
 * tag can lag the release (npm propagation) or lead it, so an exact patch in an
 * `expect` makes the contract's own first step impossible to pass.
 */
const MAJOR_VERSION = GENERATOR_VERSION.split(".")[0];

/**
 * The machine-readable description of this tool.
 *
 * Everything an agent needs to use the tool without prior knowledge lives here:
 * the invocation that works, the ordered workflow, the full option table with
 * defaults, the exit-code contract, the presets, the artifacts, the config file
 * names and the output layout. It exists because `--help` is prose written for a
 * human, and an agent with no context cannot reliably parse prose.
 *
 * `codebase-snapshot describe --format json` prints this. Keep it in sync with the CLI — the
 * test suite asserts that the defaults here match `resolveConfig`'s defaults, so
 * drift fails the build rather than misleading an agent.
 */
export interface AgentContract {
  generator: string;
  package: string;
  version: string;
  schemaVersion: string;
  contractVersion: string;
  summary: string;
  requires: { node: string; dependencies: string[] };
  invocation: {
    oneShot: string;
    installed: string;
    bins: string[];
    notes: string[];
  };
  workflow: Array<{ step: number; id: string; run: string; expect: string; notes?: string }>;
  commands: Array<{
    name: string;
    aliases: string[];
    summary: string;
    positionals: string[];
    exits: number[];
  }>;
  exitCodes: Record<string, string>;
  options: Array<{
    flag: string;
    type: "string" | "boolean";
    default?: string | number | boolean;
    appliesTo: string;
    summary: string;
  }>;
  presets: Array<{
    name: string;
    priority: number;
    recommendedBudget: string | number;
    excludes: string[];
  }>;
  artifacts: Array<{ name: string; default: boolean; summary: string }>;
  config: {
    fileNames: string[];
    settings: Array<{
      key: string;
      type: string;
      default: string | number | boolean | null;
      summary: string;
    }>;
  };
  output: { layout: string[]; notes: string[] };
  safety: string[];
  troubleshooting: Array<{ symptom: string; cause: string; fix: string }>;
}

const ARTIFACT_SUMMARY: Record<string, string> = {
  readme: "README.md describing the snapshot at the output root.",
  manifest: "manifest.json: machine-readable index of every file, part, hash and config.",
  parts: "parts/*.md: the packed, budget-limited markdown parts that carry the code.",
  navigation: "reports/navigation.md: links between parts and layers.",
  projectTree: "reports/project-tree.md: the directory tree of included files.",
  audit: "reports/audit.md: secret findings, large files, parse diagnostics, git state.",
  monolith:
    "full-codebase.json and full-codebase.md: the whole repository in one file (off by default).",
};

const ARTIFACT_DEFAULTS: Record<string, boolean> = {
  readme: true,
  manifest: true,
  parts: true,
  navigation: true,
  projectTree: true,
  audit: true,
  monolith: false,
};

/** Renders the contract for a human. `--format json` is the machine version. */
export function renderContractText(contract: AgentContract): string {
  const lines: string[] = [];
  lines.push(`${contract.package} v${contract.version}`);
  lines.push(contract.summary);
  lines.push("");
  lines.push(`Node        : ${contract.requires.node}`);
  lines.push(`Schema      : ${contract.schemaVersion} (contract ${contract.contractVersion})`);
  lines.push(`One-shot    : ${contract.invocation.oneShot} <command>`);
  lines.push(`Installed   : ${contract.invocation.installed} <command>`);
  lines.push("");
  lines.push("Workflow:");
  for (const step of contract.workflow) {
    lines.push(`  ${step.step}. ${step.id}`);
    lines.push(`     run    : ${step.run}`);
    lines.push(`     expect : ${step.expect}`);
    if (step.notes) lines.push(`     note   : ${step.notes}`);
  }
  lines.push("");
  lines.push("Commands:");
  for (const command of contract.commands) {
    const args = command.positionals.length > 0 ? ` ${command.positionals.join(" ")}` : "";
    lines.push(`  ${(command.name + args).padEnd(26)} ${command.summary}`);
  }
  lines.push("");
  lines.push("Exit codes:");
  for (const [code, meaning] of Object.entries(contract.exitCodes)) {
    lines.push(`  ${code}  ${meaning}`);
  }
  lines.push("");
  lines.push(`Presets (${contract.presets.length}): ${contract.presets.map((p) => p.name).join(", ")}`);
  lines.push("");
  lines.push("Artifacts:");
  for (const artifact of contract.artifacts) {
    lines.push(`  ${artifact.name.padEnd(12)} ${artifact.default ? "on " : "off"}  ${artifact.summary}`);
  }
  lines.push("");
  lines.push("Options:");
  for (const option of contract.options) {
    const fallback =
      option.default === undefined ? "" : ` [${JSON.stringify(option.default)}]`;
    lines.push(`  ${option.flag.padEnd(24)} ${option.appliesTo.padEnd(32)}${fallback}`);
    lines.push(`  ${"".padEnd(24)} ${option.summary}`);
  }
  lines.push("");
  lines.push("Safety:");
  for (const note of contract.safety) lines.push(`  - ${note}`);
  lines.push("");
  lines.push("Troubleshooting:");
  for (const item of contract.troubleshooting) {
    lines.push(`  ${item.symptom}`);
    lines.push(`     cause: ${item.cause}`);
    lines.push(`     fix  : ${item.fix}`);
  }
  lines.push("");
  lines.push("This is the human rendering. Agents should use: describe --format json");
  return lines.join("\n");
}

/** Builds the contract document. Cheap enough to call on every `describe`. */
export function buildAgentContract(): AgentContract {
  return {
    generator: GENERATOR_NAME,
    package: PACKAGE_NAME,
    version: GENERATOR_VERSION,
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    summary:
      "Turns a repository into an LLM-ready snapshot: code packed into size-budgeted " +
      "markdown parts, plus a manifest, a project tree, navigation and a secret audit. " +
      "Auto-detects the project shape (framework, language, monorepo, docs, infra).",
    requires: { node: ">=18.0.0", dependencies: ["typescript"] },
    invocation: {
      oneShot: `npx ${PACKAGE_NAME}@latest`,
      installed: "npx codebase-snapshot",
      bins: ["codebase-snapshot", "snap"],
      notes: [
        `The bare package name also works: npx ${PACKAGE_NAME} <command>.`,
        "Pin an exact version — for example `codebase-snapshot@0.9.0` — when you need the same build on every machine. A major range is not enough before 1.0: npm's caret on a 0.x version pins the minor, and 0.x minors are breaking by convention.",
        "Both bin names point at the same file. npm resolves a package by its bin entries, so they must stay aliases of one executable.",
        "Human progress goes to stderr. With --format json the payload on stdout is pure JSON.",
        "A failing run also writes pure JSON to stdout: { error: { message, exitCode } }. The exit code and the stderr line are unchanged.",
      ],
    },
    workflow: [
      {
        step: 1,
        id: "verify",
        run: `npx ${PACKAGE_NAME}@latest --version`,
        // The requirement is the major version; the exact build is context. A
        // floating tag may print a different patch today than next week, and an agent
        // must not conclude that a working tool is broken because of a patch.
        expect:
          `prints v${MAJOR_VERSION} or newer on stdout and exits 0 ` +
          `(this build is v${GENERATOR_VERSION}: compare the major version, not the patch)`,
        notes:
          "If it prints an older major than this contract's, the @latest tag is behind the release: " +
          `pin the exact version with \`npx ${PACKAGE_NAME}@${GENERATOR_VERSION} --version\` instead of retrying @latest. ` +
          "If it prints nothing, clear the npm cache and retry, or use `npx -p <pkg> codebase-snapshot`.",
      },
      {
        step: 2,
        id: "understand",
        run: `npx ${PACKAGE_NAME}@latest describe --format json`,
        expect: "the full contract as JSON: commands, options, presets, exit codes",
        notes: "Read this before acting if you have no prior knowledge of the tool.",
      },
      {
        step: 3,
        id: "configure",
        run: `npx ${PACKAGE_NAME}@latest init --yes`,
        expect:
          "writes a commented config file listing every setting at its current value: " +
          "snapshot.config.ts only when the running Node can strip types (>= 22.6) and the project " +
          'is an ES module (`"type": "module"` in package.json); snapshot.config.mjs otherwise',
        notes:
          "Non-interactive. The detected preset is chosen automatically; override with --preset <name>. " +
          "Skip this step to run on built-in defaults.",
      },
      {
        step: 4,
        id: "generate",
        run: `npx ${PACKAGE_NAME}@latest generate`,
        expect: "exit 0, and ./snapshot/ written with parts, reports and manifest.json",
      },
      {
        step: 5,
        id: "verify-output",
        run: `npx ${PACKAGE_NAME}@latest validate`,
        expect: "exit 0 means the snapshot matches the files on disk",
        notes: "Exit 1 means drift or a damaged snapshot; re-run generate.",
      },
      {
        step: 6,
        id: "consume",
        run: "read ./snapshot/parts/*.md, then ./snapshot/manifest.json, then ./snapshot/reports/audit.md",
        expect: "the code, the index of what was included, and the risk findings",
        notes:
          "manifest.json.files[] lists every included file with layer, kind, language, part and summary. " +
          "manifest.skipped[] explains every file that was left out and why.",
      },
    ],
    commands: [
      {
        name: "generate",
        aliases: ["default"],
        summary: "Write the snapshot. This is the command you normally want.",
        positionals: [],
        exits: [0, 1],
      },
      {
        name: "validate",
        aliases: ["check"],
        summary:
          "Compare the snapshot on disk with the repository; exit 1 on drift. " +
          "`check` is an alias of `validate`.",
        positionals: [],
        exits: [0, 1],
      },
      {
        name: "report",
        aliases: [],
        summary: "Print snapshot health, layer metrics and the secret audit.",
        positionals: [],
        exits: [0, 1],
      },
      {
        name: "setup",
        aliases: [],
        summary:
          "Everything a repository needs in one command, with defaults: write the config when there " +
          "is none (an existing one is kept), add the npm scripts, devDependency and .gitignore " +
          "entries, install dependencies with the project's package manager, then generate the " +
          "snapshot. --no-install skips the install; --dry-run writes nothing.",
        positionals: [],
        exits: [0, 1, 2],
      },
      {
        name: "init",
        aliases: [],
        summary:
          "Write a commented config file (snapshot.config.ts only when Node can strip types and the " +
          "project is an ES module; snapshot.config.mjs otherwise), add the snapshot scripts and the " +
          "devDependency, and ignore the snapshot directories. Nothing else is written. Interactive, " +
          "or --yes for CI.",
        positionals: [],
        exits: [0, 1, 2],
      },
      {
        name: "explain",
        aliases: [],
        summary:
          "Explain how one path would be treated: layer, kind, part, skip reason. " +
          "Always exits 0 when it can report; read `included` and `reason` instead of the exit code.",
        positionals: ["<path>"],
        exits: [0],
      },
      {
        name: "diff",
        aliases: [],
        summary: "Compare two snapshots (directories or manifest.json files).",
        positionals: ["<before>", "<after>"],
        exits: [0, 1],
      },
      {
        name: "describe",
        aliases: [],
        summary: "Print this contract. --format json for machines, text for humans.",
        positionals: [],
        exits: [0],
      },
      {
        name: "skill",
        aliases: [],
        summary:
          "Print the agent skill, or --install it into the tool registries this repository's " +
          "agent reads (.claude/skills, .cursor/rules). Files it creates are added to " +
          ".gitignore. It never writes AGENTS.md: that file belongs to the repository.",
        positionals: [],
        exits: [0, 1, 2],
      },
    ],
    exitCodes: {
      "0": "success (and validate: no drift)",
      "1": "drift detected, or generation refused/failed (nothing was written)",
      "2": "usage error: unknown flag/command, bad value, wrong argument count",
    },
    options: [
      {
        flag: "--out-dir",
        type: "string",
        default: "snapshot",
        appliesTo: optionAppliesTo("out-dir"),
        summary: "Where the snapshot is written. Must not be the repo root or a directory the tool did not create.",
      },
      {
        flag: "--max-part-bytes",
        type: "string",
        default: 307200,
        appliesTo: optionAppliesTo("max-part-bytes"),
        summary: 'Byte budget per markdown part. Accepts "120k" / "1.5mb". Minimum 4096.',
      },
      {
        flag: "--large-file-bytes",
        type: "string",
        default: 204800,
        appliesTo: optionAppliesTo("large-file-bytes"),
        summary: "Above this size a file gets a head/tail preview instead of the full body.",
      },
      {
        flag: "--max-monolith-bytes",
        type: "string",
        default: "unset",
        appliesTo: optionAppliesTo("max-monolith-bytes"),
        summary: "Skip the monolith artifacts when they would exceed this size.",
      },
      {
        flag: "--include-monolith",
        type: "boolean",
        default: false,
        appliesTo: optionAppliesTo("include-monolith"),
        summary: "Also write full-codebase.json and full-codebase.md.",
      },
      {
        flag: "--include-sensitive-files",
        type: "boolean",
        default: false,
        appliesTo: optionAppliesTo("include-sensitive-files"),
        summary: "Also emit .env / *.pem / .npmrc style files. Off by default; they are recorded as skipped.",
      },
      {
        flag: "--discovery",
        type: "string",
        default: "auto",
        appliesTo: optionAppliesTo("discovery"),
        summary: "How files are discovered: auto (git when usable), git (require git), walk (read the root .gitignore directly; the escape hatch for a .git that cannot be listed).",
      },
      {
        flag: "--skip-artifacts",
        type: "string",
        default: "unset",
        appliesTo: optionAppliesTo("skip-artifacts"),
        summary: "Comma-separated artifacts to omit (readme, manifest, parts, navigation, projectTree, audit, monolith).",
      },
      {
        flag: "--only-artifacts",
        type: "string",
        default: "unset",
        appliesTo: optionAppliesTo("only-artifacts"),
        summary: "Write only these artifacts. Cannot be combined with --skip-artifacts.",
      },
      {
        flag: "--format",
        type: "string",
        default: "text",
        // `optionAppliesTo` always returns the explicit slash list, so this is the same scoped form
        // as every other option — no prose sentinel a machine consumer could misread.
        appliesTo: optionAppliesTo("format"),
        summary: 'Output format: "text" or "json". JSON goes to stdout, progress to stderr.',
      },
      {
        flag: "--mode",
        type: "string",
        default: "generate",
        appliesTo: optionAppliesTo("mode"),
        summary:
          "Select the command when no command word is given. Values: generate, validate, check, " +
          "report, init, setup, explain, diff, describe, skill. A command word and --mode must name " +
          "the same command; a contradiction is a usage error (exit 2).",
      },
      {
        flag: "--cwd",
        type: "string",
        default: "process.cwd()",
        appliesTo: optionAppliesTo("cwd"),
        summary: "Repository to operate on. Must be an existing directory.",
      },
      {
        flag: "--dry-run",
        type: "boolean",
        default: false,
        appliesTo: optionAppliesTo("dry-run"),
        summary: "Compute everything and print the result without writing.",
      },
      {
        flag: "--watch",
        type: "boolean",
        default: false,
        appliesTo: optionAppliesTo("watch"),
        summary: "Regenerate on every change until interrupted.",
      },
      {
        flag: "--no-config",
        type: "boolean",
        default: false,
        appliesTo: optionAppliesTo("no-config"),
        summary: "Ignore the config file and run on the built-in defaults.",
      },
      {
        flag: "--preset",
        type: "string",
        default: "detected",
        appliesTo: optionAppliesTo("preset"),
        summary: "Force a project preset instead of detecting one. Unknown names are a usage error.",
      },
      {
        flag: "--include",
        type: "string",
        default: "unset",
        appliesTo: optionAppliesTo("include"),
        summary: "Comma-separated allow-list of globs to record in the generated config.",
      },
      {
        flag: "--exclude",
        type: "string",
        default: "unset",
        appliesTo: optionAppliesTo("exclude"),
        summary: "Comma-separated globs to record in the generated config.",
      },
      {
        flag: "--yes",
        type: "boolean",
        default: false,
        appliesTo: optionAppliesTo("yes"),
        summary: "Accept every default without prompting. Required in a non-TTY.",
      },
      {
        flag: "--force",
        type: "boolean",
        default: false,
        appliesTo: optionAppliesTo("force"),
        summary: "Overwrite an existing config file.",
      },
      {
        flag: "--install",
        type: "boolean",
        default: false,
        appliesTo: optionAppliesTo("install"),
        summary: "Write the skill into the repository instead of printing it.",
      },
      {
        flag: "--target",
        type: "string",
        default: "all",
        appliesTo: optionAppliesTo("target"),
        summary: 'Where to install: "claude", "cursor" or "all".',
      },
      {
        flag: "--no-install",
        type: "boolean",
        default: false,
        appliesTo: optionAppliesTo("no-install"),
        summary:
          "setup only: skip installing the dependency before generating (CI, offline, or a lockfile " +
          "you do not want a package manager to touch).",
      },
    ],
    presets: PRESETS.map((preset) => ({
      name: preset.name,
      priority: preset.priority,
      recommendedBudget: preset.recommendedBudget ?? "300k",
      excludes: preset.exclude ? [...preset.exclude] : [],
    })),
    artifacts: ARTIFACT_NAMES.map((name) => ({
      name,
      default: ARTIFACT_DEFAULTS[name] ?? true,
      summary: ARTIFACT_SUMMARY[name] ?? name,
    })),
    config: {
      fileNames: [
        "snapshot.config.ts",
        "snapshot.config.js",
        "snapshot.config.mjs",
        "snapshot.config.cjs",
        "snapshot.config.json",
        ".snapshotrc.json",
        ".snapshotrc",
        'package.json → "snapshot" key',
      ],
      settings: [
        { key: "outDir", type: "string", default: "snapshot", summary: "Snapshot output directory." },
        { key: "tmpDir", type: "string", default: "snapshot.tmp", summary: "Scratch directory used for the atomic swap." },
        { key: "branch", type: "string", default: "main", summary: "Branch recorded when git cannot report one." },
        { key: "preset", type: "string", default: "detected", summary: "Force a preset. Unknown names are an error." },
        { key: "maxPartBytes", type: "number | string", default: 307200, summary: "Per-part byte budget." },
        { key: "largeFileBytes", type: "number | string", default: 204800, summary: "Preview threshold for large files." },
        { key: "previewHeadLines", type: "number", default: 80, summary: "Lines kept from the head of a large file." },
        { key: "previewTailLines", type: "number", default: 40, summary: "Lines kept from the tail of a large file." },
        { key: "includeMonolith", type: "boolean", default: false, summary: "Also write the single-file monolith." },
        { key: "maxMonolithBytes", type: "number | string | null", default: null, summary: "Skip the monolith above this size." },
        { key: "includeSensitiveFiles", type: "boolean", default: false, summary: "Emit .env / *.pem / credential files." },
        { key: "include", type: "string[]", default: "[]", summary: "Allow-list of globs; empty means everything." },
        { key: "excludePatterns", type: "string[]", default: "[]", summary: "Extra exclude globs." },
        { key: "discovery", type: '"auto" | "git" | "walk"', default: "auto", summary: "How files are discovered; `walk` scans the tree and reads .gitignore directly when a .git directory cannot be listed." },
        { key: "artifacts", type: "object", default: "all on except monolith", summary: "Per-artifact opt-out." },
        { key: "budgets", type: "object", default: "{ default, byLayer }", summary: "Per-layer byte budgets." },
        { key: "layersMode", type: '"merge" | "replace"', default: "merge", summary: "Whether custom layers extend or replace the preset's." },
        { key: "layers", type: "array", default: "preset layers", summary: "Custom layer rules (glob or RegExp)." },
        { key: "kinds", type: "array", default: "preset kinds", summary: "Custom kind rules." },
        { key: "secrets", type: "object", default: "{}", summary: "Custom secret patterns, or disable the defaults." },
        { key: "hooks", type: "object", default: "{}", summary: "afterGenerate(manifest) runs after a successful generate." },
      ],
    },
    output: {
      layout: [
        "<outDir>/README.md",
        "<outDir>/manifest.json",
        "<outDir>/parts/part-NNN.md",
        "<outDir>/reports/project-tree.md",
        "<outDir>/reports/navigation.md",
        "<outDir>/reports/audit.md",
        "<outDir>/.codebase-snapshot  (ownership marker, always written)",
      ],
      notes: [
        "Parts are ordered and budget-limited; a single file larger than the budget becomes a head/tail preview.",
        "manifest.json.files[] carries relativePath, layer, kind, language, part, inclusionMode and hash; `summary` is conditional — it is absent for languages with no structural summary, and `summaryOmitted: true` marks a summary dropped to fit the part budget; encoding appears when the file was not plain UTF-8.",
        "manifest.skipped[] carries the path and the exact reason it was excluded.",
        `The output directory is replaced atomically; ${MIN_MAX_PART_BYTES} bytes is the smallest legal budget.`,
      ],
    },
    safety: [
      "Sensitive files (.env, *.pem, .npmrc, .ssh/, .tfstate) are excluded by default and listed in manifest.skipped[].",
      "Secret-shaped strings in ordinary source files are redacted in the emitted parts.",
      "The tool refuses to replace an outDir that it did not create, so a mistyped outDir cannot delete source code.",
      "Nothing is ever written above the repository root; --out-dir may not be the root or an ancestor.",
    ],
    troubleshooting: [
      {
        symptom: "Command prints nothing and exits 0",
        cause:
          "A stale global install of this package (often a leftover `npm link`) is shadowing npx: " +
          "npm runs the global binary instead of installing the published one.",
        fix:
          "Check `npm ls -g --depth=0` for codebase-snapshot and remove it with " +
          "`npm rm -g codebase-snapshot`. If it is not installed globally, clear the npx " +
          "cache with `npm cache clean --force` and retry.",
      },
      {
        symptom: "Exit 1 with 'Refusing to replace outDir'",
        cause: "The outDir exists and contains files this tool did not write.",
        fix: "Choose a new/empty --out-dir, or delete the existing directory yourself.",
      },
      {
        symptom: "Exit 1 with 'The config file could not be read'",
        cause: "snapshot.config.* exists but does not parse.",
        fix: "Fix the syntax, or delete the config to use the defaults.",
      },
      {
        symptom: "Exit 1 from validate",
        cause: "The snapshot no longer matches the files on disk.",
        fix: "Re-run generate.",
      },
      {
        symptom: "A directory you expected is missing from the snapshot",
        cause: "It is excluded by the preset, by default ignores, or by your own globs.",
        fix: "Run `explain <path>`; manifest.skipped[] also records the reason for every file.",
      },
    ],
  };
}
