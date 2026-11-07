/**
 * Which command each CLI option actually affects.
 *
 * This table exists because two separate lies were possible without it: the
 * published contract told agents that `--max-part-bytes` applied to
 * "generate/validate/report" when `init` also accepts it, and the parser
 * accepted `--watch` on `validate`, where it changed nothing at all. A flag that
 * is parsed but has no effect is a silent fallback with a command line on top:
 * the user believes an override took effect and the run used the default.
 *
 * Both consumers read this one table — the parser rejects anything outside the
 * scope, and `describe` renders the scope into `appliesTo` — so the contract
 * cannot drift from the parser again.
 */
export type CommandName =
  | "generate"
  | "validate"
  | "report"
  | "init"
  | "setup"
  | "explain"
  | "diff"
  | "describe"
  | "skill"
  | "mcp";

/** `check` is an alias of `validate`; appliesTo names the canonical command only. */
const VALIDATE_OPTIONS = [
  "cwd",
  "out-dir",
  "max-part-bytes",
  "large-file-bytes",
  "max-monolith-bytes",
  "include-monolith",
  "include-sensitive-files",
  "skip-artifacts",
  "only-artifacts",
  "no-config",
  "discovery",
  "format",
  "no-update-check",
  "mode",
  "help",
  "version",
] as const;

/**
 * `cwd` is absent from `describe` and `diff`: neither reads the repository, and
 * `diff` resolves its two positional arguments against the process directory.
 */
export const COMMAND_OPTION_SCOPE: Record<CommandName, readonly string[]> = {
  generate: [
    "skeleton",
    "changed-since",
    "staged",
    "with-dependents",
    "cwd",
    "out-dir",
    "max-part-bytes",
    "max-part-tokens",
    "large-file-bytes",
    "max-monolith-bytes",
    "include-monolith",
    "include-sensitive-files",
    "skip-artifacts",
    "only-artifacts",
    "no-config",
    "discovery",
    "format",
    "mode",
    "dry-run",
    "watch",
    "autopilot",
    "no-install",
    "no-update-check",
    "help",
    "version",
  ],
  validate: VALIDATE_OPTIONS,
  report: [
    "cwd",
    "out-dir",
    "max-part-bytes",
    "large-file-bytes",
    "max-monolith-bytes",
    "include-monolith",
    "include-sensitive-files",
    "skip-artifacts",
    "only-artifacts",
    "no-config",
    "no-update-check",
    "format",
    "mode",
    "help",
    "version",
  ],
  explain: [
    "cwd",
    "out-dir",
    "max-part-bytes",
    "large-file-bytes",
    "max-monolith-bytes",
    "include-monolith",
    "include-sensitive-files",
    "skip-artifacts",
    "only-artifacts",
    "no-config",
    "discovery",
    "no-update-check",
    "format",
    "mode",
    "help",
    "version",
  ],
  diff: ["format", "mode", "no-config", "no-update-check", "help", "version"],
  describe: ["format", "mode", "help", "version"],
  init: [
    "install-hook",
    "cwd",
    "out-dir",
    "max-part-bytes",
    "include-sensitive-files",
    "skip-artifacts",
    "only-artifacts",
    "preset",
    "include",
    "exclude",
    "yes",
    "force",
    "dry-run",
    "no-update-check",
    "format",
    "mode",
    "help",
    "version",
  ],
  skill: ["cwd", "format", "mode", "install", "target", "help", "version"],
  // `mcp` reads the repository, so it takes --cwd. It has no --format: stdout carries JSON-RPC
  // messages, and there is no second shape to choose, so offering the flag would be a lie.
  mcp: ["cwd", "mode", "help", "version"],
  // `setup` generates through the `generate` command, so every generation setting it can
  // honour is in scope. Rejecting them made the one-command path unable to express a walk
  // scan, a monolith or a different large-file threshold; the alternative was to run
  // `setup` and then edit the config it had just written.
  setup: [
    "install-hook",
    "cwd",
    "out-dir",
    "max-part-bytes",
    "large-file-bytes",
    "max-monolith-bytes",
    "include-monolith",
    "include-sensitive-files",
    "skip-artifacts",
    "only-artifacts",
    "discovery",
    "preset",
    "include",
    "exclude",
    "yes",
    "force",
    "no-install",
    "dry-run",
    "no-update-check",
    "format",
    "mode",
    "help",
    "version",
  ],
};

const COMMAND_ORDER: readonly CommandName[] = [
  "generate",
  "validate",
  "report",
  "explain",
  "init",
  "setup",
  "diff",
  "describe",
  "skill",
  "mcp",
];

/** The commands an option applies to, in the order `describe` lists them. */
export function commandsForOption(option: string): CommandName[] {
  return COMMAND_ORDER.filter((command) => COMMAND_OPTION_SCOPE[command].includes(option));
}

/**
 * The commands an option applies to, as the slash-separated list `describe` publishes.
 *
 * Always the explicit list, even for an option every command honours. It used to return the prose
 * "all commands" in that case, which a machine consumer reads as a single command named "all
 * commands" — that is, a flag that applies nowhere. `--format` was the only option that hit the
 * branch, and spelling it out here means no future option can rediscover the trap.
 */
export function optionAppliesTo(option: string): string {
  return commandsForOption(option).join("/");
}
