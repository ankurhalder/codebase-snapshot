import { ARTIFACT_NAMES } from "../config.js";
import { GENERATOR_NAME, GENERATOR_VERSION, MIN_MAX_PART_BYTES, SCHEMA_VERSION } from "../index.js";
import { PRESETS } from "../presets/registry.js";

/** Version of the shape of this document, independent of the package version. */
export const CONTRACT_VERSION = "1.0.0";

const PACKAGE_NAME = "@ankurhalder/codebase-snapshot";

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
      bins: ["codebase-snapshot"],
      notes: [
        `The bare package name also works: npx ${PACKAGE_NAME} <command>.`,
        "Pin @latest (or @2) when you need the exact same version on every machine.",
        "This package exposes exactly one executable on purpose: npm cannot infer which one to run for a scoped package that ships several.",
        "Human progress goes to stderr. With --format json the payload on stdout is pure JSON.",
      ],
    },
    workflow: [
      {
        step: 1,
        id: "verify",
        run: `npx ${PACKAGE_NAME}@latest --version`,
        expect: "prints v2.x.x on stdout and exits 0",
        notes: "If it prints nothing, clear the npm cache and retry, or use `npx -p <pkg> codebase-snapshot`.",
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
        expect: "writes snapshot.config.ts listing every setting at its current value",
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
        summary: "Compare the snapshot on disk with the repository; exit 1 on drift.",
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
        name: "init",
        aliases: [],
        summary: "Write a commented snapshot.config.ts (interactive, or --yes for CI).",
        positionals: [],
        exits: [0, 1, 2],
      },
      {
        name: "explain",
        aliases: [],
        summary: "Explain how one path would be treated: layer, kind, part, skip reason.",
        positionals: ["<path>"],
        exits: [0, 1],
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
          "Print the agent skill, or --install it into the repository (AGENTS.md, .claude/skills, .cursor/rules).",
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
        appliesTo: "generate/validate/report/explain",
        summary: "Where the snapshot is written. Must not be the repo root or a directory the tool did not create.",
      },
      {
        flag: "--max-part-bytes",
        type: "string",
        default: 307200,
        appliesTo: "generate/validate/report",
        summary: 'Byte budget per markdown part. Accepts "120k" / "1.5mb". Minimum 4096.',
      },
      {
        flag: "--large-file-bytes",
        type: "string",
        default: 204800,
        appliesTo: "generate/validate/report",
        summary: "Above this size a file gets a head/tail preview instead of the full body.",
      },
      {
        flag: "--max-monolith-bytes",
        type: "string",
        default: "unset",
        appliesTo: "generate",
        summary: "Skip the monolith artifacts when they would exceed this size.",
      },
      {
        flag: "--include-monolith",
        type: "boolean",
        default: false,
        appliesTo: "generate",
        summary: "Also write full-codebase.json and full-codebase.md.",
      },
      {
        flag: "--include-sensitive-files",
        type: "boolean",
        default: false,
        appliesTo: "generate/validate/report",
        summary: "Also emit .env / *.pem / .npmrc style files. Off by default; they are recorded as skipped.",
      },
      {
        flag: "--skip-artifacts",
        type: "string",
        default: "unset",
        appliesTo: "generate",
        summary: "Comma-separated artifacts to omit (readme, manifest, parts, navigation, projectTree, audit, monolith).",
      },
      {
        flag: "--only-artifacts",
        type: "string",
        default: "unset",
        appliesTo: "generate",
        summary: "Write only these artifacts. Cannot be combined with --skip-artifacts.",
      },
      {
        flag: "--format",
        type: "string",
        default: "text",
        appliesTo: "all commands",
        summary: 'Output format: "text" or "json". JSON goes to stdout, progress to stderr.',
      },
      {
        flag: "--cwd",
        type: "string",
        default: "process.cwd()",
        appliesTo: "all commands",
        summary: "Repository to operate on. Must be an existing directory.",
      },
      {
        flag: "--dry-run",
        type: "boolean",
        default: false,
        appliesTo: "generate",
        summary: "Compute everything and print the result without writing.",
      },
      {
        flag: "--watch",
        type: "boolean",
        default: false,
        appliesTo: "generate",
        summary: "Regenerate on every change until interrupted.",
      },
      {
        flag: "--preset",
        type: "string",
        default: "detected",
        appliesTo: "init",
        summary: "Force a project preset instead of detecting one. Unknown names are a usage error.",
      },
      {
        flag: "--include",
        type: "string",
        default: "unset",
        appliesTo: "init",
        summary: "Comma-separated allow-list of globs to record in the generated config.",
      },
      {
        flag: "--exclude",
        type: "string",
        default: "unset",
        appliesTo: "init",
        summary: "Comma-separated globs to record in the generated config.",
      },
      {
        flag: "--yes",
        type: "boolean",
        default: false,
        appliesTo: "init",
        summary: "Accept every default without prompting. Required in a non-TTY.",
      },
      {
        flag: "--minimal",
        type: "boolean",
        default: false,
        appliesTo: "init",
        summary: "Write only the settings that differ from the defaults.",
      },
      {
        flag: "--force",
        type: "boolean",
        default: false,
        appliesTo: "init",
        summary: "Overwrite an existing config file.",
      },
      {
        flag: "--install",
        type: "boolean",
        default: false,
        appliesTo: "skill",
        summary: "Write the skill into the repository instead of printing it.",
      },
      {
        flag: "--target",
        type: "string",
        default: "all",
        appliesTo: "skill",
        summary: 'Where to install: "claude", "agents", "cursor" or "all".',
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
        ".snapshotrc",
        ".snapshotrc.json",
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
        "manifest.json.files[] carries relativePath, layer, kind, language, part, inclusionMode, hash and a structural summary.",
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
          "The executable was not found: an offline or partially populated npm cache, or an npm proxy " +
          "serving an incomplete manifest.",
        fix: `Clear the npx cache (npm cache clean --force), then run npx ${PACKAGE_NAME}@latest <command>.`,
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
