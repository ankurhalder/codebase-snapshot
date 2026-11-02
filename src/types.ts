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
  relativePath: string;
  sizeBytes: number;
  lines: number;
  hashSha256: string;
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

export interface PartMetadata {
  index: number;
  filename: string;
  bytes: number;
  lines: number;
  fileCount: number;
  layersCovered: string[];
  files: Array<{
    relativePath: string;
    bytes: number;
    lines: number;
    layer: string;
    kind: string;
  }>;
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

export interface Manifest {
  schemaVersion: string;
  generatedAt: string;
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
  counts: {
    totalFiles: number;
    totalSizeBytes: number;
    totalLines: number;
    partsCount: number;
    skippedCount: number;
    largeFileCount: number;
    truncatedPreviewCount: number;
  };
  layers: Record<string, number>;
  kinds: Record<string, number>;
  parts: PartMetadata[];
  files: FileEntry[];
  skipped: SkipRecord[];
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
