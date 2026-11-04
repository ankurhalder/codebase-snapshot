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
export const GENERATOR_NAME = "@ankurhalder/codebase-snapshot";
export const GENERATOR_VERSION = "4.3.0";
