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

/**
 * Every option `validate` accepts. `check` is an alias of `validate`; appliesTo names the
 * canonical command only.
 *
 * The six generation settings are here because `validate` compares the manifest's
 * `config.digest`, and that digest is computed over all of them. Leaving them out made a
 * legitimate snapshot permanently unvalidatable: `generate --skeleton` recorded a digest that
 * includes `skeleton: true`, `validate` resolved `skeleton: false` and reported
 * "the settings differ from the ones this snapshot was generated with", and passing
 * `--skeleton` to `validate` to fix it was rejected as "does not apply to validate". The two
 * errors pointed at each other. `--changed-since`/`--staged`/`--with-dependents` additionally
 * decide which of the recorded `unchanged` skips are re-checked.
 */
const VALIDATE_OPTIONS = [
  "sarif",
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
    "sarif",
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
  // `report` reads `manifest.json` and prints what is there; a generation setting would change
  // nothing. The seven generation flags used to be listed here and were accepted as silent no-ops
  // — the exact "flag that parses but changes nothing" this table exists to prevent — while
  // `--discovery` was already rejected. Both the parser and `describe`'s `appliesTo` read this
  // list, so removing them narrows the two together.
  report: [
    "cwd",
    "out-dir",
    "no-config",
    "no-update-check",
    "format",
    "mode",
    "help",
    "version",
  ],
  explain: [
    // The scope decides what `explain` says about a file, dependents included: without these,
    // a file that is in the snapshot only because it imports a changed one was explained as
    // `included: false, reason: "unchanged"`.
    "changed-since",
    "staged",
    "with-dependents",
    "cwd",
    "out-dir",
    // `--large-file-bytes` changes the inclusion mode `explain` reports, so it belongs here.
    // `--max-part-bytes`, `--max-monolith-bytes`, `--include-monolith`, `--skip-artifacts` and
    // `--only-artifacts` were accepted and never read: a per-file answer cannot depend on how the
    // whole snapshot is partitioned, and none of them changes whether this file is included.
    // Removed rather than implemented, because a flag that parses and does nothing is the defect
    // this table exists to prevent.
    "large-file-bytes",
    "include-sensitive-files",
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
    // Persisted into the config `setup` writes, then forwarded to the generation it runs — so
    // the snapshot it produces validates against the config beside it. Accepting a setting here
    // without writing it down made `setup --large-file-bytes 100k` finish with a snapshot its
    // own `validate` called drifted, on the first run of a brand-new project.
    "max-part-tokens",
    "skeleton",
    "sarif",
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
