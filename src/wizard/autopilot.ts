import * as fs from "node:fs";
import * as path from "node:path";
import { GENERATOR_NAME, isOurGeneratorName } from "../version.js";

/**
 * What "just type `snapshot`" does.
 *
 * The decision lives here, away from the CLI's input and output, so it can be tested as
 * a table rather than by driving a terminal. The rule it encodes is the repository's own:
 * a first run either asks, or refuses out loud — it never silently falls back to the
 * built-in defaults, because a snapshot shaped by settings the developer never saw is
 * indistinguishable from a broken one.
 */

export interface FirstRunFacts {
  /** A config file, or a `"snapshot"` key in package.json, exists. */
  hasConfig: boolean;
  /** A snapshot this tool wrote is already on disk. */
  hasPriorSnapshot: boolean;
  /** stdin and stdout are both TTYs, and the output format is text. */
  interactive: boolean;
  /** `--autopilot`: never ask, set everything up. */
  autopilot: boolean;
  /** The target directory holds no files at all. */
  emptyTarget: boolean;
}

export type FirstRunRefusal = "empty" | "undecided";

export type FirstRunPlan =
  /** Nothing to set up: run the generate that was asked for. */
  | { action: "generate" }
  /** Set the repository up first, asking the developer about the detected choices. */
  | { action: "setup"; interactive: true }
  /** Set the repository up first, deciding everything — `--autopilot`. */
  | { action: "setup"; interactive: false }
  /** Stop, with a message that says what to run instead. */
  | { action: "refuse"; exitCode: number; reason: FirstRunRefusal };

/**
 * A path a person can act on.
 *
 * `--cwd` may point anywhere, and a relative path that climbs out of the working directory
 * (`..\..\..\AppData\…`) tells the reader nothing. Inside it, the relative form is shorter;
 * outside it, the absolute one is the only useful answer.
 */
function describeTarget(cwd: string): string {
  const relative = path.relative(process.cwd(), cwd);
  if (relative === "") return "this directory";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return cwd;
  return relative;
}

/** The message a non-interactive first run gets. It has to name the way out. */
export function firstRunMessage(reason: FirstRunRefusal, cwd: string): string {
  const where = describeTarget(cwd);
  if (reason === "empty") {
    return (
      `Nothing to snapshot: ${where} has no files. Run this inside the repository you want ` +
      "to snapshot, or pass --cwd."
    );
  }
  return (
    `No configuration found in ${where} and this session is not interactive, so nothing was ` +
    "generated.\nChoose one:\n" +
    `  ${GENERATOR_NAME} --autopilot     detect the project, set it up and generate, no questions\n` +
    `  ${GENERATOR_NAME} init --yes      write a config from the detected defaults, then generate\n` +
    `  ${GENERATOR_NAME} init            write a config interactively`
  );
}

/**
 * The first-run decision table.
 *
 * `--autopilot` is checked first because it is an explicit instruction: with an existing
 * config, setup still adds the npm script, the devDependency and the install the
 * repository may be missing. Everything else defers to an existing config or an existing
 * snapshot, so a repository that has been generated before never sees a wizard twice.
 *
 * An empty directory is refused before anything else: setting it up would install a
 * devDependency for a repository nobody has started yet.
 */
export function planFirstRun(facts: FirstRunFacts): FirstRunPlan {
  if (facts.emptyTarget) return { action: "refuse", exitCode: 1, reason: "empty" };
  if (facts.autopilot) return { action: "setup", interactive: false };
  if (facts.hasConfig || facts.hasPriorSnapshot) return { action: "generate" };
  if (facts.interactive) return { action: "setup", interactive: true };
  return { action: "refuse", exitCode: 2, reason: "undecided" };
}

/** Version-control metadata is not content. A `git init`ed directory is still empty. */
const NOT_CONTENT = new Set([".git", ".hg", ".svn", ".bzr", ".DS_Store", "Thumbs.db"]);

/**
 * True when there is nothing in `cwd` but version-control or operating-system metadata.
 *
 * Setting up a project that has no files produces an empty snapshot and a devDependency
 * for a repository nobody has started yet, so the answer is "not yet", not "done".
 */
export function isEffectivelyEmpty(cwd: string): boolean {
  try {
    return fs.readdirSync(cwd).every((entry) => NOT_CONTENT.has(entry));
  } catch {
    // An unreadable directory is not an empty one: let the generator report the real error.
    return false;
  }
}

/**
 * True when `outDir` holds a snapshot this tool wrote.
 *
 * The ownership marker is the same evidence the output-directory guard uses, so a
 * directory that merely happens to be named `snapshot` does not count as "we have been
 * here before" and cannot silence the first-run question.
 */
export function hasPriorSnapshot(cwd: string, outDir: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(cwd, outDir, ".codebase-snapshot"), "utf8"));
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  return isOurGeneratorName((parsed as { generator?: unknown }).generator);
}
