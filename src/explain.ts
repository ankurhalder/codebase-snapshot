import * as fs from "node:fs";
import * as path from "node:path";
import { classifyKind, classifyLayer, matchRule } from "./config.js";
import { countLines } from "./partitioner/preview.js";
import { collectFiles } from "./scanner/files.js";
import { detectLanguage } from "./scanner/language.js";
import { scanAndRedactSecrets } from "./security/redact.js";
import type { Manifest, ResolvedSnapshotConfig } from "./types.js";

export interface ExplainResult {
  /** Path relative to the configured cwd, POSIX separators. */
  path: string;
  /** Whether the path exists on disk. */
  exists: boolean;
  /** Whether the scanner would include it in the next snapshot. */
  included: boolean;
  /** Why it is excluded, when it is. Mirrors `SkipRecord.reason`. */
  reason?: string;
  detail?: string;
  layer?: string;
  layerMatch?: string;
  kind?: string;
  kindMatch?: string;
  language?: string;
  /** Part filename from the last written manifest, when one is available. */
  part?: string | null;
  inclusionMode?: string;
  lines?: number;
  bytes?: number;
  secretCount?: number;
  secrets?: Array<{ rule: string; line: number }>;
}

function describeMatcher(matcher: unknown): string {
  if (typeof matcher === "string") return matcher;
  if (matcher instanceof RegExp) return String(matcher);
  if (typeof matcher === "function") {
    // Presets use predicate functions; showing the source beats "(function)".
    const source = String(matcher).replace(/\s+/g, " ").trim();
    return source.length > 70 ? `${source.slice(0, 67)}...` : source;
  }
  return String(matcher);
}

function normalizeTarget(cwd: string, target: string): string {
  const absolute = path.resolve(cwd, target);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return target;
  return relative.split(path.sep).join("/");
}

function findRuleMatch<T extends { match: unknown }>(
  rules: T[],
  relativePath: string
): T | undefined {
  return rules.find((rule) =>
    matchRule(relativePath, rule.match as string | RegExp | ((value: string) => boolean))
  );
}

/** Reads the last written manifest, tolerating its absence. */
function readManifest(config: ResolvedSnapshotConfig): Manifest | null {
  const manifestPath = path.join(config.cwd, config.outDir, "manifest.json");
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/**
 * Explains what the scanner would do with one path.
 *
 * The whole point is that every decision is visible: which layer and kind rule
 * matched, why a file was skipped, which part it landed in, and whether any
 * secret rule fires. Re-running the real scanner is what keeps it honest.
 */
export function explainPath(config: ResolvedSnapshotConfig, target: string): ExplainResult {
  const relative = normalizeTarget(config.cwd, target);
  const absolute = path.join(config.cwd, relative);

  const result: ExplainResult = {
    path: relative,
    exists: fs.existsSync(absolute),
    included: false,
  };

  const collection = collectFiles(config.cwd, {
    includePatterns: config.include,
    excludePatterns: [...config.excludePatterns, ...config.presetExclude],
    includeSensitiveFiles: config.includeSensitiveFiles,
  });

  if (!collection.files.includes(relative)) {
    const record = collection.skipped.find((entry) => entry.path === relative);
    if (record) {
      result.reason = record.reason;
      result.detail = record.detail;
    } else if (!result.exists) {
      result.reason = "missing";
      result.detail = "no such file or directory, relative to the configured cwd";
    } else {
      result.reason = "not-discovered";
      result.detail = "exists but is not tracked or is otherwise not a candidate";
    }
    return result;
  }

  result.included = true;
  result.layer = classifyLayer(relative, config.layers);
  result.kind = classifyKind(relative, config.kinds);
  result.language = detectLanguage(relative);

  const layerRule = findRuleMatch(config.layers, relative);
  if (layerRule) result.layerMatch = describeMatcher(layerRule.match);
  const kindRule = findRuleMatch(config.kinds, relative);
  if (kindRule) result.kindMatch = describeMatcher(kindRule.match);

  if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
    const buffer = fs.readFileSync(absolute);
    const text = buffer.toString("utf8");
    result.bytes = buffer.length;
    result.lines = countLines(text);

    const { findings } = scanAndRedactSecrets(text, config.secretRules, relative);
    result.secretCount = findings.length;
    result.secrets = findings
      .slice(0, 20)
      .map((finding) => ({ rule: finding.rule, line: finding.line }));
  }

  const manifest = readManifest(config);
  const entry = manifest?.files.find((file) => file.relativePath === relative);
  result.part = entry?.part ?? null;
  result.inclusionMode = entry?.inclusionMode;

  return result;
}

/** Renders an explanation for a terminal. */
export function renderExplainText(result: ExplainResult): string {
  const lines: string[] = [result.path, ""];
  const row = (label: string, value: string): string => `  ${label.padEnd(11)}${value}`;

  if (!result.included) {
    lines.push(row("included", "no"));
    lines.push(row("reason", result.reason ?? "unknown"));
    if (result.detail) lines.push(row("detail", result.detail));
    return lines.join("\n");
  }

  lines.push(row("included", "yes"));
  lines.push(row("layer", `${result.layer}${result.layerMatch ? `   (rule ${result.layerMatch})` : ""}`));
  lines.push(row("kind", `${result.kind}${result.kindMatch ? `   (rule ${result.kindMatch})` : ""}`));
  lines.push(row("language", result.language ?? "text"));
  if (typeof result.lines === "number") {
    lines.push(row("size", `${result.bytes} B, ${result.lines} line(s)`));
  }
  lines.push(
    row(
      "part",
      result.part ?? "(not in the last snapshot; run generate)"
    )
  );
  if (result.inclusionMode) lines.push(row("inclusion", result.inclusionMode));
  lines.push(
    row(
      "secrets",
      result.secretCount
        ? `${result.secretCount} finding(s): ${Array.from(
            new Set((result.secrets ?? []).map((secret) => secret.rule))
          ).join(", ")}`
        : "none"
    )
  );

  return lines.join("\n");
}
