import assert from "node:assert/strict";
import test from "node:test";

import { CLI_OPTIONS, buildAgentContract } from "../dist/cli.js";
import { CONFIG_KEYS } from "../dist/index.js";

/**
 * The contract must not lie (rule 5), and "not lie" has to include "not omit".
 *
 * `describe` is generated from code, but the generator was written by hand: 0.9.10 added seven
 * flags and six config keys and documented none of them, and no test could see it because every
 * existing check walked *from* the contract *to* the config. These walk the other way — from the
 * parser and from `CONFIG_KEYS` — so a new setting cannot ship undocumented again.
 */

/** Flags the contract has never listed: they are handled before option parsing. */
const NOT_CONTRACT_OPTIONS = new Set(["help", "version"]);

/** Keys that are config-file aliases rather than documented settings. */
const NOT_SETTINGS = new Set(["exclude", "secretRules", "cwd"]);

const contract = buildAgentContract();
const contractedFlags = new Set(contract.options.map((option) => option.flag.replace(/^--/, "")));

test("every option the parser accepts is in the contract", () => {
  const undocumented = Object.keys(CLI_OPTIONS)
    .filter((name) => !NOT_CONTRACT_OPTIONS.has(name))
    .filter((name) => !contractedFlags.has(name));

  assert.deepEqual(
    undocumented,
    [],
    `\`describe\` omits options the CLI accepts: ${undocumented.map((name) => `--${name}`).join(", ")}`
  );
});

test("every option in the contract is one the parser accepts", () => {
  const known = new Set(Object.keys(CLI_OPTIONS));
  const invented = [...contractedFlags].filter((name) => !known.has(name));

  assert.deepEqual(
    invented,
    [],
    `\`describe\` documents flags that do not parse: ${invented.map((name) => `--${name}`).join(", ")}`
  );
});

test("every config key the loader accepts is in the contract", () => {
  const documented = new Set(contract.config.settings.map((setting) => setting.key));
  const undocumented = [...CONFIG_KEYS]
    .filter((key) => !NOT_SETTINGS.has(key))
    .filter((key) => !documented.has(key));

  assert.deepEqual(undocumented, [], `\`describe\` omits config keys: ${undocumented.join(", ")}`);
});

test("every setting in the contract is a config key the loader accepts", () => {
  const invented = contract.config.settings
    .map((setting) => setting.key)
    .filter((key) => !CONFIG_KEYS.has(key));

  assert.deepEqual(invented, [], `\`describe\` documents settings the loader rejects: ${invented.join(", ")}`);
});

test("the options this release added are described", () => {
  for (const flag of [
    "--max-part-tokens",
    "--install-hook",
    "--changed-since",
    "--staged",
    "--with-dependents",
    "--skeleton",
    "--sarif",
  ]) {
    const entry = contract.options.find((option) => option.flag === flag);
    assert.ok(entry, `\`describe\` is missing ${flag}`);
    assert.ok(typeof entry.summary === "string" && entry.summary.length > 20, `${flag}: summary`);
  }
});

test("the config keys this release added are described", () => {
  for (const key of ["maxPartTokens", "changedSince", "staged", "withDependents", "skeleton", "sarif"]) {
    const entry = contract.config.settings.find((setting) => setting.key === key);
    assert.ok(entry, `\`describe\` is missing the ${key} setting`);
    assert.equal(typeof entry.default !== "undefined", true, `${key}: states a default`);
  }
});
