import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { detectPreset, getPreset, listPresetNames, unknownPresetMessage } from "./presets/index.js";
import {
  globToRegExp,
  isDiscoveryMode,
  type DiscoveryMode,
} from "./scanner/files.js";
import { DEFAULT_SECRET_PATTERNS } from "./security/patterns.js";
import { compileSecretRules } from "./security/redact.js";
import type {
  ByteSize,
  CliOptions,
  HooksConfig,
  KindRule,
  LayerRule,
  ResolvedArtifacts,
  ResolvedBudgets,
  ResolvedSnapshotConfig,
  SecretRuleInput,
  SnapshotConfig,
} from "./types.js";

/** Carries the directory a config was loaded from, so `resolveConfig` can use it. */
export const CONFIG_DIR_SYMBOL: unique symbol = Symbol.for("codebase-snapshot.configDir");

const CONFIG_FILENAMES = [
  "snapshot.config.ts",
  "snapshot.config.js",
  "snapshot.config.mjs",
  "snapshot.config.cjs",
  "snapshot.config.json",
  ".snapshotrc.json",
  ".snapshotrc",
];

/**
 * Where a configuration would be read from, without loading it.
 *
 * The first-run decision only needs to know whether this repository has been configured
 * already. Loading the file there would run repository code before the command the
 * developer actually asked for — and a config that exists but cannot be read has to
 * reach the normal path, so it can be reported as broken instead of quietly treated as
 * absent.
 */
export function findConfigFile(cwd: string): string | null {
  for (const filename of CONFIG_FILENAMES) {
    const fullPath = path.join(cwd, filename);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  const pkgJsonPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as { snapshot?: unknown };
    return parsed.snapshot === undefined ? null : pkgJsonPath;
  } catch {
    // An unparseable package.json is not a configuration. Say "no config" here and let
    // the setup path explain the real problem when it tries to edit the file.
    return null;
  }
}


const RESOLVED_CONFIG_BRAND = Symbol.for(
  "codebase-snapshot/resolved-config"
);

/**
 * Brands a resolved config so consumers can distinguish it from a user
 * `SnapshotConfig` structurally, instead of guessing from the presence of a
 * single field (`"secretRules" in input`), which misfired for hand-built configs
 * and for user configs that happened to carry an extra key.
 */
export function markResolvedConfig<T extends ResolvedSnapshotConfig>(config: T): T {
  Object.defineProperty(config, RESOLVED_CONFIG_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return config;
}

/**
 * Detects a resolved config.
 *
 * The brand is a non-enumerable symbol, so it survives `structuredClone` but NOT
 * `{ ...resolvedConfig, override }`. Relying on the brand alone caused a real
 * regression: a spread config was re-resolved as a user config, which silently
 * dropped custom `secretRules` and let matching secrets through in clear text.
 * The structural fallback therefore accepts any object carrying the complete
 * resolved-only shape.
 */
export function isResolvedConfig(value: unknown): value is ResolvedSnapshotConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (
    (candidate as Record<symbol, unknown>)[RESOLVED_CONFIG_BRAND as unknown as symbol] ===
    true
  ) {
    return true;
  }

  const hasResolvedNumbers =
    typeof candidate.maxPartBytes === "number" &&
    typeof candidate.largeFileBytes === "number" &&
    typeof candidate.previewHeadLines === "number" &&
    typeof candidate.previewTailLines === "number";
  const hasResolvedStrings =
    typeof candidate.cwd === "string" &&
    typeof candidate.outDir === "string" &&
    typeof candidate.tmpDir === "string";
  const hasResolvedFlags =
    typeof candidate.includeMonolith === "boolean" &&
    typeof candidate.includeSensitiveFiles === "boolean";
  const hasResolvedRules =
    Array.isArray(candidate.layers) &&
    Array.isArray(candidate.kinds) &&
    Array.isArray(candidate.excludePatterns);

  // `secretRules` is the discriminator: a `SnapshotConfig` expresses custom
  // rules as `secrets.customPatterns`, never as a resolved `secretRules` array.
  const secretRules = candidate.secretRules;
  const hasCompiledRules =
    Array.isArray(secretRules) &&
    secretRules.every(
      (rule) =>
        typeof rule === "object" &&
        rule !== null &&
        typeof (rule as { rule?: unknown }).rule === "string" &&
        (typeof (rule as { pattern?: unknown }).pattern === "string" ||
          (rule as { pattern?: unknown }).pattern instanceof RegExp)
    );

  return (
    hasResolvedNumbers &&
    hasResolvedStrings &&
    hasResolvedFlags &&
    hasResolvedRules &&
    hasCompiledRules
  );
}

/**
 * Re-validates a resolved config taken from an untrusted path (e.g. a spread
 * copy), recompiling secret rules so string patterns and stray `g`/`y` flags are
 * normalised even when the object did not come from `resolveConfig`.
 */
export function normalizeResolvedConfig(
  config: ResolvedSnapshotConfig
): ResolvedSnapshotConfig {
  // Older resolved configs (or a spread copy of one built before the field
  // existed) may carry no `discovery`: fall back to `auto`, which is what
  // discovery did when the mode did not exist.
  const discovery: DiscoveryMode = isDiscoveryMode(config.discovery)
    ? config.discovery
    : "auto";

  return markResolvedConfig({
    ...config,
    discovery,
    secretRules: compileSecretRules(config.secretRules),
    artifacts: resolveArtifacts(
      config.artifacts,
      undefined,
      config.includeMonolith === true
    ),
    include: resolveInclude(config.include),
    preset: typeof config.preset === "string" ? config.preset : "generic",
    presetExclude: [
      ...new Set([
        ...(Array.isArray(config.presetExclude) ? config.presetExclude : []),
        ...outputExcludePatterns(config.cwd, config.outDir, config.tmpDir),
      ]),
    ],
    layersMode: config.layersMode === "replace" ? "replace" : "merge",
    budgets:
      config.budgets && typeof config.budgets === "object"
        ? config.budgets
        : { default: config.maxPartBytes, byLayer: {} },
    hooks: resolveHooks(config.hooks),
    excludePatterns: Array.isArray(config.excludePatterns) ? config.excludePatterns : [],
    layers: Array.isArray(config.layers) ? config.layers : [],
    kinds: Array.isArray(config.kinds) ? config.kinds : [],
  });
}

/**
 * Guards against a silently lossy config round-trip.
 *
 * A `RegExp` cannot survive `JSON.stringify`/`JSON.parse`: the pattern comes
 * back as `{}`. Such an object no longer satisfies `isResolvedConfig`, so it
 * would be re-resolved as a user config and its custom `secretRules` would be
 * dropped without a word — a silent security regression. Fail loudly instead.
 */
export function assertUsableConfigInput(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.secretRules) || candidate.secretRules.length === 0) {
    return;
  }

  const unusable = candidate.secretRules.filter((rule) => {
    if (typeof rule !== "object" || rule === null) return true;
    const pattern = (rule as { pattern?: unknown }).pattern;
    if (pattern instanceof RegExp || typeof pattern === "string") return false;
    // `{}` is what a RegExp becomes after a JSON round-trip.
    return typeof pattern === "object" && pattern !== null;
  });

  if (unusable.length > 0) {
    throw new Error(
      `This configuration carries ${unusable.length} unusable secret rule pattern(s). ` +
        "A RegExp cannot survive JSON serialization, and silently dropping these rules " +
        "would let those secrets through redaction. Pass the resolved config object " +
        "itself (or express rules via `secrets.customPatterns`) instead of a JSON clone."
    );
  }
}

export interface ConfigLoadResult {
  config: SnapshotConfig | null;
  /** Absolute path of the file the config came from, if any. */
  file: string | null;
  /** Why a candidate config file was ignored. Never silently discarded. */
  warnings: string[];
  /**
   * Config files that exist but could not be read.
   *
   * These are fatal: a config that fails to parse used to be skipped in favour of
   * the defaults, which meant a typo silently produced a snapshot with none of the
   * developer's settings applied. A config that is merely unsupported on this Node
   * version (a `.ts` file below Node 22.6) stays a warning — nothing is wrong with
   * the file, and the message already says what to do.
   */
  errors: string[];
}

/** True when this Node can `import()` a `.ts` file natively (type stripping). */
export function supportsTypeScriptImports(): boolean {
  const features = (process as unknown as { features?: { typescript?: unknown } }).features;
  if (features && "typescript" in features) {
    return features.typescript !== false && features.typescript !== undefined;
  }
  const [major, minor] = process.versions.node.split(".").map((value) => Number(value));
  if (!Number.isFinite(major)) return false;
  return major > 22 || (major === 22 && minor >= 6);
}

/**
 * Strips `//` and block comments from JSON-with-comments, plus trailing commas.
 *
 * The previous implementation was two regular expressions, and
 * `(^|[^:"'\\])\/\/.*$` treated a `//` inside a *string* as a comment: a valid
 * `package.json` containing `"build": "tsc && echo done//ok"` was truncated,
 * became unparseable, and every command then exited 1. A single pass that
 * tracks string state and escapes is the only correct way to do this.
 */
function stripJsonComments(raw: string): string {
  const text = raw.replace(/^\uFEFF/, "");
  let out = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index += 1;
      index -= 1; // let the loop emit the terminator
      continue;
    }

    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n" || text[index] === "\r") out += text[index];
        index += 1;
      }
      index += 1; // skip the closing "/"
      continue;
    }

    out += char;
  }

  return stripTrailingCommas(out);
}

/** Removes `,` before `}`/`]`, which JSONC allows and JSON.parse rejects. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
    }

    out += char;
  }

  return out;
}

function parseJsonish(raw: string, file: string): SnapshotConfig {
  try {
    return JSON.parse(stripJsonComments(raw)) as SnapshotConfig;
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
  }
}

/** Describes a value for an error message without ever echoing its contents. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (value instanceof RegExp) return value.toString();
  if (typeof value === "function") return "a function";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length > 0 ? `an object with keys ${keys.join(", ")}` : "an empty object";
  }
  return `${typeof value} (${String(value)})`;
}

const isThenable = (value: object): boolean =>
  typeof (value as { then?: unknown }).then === "function";

/**
 * Every key a configuration file may carry.
 *
 * This is `SnapshotConfig` plus the spellings that are read through casts: `discovery`
 * (validated separately), `exclude` (the flag spelling of `excludePatterns`) and
 * `secretRules` (the library spelling of a rule list, accepted by `resolveConfig` and
 * therefore needed here too — omitting it made a config file that used it fail with
 * "unknown setting(s): secretRules" while the same key worked when passed in code).
 */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  "artifacts",
  "branch",
  "budgets",
  "cwd",
  "discovery",
  "exclude",
  "excludePatterns",
  "hooks",
  "include",
  "includeMonolith",
  "includeSensitiveFiles",
  "kinds",
  "largeFileBytes",
  "layers",
  "layersMode",
  "maxMonolithBytes",
  "maxPartBytes",
  "outDir",
  "preset",
  "previewHeadLines",
  "previewTailLines",
  "secretRules",
  "secrets",
  "tmpDir",
]);

/**
 * Rejects a setting the tool does not have, naming it.
 *
 * An unknown key used to be dropped without a word: `{ maxPartByte: 4096 }` generated with the
 * default budget at exit 0, so the user believed an override had been applied. That is the silent
 * fallback this project forbids, and it also protects the generated file's promise that it lists
 * every setting — a key absent from this list is not one.
 */
function assertKnownConfigKeys(value: Record<string, unknown>, file: string): void {
  const unknownKeys = Object.keys(value).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length === 0) return;
  const listed = unknownKeys.map((key) => `\`${key}\``).join(", ");
  throw new Error(
    `${file} has unknown setting(s): ${listed}. Check the spelling against docs/configuration.md, ` +
      "or run `codebase-snapshot init --force` to write a config that lists every setting."
  );
}

/**
 * Reads what a config module exported.
 *
 * A `Promise` used to pass the `typeof === "object"` check, so
 * `export default Promise.resolve({…})` produced an empty configuration with
 * every setting silently ignored and exit 0. Anything that is not a plain
 * object is now a hard error that says what was received.
 */
function readConfigExport(exported: unknown, file: string): SnapshotConfig {
  if (exported === undefined || exported === null) {
    throw new Error(
      `${file} does not export a configuration object (received ${describeValue(exported)}).`
    );
  }
  if (Array.isArray(exported)) {
    throw new Error(
      `${file} exports an array; expected a single configuration object such as \`export default { outDir: "snapshot" }\`.`
    );
  }
  if (typeof exported === "function") {
    throw new Error(
      `${file} exports a function; expected a configuration object. Call the function yourself and export its result.`
    );
  }
  if (typeof exported !== "object") {
    throw new Error(
      `${file} does not export a configuration object (received ${describeValue(exported)}).`
    );
  }
  if (isThenable(exported)) {
    throw new Error(
      `${file} exports a Promise/thenable, not a configuration object. ` +
        "An async config is read synchronously, so its settings would be ignored: " +
        "export a plain object (`const config = {…}; export default config;`)."
    );
  }
  assertKnownConfigKeys(exported as Record<string, unknown>, file);
  return exported as SnapshotConfig;
}

/**
 * Bumped for every module-config load (`snapshot.config.ts|js|mjs|cjs`).
 *
 * ESM caches a module per specifier, so a second `import()` of the same file
 * returned the module evaluated on the first load. `generate --watch` therefore
 * kept applying the config it started with, and a config that became invalid
 * mid-watch silently re-used the last good object instead of reporting the error
 * a cold start reports. A distinct query string makes each load a fresh module.
 */
let moduleConfigLoadToken = 0;

/**
 * Imports a module config without re-using an earlier evaluation of it.
 *
 * The query string covers `.mjs`, `.ts` and `.js` in an ES-module package. A
 * CommonJS file (`.cjs`, or `.js` in a CommonJS package) is additionally evicted
 * from the require cache, which is keyed by filename and ignores the query, so
 * without the eviction the custom loader would still hand back stale exports.
 * Failures are left to the caller: `import()` below reports them the same way a
 * first load does.
 */
async function importConfigModule(
  fullPath: string
): Promise<Record<string, unknown> & { default?: unknown }> {
  try {
    const requireFromConfig = createRequire(fullPath);
    delete requireFromConfig.cache[requireFromConfig.resolve(fullPath)];
  } catch {
    // Best effort: an extension `require.resolve` cannot handle is still import()ed
    // below, and a genuine problem there is reported by that import.
  }

  const url = pathToFileURL(fullPath);
  moduleConfigLoadToken += 1;
  url.searchParams.set("codebaseSnapshotLoad", String(moduleConfigLoadToken));
  return (await import(url.href)) as Record<string, unknown> & { default?: unknown };
}

/**
 * Loads the first usable config file from `cwd`.
 *
 * Every failure is reported through `warnings` instead of being swallowed by an
 * empty `catch`: a syntax error in a user's config used to be indistinguishable
 * from having no config at all.
 */
export async function loadConfigFileDetailed(cwd: string): Promise<ConfigLoadResult> {
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const filename of CONFIG_FILENAMES) {
    const fullPath = path.join(cwd, filename);
    if (!fs.existsSync(fullPath)) continue;

    if (filename.endsWith(".json") || filename === ".snapshotrc") {
      try {
        // The same guard a module config gets: this file is the configuration, so a typo in it
        // would otherwise be accepted and silently ignored.
        const config = parseJsonish(fs.readFileSync(fullPath, "utf8"), fullPath);
        if (config === null || typeof config !== "object" || Array.isArray(config)) {
          throw new Error(
            `${fullPath} does not hold a configuration object (received ${describeValue(config)}).`
          );
        }
        assertKnownConfigKeys(config as Record<string, unknown>, fullPath);
        return { config, file: fullPath, warnings, errors };
      } catch (err) {
        // A read failure (an `EISDIR` from a config that is a directory, a permission error) comes
        // from `readFileSync` and carries no filename, so a repository with several config files
        // could not tell which one failed. Parse errors already name the file, hence the check.
        const raw = (err as Error).message;
        const message = raw.includes(fullPath) ? raw : `${fullPath}: ${raw}`;
        warnings.push(message);
        errors.push(message);
        continue;
      }
    }

    if (filename.endsWith(".ts") && !supportsTypeScriptImports()) {
      warnings.push(
        `${fullPath} was ignored: loading a .ts config needs Node >= 22.6 ` +
          `(running ${process.versions.node}). Use snapshot.config.mjs, .cjs or .json instead.`
      );
      continue;
    }

    try {
      // `pathToFileURL` handles drive letters, spaces, `#` and `%` correctly;
      // naive `file://${fullPath}` concatenation does not. The import goes
      // through a cache-busting helper so a reload sees the file on disk now.
      const imported = await importConfigModule(fullPath);
      // `default ?? imported` erased a deliberate `export default null`: the nullish fallback
      // substituted the module namespace, which is an object, so `readConfigExport` never saw the
      // null and the run generated with built-in defaults at exit 0. Distinguish "no default
      // export" from "the default export is null".
      const hasDefault = Object.prototype.hasOwnProperty.call(imported, "default");
      const config = readConfigExport(hasDefault ? imported.default : imported, fullPath);
      return { config, file: fullPath, warnings, errors };
    } catch (err) {
      const message = `Could not load ${fullPath}: ${(err as Error).message}`;
      warnings.push(message);
      errors.push(message);
      continue;
    }
  }

  const pkgJsonPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const parsed = parseJsonish(fs.readFileSync(pkgJsonPath, "utf8"), pkgJsonPath);
      const snapshotKey = (parsed as unknown as { snapshot?: unknown }).snapshot;
      // `typeof [] === "object"`, so an array used to be handed to the resolver as though it were a
      // configuration object and then silently ignored — with no warning, against this file's own
      // rule that a wrong type is a warning, and against the hard error an array throws in a module
      // config. The array is a wrong type like any other.
      if (snapshotKey && typeof snapshotKey === "object" && !Array.isArray(snapshotKey)) {
        // The same guard every other config file gets. It was skipped here, so
        // `"snapshot": { "maxPartByte": 4096 }` in package.json fell back to the default
        // budget at exit 0 — the silent fallback rule 1 forbids, in the one config
        // location a Node project is most likely to use.
        assertKnownConfigKeys(
          snapshotKey as Record<string, unknown>,
          `${pkgJsonPath} (the "snapshot" key)`
        );
        return { config: snapshotKey as SnapshotConfig, file: pkgJsonPath, warnings, errors };
      }
      // A wrong-typed key is a mistake but not proof of intent — plenty of other
      // tools use a "snapshot" key — so warn rather than fail the run. Silently
      // ignoring it was the worst of the three options.
      if (snapshotKey !== undefined) {
        const kind = Array.isArray(snapshotKey) ? "array" : typeof snapshotKey;
        warnings.push(
          `${pkgJsonPath}: the "snapshot" key must be an object; it was ${kind} and was ignored.`
        );
      }
    } catch (err) {
      const message = (err as Error).message;
      warnings.push(message);
      errors.push(message);
    }
  }

  return { config: null, file: null, warnings, errors };
}

export async function loadConfigFile(cwd: string): Promise<SnapshotConfig | null> {
  const loaded = await loadConfigFileDetailed(cwd);
  // Remember where the config came from. `resolveConfig(await loadConfigFile(dir))` is the
  // documented flow, and without this it generated into process.cwd() instead of that dir.
  if (loaded.config && loaded.file && typeof loaded.config === "object") {
    Object.defineProperty(loaded.config, CONFIG_DIR_SYMBOL, {
      value: path.dirname(loaded.file),
      enumerable: false,
      configurable: true,
    });
  }
  // A config that exists but cannot be read is an error, not "no config": returning
  // null here made `resolveConfig(await loadConfigFile(cwd))` silently generate on
  // defaults while every setting the caller wrote was ignored.
  if (loaded.errors.length > 0) {
    throw new Error(`The config file could not be read: ${loaded.errors.join("; ")}`);
  }
  return loaded.config;
}

/** Smallest usable part budget: a part header plus one section must fit. */
export const MIN_MAX_PART_BYTES = 4096;

/** Every artifact this package can write, in the order it is written. */
export const ARTIFACT_NAMES = [
  "readme",
  "manifest",
  "parts",
  "navigation",
  "projectTree",
  "audit",
  "monolith",
] as const;

export type ArtifactName = (typeof ARTIFACT_NAMES)[number];

/** Everything on, except the monolith, which duplicates the whole payload. */
const DEFAULT_ARTIFACTS: ResolvedArtifacts = {
  readme: true,
  manifest: true,
  parts: true,
  navigation: true,
  projectTree: true,
  audit: true,
  monolith: false,
};

function isArtifactName(value: string): value is ArtifactName {
  return (ARTIFACT_NAMES as ReadonlyArray<string>).includes(value);
}

/**
 * Validates a user-supplied artifact selection.
 *
 * Unknown keys are rejected rather than ignored: a typo here silently produces
 * an artifact the developer believed they had switched off, or leaves one they
 * believed they had removed.
 */
function resolveArtifacts(
  requested: SnapshotConfig["artifacts"] | undefined,
  skipped: string[] | undefined,
  includeMonolith: boolean,
  monolithOverride?: boolean
): ResolvedArtifacts {
  const artifacts: ResolvedArtifacts = {
    ...DEFAULT_ARTIFACTS,
    // `includeMonolith` predates this selection and stays the switch for it.
    monolith: includeMonolith,
  };

  if (requested !== undefined) {
    if (typeof requested !== "object" || requested === null || Array.isArray(requested)) {
      throw new Error("`artifacts` must be an object of boolean flags.");
    }
    for (const [name, value] of Object.entries(requested)) {
      if (!isArtifactName(name)) {
        throw new Error(
          `Unknown artifact "${name}". Expected one of: ${ARTIFACT_NAMES.join(", ")}.`
        );
      }
      if (typeof value !== "boolean") {
        throw new Error(`\`artifacts.${name}\` must be a boolean.`);
      }
      artifacts[name] = value;
    }
  }

  // An explicit `--include-monolith` outranks `artifacts.monolith: false` in the
  // config: the CLI is the more specific, more recent instruction. Suppressions
  // from `--skip-artifacts` are applied afterwards and still win, because asking
  // for both is a contradiction the user can see in the summary.
  if (monolithOverride !== undefined) {
    artifacts.monolith = monolithOverride;
  }

  for (const name of skipped ?? []) {
    if (!isArtifactName(name)) {
      throw new Error(
        `Unknown artifact "${name}". Expected one of: ${ARTIFACT_NAMES.join(", ")}.`
      );
    }
    artifacts[name] = false;
  }

  return artifacts;
}

/**
 * A wrong-typed or unusable setting is a hard error, never a fallback.
 *
 * `previewHeadLines: 0` used to be silently replaced by 80 and the run exited 0,
 * while `include: "x"` errored — the same class of mistake behaving two ways.
 */
function strictPositiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer (received ${describeValue(value)}).`);
  }
  return value;
}

function strictBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be true or false (received ${describeValue(value)}).`);
  }
  return value;
}

function strictString(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string (received ${describeValue(value)}).`);
  }
  return value;
}

/** `excludePatterns: "src/**"` used to be stored as-is and silently matched nothing. */
function resolveExcludePatterns(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((pattern) => typeof pattern !== "string")) {
    throw new Error(
      `\`excludePatterns\` must be an array of glob strings such as ["**/*.test.ts"] (received ${describeValue(value)}).`
    );
  }
  return value.map((pattern) => pattern.trim()).filter(Boolean);
}

/**
 * `preset: "detected"` is the documented default and what `describe` reports, so
 * it must be accepted; `"auto"` is its obvious spelling and is accepted too.
 */
const AUTO_PRESET_ALIASES = new Set(["auto", "detected"]);

function resolvePresetName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `\`preset\` must be a preset name (received ${describeValue(value)}). ` +
        `Use "detected" (or "auto") to detect one, or one of: ${listPresetNames().join(", ")}.`
    );
  }
  const name = value.trim();
  return AUTO_PRESET_ALIASES.has(name.toLowerCase()) ? undefined : name;
}

interface NormalisedRule {
  name: string;
  match: string | RegExp | ((filePath: string) => boolean);
}

/**
 * Validates custom `layers` / `kinds` rules.
 *
 * The documented example used `{ layer: "api", … }` while the type requires
 * `name`, and nothing checked it: `classifyLayer` returned `undefined` and
 * `capMetadata(undefined).length` crashed `generate` with a `TypeError` after the
 * scan had already run. Both spellings are now accepted, and anything else is a
 * validation error that names the index and the expected shape.
 */
function resolveRuleList(value: unknown, kind: "layer" | "kind"): NormalisedRule[] {
  const collection = kind === "layer" ? "layers" : "kinds";
  const example =
    kind === "layer"
      ? `{ name: "api", match: "src/api/**" }`
      : `{ kind: "route", match: "src/routes/**" }`;

  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `\`${collection}\` must be an array of ${kind} rules (received ${describeValue(value)}). A ${kind} rule is ${example}.`
    );
  }

  return value.map((entry, index) => {
    const where = `${collection}[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${where} must be an object (received ${describeValue(entry)}). A ${kind} rule is ${example}.`);
    }

    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    const canonical = kind === "layer" ? "name" : "kind";
    const alias = kind === "layer" ? "layer" : "name";
    const rawName =
      typeof record[canonical] === "string"
        ? record[canonical]
        : typeof record[alias] === "string"
          ? record[alias]
          : undefined;

    if (rawName === undefined || rawName.trim() === "") {
      throw new Error(
        `${where} is missing \`${canonical}\` (received keys: ${keys.join(", ") || "none"}). ` +
          `A ${kind} rule is ${example}; \`${alias}\` is accepted as an alias of \`${canonical}\`.`
      );
    }

    const match = record.match;
    if (match === undefined) {
      throw new Error(
        `${where}.match is required (received keys: ${keys.join(", ") || "none"}). ` +
          `Use a glob string ("src/api/**"), a RegExp (/\\\\.tsx$/) or a function.`
      );
    }
    if (!(typeof match === "string" || match instanceof RegExp || typeof match === "function")) {
      throw new Error(`${where}.match must be a string, a RegExp or a function (received ${describeValue(match)}).`);
    }
    if (typeof match === "string" && match.trim() === "") {
      throw new Error(`${where}.match must not be an empty string.`);
    }

    return {
      name: rawName.trim(),
      match: match as string | RegExp | ((filePath: string) => boolean),
    };
  });
}

function resolveLayerRules(value: unknown): LayerRule[] {
  return resolveRuleList(value, "layer").map((rule) => ({ name: rule.name, match: rule.match }));
}

function resolveKindRules(value: unknown): KindRule[] {
  return resolveRuleList(value, "kind").map((rule) => ({ kind: rule.name, match: rule.match }));
}

/**
 * The output directories, expressed as cwd-relative exclude patterns.
 *
 * They are the tool's own artifacts, not source: scanning them changed the
 * fingerprint on every run and made `validate` report `modified:` for files
 * `generate` had just written. Only directories inside `cwd` can be scanned, so
 * only those need excluding.
 */
function outputExcludePatterns(cwd: string, outDir: string, tmpDir: string): string[] {
  const patterns: string[] = [];
  for (const dir of [outDir, tmpDir]) {
    const absolute = path.resolve(cwd, dir);
    const relative = path.relative(cwd, absolute);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    patterns.push(`${relative.replace(/\\/g, "/")}/**`);
  }
  return patterns;
}

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 * 1024,
  mb: 1024 * 1024,
  mib: 1024 * 1024,
  g: 1024 * 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  gib: 1024 * 1024 * 1024,
};

/**
 * Parses a byte budget.
 *
 * Accepts a plain number (`122880`), a numeric string (`"122880"`), or a
 * human-readable size (`"120k"`, `"1.5mb"`, `"2 GB"`). Returns `undefined` for
 * anything it cannot read, so callers can decide whether that is an error or a
 * fallback — a typo'd budget must not silently become the default.
 */
export function parseByteSize(value: ByteSize | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.floor(value) : undefined;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|k|kb|kib|m|mb|mib|g|gb|gib)?\s*$/i.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const multiplier = BYTE_UNITS[(match[2] ?? "b").toLowerCase()] ?? 1;
  return Math.floor(amount * multiplier);
}

function describeBytes(value: ByteSize): string {
  return typeof value === "number" ? String(value) : `"${value}"`;
}

/**
 * Byte budgets must be usable, not merely positive: a budget below the part
 * header cannot be honoured, and silently clamping it used to produce parts
 * that blew through the requested limit.
 */
function boundedBytes(
  value: ByteSize | undefined,
  fallback: number,
  minimum: number,
  label: string
): number {
  if (value === undefined) return fallback;
  const parsed = parseByteSize(value);
  if (parsed === undefined) {
    throw new Error(
      `${label} must be a byte count such as 120000, "120k" or "1.5mb" (received ${describeBytes(value)}).`
    );
  }
  // A non-positive value is a mistake, not a request for the default: treating
  // `maxPartBytes: 0` as "use 300 KB" silently ignored the setting while
  // `maxPartBytes: 1000` threw.
  if (parsed <= 0) {
    throw new Error(`${label} must be a positive byte count (received ${describeBytes(value)}).`);
  }
  if (parsed < minimum) {
    throw new Error(`${label} must be at least ${minimum} bytes (received ${describeBytes(value)}).`);
  }
  return parsed;}

function optionalBytes(
  value: ByteSize | null | undefined,
  label: string
): number | null {
  if (value === undefined || value === null) return null;
  const parsed = parseByteSize(value);
  if (parsed === undefined || parsed <= 0) {
    throw new Error(
      `${label} must be a positive byte count such as 1000000 or "1mb" (received ${describeBytes(value)}).`
    );
  }
  return parsed;
}

/** Normalises the `include` allow-list, rejecting anything that is not a glob. */
function resolveInclude(include: SnapshotConfig["include"]): string[] {
  if (include === undefined) return [];
  if (!Array.isArray(include) || include.some((pattern) => typeof pattern !== "string")) {
    throw new Error("`include` must be an array of glob strings.");
  }
  return include.map((pattern) => pattern.trim()).filter(Boolean);
}

function resolveLayersMode(mode: SnapshotConfig["layersMode"]): "merge" | "replace" {
  if (mode === undefined) return "merge";
  if (mode !== "merge" && mode !== "replace") {
    throw new Error(`\`layersMode\` must be "merge" or "replace" (received ${JSON.stringify(mode)}).`);
  }
  return mode;
}

/**
 * Resolves per-layer budgets.
 *
 * `overrideDefault` is set when `maxPartBytes` was written explicitly (CLI flag
 * or config key). That value is the single-part budget the CLI prints and the
 * manifest records, so it becomes `budgets.default` and caps every per-layer
 * budget: `--max-part-bytes 4096` next to `budgets: { default: "300k" }` used to
 * print "Part budget: 4 KB" while emitting 151 KB parts.
 */
function resolveBudgets(
  budgets: SnapshotConfig["budgets"],
  fallback: number,
  overrideDefault: boolean
): ResolvedBudgets {
  const byLayer: Record<string, number> = {};
  if (budgets === undefined) return { default: fallback, byLayer };

  if (typeof budgets !== "object" || budgets === null || Array.isArray(budgets)) {
    throw new Error(
      `\`budgets\` must be an object such as { default: "120k", byLayer: { api: "60k" } } (received ${describeValue(budgets)}).`
    );
  }
  if (budgets.byLayer !== undefined) {
    if (typeof budgets.byLayer !== "object" || budgets.byLayer === null) {
      throw new Error("`budgets.byLayer` must be an object of layer name to byte size.");
    }
    for (const [layer, value] of Object.entries(budgets.byLayer)) {
      byLayer[layer] = boundedBytes(
        value,
        fallback,
        MIN_MAX_PART_BYTES,
        `budgets.byLayer["${layer}"]`
      );
    }
  }

  // Validated even when overridden, so `budgets.default: 0` is still an error
  // rather than a silently ignored setting.
  const resolvedDefault = boundedBytes(budgets.default, fallback, MIN_MAX_PART_BYTES, "budgets.default");
  if (!overrideDefault) return { default: resolvedDefault, byLayer };

  for (const [layer, value] of Object.entries(byLayer)) {
    byLayer[layer] = Math.min(value, fallback);
  }
  return { default: fallback, byLayer };
}

function resolveHooks(hooks: SnapshotConfig["hooks"]): HooksConfig {
  if (hooks === undefined) return {};
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error("`hooks` must be an object.");
  }
  if (hooks.afterGenerate !== undefined && typeof hooks.afterGenerate !== "function") {
    throw new Error("`hooks.afterGenerate` must be a function.");
  }
  return { ...hooks };
}

function resolveCandidateCwd(
  userConfig: SnapshotConfig | null,
  cliOptions: Partial<CliOptions> | undefined,
  baseDir: string | undefined
): string {
  if (
    userConfig?.cwd !== undefined &&
    (typeof userConfig.cwd !== "string" || userConfig.cwd.trim() === "")
  ) {
    throw new Error(
      `\`cwd\` must be a non-empty path string (received ${describeValue(userConfig.cwd)}).`
    );
  }
  const candidate = cliOptions?.cwd || userConfig?.cwd || baseDir || process.cwd();
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Working directory does not exist: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Working directory is not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Merges user config, preset defaults and CLI overrides.
 *
 * `baseDir` is the directory the config was loaded from. Without it the natural
 * library flow (`loadConfigFile(dir)` then `resolveConfig(config)`) silently
 * fell back to `process.cwd()` and generated into the caller's directory.
 */
export function resolveConfig(
  userConfig: SnapshotConfig | null,
  cliOptions?: Partial<CliOptions>,
  baseDir?: string
): ResolvedSnapshotConfig {
  // The directory the config was loaded from wins over process.cwd(): a config that
  // travels to another directory must not silently scan the caller's project.
  const configDir = (userConfig as Record<string | symbol, unknown> | null)?.[CONFIG_DIR_SYMBOL] as
    | string
    | undefined;
  const cwd = resolveCandidateCwd(userConfig ?? null, cliOptions, baseDir ?? configDir);

  // How candidates are found. The CLI flag outranks the config key, an unusable
  // value is a hard error (never a silent "auto"), and the effective mode is
  // registered for every scan in this run.
  const requestedDiscovery =
    (cliOptions as { discovery?: unknown } | undefined)?.discovery ??
    (userConfig as { discovery?: unknown } | null | undefined)?.discovery;
  if (requestedDiscovery !== undefined && !isDiscoveryMode(requestedDiscovery)) {
    throw new Error(
      `\`discovery\` must be one of: auto, git, walk (received ${describeValue(requestedDiscovery)}).`
    );
  }
  const discovery: DiscoveryMode = requestedDiscovery ?? "auto";

  // A forced preset must exist: silently falling back would leave the developer
  // believing their layers are in effect when they are not.
  const forcedPreset = resolvePresetName(userConfig?.preset);
  if (forcedPreset !== undefined && !getPreset(forcedPreset)) {
    throw new Error(unknownPresetMessage(forcedPreset));
  }
  const preset = detectPreset(cwd, forcedPreset);
  const layersMode = resolveLayersMode(userConfig?.layersMode);

  // Validated before use: an unvalidated rule used to reach `classifyLayer` and
  // crash `generate` with `Cannot read properties of undefined (reading 'length')`.
  const userLayers = resolveLayerRules(userConfig?.layers);
  const userKinds = resolveKindRules(userConfig?.kinds);

  // `merge` (the default) keeps the preset's rules and lets user rules win by
  // being evaluated first; `replace` is the old, all-or-nothing behaviour.
  const layers: LayerRule[] =
    userLayers.length > 0
      ? layersMode === "replace"
        ? userLayers
        : [...userLayers, ...preset.layers]
      : preset.layers;

  const kinds: KindRule[] =
    userKinds.length > 0
      ? layersMode === "replace"
        ? userKinds
        : [...userKinds, ...preset.kinds]
      : preset.kinds;

  const secrets = userConfig?.secrets;
  if (secrets !== undefined && (typeof secrets !== "object" || Array.isArray(secrets))) {
    throw new Error(
      `\`secrets\` must be an object of { customPatterns, disableDefaultPatterns } (received ${describeValue(secrets)}).`
    );
  }
  const customRules = secrets?.customPatterns ?? [];
  if (!Array.isArray(customRules)) {
    throw new Error(
      `\`secrets.customPatterns\` must be an array of secret rules (received ${describeValue(customRules)}). ` +
        "Each entry is a RegExp, a string, or { rule, pattern }."
    );
  }
  const disableDefaultPatterns = strictBoolean(
    secrets?.disableDefaultPatterns,
    false,
    "`secrets.disableDefaultPatterns`"
  );
  // Compiled separately so a rejected rule is reported at its index in the user's
  // `customPatterns` array, and so a bare RegExp is named `custom-1`, `custom-2`, …
  // rather than by its position after the built-ins.
  // A raw `{ secretRules: [...] }` handed to the library used to be dropped:
  // only `secrets.customPatterns` was read, so the caller got clear-text output
  // and no warning. Applying them is the only non-silent option; a non-array is
  // refused outright.
  const aliasedRules = (userConfig as { secretRules?: unknown } | null | undefined)?.secretRules;
  if (aliasedRules !== undefined && !Array.isArray(aliasedRules)) {
    throw new Error(
      `\`secretRules\` must be an array of { rule, pattern } entries (received ${describeValue(aliasedRules)}).`
    );
  }

  const compiledCustomRules = compileSecretRules([
    ...customRules,
    ...((aliasedRules ?? []) as SecretRuleInput[]),
  ]);
  const secretRules = disableDefaultPatterns
    ? compiledCustomRules
    : [...compileSecretRules(DEFAULT_SECRET_PATTERNS), ...compiledCustomRules];

  // Registered so `collectFiles` scans *paths* with the same rules that redact
  // content, including `customPatterns`. An explicit `options.secretRules` still
  // wins, and every command resolves its configuration immediately before it
  // scans.

  const cliMonolith = cliOptions?.includeMonolith;
  const includeMonolith =
    cliMonolith ?? strictBoolean(userConfig?.includeMonolith, false, "`includeMonolith`");
  const artifacts = resolveArtifacts(
    userConfig?.artifacts,
    cliOptions?.skipArtifacts,
    includeMonolith,
    cliMonolith
  );

  // Precedence: CLI `--max-part-bytes` > config `maxPartBytes` > `budgets.default`
  // > 300 KB. `resolveBudgets` turns an explicit value into `budgets.default` and
  // caps every per-layer budget, so the printed budget and the emitted part size
  // can never disagree.
  const explicitMaxPartBytes = cliOptions?.maxPartBytes ?? userConfig?.maxPartBytes;
  const maxPartBytes = boundedBytes(
    explicitMaxPartBytes,
    300 * 1024,
    MIN_MAX_PART_BYTES,
    "maxPartBytes"
  );
  const budgets = resolveBudgets(
    userConfig?.budgets,
    maxPartBytes,
    explicitMaxPartBytes !== undefined
  );

  const configuredOutDir = strictString(userConfig?.outDir, "snapshot", "`outDir`");
  const outDir = cliOptions?.outDir || configuredOutDir;
  const tmpDir = strictString(userConfig?.tmpDir, "snapshot.tmp", "`tmpDir`");
  const branch = strictString(userConfig?.branch, "main", "`branch`");
  const configuredSensitiveFiles = strictBoolean(
    userConfig?.includeSensitiveFiles,
    false,
    "`includeSensitiveFiles`"
  );
  const includeSensitiveFiles = strictBoolean(
    cliOptions?.includeSensitiveFiles,
    configuredSensitiveFiles,
    "`includeSensitiveFiles`"
  );

  // The resolved output directories are this tool's own artifacts, never source.
  // Leaving them in the scan made the fingerprint change on every run and made
  // `validate` report `modified:` for files `generate` had just written.
  const presetExclude = [
    ...new Set([...preset.exclude, ...outputExcludePatterns(cwd, outDir, tmpDir)]),
  ];

  return markResolvedConfig({
    cwd,
    branch,
    outDir,
    tmpDir,
    maxPartBytes,
    largeFileBytes: boundedBytes(cliOptions?.largeFileBytes ?? userConfig?.largeFileBytes, 200 * 1024, 1, "largeFileBytes"),
    previewHeadLines: strictPositiveInteger(userConfig?.previewHeadLines, 80, "`previewHeadLines`"),
    previewTailLines: strictPositiveInteger(userConfig?.previewTailLines, 40, "`previewTailLines`"),
    includeMonolith: artifacts.monolith,
    maxMonolithBytes: optionalBytes(
      cliOptions?.maxMonolithBytes !== undefined
        ? cliOptions.maxMonolithBytes
        : userConfig?.maxMonolithBytes,
      "maxMonolithBytes"
    ),
    includeSensitiveFiles,
    include: resolveInclude(userConfig?.include),
    preset: preset.presetName,
    presetExclude,
    artifacts,
    layersMode,
    budgets,
    hooks: resolveHooks(userConfig?.hooks),
    layers,
    kinds,
    // `exclude` is the flag spelling of the same setting; writing it in a config used to
    // be ignored without a word.
    excludePatterns: resolveExcludePatterns(
      userConfig?.excludePatterns ?? (userConfig as { exclude?: unknown } | null)?.exclude
    ),
    secretRules,
    // Extra property rather than a `ResolvedSnapshotConfig` field: the resolved
    // shape is owned elsewhere, and every scan reads it through the registry in
    // `scanner/files.ts`.
    discovery,
  } as ResolvedSnapshotConfig & { discovery: DiscoveryMode });
}

/**
 * Matches a path against a layer/kind rule.
 *
 * `"src/app/**"` now means "exactly `src/app` or below": the previous
 * implementation stripped `**` **and** the trailing slash, so the pattern also
 * matched `src/apple/` and `src/application/`.
 */
export function matchRule(
  filePath: string,
  matcher: string | RegExp | ((filePath: string) => boolean)
): boolean {
  if (typeof matcher === "function") return matcher(filePath);
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(filePath);
  }
  if (typeof matcher === "string") {
    const pattern = matcher.replace(/\\/g, "/").trim();
    if (!pattern) return false;

    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3).replace(/\/+$/, "");
      // A literal prefix gets exact path-boundary semantics. A prefix that
      // itself contains glob characters (e.g. `**/features/**`) must fall
      // through to the glob matcher instead.
      if (!prefix) return true;
      if (!/[*?]/.test(prefix)) {
        return filePath === prefix || filePath.startsWith(`${prefix}/`);
      }
    }
    if (pattern.includes("*") || pattern.includes("?")) {
      return globToRegExp(pattern).test(filePath);
    }
    return filePath.includes(pattern);
  }
  return false;
}

export function classifyLayer(filePath: string, layers: LayerRule[]): string {
  for (const layer of layers) {
    if (matchRule(filePath, layer.match)) return layer.name;
  }
  return "other";
}

export function classifyKind(filePath: string, kinds: KindRule[]): string {
  for (const kind of kinds) {
    if (matchRule(filePath, kind.match)) return kind.kind;
  }
  return "other";
}

/**
 * Digest of every setting that changes what a snapshot contains.
 *
 * Masked config values cannot be compared directly: two different secrets both
 * mask to the same placeholder, and `validate` would then report "current" for a
 * snapshot generated with different rules. A digest of the raw effective settings
 * answers "is this snapshot still configured the same way" without ever printing
 * a value.
 */
export function configDigest(config: ResolvedSnapshotConfig): string {
  const material = {
    maxPartBytes: config.maxPartBytes,
    largeFileBytes: config.largeFileBytes,
    previewHeadLines: config.previewHeadLines,
    previewTailLines: config.previewTailLines,
    includeMonolith: config.includeMonolith,
    maxMonolithBytes: config.maxMonolithBytes ?? null,
    includeSensitiveFiles: config.includeSensitiveFiles,
    artifacts: config.artifacts,
    include: config.include,
    excludePatterns: config.excludePatterns,
    preset: config.preset,
    layersMode: config.layersMode,
    budgets: config.budgets,
    // The matcher is what makes a layer a layer. Hashing only the names meant that
    // moving `{ name: "api", match: "src/api/**" }` to `"src/v2/**"` produced the same
    // digest, so `validate` reported "valid and up to date" for a snapshot whose files
    // had all been reclassified — and per-layer budgets applied to different files.
    layers: config.layers.map((layer) => ({ name: layer.name, match: String(layer.match) })),
    kinds: config.kinds.map((kind) => ({ kind: kind.kind, match: String(kind.match) })),
    // How files are enumerated decides what is in the snapshot at all.
    discovery: config.discovery ?? "auto",
    // `flags` and `valueGroup` change *what is masked*, and a rule's source alone does
    // not imply either: the same source with and without `i` redacts different lines.
    secretRules: config.secretRules
      .map(
        (rule) =>
          `${rule.rule}:${rule.pattern.source}/${rule.pattern.flags}:${rule.valueGroup ?? ""}`
      )
      .sort(),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
