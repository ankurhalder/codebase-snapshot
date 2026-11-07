import * as fs from "node:fs";
import * as path from "node:path";
import { importsOfFile } from "./ast/imports.js";
import { classifyKind, classifyLayer, matchRule } from "./config.js";
import { countLines } from "./partitioner/preview.js";
import { collectFiles, findSecretInPath } from "./scanner/files.js";
import { resolveChangedScope } from "./scanner/changed.js";
import { buildImportResolver, importsChangedFile } from "./scanner/dependents.js";
import { BINARY_SCAN_BYTES, isBinaryFile, decodeText } from "./scanner/binary.js";
import { detectLanguage } from "./scanner/language.js";
import { scanAndRedactSecrets } from "./security/redact.js";
import { escapeControls } from "./terminal.js";
import type {
  Manifest,
  ResolvedSnapshotConfig,
  SkipRecord,
  TextEncoding,
} from "./types.js";

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
  secrets?: Array<{ rules: string[]; line: number }>;
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

/**
 * Normalises a caller-supplied path against the repository root.
 *
 * `explain` is reachable from an MCP tool that a prompt can call, so the target is not a trusted
 * argument. This used to answer "target unchanged" for anything whose relative form began with
 * `..`, and `explainPath` then joined it to `cwd` and called `fs.existsSync` — which made a
 * read-only tool an existence oracle for every path on the machine (`../../../etc/shadow`,
 * `../other-repo/.env`). Resolving first and refusing outside the root is the whole fix; the
 * caller gets `outside-root` and nothing is stat-ed.
 *
 * `relative.startsWith("..")` alone was also wrong in the other direction: a file legitimately
 * named `..foo.ts` is inside the root and was classified as a traversal.
 */
function normalizeTarget(
  cwd: string,
  target: string
): { relative: string; outsideRoot: boolean } {
  const resolvedCwd = path.resolve(cwd);
  const absolute = path.resolve(resolvedCwd, target);
  const relative = path.relative(resolvedCwd, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return { relative: target.replace(/\\/g, "/"), outsideRoot: true };
  }
  return { relative: relative.split(path.sep).join("/"), outsideRoot: false };
}

function findRuleMatch<T extends { match: unknown }>(
  rules: T[],
  relativePath: string
): T | undefined {
  return rules.find((rule) =>
    matchRule(relativePath, rule.match as string | RegExp | ((value: string) => boolean))
  );
}

/**
 * The nearest recorded skip whose path is a proper directory ancestor of `target`.
 *
 * `collectFiles` records a skipped directory but never its contents, so the only
 * evidence for a file inside a skipped tree is the ancestor's record. This
 * applies to every reason, built-in ignores included: the walker records
 * `node_modules` as `default-ignore`, so a file inside it names that directory
 * instead of falling back to `not-discovered`. The longest matching prefix wins,
 * which is the closest explanation to the file.
 */
function findRecordedAncestor(
  skipped: readonly SkipRecord[],
  relative: string,
  maskedPath: string
): SkipRecord | undefined {
  let nearest: SkipRecord | undefined;
  for (const record of skipped) {
    const ancestorPath = record.path;
    if (ancestorPath.length === 0) continue;
    const isAncestor =
      relative.startsWith(`${ancestorPath}/`) || maskedPath.startsWith(`${ancestorPath}/`);
    if (!isAncestor) continue;
    if (!nearest || ancestorPath.length > nearest.path.length) nearest = record;
  }
  return nearest;
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
  const normalized = normalizeTarget(config.cwd, target);
  const relative = normalized.relative;

  // The echoed path is an artifact too: a token in a filename must not come back
  // out of explain.
  const maskedPath = findSecretInPath(relative, config.secretRules)?.masked ?? relative;

  if (normalized.outsideRoot) {
    // Answered without touching the filesystem: `exists` is not "false because it is missing", it
    // is "not asked", and saying so is the only honest option. The path is still masked, because
    // the traversal itself can carry a credential-shaped segment.
    return {
      path: maskedPath,
      exists: false,
      included: false,
      reason: "outside-root",
      detail:
        "path resolves outside the configured repository root and was not inspected",
    };
  }

  const absolute = path.join(config.cwd, relative);
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
    // `explain` must enumerate files exactly as `generate` would, or it explains a
    // decision the generator never made.
    discovery: config.discovery,
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
      // A file inside an ignored directory has no record of its own -- the walk
      // never descended -- so answer with the nearest ancestor's record instead
      // of the vague `not-discovered`. The ancestor is named so the answer stays
      // traceable to the rule that actually removed it.
      const ancestor = findRecordedAncestor(collection.skipped, relative, maskedPath);
      if (ancestor) {
        result.reason = ancestor.reason;
        result.detail = ancestor.detail
          ? `${ancestor.detail} — inherited from the skipped directory \`${ancestor.path}\``
          : `inside the skipped directory \`${ancestor.path}\``;
      } else {
        result.reason = "not-discovered";
        result.detail = "exists but is not tracked or is otherwise not a candidate";
      }
    }
    return result;
  }

  result.included = true;
  // A changed-files scope narrows what `generate` emits: a file outside it stays out of the
  // snapshot however includable it is. `explain` ignored the scope entirely and answered
  // `included: true` for exactly the files the generator would have recorded as `unchanged` —
  // the one thing an explanation must not do.
  if (config.changedSince !== undefined || config.staged === true) {
    let inScope: boolean;
    let scopeDetail = "";
    try {
      const scope = resolveChangedScope(config.cwd, {
        ...(config.changedSince === undefined ? {} : { changedSince: config.changedSince }),
        ...(config.staged === true ? { staged: true } : {}),
      });
      inScope = scope.paths.has(relative);
      if (!inScope && config.withDependents === true) {
        // `--with-dependents` widens the scope by one hop of importers, and `generate` applies
        // that hop. Explaining only the path set answered `included: false, reason: "unchanged"`
        // for exactly the files the snapshot contains, so the two accounts of one run disagreed.
        // The hop is answered from this file alone: the question is whether *it* imports
        // something that changed, which needs its own imports and nothing else's.
        inScope = importsChangedFile(
          relative,
          importsOfFile(relative, absolute),
          scope.paths,
          buildImportResolver(collection.files.map((file) => ({ relativePath: file })))
        );
      }
      scopeDetail = scope.detail;
    } catch (err) {
      // The scope is a fact about the repository this tool cannot reconstruct without git. Saying
      // "included" here would be a guess presented as an answer.
      result.included = false;
      result.reason = "unknown";
      result.detail = `the changed-files scope could not be resolved: ${(err as Error).message}`;
      return result;
    }
    if (!inScope) {
      result.included = false;
      result.reason = "unchanged";
      result.detail =
        `not ${scopeDetail}; the snapshot was generated with a changed-files scope, ` +
        "which keeps only the files that moved (plus dependents, with --with-dependents)";
      return result;
    }
  }
  // `generate` skips binaries and records `binary` in manifest.skipped[]. The
  // explanation used to answer "included: true" for a file the very next run
  // would drop, which is worse than no answer at all.
  //
  // Only a file too large to load is sniffed *before* it is read. Below the cap the decode
  // below is the complete check — it looks at every byte, not a head — and it reports why
  // the file is binary instead of a bare size. Sniffing first opened the file, read it in
  // chunks and then read it again in full.
  let sizeOnDisk: number | null = null;
  try {
    sizeOnDisk = fs.statSync(absolute).size;
  } catch {
    sizeOnDisk = null;
  }
  if (sizeOnDisk !== null && sizeOnDisk > BINARY_SCAN_BYTES && isBinaryFile(absolute)) {
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
      result.detail = `binary content (${decoded.binaryReason ?? "not text"}); generate skips it and records \`binary\` in manifest.skipped[]`;
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
      .map((finding) => ({ rules: finding.rules, line: finding.line }));
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
            new Set((result.secrets ?? []).flatMap((secret) => secret.rules))
          ).join(", ")}`
        : "none"
    )
  );

  return lines.join("\n");
}
