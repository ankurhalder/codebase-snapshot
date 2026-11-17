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
 * `signatures` – function and method bodies were collapsed to an empty block.
 * `comments-stripped` – comment text was removed (line numbers preserved) before emission.
 */
export type InclusionMode = "full" | "preview" | "signatures" | "comments-stripped";

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
  /**
   * Which module system's exports are recorded here.
   *
   * Absent means the file had no exports at all — no ES `export` and no
   * `module.exports`/`exports.*`. `esm` means every name came from an ES `export`;
   * `cjs` means they came from `module.exports`/`exports.*` — a shape the ES-module walk used to
   * miss entirely, leaving a CommonJS module's public surface empty in the manifest; `mixed`
   * means both kinds are present.
   */
  exportsKind?: "esm" | "cjs" | "mixed";
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
  /**
   * A tracked path that is absent from disk — deleted without staging.
   *
   * Distinct from `read-error`, which means the path exists but could not be read (EACCES, a
   * sharing violation). Conflating the two left an operator unable to tell a missing file from an
   * unreadable one, because neither record carried a detail.
   */
  | "missing"
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
  | "nested-repository"
  /**
   * Not in the set that `--changed-since` or `--staged` asked for.
   *
   * Deliberately distinct from `excluded`, which means the user's own glob rejected the path.
   * Here the file is perfectly includable and simply did not change; reporting it as
   * `excluded` would send a reader looking for an exclude pattern they never wrote.
   */
  | "unchanged"
  /**
   * Scanned, but the `--slice` planner did not choose it for the question.
   *
   * Different from `unchanged`: the file may have changed and may still matter; it simply is not
   * part of the budgeted answer to the question this snapshot was asked to serve.
   */
  | "not-selected"
  /**
   * Staged for deletion: the path is in the next commit's parent, not in the next commit.
   *
   * With `--staged` the scope is the index, and a deletion has no blob to read. Recording it is
   * the point: the alternative was to drop it silently and describe a commit that deletes a file
   * as though the file never existed.
   */
  | "deleted";

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
  /**
   * Why the emitted body is shorter than the file on disk. Absent when nothing was dropped.
   *
   * `inclusionMode: "preview"` alone could mean "this file is large, so a head/tail preview is
   * the policy" or "the partitioner cut it to fit a part", and `isLarge: false` beside
   * `isPreviewTruncated: true` told a reader neither — the manifest recorded a preview-by-policy
   * for a file whose missing 57 % nobody could find.
   */
  truncationReason?: TruncationReason;
  /**
   * 1-based, inclusive source line ranges that are not in the snapshot **in full**.
   *
   * A byte cut can end inside a line, which leaves that one line partly present; it is named
   * here rather than omitted, because a range list that stays empty while bytes are missing
   * would be the same silence this field exists to end.
   */
  omittedRanges?: Array<[number, number]>;
  /** Line count of the file on disk. */
  originalLines: number;
  /** Lines actually emitted into the snapshot. */
  includedLines: number;
  /** UTF-8 bytes of file content actually emitted into the snapshot. */
  includedBytes: number;
  summary?: SourceSummary | JsonSummary | MarkdownSummary;
  /** How the summary was produced. Absent when there is no summary. */
  summaryQuality?: SummaryQuality;
  /**
   * True when a summary was not emitted for a size reason, rather than being unavailable for a
   * language with no profile.
   */
  summaryOmitted?: boolean;
  /** Which size rule removed it. Present exactly when `summaryOmitted` is true. */
  summaryOmittedReason?: "oversize" | "preview" | "part-budget";
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
   * Estimated tokens in this part.
   *
   * `byteSize` answers "will this fit the byte budget"; this answers the question a caller
   * actually has, which is "will this fit my context window". An estimate, and labelled as
   * one: `estimateTokens` documents exactly what it counts.
   */
  estimatedTokens: number;
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
  /**
   * Lines the source files contain, after redaction, before previews and part budgets.
   *
   * `counts.totalLines` is the same number. `emittedLines` below is the one a reader of the parts
   * actually sees; the two differ whenever a preview or a byte-budget cut removed lines, and the
   * README used to print only the first under the label "Total Code Lines".
   */
  sourceLines?: number;
  /** Lines carried by the emitted parts. Optional for manifests written before it was recorded. */
  emittedLines?: number;
  /**
   * Estimated tokens in the emitted parts.
   *
   * Optional because a manifest written before this was recorded has no such key. The number
   * is an estimate — see `estimateTokens` for the method — and it exists because the snapshot
   * is pasted into a context window, which is measured in tokens rather than bytes.
   */
  estimatedTokens?: number;
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
    /**
     * One entry per file whose import edges are known.
     *
     * A previewed or oversized file has no structural summary, but its import specifiers are
     * still extracted — they are what makes it a dependent — so it appears here. Its
     * `exports` list was never read, and `exportsOmitted` says so instead of leaving an empty
     * array that reads as "this file exports nothing".
     */
    byFile: Array<{
      path: string;
      imports: string[];
      exports: string[];
      exportsOmitted?: true;
    }>;
    centralFiles: Array<{ path: string; importedByCount: number }>;
  };
  directives: Array<{ path: string; directives: string[] }>;
}

/** Effective configuration recorded so `validate` can detect config drift. */
export interface ManifestConfigSnapshot {
  /** Digest of the effective settings; see `configDigest`. */
  digest?: string;
  maxPartBytes: number;
  /**
   * The token ceiling the run was given, or `undefined` when only bytes were named.
   *
   * Recorded so the manifest states the budget the user chose rather than only the byte
   * value it was converted to.
   */
  maxPartTokens?: number;
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
  /** Whether comment text was stripped from JS/TS bodies in this run. */
  stripComments?: boolean;
  /**
   * The file-slot ceiling `PROMPT.md` was planned for; `0` for no limit.
   *
   * Recorded so the manifest states the destination the instructions were written for, and
   * optional because a manifest written before this was recorded has no such key. It is not part
   * of `configDigest`: the payload is identical either way, and a new delivery preference must not
   * make an existing snapshot fail `validate` as configuration drift.
   */
  attachmentSlots?: number;
  /** The part-count ceiling the run enforced, `null` when the experimental mode was off. */
  maxParts?: number | null;
  /** Which job the brief was written for. */
  promptTask?: PromptTask;
  /** The owner brief this run was given, by path and digest. */
  brief?: { path: string; digest: string };
  /** How files were discovered; `undefined` on manifests written before this was recorded. */
  discovery?: DiscoveryMode;
  /** The changed-files scope the snapshot was taken over, when one was used. */
  changedSince?: string;
  staged?: boolean;
  withDependents?: boolean;
  /** True when bodies were replaced by signatures. */
  skeleton?: boolean;
  /** True when `reports/audit.sarif` was written. */
  sarif?: boolean;
  artifacts: ResolvedArtifacts;
  include: string[];
  preset: string;
  layersMode: "merge" | "replace";
  budgets: ResolvedBudgets;
  excludePatterns: string[];
  layers: string[];
  kinds: string[];
}

/** Why a file's emitted body is shorter than the file itself. */
export type TruncationReason = "large-file-budget" | "part-budget" | "section-metadata";

/** One file the snapshot does not contain in full, and what was left out of it. */
export interface IncompleteFile {
  relativePath: string;
  /** The part this file was written to, so the omission can be found on disk. */
  part: string;
  reason: TruncationReason;
  /** 1-based, inclusive. Sorted and non-overlapping. */
  omittedRanges: Array<[number, number]>;
  /** Source lines the ranges cover — the sum of their lengths. */
  omittedLines: number;
  /**
   * Lines in the emitted block, **including an omission notice line when one is written**.
   *
   * It counts what the fenced block holds, not the source lines that survived, so a preview
   * records head + tail + the notice. `includedLines + omittedLines` is therefore not `lines`
   * and no consumer should expect it to be.
   */
  includedLines: number;
  /** Lines in the source file. */
  lines: number;
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
  /**
   * Where the described tree came from, when it was fetched rather than found on disk.
   *
   * Absent for a local run. Present for `--remote`, with the commit that was actually cloned so
   * a reader can trace the snapshot back to a revision rather than to a URL that may have moved.
   */
  source?: {
    url: string;
    host: string;
    owner: string;
    repo: string;
    ref: string | null;
    commit: string;
    fetchedAt: string;
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
    /** Length of `incomplete`; the number a run summary has to be able to quote. */
    incompleteCount: number;
  };
  totals: ManifestTotals;
  fingerprint: string;
  validation: {
    status: "passed" | "failed";
    errors: string[];
  };
  artifacts: {
    /**
     * The human-facing artifacts, recorded in the same shape as the monoliths.
     *
     * `validate` used to verify only parts, monoliths and SARIF, so deleting the README or the
     * navigation index left it green. Optional because a manifest written before these were
     * recorded has no key; a current manifest records every artifact it wrote.
     */
    readme?: ManifestArtifact;
    prompt?: ManifestArtifact;
    navigation?: ManifestArtifact;
    projectTree?: ManifestArtifact;
    audit?: ManifestArtifact;
    /** `reports/diff.md`, when `diff` was requested and the repository had changes. */
    diff?: ManifestArtifact;
    /** `reports/log.md`, when `log` was requested and the repository had commits. */
    log?: ManifestArtifact;
    /** `reports/tokens.md`, when `tokenTree` was requested. */
    tokenTree?: ManifestArtifact;
    fullJson: ManifestArtifact | null;
    fullMarkdown: ManifestArtifact | null;
    /** `full-codebase.xml`, when `--pack xml` asked for it. */
    fullXml?: ManifestArtifact | null;
    /**
     * `reports/audit.sarif`, when `--sarif` asked for it.
     *
     * Optional because most runs do not write one, and a manifest written before this
     * existed has no such key at all — the two are indistinguishable to a reader, which is
     * why the presence of the file is also recorded in `config`.
     */
    sarif?: ManifestArtifact;
  };
  /**
   * What this snapshot contains relative to a base snapshot (`--delta`).
   *
   * Present only when a base was given. `files[]` then contains the changed and added files and
   * their one-hop dependents; every unchanged file is accounted in `delta.unchanged` and in
   * `skipped[]` with reason "unchanged", so nothing disappears without a record.
   */
  /**
   * A task-scoped slice (`--slice`): which question the snapshot was narrowed for.
   *
   * `files[]` then contains the planner selection; every other scanned path is in `skipped[]`
   * with reason "slice-dropped", so the accounting contract still holds.
   */
  /**
   * A token-budget selection (`--budget-tokens`): the plan that fit the repository into a budget.
   *
   * `files[]` holds the selection; the rest are in `skipped[]` with reason "not-selected".
   */
  budget?: {
    maxTokens: number;
    usedTokens: number;
    /** What survived, by layer and by symbol, so a reader can judge the cut. */
    coverage?: {
      byLayer: Record<string, { kept: number; total: number }>;
      entryPoints: { kept: number; total: number };
      symbols: { kept: number; total: number };
    };
    /** Paths chosen, in the order they were selected. */
    files: string[];
    /** Scanned paths that did not fit. */
    dropped: number;
  };
  slice?: {
    question: string;
    budgetTokens: number;
    usedTokens: number;
    /** The paths the planner chose, in reading order. */
    files: string[];
    /** Scanned paths the planner did not choose. */
    dropped: number;
  };
  delta?: {
    base: { path: string; fingerprint: string; generatedAt: string };
    added: string[];
    changed: string[];
    removed: string[];
    /** Paths present in both snapshots with the same hash; omitted from parts, listed here. */
    unchanged: string[];
  };
  layers: Record<string, number>;
  kinds: Record<string, number>;
  indexes: ManifestIndexes;
  parts: PartMetadata[];
  files: FileEntry[];
  skipped: SkipRecord[];
  /**
   * Every included file whose emitted body is not the whole file.
   *
   * The same statement lives in `files[]`; this list exists so a consumer can ask "was anything
   * lost?" without filtering four hundred entries, and so an omission cannot hide behind an
   * `inclusionMode` that reads like policy. Empty is the normal case and is written as an empty
   * array rather than omitted, because "no key" and "nothing lost" must not look alike.
   */
  incomplete: IncompleteFile[];
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
/**
 * The job the brief is written for.
 *
 * The standard and the coverage duty are the same in all three; what changes is what the
 * reader is asked to produce, in the opening section of the brief.
 */
export type PromptTask = "audit" | "review" | "explain";

/** The owner-written half of the brief, parsed and hashed. */
export interface OwnerBrief {
  /** Path as the user wrote it, for provenance. */
  path: string;
  /** sha256 of the file as read, so changing it is configuration drift. */
  digest: string;
  stakes?: string;
  system?: string;
  history?: string;
  bar?: string;
  calibration?: string;
  /** Headings the merge did not recognise, kept rather than dropped. */
  notes: Array<{ heading: string; body: string }>;
  /** Text before the first heading, when there is any. */
  preamble?: string;
}

export interface ArtifactSelection {
  /** `README.md` — the orientation page for humans and models. */
  readme?: boolean;
  /** `PROMPT.md` — the instruction sheet a snapshot is pasted with. */
  prompt?: boolean;
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
  /** `reports/diff.md` — the uncommitted diff, when the repository has one. */
  diff?: boolean;
  /** `reports/log.md` — recent commits. */
  log?: boolean;
  /** `reports/tokens.md` — per-file token estimates. */
  tokenTree?: boolean;
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
  /**
   * A per-part ceiling in *tokens* rather than bytes.
   *
   * The snapshot is pasted into a context window, and a context window is measured in tokens;
   * bytes are what the partitioner writes. Naming a token budget sets `maxPartBytes` to the
   * byte count that corresponds to it, so the byte bound — the thing the partitioner actually
   * enforces — never stops being true. The smaller of the two ceilings wins.
   */
  maxPartTokens?: ByteSize;
  largeFileBytes?: ByteSize;
  previewHeadLines?: number;
  previewTailLines?: number;
  includeMonolith?: boolean;
  maxMonolithBytes?: ByteSize | null;
  /** Opt in to emitting `.env`/`*.pem`/`.npmrc`/`credential files. Default false. */
  includeSensitiveFiles?: boolean;
  /**
   * Files the destination accepts in one message; 10 by default, `0` for no limit.
   *
   * `PROMPT.md` plans the delivery to fit: which parts to attach, what to leave behind, and the
   * part budget that would merge them. The payload is unchanged by this setting — only the
   * instructions and the plan that ships with it.
   */
  attachmentSlots?: number;
  /**
   * Experimental: the most parts a snapshot may have.
   *
   * Off by default. When set, the partitioner grows the per-part budget until the run fits this
   * many parts, which is how a repository that keeps growing keeps its shape instead of adding a
   * twelfth file to a chat that takes ten. The budget it settles on is recorded in
   * `manifest.budgets.maxPartBytes` and may exceed the configured `maxPartBytes`; a warning says
   * so, because a larger part is more tokens for the destination to swallow at once.
   */
  maxParts?: number | null;
  /**
   * Path to the owner-written half of the brief, relative to `cwd`.
   *
   * The generated brief can state the job, the map and the standard; it cannot say what the
   * software is for or what has already gone wrong. That is judgement, and it is supplied here.
   */
  brief?: string;
  /** Which job the brief is written for. Defaults to `audit`. */
  promptTask?: PromptTask;
  /**
   * How files are discovered; `auto` picks git when it can list files and walks the tree
   * otherwise.
   *
   * Present here because this is the type a user writes against — `defineConfig` and
   * `resolveConfig` both take it — and it was missing while `ResolvedSnapshotConfig`,
   * `CliOptions` and `CONFIG_KEYS` all carried it. A TypeScript config containing
   * `discovery: "walk"` was TS2353 in exactly the format `init` recommends.
   */
  discovery?: DiscoveryMode;
  /** Allow-list of globs. When non-empty, only matching files are included. */
  include?: string[];
  /** Force a preset by name instead of auto-detecting one. */
  preset?: string;
  /**
   * Only include files changed since this git ref.
   *
   * The pull-request case: the diff is small and the repository is not. Unchanged files are
   * recorded in `skipped[]` with reason `unchanged`, so the manifest accounts for them.
   */
  changedSince?: string;
  /** Only include files staged for the next commit. */
  staged?: boolean;
  /**
   * Emit signatures instead of bodies for TypeScript and TSX files.
   *
   * Matches `inclusionMode: "signatures"` on the entries it applies to, so a reader can tell a
   * compressed file from a whole one without diffing it against the source.
   */
  skeleton?: boolean;
  /** Also write `reports/audit.sarif` so a CI security gate can read the findings. */
  sarif?: boolean;
  /** How many commits `reports/log.md` carries when it is enabled (default 20). */
  logCount?: number;
  /** Remove comment text from JavaScript/TypeScript bodies (line numbers preserved). */
  stripComments?: boolean;
  /**
   * Which single-file pack to write: `single` (markdown), `xml` or `json`.
   *
   * Unset keeps the historical `--include-monolith` behaviour: markdown and JSON together.
   */
  pack?: "single" | "xml" | "json";
  /**
   * With `changedSince` or `staged`, also include the files that import a changed one.
   *
   * A one-hop closure: the file you changed and the files that reference it are the context
   * needed to change it safely.
   */
  withDependents?: boolean;
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
  /** The token ceiling the user asked for, before it was turned into `maxPartBytes`. */
  maxPartTokens?: number;
  largeFileBytes: number;
  previewHeadLines: number;
  previewTailLines: number;
  includeMonolith: boolean;
  maxMonolithBytes: number | null;
  includeSensitiveFiles: boolean;
  /** Files the destination accepts in one message; `0` means no limit. */
  attachmentSlots: number;
  /** The part-count ceiling, or `null` when the experimental mode is off. */
  maxParts: number | null;
  /** The job the brief is written for. */
  promptTask: PromptTask;
  /** The parsed owner brief, when one was configured. */
  brief?: OwnerBrief;
  /**
   * How files are discovered; `auto` picks git when it can list files and walks the tree otherwise.
   * Optional because a resolved config can arrive from an older caller that never named it — every
   * reader treats `undefined` as `auto`, so the effective mode is never guessed twice.
   */
  discovery?: DiscoveryMode;
  /** Only files changed since this git ref; `undefined` scans everything. */
  changedSince?: string;
  /** Only files staged for the next commit. */
  staged?: boolean;
  /** Emit signatures instead of bodies for TypeScript and TSX files. */
  skeleton?: boolean;
  /**
   * Also write `reports/audit.sarif`, the findings in SARIF 2.1.0.
   *
   * For a CI security gate: GitHub Code Scanning reads SARIF, and a markdown report it cannot
   * ingest is a finding nobody's build can act on.
   */
  sarif?: boolean;
  /** How many commits `reports/log.md` carries when it is enabled. */
  logCount: number;
  /** Comment stripping for JS/TS bodies. */
  stripComments: boolean;
  /** The chosen single-file pack, or null for the historical pair. */
  pack: "single" | "xml" | "json" | null;
  /** Also include the files that import a changed one. */
  withDependents?: boolean;
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
  /** `--attachment-slots`: how many files the destination accepts. */
  attachmentSlots?: number;
  /** `--max-parts`: the experimental part-count ceiling. */
  maxParts?: number | null;
  /** `--brief`: path to the owner-written half of the brief. */
  brief?: string;
  /** `--prompt-task`: which job the brief is written for. */
  promptTask?: PromptTask;
  /** `--include-diffs`: write reports/diff.md from the uncommitted diff. */
  includeDiffs?: boolean;
  /** `--include-logs <n>`: write reports/log.md with the last n commits. */
  includeLogs?: number;
  /** `--token-tree`: write reports/tokens.md. */
  tokenTree?: boolean;
  /** `--strip-comments`: remove comment text from JS/TS bodies. */
  stripComments?: boolean;
  maxPartBytes?: number;
  maxPartTokens?: ByteSize | null;
  largeFileBytes?: number;
  /** Artifact names to suppress for this invocation (`--skip-artifacts`). */
  skipArtifacts?: string[];
  /**
   * Artifact names to keep, with everything else off (`--only-artifacts`).
   *
   * Separate from the derived `skipArtifacts` because the two are not interchangeable: "only
   * these" is a statement about the whole selection, and the suppression list cannot express it
   * when the configuration has already turned one of the named artifacts off.
   */
  onlyArtifacts?: string[];
  discovery?: DiscoveryMode;
  changedSince?: string;
  staged?: boolean;
  withDependents?: boolean;
  skeleton?: boolean;
  sarif?: boolean;
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
