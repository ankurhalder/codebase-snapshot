export type Mode = "generate" | "validate" | "report";
export type OutputFormat = "text" | "json";

/**
 * How files are discovered.
 *
 * `auto` lists files through git when git can do it and walks the tree otherwise; `git` and `walk`
 * force one path. It is part of the manifest's recorded settings because it decides which files a
 * snapshot contains — the same repository scanned both ways is two different snapshots.
 */
export type DiscoveryMode = "auto" | "git" | "walk";

/**
 * How a file's bytes became text.
 *
 * Absent from a `FileEntry` means plain UTF-8, which is the overwhelmingly common case. The other
 * values are recorded because they change what the artifact actually contains: `utf-16le`/`utf-16be`
 * files were transcoded, and `utf-8-lossy` files carry U+FFFD where their undecodable bytes were.
 */
export type TextEncoding = "utf-8" | "utf-8-lossy" | "utf-16le" | "utf-16be";

/**
 * How much of a file made it into the snapshot.
 * `full`    – the complete file body was emitted.
 * `preview` – the body was truncated (by lines and/or bytes) before emission.
 */
export type InclusionMode = "full" | "preview";

export interface SourceSummary {
  directives: string[];
  imports: string[];
  exports: string[];
  /** Module specifiers re-exported wholesale via `export * from "..."`. */
  reExports: string[];
  functions: string[];
  classes: string[];
  interfaces: string[];
  types: string[];
  enums: string[];
  variables: string[];
  reactComponents: string[];
  hooks: string[];
  routeHandlers: string[];
  /** Number of parser diagnostics, present only when the file has syntax errors. */
  parseErrors?: number;
}

export interface JsonSummary {
  shape: string;
  itemCount: number | null;
  keys: string[];
  sampleKeys: string[];
}

export interface MarkdownSummary {
  headings: string[];
  frontmatterKeys: string[];
}

/**
 * How a summary was produced.
 *
 * `ast`        — a real parser (TypeScript compiler; the script block of a
 *                Vue/Svelte/Astro component).
 * `structural` — a real grammar for a data format (JSON, Markdown).
 * `heuristic`  — line patterns. Useful, but not a parse, and never presented
 *                as one.
 */
export type SummaryQuality = "ast" | "structural" | "heuristic";

/**
 * Why a discovered path was not emitted.
 *
 * Every reason below is produced by the scanner; nothing in the type is
 * aspirational. `asset` was removed because no code path ever emitted it.
 */
export type SkipReason =
  | "binary"
  | "read-error"
  | "not-file"
  /** A credential-bearing name (`.env`, `*.pem`, `.npmrc`, …). */
  | "sensitive-file"
  /** The path itself matched a secret rule; the emitted path is span-masked. */
  | "sensitive-path"
  /** A directory link (never followed), or a link to neither file nor directory. */
  | "symlink"
  /** A file link whose target resolves outside the scanned root. */
  | "outside-root"
  /** Excluded by a `.gitignore` in a scan without git. */
  | "gitignore"
  /** Excluded by a built-in rule: the ignore list, a preset, or an output dir. */
  | "default-ignore"
  /** Excluded by the user's own `excludePatterns` or `include` allow-list. */
  | "excluded"
  /**
   * A directory that belongs to another repository: a nested checkout or a submodule.
   *
   * A submodule is a single gitlink entry, so `stat` reports a directory where a file was
   * expected — which used to be recorded as the generic `not-file`, implying the path was a
   * socket or a FIFO rather than a repository whose contents are simply somebody else's.
   */
  | "nested-repository";

export interface SkipRecord {
  /** Path as it may be shown in an artifact: secret spans are masked. */
  path: string;
  reason: SkipReason;
  detail?: string;
}

/**
 * One scanned file. Field names are canonical and unique by design:
 * earlier releases carried `path`/`relativePath`, `sizeBytes`/`bytes` and
 * `hashSha256`/`sha256` aliases that could only ever agree.
 */
export interface FileEntry {
  relativePath: string;
  sizeBytes: number;
  lines: number;
  hashSha256: string;
  part: string;
  layer: string;
  kind: string;
  language: string;
  inclusionMode: InclusionMode;
  isLarge: boolean;
  isPreviewTruncated: boolean;
  /** Line count of the file on disk. */
  originalLines: number;
  /** Lines actually emitted into the snapshot. */
  includedLines: number;
  /** UTF-8 bytes of file content actually emitted into the snapshot. */
  includedBytes: number;
  summary?: SourceSummary | JsonSummary | MarkdownSummary;
  /** How the summary was produced. Absent when there is no summary. */
  summaryQuality?: SummaryQuality;
  /** True when the summary alone was too large for the part budget and was dropped. */
  summaryOmitted?: boolean;
  /**
   * How the file's bytes were decoded. Absent means plain UTF-8. Present when the file was
   * transcoded from UTF-16, or when it was not valid UTF-8 and lost bytes to U+FFFD.
   */
  encoding?: TextEncoding;
  /** Emitted body after redaction/truncation. Never serialized into the manifest. */
  content?: string;
}

export interface PartFileEntry {
  relativePath: string;
  sourceBytes: number;
  includedBytes: number;
  lines: number;
  layer: string;
  kind: string;
}

export interface PartMetadata {
  index: number;
  filename: string;
  /** Exact UTF-8 byte length of the emitted part file. */
  byteSize: number;
  /**
   * The byte budget this part was partitioned against.
   *
   * With per-layer budgets a snapshot has several budgets at once, so "within budget"
   * cannot be answered without knowing which one applied. Verification compared every
   * part against the *largest* budget in the run, which passed a part that was over its
   * own.
   */
  budgetBytes: number;
  sha256: string;
  lines: number;
  fileCount: number;
  layersCovered: string[];
  includedFiles: PartFileEntry[];
}

export interface SecretRule {
  rule: string;
  pattern: RegExp;
  /**
   * Index of the capture group that holds the secret, when the rule has to match
   * its surrounding context to identify one (`password: "…"`). Redaction then
   * masks only that group, so the key and the rest of the line survive.
   */
  valueGroup?: number;
}

/**
 * Shape accepted for `secrets.customPatterns`.
 *
 * A bare `RegExp` or string is accepted because it is the documented form; the
 * object form exists to name a rule. `valueGroup` is only useful with the object
 * form, since a bare pattern has no group to name.
 */
export type SecretRuleInput =
  | { rule: string; pattern: RegExp | string; valueGroup?: number }
  | RegExp
  | string;

/**
 * A detected secret. Deliberately carries no excerpt of the matched source:
 * the previous `snippet` field was the vector by which raw credentials were
 * written into `reports/audit.md`.
 */
export interface SecretFinding {
  /**
   * Every rule that matched this line, in rule-table order.
   *
   * One finding is one *line*, not one (line, rule) pair. A single line can match two rules — an
   * unquoted `AUTH_TOKEN=<value>` assignment matches both `credential-assignment-unquoted` and
   * `env-secret-assignment` — and reporting it twice doubled the figure a user is asked to explain,
   * in the CLI summary and in `reports/audit.md` alike.
   */
  rules: string[];
  line: number;
  path?: string;
}

export interface ManifestTotals {
  candidateFiles: number;
  includedFiles: number;
  fullFiles: number;
  previewFiles: number;
  skippedFiles: number;
  totalSourceBytes: number;
  totalContentBytes: number;
  partCount: number;
  warningCount: number;
  /**
   * Lines whose values were masked, counted once per line.
   *
   * Separate from `warningCount` because they are not the same event: a warning says the snapshot
   * may surprise you, while a redaction says the tool did its job. Folding them together made a
   * clean repository report `Warnings: 156` and left the summary's own slice of ten looking like
   * a truncated warning list.
   */
  redactedLines: number;
}

export interface ManifestArtifact {
  byteSize: number;
  sha256: string;
}

export interface ManifestIndexes {
  routes: Array<{ path: string; methods: string[]; part: string }>;
  components: Array<{ path: string; symbols: string[]; part: string; layer: string }>;
  handlers: Array<{ path: string; exports: string[]; part: string }>;
  features: Array<{ name: string; files: number }>;
  imports: {
    byFile: Array<{ path: string; imports: string[]; exports: string[] }>;
    centralFiles: Array<{ path: string; importedByCount: number }>;
  };
  directives: Array<{ path: string; directives: string[] }>;
}

/** Effective configuration recorded so `validate` can detect config drift. */
export interface ManifestConfigSnapshot {
  /** Digest of the effective settings; see `configDigest`. */
  digest?: string;
  maxPartBytes: number;
  largeFileBytes: number;
  previewHeadLines: number;
  previewTailLines: number;
  includeMonolith: boolean;
  /**
   * The ceiling above which the monolith is not written; `null` for no ceiling.
   *
   * Optional because a manifest written before this was recorded has no such key.
   */
  maxMonolithBytes?: number | null;
  includeSensitiveFiles: boolean;
  /** How files were discovered; `undefined` on manifests written before this was recorded. */
  discovery?: DiscoveryMode;
  artifacts: ResolvedArtifacts;
  include: string[];
  preset: string;
  layersMode: "merge" | "replace";
  budgets: ResolvedBudgets;
  excludePatterns: string[];
  layers: string[];
  kinds: string[];
}

export interface Manifest {
  schemaVersion: string;
  generatedAt: string;
  /**
   * Present only in the manifest embedded in `full-codebase.json`.
   *
   * That file cannot record its own sha256, so its embedded copy leaves `artifacts.fullJson` null
   * and points at `manifest.json` for the real digest instead of writing a number that describes
   * different bytes. The shipped manifest never carries this field.
   */
  selfReference?: string;
  generator: {
    name: string;
    version: string;
  };
  git: {
    branch: string;
    commit: string;
    isDirty: boolean;
  };
  budgets: {
    maxPartBytes: number;
    largeFileBytes: number;
  };
  config: ManifestConfigSnapshot;
  counts: {
    totalFiles: number;
    totalSizeBytes: number;
    totalLines: number;
    partsCount: number;
    skippedCount: number;
    largeFileCount: number;
    truncatedPreviewCount: number;
  };
  totals: ManifestTotals;
  fingerprint: string;
  validation: {
    status: "passed" | "failed";
    errors: string[];
  };
  artifacts: {
    fullJson: ManifestArtifact | null;
    fullMarkdown: ManifestArtifact | null;
  };
  layers: Record<string, number>;
  kinds: Record<string, number>;
  indexes: ManifestIndexes;
  parts: PartMetadata[];
  files: FileEntry[];
  skipped: SkipRecord[];
  warnings: string[];
}

export interface LayerRule {
  name: string;
  match: string | RegExp | ((filePath: string) => boolean);
}

/**
 * Which snapshot artifacts get written.
 *
 * Everything a developer opens is produced by default; each entry exists only so
 * a single artifact can be switched off without disabling the rest. `monolith`
 * is the one exception, because it duplicates the entire payload: it follows
 * `includeMonolith` (off by default) unless set here explicitly.
 */
export interface ArtifactSelection {
  /** `README.md` — the orientation page for humans and models. */
  readme?: boolean;
  /** `manifest.json` — the registry `validate` and `report` read. */
  manifest?: boolean;
  /** `parts/part-XXX.md` — the partitioned code payload. */
  parts?: boolean;
  /** `reports/navigation.md` — file-to-part lookup index. */
  navigation?: boolean;
  /** `reports/project-tree.md` — ASCII repository tree. */
  projectTree?: boolean;
  /** `reports/audit.md` — security, layer, kind and skip findings. */
  audit?: boolean;
  /** `full-codebase.{json,md}` — one file per format, the whole payload again. */
  monolith?: boolean;
}

/** Every artifact decision made concrete. */
export type ResolvedArtifacts = Required<ArtifactSelection>;

export interface KindRule {
  kind: string;
  match: string | RegExp | ((filePath: string) => boolean);
}

/** A byte budget: either raw bytes or a human-readable size such as `"120k"`. */
export type ByteSize = number | string;

/** Per-layer part budgets. Unlisted layers fall back to `default`. */
export interface BudgetConfig {
  default?: ByteSize;
  byLayer?: Record<string, ByteSize>;
}

/** Every budget resolved to concrete byte counts. */
export interface ResolvedBudgets {
  default: number;
  byLayer: Record<string, number>;
}

/** Lifecycle hooks. Not serialized into the manifest (functions are not data). */
export interface HooksConfig {
  /** Runs once after a successful generate, with the manifest that was written. */
  afterGenerate?: (manifest: Manifest) => void;
}

export interface SnapshotConfig {
  cwd?: string;
  branch?: string;
  outDir?: string;
  tmpDir?: string;
  /** Raw bytes, or a human-readable size (`"120k"`, `"1.5mb"`). */
  maxPartBytes?: ByteSize;
  largeFileBytes?: ByteSize;
  previewHeadLines?: number;
  previewTailLines?: number;
  includeMonolith?: boolean;
  maxMonolithBytes?: ByteSize | null;
  /** Opt in to emitting `.env`/`*.pem`/`.npmrc`/credential files. Default false. */
  includeSensitiveFiles?: boolean;
  /** Allow-list of globs. When non-empty, only matching files are included. */
  include?: string[];
  /** Force a preset by name instead of auto-detecting one. */
  preset?: string;
  /** Switch individual snapshot artifacts off. Everything is on by default. */
  artifacts?: ArtifactSelection;
  /**
   * How user `layers`/`kinds` interact with the detected preset (default
   * `"merge"`): user rules are evaluated first, then the preset fills the gaps.
   * `"replace"` discards the preset entirely.
   */
  layersMode?: "merge" | "replace";
  /** Per-layer part budgets. */
  budgets?: BudgetConfig;
  hooks?: HooksConfig;
  layers?: LayerRule[];
  kinds?: KindRule[];
  excludePatterns?: string[];
  secrets?: {
    customPatterns?: SecretRuleInput[];
    disableDefaultPatterns?: boolean;
  };
}

export interface ResolvedSnapshotConfig {
  cwd: string;
  branch: string;
  outDir: string;
  tmpDir: string;
  maxPartBytes: number;
  largeFileBytes: number;
  previewHeadLines: number;
  previewTailLines: number;
  includeMonolith: boolean;
  maxMonolithBytes: number | null;
  includeSensitiveFiles: boolean;
  /**
   * How files are discovered; `auto` picks git when it can list files and walks the tree otherwise.
   * Optional because a resolved config can arrive from an older caller that never named it — every
   * reader treats `undefined` as `auto`, so the effective mode is never guessed twice.
   */
  discovery?: DiscoveryMode;
  /** Empty means "no allow-list"; every discovered file is a candidate. */
  include: string[];
  /** The preset that was resolved (detected or forced). */
  preset: string;
  /** Ecosystem ignores contributed by the preset, merged with `excludePatterns`. */
  presetExclude: string[];
  artifacts: ResolvedArtifacts;
  layersMode: "merge" | "replace";
  budgets: ResolvedBudgets;
  hooks: HooksConfig;
  layers: LayerRule[];
  kinds: KindRule[];
  excludePatterns: string[];
  secretRules: SecretRule[];
}

export interface CliOptions {
  mode: Mode;
  format: OutputFormat;
  dryRun: boolean;
  cwd?: string;
  outDir?: string;
  includeMonolith?: boolean;
  includeSensitiveFiles?: boolean;
  maxMonolithBytes?: number | null;
  maxPartBytes?: number;
  largeFileBytes?: number;
  /** Artifact names to suppress for this invocation (`--skip-artifacts`). */
  skipArtifacts?: string[];
}

export interface ValidationDrift {
  missingInSnapshot: string[];
  missingOnDisk: string[];
  /** Files that exist but could not be read, so their content could not be verified. */
  unreadable: string[];
  hashMismatches: Array<{ path: string; diskHash: string; snapshotHash: string }>;
  /** Emitted `parts/*.md` that are missing or no longer match their recorded hash. */
  partIssues: Array<{ part: string; issue: string }>;
  /** `counts`/`totals`/`budgets` that disagree with the rest of the manifest. */
  totalsMismatches: string[];
  /** Effective-configuration differences between the manifest and the current run. */
  configMismatches: string[];
}

export interface ValidationResult {
  valid: boolean;
  manifestPresent: boolean;
  drift: ValidationDrift;
  errors: string[];
  /** Non-fatal observations (e.g. branch moved on). */
  warnings: string[];
}
