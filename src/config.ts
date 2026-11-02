import * as fs from "node:fs";
import * as path from "node:path";
import { detectPreset } from "./presets/index.js";
import { DEFAULT_SECRET_PATTERNS } from "./security/patterns.js";
import type {
  CliOptions,
  KindRule,
  LayerRule,
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

export async function loadConfigFile(cwd: string): Promise<SnapshotConfig | null> {
  for (const filename of CONFIG_FILENAMES) {
    const fullPath = path.join(cwd, filename);
    if (!fs.existsSync(fullPath)) continue;

    if (filename.endsWith(".json") || filename === ".snapshotrc") {
      try {
        const raw = fs.readFileSync(fullPath, "utf8");
        return JSON.parse(raw);
      } catch {
        continue;
      }
    }

    try {
      const imported = await import(`file://${fullPath}`);
      return imported.default || imported;
    } catch {
      continue;
    }
  }

  const pkgJsonPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const raw = fs.readFileSync(pkgJsonPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.snapshot && typeof parsed.snapshot === "object") {
        return parsed.snapshot;
      }
    } catch {}
  }

  return null;
}

export function resolveConfig(
  userConfig: SnapshotConfig | null,
  cliOptions?: Partial<CliOptions>
): ResolvedSnapshotConfig {
  const cwd = cliOptions?.cwd || userConfig?.cwd || process.cwd();
  const preset = detectPreset(cwd);

  const layers: LayerRule[] = userConfig?.layers && userConfig.layers.length > 0
    ? userConfig.layers
    : preset.layers;

  const kinds: KindRule[] = userConfig?.kinds && userConfig.kinds.length > 0
    ? userConfig.kinds
    : preset.kinds;

  const secretRules = userConfig?.secrets?.disableDefaultPatterns
    ? userConfig.secrets.customPatterns || []
    : [...DEFAULT_SECRET_PATTERNS, ...(userConfig?.secrets?.customPatterns || [])];

  return {
    cwd,
    branch: userConfig?.branch || "main",
    outDir: userConfig?.outDir || "snapshot",
    tmpDir: userConfig?.tmpDir || "snapshot.tmp",
    maxPartBytes:
      cliOptions?.maxPartBytes ??
      userConfig?.maxPartBytes ??
      300 * 1024,
    largeFileBytes:
      cliOptions?.largeFileBytes ??
      userConfig?.largeFileBytes ??
      200 * 1024,
    previewHeadLines: userConfig?.previewHeadLines ?? 80,
    previewTailLines: userConfig?.previewTailLines ?? 40,
    includeMonolith:
      cliOptions?.includeMonolith ??
      userConfig?.includeMonolith ??
      false,
    monolithContent:
      cliOptions?.monolithContent ??
      userConfig?.monolithContent ??
      "full",
    maxMonolithBytes:
      cliOptions?.maxMonolithBytes !== undefined
        ? cliOptions.maxMonolithBytes
        : userConfig?.maxMonolithBytes !== undefined
        ? userConfig.maxMonolithBytes
        : null,
    layers,
    kinds,
    excludePatterns: userConfig?.excludePatterns || [],
    secretRules,
  };
}

export function matchRule(
  filePath: string,
  matcher: string | RegExp | ((filePath: string) => boolean)
): boolean {
  if (typeof matcher === "function") {
    return matcher(filePath);
  }
  if (matcher instanceof RegExp) {
    return matcher.test(filePath);
  }
  if (typeof matcher === "string") {
    if (matcher.endsWith("/**")) {
      const prefix = matcher.slice(0, -3);
      return filePath.startsWith(prefix);
    }
    return filePath.includes(matcher);
  }
  return false;
}

export function classifyLayer(filePath: string, layers: LayerRule[]): string {
  for (const layer of layers) {
    if (matchRule(filePath, layer.match)) {
      return layer.name;
    }
  }
  return "other";
}

export function classifyKind(filePath: string, kinds: KindRule[]): string {
  for (const kind of kinds) {
    if (matchRule(filePath, kind.match)) {
      return kind.kind;
    }
  }
  return "other";
}
