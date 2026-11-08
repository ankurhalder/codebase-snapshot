/**
 * The published identity of this package: its name and its version.
 *
 * Both live here rather than in `index.ts` because the wizard needs them and
 * `index.ts` re-exports the wizard. Importing the barrel from the wizard closes a
 * cycle, and a cycle over a `const` is read at call time — fine under ESM, a trap
 * under CJS, where the first access can land before the assignment runs. `index.ts`
 * re-exports these two names, so the public API keeps them at the same place.
 *
 * `package.json` carries the same version; `npm run verify` compares the two.
 */
export const GENERATOR_NAME = "codebase-snapshot";
export const GENERATOR_VERSION = "0.9.15";

/**
 * Names this generator was published under before it moved to `codebase-snapshot`.
 *
 * The name is not cosmetic: it is written into every ownership marker and every
 * manifest, and the output-directory guard refuses to replace a directory whose
 * evidence names a different generator. Renaming the constant without accepting
 * the old spelling would therefore strand every snapshot written by 1.0.0 through 4.4.1 —
 * the tool would stop recognising its own output. Ownership accepts the legacy
 * name and rewrites it to the current one on the next run.
 */
export const LEGACY_GENERATOR_NAMES: readonly string[] = ["@ankurhalder/codebase-snapshot"];

/** Whether a name found in an ownership marker or manifest belongs to this generator. */
export function isOurGeneratorName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  return name === GENERATOR_NAME || LEGACY_GENERATOR_NAMES.includes(name);
}
