import * as fs from "node:fs";
import * as path from "node:path";
import { classifyKind, classifyLayer, matchRule } from "./config.js";
import { countLines } from "./partitioner/preview.js";
import { collectFiles, findSecretInPath } from "./scanner/files.js";
import { isBinaryFile, decodeText } from "./scanner/binary.js";
import { detectLanguage } from "./scanner/language.js";
import { scanAndRedactSecrets } from "./security/redact.js";
import { escapeControls } from "./terminal.js";
import type { Manifest, ResolvedSnapshotConfig, TextEncoding } from "./types.js";

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
  /** Present when the file is not plain UTF-8, so an explanation cannot quietly lie about it. */
  encoding?: TextEncoding;
  secretCount?: number;
  secrets?: Array<{ rule: string; line: number }>;
}

function describeMatcher(matcher: unknown): string {
  if (typeof matcher === "string") return matcher;
  if (matcher instanceof RegExp) return String(matcher);
  if (typeof matcher === "function") {
    // Presets use predicate functions. Printing the function source leaked
    // implementation detail into a machine-readable payload and was unreadable;
    // say that a custom predicate decided it, which is all the caller can act on.
    return "function (custom predicate)";
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
  // `path.resolve` so an absolute outDir is not appended to cwd.
  const manifestPath = path.resolve(config.cwd, config.outDir, "manifest.json");
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

  // The echoed path is an artifact too: a token in a filename must not come back
  // out of xplain.
  const maskedPath = findSecretInPath(relative, config.secretRules)?.masked ?? relative;
  const result: ExplainResult = {
    path: maskedPath,
    exists: fs.existsSync(absolute),
    included: false,
  };

  const collection = collectFiles(config.cwd, {
    includePatterns: config.include,
    excludePatterns: [...config.excludePatterns, ...config.presetExclude],
    includeSensitiveFiles: config.includeSensitiveFiles,
    secretRules: config.secretRules,
    // Same exclusion `generate` applies, so `explain` never says "not-discovered" about a file
    // that is only missing because the walker dropped the tool's own output directory.
    toolOwnedPaths: [config.outDir, config.tmpDir]
      .map((directory) =>
        path.relative(config.cwd, path.resolve(config.cwd, directory)).replace(/\\/g, "/")
      )
      .filter((relative) => relative.length > 0 && !relative.startsWith("..")),
  });

  if (!collection.files.includes(relative)) {
    // `collectFiles` masks secret spans in the paths it records, so match either form.
    const record = collection.skipped.find(
      (entry) => entry.path === relative || entry.path === maskedPath
    );
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
  // `generate` skips binaries and records `binary` in manifest.skipped[]. The
  // explanation used to answer "included: true" for a file the very next run
  // would drop, which is worse than no answer at all.
  if (isBinaryFile(absolute)) {
    result.included = false;
    result.reason = "binary";
    result.detail = "binary content; generate skips it and records `binary` in manifest.skipped[]";
    return result;
  }
  result.layer = classifyLayer(relative, config.layers);
  result.kind = classifyKind(relative, config.kinds);
  result.language = detectLanguage(relative);

  const layerRule = findRuleMatch(config.layers, relative);
  if (layerRule) result.layerMatch = describeMatcher(layerRule.match);
  const kindRule = findRuleMatch(config.kinds, relative);
  if (kindRule) result.kindMatch = describeMatcher(kindRule.match);

  if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
    const buffer = fs.readFileSync(absolute);
    // Decode the way `generate` decodes: a UTF-16 file is transcoded rather than reported as a
    // pile of NULs, and a lossy decode is stated instead of being passed off as clean text.
    const decoded = decodeText(buffer);
    if (decoded.binary) {
      result.included = false;
      result.reason = "binary";
      result.detail = `binary content (NUL byte at offset ${decoded.binaryOffset ?? 0}); generate skips it and records \`binary\` in manifest.skipped[]`;
      return result;
    }
    const text = decoded.text;
    result.bytes = buffer.length;
    result.lines = countLines(text);
    if (decoded.encoding !== "utf-8") result.encoding = decoded.encoding;

    const { findings } = scanAndRedactSecrets(text, config.secretRules, relative);
    result.secretCount = findings.length;
    result.secrets = findings
      .slice(0, 20)
      .map((finding) => ({ rule: finding.rule, line: finding.line }));
  }

  const manifest = readManifest(config);
  const entry = Array.isArray(manifest?.files)
    ? manifest.files.find((file) => file.relativePath === relative)
    : undefined;
  result.part = entry?.part ?? null;
  result.inclusionMode = entry?.inclusionMode;

  return result;
}

/** Renders an explanation for a terminal. */
export function renderExplainText(result: ExplainResult): string {
  // Every value here can be repository-derived: the path, the layer and kind names (which a
  // committed `snapshot.config.*` may set), a manifest part name, a matched rule. A raw bidi
  // override or C1 control in one of them reorders the line or drives the terminal, so each value
  // is re-spelled as `\uXXXX` before it is padded and printed — the labels are fixed text.
  const lines: string[] = [escapeControls(result.path), ""];
  const row = (label: string, value: string): string =>
    `  ${label.padEnd(11)}${escapeControls(value)}`;

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
  if (result.encoding) lines.push(row("encoding", result.encoding));
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
