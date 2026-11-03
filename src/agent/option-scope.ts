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
  | "explain"
  | "diff"
  | "describe"
  | "skill";

/**
 * `cwd` is absent from `describe` and `diff`: neither reads the repository, and
 * `diff` resolves its two positional arguments against the process directory.
 */
export const COMMAND_OPTION_SCOPE: Record<CommandName, readonly string[]> = {
  generate: [
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
    "format",
    "mode",
    "dry-run",
    "watch",
    "help",
    "version",
  ],
  validate: [
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
    "format",
    "mode",
    "help",
    "version",
  ],
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
    "format",
    "mode",
    "help",
    "version",
  ],
  diff: ["format", "mode", "no-config", "help", "version"],
  describe: ["format", "mode", "help", "version"],
  init: [
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
    "minimal",
    "force",
    "dry-run",
    "format",
    "mode",
    "help",
    "version",
  ],
  skill: ["cwd", "format", "mode", "install", "target", "help", "version"],
};

const COMMAND_ORDER: readonly CommandName[] = [
  "generate",
  "validate",
  "report",
  "explain",
  "init",
  "diff",
  "describe",
  "skill",
];

/** The commands an option applies to, in the order `describe` lists them. */
export function commandsForOption(option: string): CommandName[] {
  return COMMAND_ORDER.filter((command) => COMMAND_OPTION_SCOPE[command].includes(option));
}

/** `--format` is the one option every command honours. */
export function optionAppliesTo(option: string): string {
  const commands = commandsForOption(option);
  if (commands.length === COMMAND_ORDER.length) return "all commands";
  return commands.join("/");
}
