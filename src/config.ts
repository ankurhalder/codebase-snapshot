import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { detectPreset, getPreset, listPresetNames } from "./presets/index.js";
import { globToRegExp } from "./scanner/files.js";
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
  SnapshotConfig,
} from "./types.js";

const CONFIG_FILENAMES = [
  "snapshot.config.ts",
  "snapshot.config.js",
  "snapshot.config.mjs",
  "snapshot.config.cjs",
  "snapshot.config.json",
  ".snapshotrc.json",
  ".snapshotrc",
];

const RESOLVED_CONFIG_BRAND = Symbol.for(
  "@ankurhalder/codebase-snapshot/resolved-config"
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
  return markResolvedConfig({
    ...config,
    secretRules: compileSecretRules(config.secretRules),
    artifacts: resolveArtifacts(
      config.artifacts,
      undefined,
      config.includeMonolith === true
    ),
    include: resolveInclude(config.include),
    preset: typeof config.preset === "string" ? config.preset : "generic",
    presetExclude: Array.isArray(config.presetExclude) ? config.presetExclude : [],
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

function stripJsonComments(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

function parseJsonish(raw: string, file: string): SnapshotConfig {
  try {
    return JSON.parse(stripJsonComments(raw)) as SnapshotConfig;
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
  }
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
        return {
          config: parseJsonish(fs.readFileSync(fullPath, "utf8"), fullPath),
          file: fullPath,
          warnings,
          errors,
        };
      } catch (err) {
        const message = (err as Error).message;
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
      // naive `file://${fullPath}` concatenation does not.
      const imported = (await import(pathToFileURL(fullPath).href)) as {
        default?: SnapshotConfig;
      } & SnapshotConfig;
      const config = imported.default ?? imported;
      if (!config || typeof config !== "object") {
        const message = `${fullPath} does not export a configuration object.`;
        warnings.push(message);
        errors.push(message);
        continue;
      }
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
      if (snapshotKey && typeof snapshotKey === "object") {
        return { config: snapshotKey as SnapshotConfig, file: pkgJsonPath, warnings, errors };
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
  includeMonolith: boolean
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

function positiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
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
  if (parsed <= 0) return fallback;
  if (parsed < minimum) {
    throw new Error(`${label} must be at least ${minimum} bytes (received ${describeBytes(value)}).`);
  }
  return parsed;
}

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

/** Resolves per-layer budgets, defaulting every missing entry to `maxPartBytes`. */
function resolveBudgets(
  budgets: SnapshotConfig["budgets"],
  fallback: number
): ResolvedBudgets {
  const byLayer: Record<string, number> = {};
  if (budgets === undefined) return { default: fallback, byLayer };

  if (typeof budgets !== "object" || budgets === null || Array.isArray(budgets)) {
    throw new Error("`budgets` must be an object.");
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

  return {
    default: boundedBytes(budgets.default, fallback, MIN_MAX_PART_BYTES, "budgets.default"),
    byLayer,
  };
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
  const cwd = resolveCandidateCwd(userConfig ?? null, cliOptions, baseDir);

  // A forced preset must exist: silently falling back would leave the developer
  // believing their layers are in effect when they are not.
  const forcedPreset = userConfig?.preset;
  if (forcedPreset !== undefined && !getPreset(forcedPreset)) {
    throw new Error(
      `Unknown preset "${forcedPreset}". Expected one of: ${listPresetNames().join(", ")}.`
    );
  }
  const preset = detectPreset(cwd, forcedPreset);
  const layersMode = resolveLayersMode(userConfig?.layersMode);

  // `merge` (the default) keeps the preset's rules and lets user rules win by
  // being evaluated first; `replace` is the old, all-or-nothing behaviour.
  const layers: LayerRule[] =
    userConfig?.layers && userConfig.layers.length > 0
      ? layersMode === "replace"
        ? userConfig.layers
        : [...userConfig.layers, ...preset.layers]
      : preset.layers;

  const kinds: KindRule[] =
    userConfig?.kinds && userConfig.kinds.length > 0
      ? layersMode === "replace"
        ? userConfig.kinds
        : [...userConfig.kinds, ...preset.kinds]
      : preset.kinds;

  const customRules = userConfig?.secrets?.customPatterns ?? [];
  const rawRules = userConfig?.secrets?.disableDefaultPatterns
    ? customRules
    : [...DEFAULT_SECRET_PATTERNS, ...customRules];
  const secretRules = compileSecretRules(rawRules);

  const includeMonolith = cliOptions?.includeMonolith ?? userConfig?.includeMonolith ?? false;
  const artifacts = resolveArtifacts(
    userConfig?.artifacts,
    cliOptions?.skipArtifacts,
    includeMonolith
  );

  const maxPartBytes = boundedBytes(
    cliOptions?.maxPartBytes ?? userConfig?.maxPartBytes,
    300 * 1024,
    MIN_MAX_PART_BYTES,
    "maxPartBytes"
  );
  const budgets = resolveBudgets(userConfig?.budgets, maxPartBytes);

  return markResolvedConfig({
    cwd,
    branch: userConfig?.branch || "main",
    outDir: cliOptions?.outDir || userConfig?.outDir || "snapshot",
    tmpDir: userConfig?.tmpDir || "snapshot.tmp",
    maxPartBytes,
    largeFileBytes: boundedBytes(cliOptions?.largeFileBytes ?? userConfig?.largeFileBytes, 200 * 1024, 1, "largeFileBytes"),
    previewHeadLines: positiveInteger(userConfig?.previewHeadLines ?? 80, 80),
    previewTailLines: positiveInteger(userConfig?.previewTailLines ?? 40, 40),
    includeMonolith: artifacts.monolith,
    maxMonolithBytes: optionalBytes(
      cliOptions?.maxMonolithBytes !== undefined
        ? cliOptions.maxMonolithBytes
        : userConfig?.maxMonolithBytes,
      "maxMonolithBytes"
    ),
    includeSensitiveFiles:
      cliOptions?.includeSensitiveFiles ?? userConfig?.includeSensitiveFiles ?? false,
    include: resolveInclude(userConfig?.include),
    preset: preset.presetName,
    presetExclude: [...preset.exclude],
    artifacts,
    layersMode,
    budgets,
    hooks: resolveHooks(userConfig?.hooks),
    layers,
    kinds,
    excludePatterns: userConfig?.excludePatterns ?? [],
    secretRules,
  });
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
