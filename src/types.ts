export type Mode = "generate" | "validate" | "report";
export type OutputFormat = "text" | "json";
export type InclusionMode = "full" | "summary-only";
export type MonolithContentMode = "full" | "snapshot";

export interface SourceSummary {
  directives: string[];
  imports: string[];
  exports: string[];
  functions: string[];
  classes: string[];
  interfaces: string[];
  types: string[];
  enums: string[];
  variables: string[];
  reactComponents: string[];
  hooks: string[];
  routeHandlers: string[];
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

export interface SkipRecord {
  path: string;
  reason: "asset" | "binary" | "read-error" | "not-file";
  detail?: string;
}

export interface FileEntry {
  path: string;
  relativePath: string;
  sizeBytes: number;
  bytes: number;
  lines: number;
  hashSha256: string;
  sha256: string;
  part: string;
  layer: string;
  kind: string;
  language: string;
  inclusionMode: InclusionMode;
  isLarge: boolean;
  isPreviewTruncated: boolean;
  originalLines: number;
  includedLines: number;
  summary?: SourceSummary | JsonSummary | MarkdownSummary;
  content?: string;
}

export interface PartFileEntry {
  path: string;
  relativePath: string;
  bytes: number;
  sizeBytes: number;
  lines: number;
  layer: string;
  kind: string;
}

export interface PartMetadata {
  index: number;
  filename: string;
  bytes: number;
  byteSize: number;
  sha256: string;
  lines: number;
  fileCount: number;
  layersCovered: string[];
  files: string[];
  includedFiles: PartFileEntry[];
}

export interface SecretRule {
  rule: string;
  pattern: RegExp;
}

export interface SecretFinding {
  rule: string;
  line: number;
  snippet: string;
  path?: string;
}

export interface ManifestTotals {
  candidateFiles: number;
  includedFiles: number;
  fullFiles: number;
  summaryOnlyFiles: number;
  skippedFiles: number;
  totalSourceBytes: number;
  totalContentBytes: number;
  partCount: number;
  warningCount: number;
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

export interface Manifest {
  schemaVersion: string;
  generatedAt: string;
  generator: {
    name: string;
    version: string;
    script?: string;
    mode?: string;
    maxPartBytes?: number;
    largeFileBytes?: number;
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
  contentFingerprint: string;
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
  indexes?: ManifestIndexes;
  parts: PartMetadata[];
  files: FileEntry[];
  skipped: SkipRecord[];
  warnings: string[];
}

export interface LayerRule {
  name: string;
  match: string | RegExp | ((filePath: string) => boolean);
}

export interface KindRule {
  kind: string;
  match: string | RegExp | ((filePath: string) => boolean);
}

export interface SnapshotConfig {
  cwd?: string;
  branch?: string;
  outDir?: string;
  tmpDir?: string;
  maxPartBytes?: number;
  largeFileBytes?: number;
  previewHeadLines?: number;
  previewTailLines?: number;
  includeMonolith?: boolean;
  monolithContent?: MonolithContentMode;
  maxMonolithBytes?: number | null;
  layers?: LayerRule[];
  kinds?: KindRule[];
  excludePatterns?: string[];
  secrets?: {
    customPatterns?: SecretRule[];
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
  monolithContent: MonolithContentMode;
  maxMonolithBytes: number | null;
  layers: LayerRule[];
  kinds: KindRule[];
  excludePatterns: string[];
  secretRules: SecretRule[];
}

export interface CliOptions {
  mode: Mode;
  format: OutputFormat;
  dryRun: boolean;
  force: boolean;
  cwd?: string;
  includeMonolith?: boolean;
  monolithContent?: MonolithContentMode;
  maxMonolithBytes?: number | null;
  maxPartBytes?: number;
  largeFileBytes?: number;
}

export interface ValidationDrift {
  missingInSnapshot: string[];
  missingOnDisk: string[];
  hashMismatches: Array<{ path: string; diskHash: string; snapshotHash: string }>;
}

export interface ValidationResult {
  valid: boolean;
  manifestPresent: boolean;
  drift: ValidationDrift;
  errors: string[];
}

