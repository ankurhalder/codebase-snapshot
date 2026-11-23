import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DEFAULT_SECRET_PATTERNS } from "../security/patterns.js";
import {
  PEM_REDACTION_MARKER,
  REDACTION_MARKER,
  compileSecretRules,
  scanAndRedactSecrets,
} from "../security/redact.js";
import { estimateTokens } from "../tokenize.js";
import { describeManifestShapeProblem } from "../validator/validate.js";
import { SIGNATURE_FILE, verifySnapshotSignature } from "../signing.js";
import { findSection, parsePartSections, type PartSection } from "../partitioner/part-format.js";
import { anchorForPath, displayPath, emittedBody } from "../partitioner/chunker.js";
import { countBodyLines } from "../partitioner/preview.js";
import { decodeText } from "../scanner/binary.js";
import { readConfinedBytes, readConfinedText } from "../security/confine.js";
import { escapeControls } from "../terminal.js";
import type { Manifest, SecretRule } from "../types.js";

/**
 * The health service: audits a written snapshot against the repository it claims to describe.
 *
 * validate answers "did the code move since this was generated?". It cannot answer the
 * questions a reader cares about before pasting a snapshot somewhere: did anything secret
 * survive into an artifact, can the claims be checked, is the token count real, does the
 * machine identity leak into the text? This module answers those, with severities and a score.
 *
 * Nothing here writes. A report that mutates is not evidence.
 */

export type HealthSeverity = "critical" | "warning" | "info";
export type HealthStatus = "pass" | "warn" | "fail" | "skip";

export interface HealthCheck {
  id: string;
  title: string;
  severity: HealthSeverity;
  status: HealthStatus;
  /** What was measured, in one sentence. Never includes a secret value. */
  detail: string;
}

export interface HealthReport {
  snapshotDir: string;
  repoDir: string;
  generatedAt: string;
  score: number;
  checks: HealthCheck[];
  counts: { pass: number; warn: number; fail: number; skip: number };
}

export interface HealthOptions {
  snapshotDir: string;
  repoDir: string;
  /** Extra rules on top of the built-in set, e.g. the project config. */
  secretRules?: readonly SecretRule[];
  /** Cap on how much artifact text the secret scan reads. */
  maxScanBytes?: number;
  /**
   * Replay every full body against the bytes on disk.
   *
   * Off by default because it re-reads the whole repository; on by `--deep`. The cheap checks
   * compare the snapshot with its own manifest, which cannot see a generator that read the source
   * incorrectly in the first place.
   */
  deep?: boolean;
}

/** Files the generator writes, keyed by their manifest artifact name. */
const ARTIFACT_FILES: Record<string, string> = {
  readme: "README.md",
  prompt: "PROMPT.md",
  navigation: "reports/navigation.md",
  projectTree: "reports/project-tree.md",
  audit: "reports/audit.md",
  diff: "reports/diff.md",
  log: "reports/log.md",
  tokenTree: "reports/tokens.md",
  selection: "reports/selection.md",
  fullJson: "full-codebase.json",
  fullMarkdown: "full-codebase.md",
  fullXml: "full-codebase.xml",
  sarif: "reports/audit.sarif",
};

const TEXT_ARTIFACT = /\.(md|json|txt|sarif|xml)$/i;

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Reads a snapshot-relative text file through the same confinement every resource uses. */
function snapshotText(snapshotDir: string, relative: string): string | null {
  const read = readConfinedText(snapshotDir, relative);
  return read.ok ? read.text : null;
}

function snapshotBytes(snapshotDir: string, relative: string): Buffer | null {
  const read = readConfinedBytes(snapshotDir, relative);
  return read.ok ? read.bytes : null;
}

function readJson(file: string): unknown {
  const confined = readConfinedText(path.dirname(file), path.basename(file));
  const text = confined.ok ? confined.text : null;
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function walk(dir: string, prefix = ""): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : prefix + "/" + entry.name;
    if (entry.isDirectory()) files.push(...walk(path.join(dir, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function check(
  id: string,
  title: string,
  severity: HealthSeverity,
  status: HealthStatus,
  detail: string
): HealthCheck {
  return { id, title, severity, status, detail };
}

/** A failed check costs 25, a warning 5, and the floor is zero. */
function scoreOf(checks: readonly HealthCheck[]): number {
  let score = 100;
  for (const item of checks) {
    if (item.status === "fail") score -= 25;
    else if (item.status === "warn") score -= 5;
  }
  return Math.max(0, score);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MiB";
}

/** The first few entries, joined for a one-line detail. */
function sample(items: readonly string[], limit = 3): string {
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? shown + " and " + (items.length - limit) + " more" : shown;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Values from an excluded file worth searching for: long, and not prose. */
function secretTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const raw of text.split(/[\s"',;`]+/)) {
    const token = raw.trim();
    if (token.length < 12 || token.length > 200) continue;
    if (!/[0-9]/.test(token) && !(/[a-z]/.test(token) && /[A-Z]/.test(token))) continue;
    tokens.add(token);
    if (tokens.size >= 60) break;
  }
  return [...tokens];
}

/**
 * Every text artifact read once, so the skipped-secret comparison below does not re-walk and
 * re-read the whole directory per token: with 400 tokens against a 4 MiB snapshot that was close
 * to 2 GiB of reads for one check.
 */
function readArtifactTexts(
  snapshotDir: string,
  maxBytes = 32 * 1024 * 1024
): { texts: string[]; truncated: boolean } {
  const texts: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const relative of walk(snapshotDir)) {
    if (!TEXT_ARTIFACT.test(relative)) continue;
    const full = path.join(snapshotDir, relative);
    let size: number;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    if (bytes + size > maxBytes) {
      // Skip this artifact and keep looking: a 32 MB monolith first in the walk must not hide
      // every smaller part behind it.
      truncated = true;
      continue;
    }
    const text = snapshotText(snapshotDir, relative);
    if (text !== null) {
      texts.push(text);
      bytes += Buffer.byteLength(text, "utf8");
    }
  }
  return { texts, truncated };
}



function findHostPaths(
  snapshotDir: string,
  repoDir: string,
  maxBytes = 32 * 1024 * 1024
): { hits: string[]; truncated: boolean } {
  const patterns = [
    /\/home\/[A-Za-z0-9._-]+/g,
    /\/Users\/[A-Za-z0-9._-]+/g,
    // One file may hold the path as plain text (`C:\Users\name`) and another as a JavaScript or
    // JSON string literal (`C:\\Users\\name`); both name the same machine and both are a leak. The
    // forward-slash form is how the same path is written when it has to be portable.
    /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+/g,
  ];
  const repoPattern = new RegExp(escapeRegExp(repoDir), "g");
  const hits = new Set<string>();
  let scanned = 0;
  let truncated = false;
  for (const relative of walk(snapshotDir)) {
    if (!TEXT_ARTIFACT.test(relative)) continue;
    let size: number;
    try {
      size = fs.statSync(path.join(snapshotDir, relative)).size;
    } catch {
      continue;
    }
    if (scanned + size > maxBytes) {
      truncated = true;
      continue;
    }
    const text = snapshotText(snapshotDir, relative);
    if (text === null) continue;
    scanned += Buffer.byteLength(text, "utf8");
    for (const pattern of patterns) {
      for (const match of text.match(pattern) ?? []) hits.add(relative + ": " + match);
    }
    repoPattern.lastIndex = 0;
    if (repoPattern.test(text)) hits.add(relative + ": the repository absolute path");
  }
  return { hits: [...hits], truncated };
}

/** What git says now versus what the manifest recorded. */
function staleAgainstRepository(manifest: Manifest, repoDir: string): string | null {
  const recorded = manifest.git.commit;
  if (recorded === "" || recorded === "unknown" || recorded === "none") return null;
  let head: string;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  if (head === recorded) return null;
  return (
    "HEAD is " + head.slice(0, 8) + " but the snapshot was generated at " +
    recorded.slice(0, 8) + "; regenerate before trusting it."
  );
}

/**
 * The quality checks added after the first audit.
 *
 * The manifest can be internally consistent and still describe the wrong text: a summary can
 * name a symbol the body does not contain, a report can quote another run, a section can sit in
 * the wrong place, a single-file pack can hold different bytes than the parts, or an index can
 * name a file that is not there. Each helper below answers one of those questions.
 */

interface SummaryClaim {
  field: string;
  value: string;
}

/** Every testable claim a summary makes about the file's contents. */
function summaryClaims(
  summary: NonNullable<Manifest["files"][number]["summary"]>
): SummaryClaim[] {
  if ("imports" in summary) {
    const fields: Array<[string, readonly string[]]> = [
      ["imports", summary.imports],
      ["reExports", summary.reExports],
      ["exports", summary.exports],
      ["functions", summary.functions],
      ["classes", summary.classes],
      ["interfaces", summary.interfaces],
      ["types", summary.types],
      ["enums", summary.enums],
      ["variables", summary.variables],
      ["reactComponents", summary.reactComponents],
      ["hooks", summary.hooks],
      ["routeHandlers", summary.routeHandlers],
    ];
    const claims: SummaryClaim[] = [];
    for (const [field, values] of fields) {
      for (const value of values) {
        if (typeof value !== "string" || value === "") continue;
        // A route handler is recorded as "GET /path": the method is not a literal in the source
        // (`app.get(...)`), so the path is the part that can be checked.
        if (field === "routeHandlers" && value.includes(" ")) {
          const route = value.slice(value.indexOf(" ") + 1).trim();
          if (route !== "") claims.push({ field, value: route });
          continue;
        }
        claims.push({ field, value });
      }
    }
    return claims;
  }
  if ("keys" in summary) {
    return [...summary.keys, ...summary.sampleKeys].map((key) => ({
      field: "keys",
      value: '"' + key + '"',
    }));
  }
  return summary.headings.map((heading) => ({ field: "headings", value: heading }));
}

/** A number a report states in the form `**Label:** \`1,234\``. */
function reportNumber(text: string, label: string): number | null {
  const match = new RegExp("\\*\\*" + escapeRegExp(label) + ":\\*\\* `([0-9][0-9,]*)`").exec(text);
  return match === null ? null : Number(match[1].replace(/,/g, ""));
}

/** A size a report states in MiB, compared to two decimal places. */
function reportMib(text: string, label: string): number | null {
  const match = new RegExp(
    "\\*\\*" + escapeRegExp(label) + ":\\*\\* `([0-9]+(?:\\.[0-9]+)?) MiB`"
  ).exec(text);
  return match === null ? null : Number(match[1]);
}

/**
 * True when a part line is its source line with secret spans replaced by the marker.
 *
 * The marker's length is not the length of what it replaced, so the comparison is the surviving
 * text in order rather than a byte count. A line that differs in any other way does not match.
 */
function maskCompatible(sourceLine: string, bodyLine: string): boolean {
  // A private-key block has its own marker, so both are a mask. Normalising the special one to
  // the general one keeps the walk below a single split.
  const normalised = bodyLine.split(PEM_REDACTION_MARKER).join(REDACTION_MARKER);
  let cursor = 0;
  for (const piece of normalised.split(REDACTION_MARKER)) {
    if (piece === "") continue;
    const at = sourceLine.indexOf(piece, cursor);
    if (at === -1) return false;
    cursor = at + piece.length;
  }
  return true;
}

/** The 1-based first line that is neither equal nor a redaction of the source, or null. */
function firstBodyMismatch(expected: string, actual: string): number | null {
  const sourceLines = expected.split("\n");
  const bodyLines = actual.split("\n");
  const shared = Math.min(sourceLines.length, bodyLines.length);
  for (let index = 0; index < shared; index += 1) {
    if (sourceLines[index] === bodyLines[index]) continue;
    if (!bodyLines[index].includes(REDACTION_MARKER) && !bodyLines[index].includes(PEM_REDACTION_MARKER)) {
      return index + 1;
    }
    if (!maskCompatible(sourceLines[index], bodyLines[index])) return index + 1;
  }
  return sourceLines.length === bodyLines.length ? null : shared + 1;
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The per-file bodies in `full-codebase.json`, or null when the document is not that shape. */
function jsonPackBodies(text: string): Map<string, string> | null {
  try {
    const parsed = JSON.parse(text) as { files?: unknown };
    if (!Array.isArray(parsed?.files)) return null;
    const bodies = new Map<string, string>();
    for (const entry of parsed.files as Array<{ relativePath?: unknown; content?: unknown }>) {
      if (typeof entry?.relativePath !== "string" || typeof entry.content !== "string") continue;
      bodies.set(entry.relativePath, entry.content);
    }
    return bodies;
  } catch {
    return null;
  }
}

/** The per-file bodies in `full-codebase.xml`, joining CDATA sections split by the writer. */
function xmlPackBodies(text: string): Map<string, string> | null {
  const bodies = new Map<string, string>();
  const filePattern = /  <file path="([^"]*)"[^>]*>\n([\s\S]*?)\n  <\/file>/g;
  for (const match of text.matchAll(filePattern)) {
    const content = [...match[2].matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)]
      .map((part) => part[1])
      .join("");
    bodies.set(decodeXmlAttribute(match[1]), content);
  }
  return bodies.size === 0 ? null : bodies;
}

/** The per-file bodies in `full-codebase.md`, read with the writer's adaptive fence. */
function markdownPackBodies(text: string): Map<string, string> | null {
  const bodies = new Map<string, string>();
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].startsWith("## File: ")) {
      index += 1;
      continue;
    }
    const filePath = lines[index].slice("## File: ".length).trim();
    let cursor = index + 1;
    while (cursor < lines.length && !/^`{3,}/.test(lines[cursor])) {
      if (lines[cursor].startsWith("## File: ")) break;
      cursor += 1;
    }
    const fence = /^(`{3,})/.exec(lines[cursor] ?? "");
    if (fence === null) {
      index = cursor + 1;
      continue;
    }
    const body: string[] = [];
    let bodyLine = cursor + 1;
    while (bodyLine < lines.length && lines[bodyLine] !== fence[1]) {
      body.push(lines[bodyLine]);
      bodyLine += 1;
    }
    bodies.set(filePath, body.join("\n"));
    index = bodyLine + 1;
  }
  return bodies.size === 0 ? null : bodies;
}

export function auditSnapshot(options: HealthOptions): HealthReport {
  const snapshotDir = path.resolve(options.snapshotDir);
  const repoDir = path.resolve(options.repoDir);
  const checks: HealthCheck[] = [];

  const manifestFile = path.join(snapshotDir, "manifest.json");
  const raw = readJson(manifestFile);
  const problem =
    raw === null ? "the file is missing or is not valid JSON" : describeManifestShapeProblem(raw);
  if (raw === null || problem !== null) {
    checks.push(
      check(
        "manifest",
        "Manifest is present and well-formed",
        "critical",
        "fail",
        raw === null ? "No readable manifest at " + manifestFile + "." : "Not a snapshot manifest: " + problem
      )
    );
    return report(snapshotDir, repoDir, checks);
  }
  const manifest = raw as Manifest;
  checks.push(
    check(
      "manifest",
      "Manifest is present and well-formed",
      "critical",
      "pass",
      "Schema " + manifest.schemaVersion + ", fingerprint " + manifest.fingerprint.slice(0, 12) + "."
    )
  );

  // Integrity
  const partNames = new Set(manifest.parts.map((part) => part.filename));
  const missingParts: string[] = [];
  const mismatched: string[] = [];
  for (const part of manifest.parts) {
    const bytes = snapshotBytes(snapshotDir, "parts/" + part.filename);
    if (bytes === null) {
      missingParts.push(part.filename);
      continue;
    }
    if (bytes.length !== part.byteSize) {
      mismatched.push(part.filename + " (size " + bytes.length + " != " + part.byteSize + ")");
    } else if (sha256(bytes) !== part.sha256) {
      mismatched.push(part.filename + " (sha256)");
    }
  }
  checks.push(
    missingParts.length === 0
      ? check("parts.present", "Every part the manifest names is on disk", "critical", "pass",
          manifest.parts.length + " part(s) present.")
      : check("parts.present", "Every part the manifest names is on disk", "critical", "fail",
          missingParts.length + " missing: " + sample(missingParts))
  );
  checks.push(
    mismatched.length === 0
      ? check("parts.hashes", "Every part matches its recorded size and hash", "critical", "pass",
          manifest.parts.length + " part(s) verified.")
      : check("parts.hashes", "Every part matches its recorded size and hash", "critical", "fail",
          mismatched.length + " altered: " + sample(mismatched))
  );

  const unassigned = manifest.files.filter(
    (file) => file.part === null || !partNames.has(file.part)
  );
  const declared = manifest.parts.reduce((total, part) => total + part.fileCount, 0);
  checks.push(
    unassigned.length === 0 && declared === manifest.files.length
      ? check("parts.accounting", "Every file is in exactly one part", "critical", "pass",
          manifest.files.length + " file(s) across " + manifest.parts.length + " part(s).")
      : check("parts.accounting", "Every file is in exactly one part", "critical", "fail",
          unassigned.length + " file(s) point at no part; the parts declare " + declared + " of " +
            manifest.files.length + ".")
  );

  // Artifacts
  const artifacts = (manifest.artifacts ?? {}) as Record<
    string,
    { byteSize?: number; sha256?: string } | null
  >;
  const artifactProblems: string[] = [];
  let artifactCount = 0;
  for (const [key, value] of Object.entries(artifacts)) {
    if (value === null || value === undefined) continue;
    const relative = ARTIFACT_FILES[key];
    if (relative === undefined) continue;
    artifactCount += 1;
    const bytes = snapshotBytes(snapshotDir, relative);
    if (bytes === null) artifactProblems.push(relative + " is missing");
    else if (typeof value.sha256 === "string" && sha256(bytes) !== value.sha256) {
      artifactProblems.push(relative + " changed");
    }
  }
  checks.push(
    artifactProblems.length === 0
      ? check("artifacts", "Every recorded artifact is present and unchanged", "critical", "pass",
          artifactCount + " artifact(s) verified.")
      : check("artifacts", "Every recorded artifact is present and unchanged", "critical", "fail",
          sample(artifactProblems))
  );

  // Expected paths are the fixed files plus the artifacts this manifest actually records: an
  // artifact a run did not write is not expected, and a file it did not declare is unexpected.
  const recordedArtifacts = (manifest.artifacts ?? {}) as Record<string, unknown>;
  const known = new Set<string>([
    ".codebase-snapshot",
    "manifest.json",
    // Written after the manifest by `--sign`, so it is not in any artifact record, but it is a
    // file this tool wrote and belongs to the snapshot it signs.
    "signature.json",
    ...Object.entries(ARTIFACT_FILES)
      .filter(([key]) => recordedArtifacts[key] !== undefined && recordedArtifacts[key] !== null)
      .map(([, file]) => file),
    ...manifest.parts.map((part) => "parts/" + part.filename),
  ]);
  const unexpected = walk(snapshotDir).filter((file) => !known.has(file));
  checks.push(
    unexpected.length === 0
      ? check("artifacts.extra", "Nothing unexpected in the snapshot directory", "warning", "pass",
          known.size + " expected path(s), no others.")
      : check("artifacts.extra", "Nothing unexpected in the snapshot directory", "warning", "warn",
          unexpected.length + " unexpected path(s): " + sample(unexpected))
  );

  // A signature is optional; when present it must prove the manifest it names.
  const signaturePath = path.join(snapshotDir, "signature.json");
  if (fs.existsSync(signaturePath)) {
    const outcome = verifySnapshotSignature(snapshotDir);
    checks.push(
      outcome.ok
        ? check("signature", "The manifest signature verifies", "critical", "pass",
            "signed " + outcome.record.signedAt + " (key: " + outcome.record.keyOrigin + ", " +
              outcome.record.fingerprint.slice(0, 12) + ")")
        : check("signature", "The manifest signature verifies", "critical", "fail", outcome.reason)
    );
  } else {
    checks.push(
      check("signature", "The manifest is signed", "warning", "skip",
        "No signature.json; the snapshot cannot prove who produced it.")
    );
  }

  // Bookkeeping: the counts are what a summary quotes, and nothing else in the audit compares them
  // with the arrays they summarise. A manifest edited to say "5 more files" passed every check
  // while the parts held one.
  const bookkeeping: string[] = [];
  const expect = (name: string, recorded: number, computed: number): void => {
    if (recorded !== computed) bookkeeping.push(name + ": manifest says " + recorded + ", the data has " + computed);
  };
  expect("counts.totalFiles", manifest.counts.totalFiles, manifest.files.length);
  expect("counts.partsCount", manifest.counts.partsCount, manifest.parts.length);
  expect("counts.skippedCount", manifest.counts.skippedCount, manifest.skipped.length);
  if (typeof manifest.totals.includedFiles === "number") {
    expect("totals.includedFiles", manifest.totals.includedFiles, manifest.files.length);
  }
  const contentBytes = manifest.files.reduce((sum, file) => sum + file.includedBytes, 0);
  expect("totals.totalContentBytes", manifest.totals.totalContentBytes, contentBytes);
  const layerCounts = new Map<string, number>();
  for (const file of manifest.files) layerCounts.set(file.layer, (layerCounts.get(file.layer) ?? 0) + 1);
  for (const [layer, count] of layerCounts) {
    expect("layers." + layer, manifest.layers[layer] ?? -1, count);
  }
  for (const layer of Object.keys(manifest.layers)) {
    if (!layerCounts.has(layer)) expect("layers." + layer, manifest.layers[layer], 0);
  }
  checks.push(
    bookkeeping.length === 0
      ? check("bookkeeping", "The counts equal the data they summarise", "critical", "pass",
          "Files, parts, skips, content bytes and layer counts all agree.")
      : check("bookkeeping", "The counts equal the data they summarise", "critical", "fail",
          bookkeeping.length + " mismatch(es): " + sample(bookkeeping))
  );

  // One parse per part, reused by the body accounting, the section structure, the packs and the
  // deep replay: every check below asks about the same sections.
  const fileByPath = new Map(manifest.files.map((file) => [file.relativePath, file]));
  const partTexts = new Map<string, string>();
  const partSections = new Map<string, PartSection[]>();
  const bodyByPath = new Map<string, string>();
  const anchorToPath = new Map(
    manifest.files.map((file) => [anchorForPath(file.relativePath), file.relativePath])
  );
  for (const part of manifest.parts) {
    const partText = snapshotText(snapshotDir, "parts/" + part.filename);
    if (partText === null) continue;
    const sections = parsePartSections(partText);
    partTexts.set(part.filename, partText);
    partSections.set(part.filename, sections);
    for (const section of sections) {
      if (section.anchor === null) continue;
      const relativePath = anchorToPath.get(section.anchor);
      if (relativePath !== undefined) bodyByPath.set(relativePath, section.body);
    }
  }

  // A summary is a claim about the body. It comes from a separate parse, so a parser change, a
  // stale manifest or a masked symbol can leave it naming something the parts do not contain.
  // Redacted names are skipped; a name is never printed, because a symbol can itself be secret.
  const summaryProblems: string[] = [];
  let claimsChecked = 0;
  let summarisedFiles = 0;
  for (const file of manifest.files) {
    if (file.summary === undefined) continue;
    if (file.inclusionMode === "preview" || file.emptyLinesRemoved === true) continue;
    const body = bodyByPath.get(file.relativePath);
    if (body === undefined) continue;
    summarisedFiles += 1;
    for (const claim of summaryClaims(file.summary)) {
      if (claim.value.includes(REDACTION_MARKER)) continue;
      claimsChecked += 1;
      if (!body.includes(claim.value)) {
        summaryProblems.push(file.relativePath + " (" + claim.field + ")");
      }
    }
  }
  checks.push(
    summarisedFiles === 0
      ? check("summary.truth", "Every summary claim appears in the body", "critical", "skip",
          "No summarised file could be compared with a body.")
      : summaryProblems.length === 0
        ? check("summary.truth", "Every summary claim appears in the body", "critical", "pass",
            claimsChecked + " claim(s) across " + summarisedFiles + " file(s) are present in the parts.")
        : check("summary.truth", "Every summary claim appears in the body", "critical", "fail",
            summaryProblems.length + " claim(s) name something the body does not contain: " + sample(summaryProblems))
  );

  // The human-facing reports quote the manifest. A report copied from a previous run, or generated
  // before the manifest was updated, is a document that describes a different snapshot.
  const reportProblems: string[] = [];
  let reportClaims = 0;
  const compareNumber = (label: string, actual: number | null, expected: number): void => {
    if (actual === null) return;
    reportClaims += 1;
    if (actual !== expected) {
      reportProblems.push(label + " says " + actual + ", the manifest says " + expected);
    }
  };
  const compareMib = (label: string, actual: number | null, bytes: number): void => {
    if (actual === null) return;
    reportClaims += 1;
    const expected = Number((bytes / (1024 * 1024)).toFixed(2));
    if (Math.abs(actual - expected) > 0.011) {
      reportProblems.push(label + " says " + actual + " MiB, the manifest says " + expected);
    }
  };
  if (manifest.artifacts?.readme != null) {
    const text = snapshotText(snapshotDir, "README.md");
    if (text === null) {
      reportProblems.push("README.md is recorded but unreadable");
    } else {
      compareNumber("README total files", reportNumber(text, "Total Tracked Files"), manifest.counts.totalFiles);
      compareNumber("README source lines", reportNumber(text, "Source Lines"), manifest.counts.totalLines);
      compareNumber(
        "README emitted lines",
        reportNumber(text, "Emitted Lines"),
        manifest.totals.emittedLines ?? manifest.counts.totalLines
      );
      const partsWritten = manifest.config.artifacts?.parts !== false;
      compareNumber("README part count", reportNumber(text, "Part Count"), partsWritten ? manifest.counts.partsCount : 0);
      compareMib("README total size", reportMib(text, "Total Size"), manifest.counts.totalSizeBytes);
      compareMib("README emitted content", reportMib(text, "Emitted Content"), manifest.totals.totalContentBytes);
      const rows = [...text.matchAll(/^\| \[([^\]]+)\]\(parts\/([^)]+)\) \| (\d+) \| ([0-9.]+) KB \|/gm)];
      if (rows.length > 0) {
        reportClaims += rows.length;
        if (rows.length !== manifest.parts.length) {
          reportProblems.push("README tables " + rows.length + " part(s), the manifest holds " + manifest.parts.length);
        }
        for (const row of rows) {
          const part = manifest.parts.find((candidate) => candidate.filename === row[2]);
          if (part === undefined) {
            reportProblems.push("README names " + row[2] + ", which the manifest does not hold");
            continue;
          }
          if (Number(row[3]) !== part.fileCount) {
            reportProblems.push("README " + row[2] + " says " + row[3] + " file(s), the manifest says " + part.fileCount);
          }
          const stated = Number(row[4]);
          const expected = Number((part.byteSize / 1024).toFixed(1));
          if (Math.abs(stated - expected) > 0.11) {
            reportProblems.push("README " + row[2] + " says " + stated + " KB, the manifest says " + expected);
          }
        }
      }
    }
  }
  if (manifest.artifacts?.prompt != null) {
    const text = snapshotText(snapshotDir, "PROMPT.md");
    if (text === null) {
      reportProblems.push("PROMPT.md is recorded but unreadable");
    } else {
      const fingerprint = /^- Fingerprint: \x60([0-9a-f]{12,64})\x60/m.exec(text);
      if (fingerprint !== null) {
        reportClaims += 1;
        if (fingerprint[1] !== manifest.fingerprint) reportProblems.push("PROMPT names a different fingerprint");
      }
      const generated = /^- Generated: \x60([^\x60]+)\x60 from branch \x60([^\x60]+)\x60 at commit \x60([0-9a-f]+)\x60/m.exec(text);
      if (generated !== null) {
        reportClaims += 3;
        if (generated[1] !== manifest.generatedAt) reportProblems.push("PROMPT names a different generation time");
        if (generated[2] !== manifest.git.branch) reportProblems.push("PROMPT names a different branch");
        if (!manifest.git.commit.startsWith(generated[3])) reportProblems.push("PROMPT names a different commit");
      }
      const validation = /^- Validation: the generation-time check was \x60([^\x60]+)\x60/m.exec(text);
      if (validation !== null) {
        reportClaims += 1;
        if (validation[1] !== manifest.validation.status) reportProblems.push("PROMPT quotes a different validation status");
      }
      const partsLine = /^- Parts: ([\d,]+) at a ([\d,]+) KB ceiling/m.exec(text);
      if (partsLine !== null) {
        reportClaims += 2;
        if (Number(partsLine[1].replace(/,/g, "")) !== manifest.parts.length) {
          reportProblems.push("PROMPT says " + partsLine[1] + " part(s), the manifest holds " + manifest.parts.length);
        }
        const ceiling = Math.round(manifest.budgets.maxPartBytes / 1024);
        if (Number(partsLine[2].replace(/,/g, "")) !== ceiling) {
          reportProblems.push("PROMPT says a " + partsLine[2] + " KB ceiling, the manifest says " + ceiling);
        }
      }
      for (const row of text.matchAll(/^  - \x60([^\x60]+)\x60 - ([\d,]+) file\(s\)$/gm)) {
        reportClaims += 1;
        const part = manifest.parts.find((candidate) => candidate.filename === row[1]);
        if (part === undefined) {
          reportProblems.push("PROMPT names " + row[1] + ", which the manifest does not hold");
        } else if (Number(row[2].replace(/,/g, "")) !== part.fileCount) {
          reportProblems.push("PROMPT " + row[1] + " says " + row[2] + " file(s), the manifest says " + part.fileCount);
        }
      }
      const coverage = /^- ([\d,]+) paths were found; ([\d,]+) (?:is|are) in the parts and ([\d,]+) (?:was|were) skipped/m.exec(text);
      if (coverage !== null) {
        reportClaims += 3;
        if (Number(coverage[1].replace(/,/g, "")) !== manifest.totals.candidateFiles) {
          reportProblems.push("PROMPT says " + coverage[1] + " paths were found, the manifest says " + manifest.totals.candidateFiles);
        }
        if (Number(coverage[2].replace(/,/g, "")) !== manifest.totals.includedFiles) {
          reportProblems.push("PROMPT says " + coverage[2] + " are in the parts, the manifest says " + manifest.totals.includedFiles);
        }
        if (Number(coverage[3].replace(/,/g, "")) !== manifest.counts.skippedCount) {
          reportProblems.push("PROMPT says " + coverage[3] + " were skipped, the manifest says " + manifest.counts.skippedCount);
        }
      }
      const partial = /^- Partial files: (none|[\d,]+)\./m.exec(text);
      if (partial !== null) {
        reportClaims += 1;
        const stated = partial[1] === "none" ? 0 : Number(partial[1].replace(/,/g, ""));
        if (stated !== manifest.incomplete.length) {
          reportProblems.push("PROMPT says " + partial[1] + " partial file(s), the manifest holds " + manifest.incomplete.length);
        }
      }
      if (text.includes("- Redacted: no line matched a secret rule.")) {
        reportClaims += 1;
        if (manifest.totals.redactedLines !== 0) {
          reportProblems.push("PROMPT says nothing was redacted, the manifest says " + manifest.totals.redactedLines);
        }
      } else {
        const redacted = /^- Redacted: ([\d,]+) line\(s\) had values masked/m.exec(text);
        if (redacted !== null) {
          reportClaims += 1;
          if (Number(redacted[1].replace(/,/g, "")) !== manifest.totals.redactedLines) {
            reportProblems.push("PROMPT says " + redacted[1] + " redacted line(s), the manifest says " + manifest.totals.redactedLines);
          }
        }
      }
      const layersLine = /^- Layers, by file count: (.+)$/m.exec(text);
      if (layersLine !== null) {
        for (const layer of layersLine[1].matchAll(/\x60([^\x60]+)\x60 ([\d,]+)/g)) {
          reportClaims += 1;
          const expected = manifest.layers[layer[1]] ?? 0;
          if (Number(layer[2].replace(/,/g, "")) !== expected) {
            reportProblems.push("PROMPT layer " + layer[1] + " says " + layer[2] + ", the manifest says " + expected);
          }
        }
      }
    }
  }
  checks.push(
    reportProblems.length > 0
      ? check("report.truth", "The reports quote this run, not another", "critical", "fail",
          reportProblems.length + " disagreement(s): " + sample(reportProblems))
      : reportClaims === 0
        ? check("report.truth", "The reports quote this run, not another", "critical", "skip",
            "No report in the current shape could be compared with the manifest.")
        : check("report.truth", "The reports quote this run, not another", "critical", "pass",
            reportClaims + " figure(s) in README.md and PROMPT.md agree with the manifest.")
  );

  // An index that names a path the snapshot does not carry is a promise the reader cannot keep.
  const indexProblems: string[] = [];
  const indexedPaths = new Set<string>();
  const checkIndexed = (kind: string, relativePath: string, part?: string): void => {
    const file = fileByPath.get(relativePath);
    if (file === undefined) {
      indexProblems.push(kind + " names " + relativePath + ", which is not in files[]");
      return;
    }
    if (part !== undefined && file.part !== part) {
      indexProblems.push(kind + " puts " + relativePath + " in " + part + ", the manifest says " + file.part);
    }
  };
  for (const route of manifest.indexes.routes) checkIndexed("routes", route.path, route.part);
  for (const component of manifest.indexes.components) checkIndexed("components", component.path, component.part);
  for (const handler of manifest.indexes.handlers) checkIndexed("handlers", handler.path, handler.part);
  for (const directive of manifest.indexes.directives) checkIndexed("directives", directive.path);
  for (const entry of manifest.indexes.imports.byFile) {
    checkIndexed("imports.byFile", entry.path);
    if (indexedPaths.has(entry.path)) indexProblems.push("imports.byFile lists " + entry.path + " twice");
    indexedPaths.add(entry.path);
  }
  for (const entry of manifest.indexes.imports.centralFiles) {
    checkIndexed("centralFiles", entry.path);
    if (entry.importedByCount < 1) {
      indexProblems.push("centralFiles says " + entry.path + " has " + entry.importedByCount + " importer(s)");
    }
  }
  checks.push(
    indexProblems.length === 0
      ? check("indexes.consistent", "Every index entry names a file in the snapshot", "critical", "pass",
          manifest.indexes.imports.byFile.length + " import edge(s) and " +
            (manifest.indexes.routes.length + manifest.indexes.components.length + manifest.indexes.handlers.length) +
            " route/component/handler entry(s) resolve.")
      : check("indexes.consistent", "Every index entry names a file in the snapshot", "critical", "fail",
          indexProblems.length + " index problem(s): " + sample(indexProblems))
  );

  // Every single-file pack is checked for membership: a digest proves the file is what the manifest
  // recorded, not that the recorded pack holds every file. JSON, XML and markdown write the path in
  // a different shape, so each reader is small and format-specific rather than one clever regex.
  const packReaders: Array<{ key: "fullJson" | "fullXml" | "fullMarkdown"; file: string; label: string; paths: (text: string) => Set<string> | null }> = [
    {
      key: "fullJson",
      file: "full-codebase.json",
      label: "JSON",
      paths: (text) => {
        try {
          const parsed = JSON.parse(text) as { files?: unknown };
          if (!Array.isArray(parsed?.files)) return null;
          return new Set(parsed.files.map((entry: { relativePath?: unknown }) => String(entry?.relativePath)));
        } catch {
          return null;
        }
      },
    },
    {
      key: "fullXml",
      file: "full-codebase.xml",
      label: "XML",
      paths: (text) => {
        const found = [...text.matchAll(/<file path="([^"]+)"/g)].map((match) => match[1]);
        if (found.length === 0) return null;
        return new Set(found.map((value) => value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")));
      },
    },
    {
      key: "fullMarkdown",
      file: "full-codebase.md",
      label: "markdown",
      paths: (text) => {
        const found = [...text.matchAll(/^## File: (.+)$/gm)].map((match) => match[1].trim());
        if (found.length === 0) return null;
        return new Set(found);
      },
    },
  ];
  for (const reader of packReaders) {
    if (manifest.artifacts?.[reader.key] == null) continue;
    const packText = snapshotText(snapshotDir, reader.file);
    const problems: string[] = [];
    if (packText === null) {
      problems.push(reader.file + " is recorded but unreadable");
    } else {
      const packed = reader.paths(packText);
      if (packed === null) {
        problems.push(reader.file + " could not be parsed for its file list");
      } else {
        const known = new Set(manifest.files.map((file) => file.relativePath));
        for (const file of manifest.files) {
          if (!packed.has(file.relativePath)) problems.push(file.relativePath + " is in the manifest but not the pack");
        }
        for (const path of packed) {
          if (!known.has(path)) problems.push(path + " is in the pack but not the manifest");
        }
      }
    }
    const title = "The " + reader.label + " pack holds every file the manifest lists";
    checks.push(
      problems.length === 0
        ? check("pipeline.monolith", title, "critical", "pass",
            manifest.files.length + " file(s) present in " + reader.file + ", and nothing extra.")
        : check("pipeline.monolith", title, "critical", "fail",
            problems.length + " problem(s): " + sample(problems))
    );
  }


  // The manifest says how many bytes and lines each file contributed. The parts are the only
  // place that claim can be checked, and a part whose section is shorter than the manifest says
  // is a snapshot that under-delivers while its hashes still agree. One parse per part, reused by
  // the section, pack and replay checks below, then every file in it is looked up by anchor.
  const bodyProblems: string[] = [];
  let bodiesChecked = 0;
  for (const part of manifest.parts) {
    const sections = partSections.get(part.filename);
    if (sections === undefined) continue;
    for (const file of manifest.files) {
      if (file.part !== part.filename) continue;
      const section = findSection(sections, file.relativePath);
      if (section === null) {
        bodyProblems.push(file.relativePath + " has no section in " + part.filename);
        continue;
      }
      bodyByPath.set(file.relativePath, section.body);
      bodiesChecked += 1;
      const bytes = Buffer.byteLength(section.body, "utf8");
      // The body keeps a trailing newline only when the source ended with a blank line: the
      // closing newline is dropped by `emittedBody`, so a remaining one *is* that blank line.
      const bodyLines = countBodyLines(section.body);
      if (bytes !== file.includedBytes) {
        bodyProblems.push(file.relativePath + ": manifest says " + file.includedBytes + " B, part holds " + bytes + " B");
      } else if (bodyLines !== file.includedLines) {
        bodyProblems.push(file.relativePath + ": manifest says " + file.includedLines + " line(s), part holds " + bodyLines);
      }
    }
  }
  checks.push(
    bodyProblems.length === 0
      ? check("pipeline.bodies", "Every file body matches the manifest accounting", "critical", "pass",
          bodiesChecked + " file body/bodies match their recorded bytes and lines.")
      : check("pipeline.bodies", "Every file body matches the manifest accounting", "critical", "fail",
          bodyProblems.length + " file(s) disagree: " + sample(bodyProblems))
  );

  // A section that sits under the wrong heading, or a part whose declared count is not the number
  // of sections it holds, still hashes correctly: the hash proves the bytes are the recorded bytes,
  // not that they are in the place the manifest describes.
  const structureProblems: string[] = [];
  let sectionsChecked = 0;
  for (const part of manifest.parts) {
    const text = partTexts.get(part.filename);
    const sections = partSections.get(part.filename);
    if (text === undefined || sections === undefined) continue;
    const header = /^# Codebase Snapshot Part (\d+) of (\d+)$/m.exec(text);
    if (header !== null) {
      if (Number(header[1]) !== part.index) {
        structureProblems.push(part.filename + " says part " + header[1] + ", the manifest says " + part.index);
      }
      if (Number(header[2]) !== manifest.parts.length) {
        structureProblems.push(part.filename + " says " + header[2] + " parts, the manifest holds " + manifest.parts.length);
      }
    }
    const filesLine = /^- Files: (\d+)$/m.exec(text);
    if (filesLine !== null && Number(filesLine[1]) !== part.fileCount) {
      structureProblems.push(part.filename + " says " + filesLine[1] + " file(s), the manifest says " + part.fileCount);
    }
    const fingerprintLine = /^- Content Fingerprint: (\S+)$/m.exec(text);
    if (fingerprintLine !== null && fingerprintLine[1] !== manifest.fingerprint) {
      structureProblems.push(part.filename + " names a different content fingerprint");
    }
    const tokenLine = /^- Estimated Tokens: ~([0-9,]+)$/m.exec(text);
    if (tokenLine !== null && Number(tokenLine[1].replace(/,/g, "")) !== part.estimatedTokens) {
      structureProblems.push(part.filename + " says " + tokenLine[1] + " tokens, the manifest says " + part.estimatedTokens);
    }
    if (sections.length !== part.fileCount) {
      structureProblems.push(part.filename + " holds " + sections.length + " section(s), the manifest says " + part.fileCount);
    }
    const expectedAnchors = new Set(part.includedFiles.map((entry) => anchorForPath(entry.relativePath)));
    for (const section of sections) {
      if (section.anchor === null || !expectedAnchors.has(section.anchor)) {
        structureProblems.push(part.filename + " holds a section for " + section.path + ", which the manifest does not list");
      }
    }
    const expectedOrder = part.includedFiles.map((entry) => anchorForPath(entry.relativePath)).join("\n");
    const actualOrder = sections
      .map((section) => section.anchor)
      .filter((anchor): anchor is string => anchor !== null)
      .join("\n");
    if (actualOrder !== expectedOrder) {
      structureProblems.push(part.filename + " orders its sections differently than the manifest");
    }
    for (const entry of part.includedFiles) {
      const file = fileByPath.get(entry.relativePath);
      if (file === undefined) continue;
      const section = findSection(sections, entry.relativePath);
      if (section === null) {
        structureProblems.push(entry.relativePath + " has no section in " + part.filename);
        continue;
      }
      sectionsChecked += 1;
      if (section.path !== displayPath(entry.relativePath)) {
        structureProblems.push(entry.relativePath + " is headed " + section.path);
      }
      if (section.inclusion !== null && section.inclusion !== file.inclusionMode) {
        structureProblems.push(entry.relativePath + " declares " + section.inclusion + ", the manifest says " + file.inclusionMode);
      }
      if (section.includedLines !== null && section.includedLines !== file.includedLines) {
        structureProblems.push(entry.relativePath + " declares " + section.includedLines + " line(s), the manifest says " + file.includedLines);
      }
    }
  }
  checks.push(
    structureProblems.length === 0
      ? check("markdown.structure", "Every section sits where the manifest says", "critical", "pass",
          sectionsChecked + " section(s) in " + manifest.parts.length + " part(s) match their heading, metadata and order.")
      : check("markdown.structure", "Every section sits where the manifest says", "critical", "fail",
          structureProblems.length + " structural problem(s): " + sample(structureProblems))
  );

  // The pack is a second copy of the same payload. Membership is checked above; this checks the
  // bytes. A pack that lists every file but carries a different body is still a pack that lies,
  // and the artifact digest cannot see it because the digest was taken over the wrong bytes.
  const packCandidates: Array<{
    key: "fullJson" | "fullXml" | "fullMarkdown";
    file: string;
    label: string;
    read: (text: string) => Map<string, string> | null;
  }> = [
    { key: "fullJson", file: "full-codebase.json", label: "JSON", read: jsonPackBodies },
    { key: "fullXml", file: "full-codebase.xml", label: "XML", read: xmlPackBodies },
    { key: "fullMarkdown", file: "full-codebase.md", label: "markdown", read: markdownPackBodies },
  ];
  const packsWanted = packCandidates.filter((pack) => manifest.artifacts?.[pack.key] != null);
  if (packsWanted.length > 0) {
    const renderedPaths = new Map(
      manifest.files.map((file) => [escapeControls(file.relativePath), file.relativePath])
    );
    const packProblems: string[] = [];
    let packBodies = 0;
    let packSkipped = 0;
    for (const pack of packsWanted) {
      const text = snapshotText(snapshotDir, pack.file);
      if (text === null) continue;
      const bodies = pack.read(text);
      if (bodies === null) {
        packProblems.push(pack.file + " could not be read as a file pack");
        continue;
      }
      for (const [entryPath, body] of bodies) {
        const relativePath = pack.key === "fullMarkdown" ? (renderedPaths.get(entryPath) ?? entryPath) : entryPath;
        const file = fileByPath.get(relativePath);
        if (file === undefined) continue;
        // A preview's or skeleton's pack carries the redacted whole file on purpose; the part does
        // not. Only the modes whose pack body and part body are the same string are compared.
        if (file.inclusionMode === "preview" || file.inclusionMode === "signatures") {
          packSkipped += 1;
          continue;
        }
        const partBody = bodyByPath.get(relativePath);
        if (partBody === undefined) continue;
        packBodies += 1;
        const normalised = pack.key === "fullMarkdown" ? body : emittedBody(body);
        if (normalised !== partBody) {
          packProblems.push(pack.file + ": " + relativePath + " holds a different body");
        }
      }
    }
    checks.push(
      packProblems.length === 0
        ? check("packs.bodies", "Every pack body is the body the parts carry", "critical", "pass",
            packBodies + " full body/bodies match across " + packsWanted.length + " pack(s)" +
              (packSkipped > 0 ? "; " + packSkipped + " preview/signature body(s) are whole-file by design." : "."))
        : check("packs.bodies", "Every pack body is the body the parts carry", "critical", "fail",
            packProblems.length + " body/bodies differ: " + sample(packProblems))
    );
  }

  // The deep check closes the one gap the checks above cannot: the manifest and the parts can agree
  // with each other while both describe a file the generator read incorrectly. It replays each full
  // body from the bytes on disk, allowing only the documented redaction marker.
  if (options.deep !== true) {
    checks.push(
      check("fidelity.bodies", "Every full body replays from the source bytes", "critical", "skip",
        "Run health --deep to replay each full body against the file on disk.")
    );
  } else {
    const replayProblems: string[] = [];
    let replayed = 0;
    let unreplayable = 0;
    for (const file of manifest.files) {
      if (file.inclusionMode !== "full" || file.emptyLinesRemoved === true) {
        unreplayable += 1;
        continue;
      }
      const body = bodyByPath.get(file.relativePath);
      if (body === undefined) {
        unreplayable += 1;
        continue;
      }
      const repoBytes = readConfinedBytes(repoDir, file.relativePath);
      const bytes = repoBytes.ok ? repoBytes.bytes : null;
      // A file that changed on disk is validate's question, not fidelity's: the manifest no longer
      // describes the bytes being replayed, so a mismatch here would blame the generator for a
      // later edit.
      if (bytes === null || sha256(bytes) !== file.hashSha256) {
        unreplayable += 1;
        continue;
      }
      const decoded = decodeText(bytes);
      if (decoded.binary) {
        replayProblems.push(file.relativePath + " is binary on disk");
        continue;
      }
      const expected = emittedBody(decoded.text);
      if (expected === body) {
        replayed += 1;
        continue;
      }
      const line = firstBodyMismatch(expected, body);
      if (line === null) {
        replayed += 1;
        continue;
      }
      replayProblems.push(file.relativePath + " line " + line + " is not the source line");
    }
    checks.push(
      replayProblems.length === 0
        ? check("fidelity.bodies", "Every full body replays from the source bytes", "critical", "pass",
            replayed + " full body/bodies replayed byte-for-byte (redaction allowed); " +
              unreplayable + " not replayable by design or because the file moved.")
        : check("fidelity.bodies", "Every full body replays from the source bytes", "critical", "fail",
            replayProblems.length + " body/bodies disagree with the source: " + sample(replayProblems))
    );
  }

  // A workspace index describes its members. When this snapshot is one of them, the two records
  // have to agree, or the deliverable says two different things about the same directory.
  const indexParent = path.dirname(snapshotDir);
  // A workspace member's snapshot lives at <workspace>/snapshot/<member>, so its WORKSPACE.json
  // is one directory above the member repository. The read is still confined to the directory
  // that holds the snapshot; a symlinked WORKSPACE.json is refused, and member.path is never
  // stat'ed until it resolves inside repoDir.
  const indexRead = readConfinedText(indexParent, "WORKSPACE.json");
  if (indexRead.ok) {
      let members: Array<{ name?: unknown; path?: unknown; fingerprint?: unknown; files?: unknown }> = [];
      let problem: string | null = null;
      try {
        const parsed = JSON.parse(indexRead.text) as { members?: unknown };
        if (!Array.isArray(parsed?.members)) problem = "its members field is not an array";
        else members = parsed.members as typeof members;
      } catch {
        // Never echo the parser's message. Node 20+ includes the opening bytes of the input there,
        // which made a symlinked WORKSPACE.json a host-file prefix leak.
        problem = "it is not valid JSON";
      }
      const memberName = path.basename(snapshotDir);
      const member = members.find((entry) => entry.name === memberName);
      if (problem !== null) {
        checks.push(check("workspace.index", "The workspace index agrees with this member", "warning", "warn",
          "WORKSPACE.json could not be read: " + problem));
      } else if (member === undefined) {
        checks.push(check("workspace.index", "The workspace index agrees with this member", "warning", "skip",
          "WORKSPACE.json lists no member named " + memberName + "."));
      } else {
        const disagreements: string[] = [];
        if (member.fingerprint !== manifest.fingerprint) disagreements.push("fingerprint");
        if (typeof member.files === "number" && member.files !== manifest.counts.totalFiles) {
          disagreements.push("file count");
        }
        // A WORKSPACE.json is repository content. Its member.path is untrusted input: using
        // fs.existsSync on it was a host-file existence oracle (and followed a symlink out of the
        // repository). Resolve only a path whose canonical target stays inside the repository.
        let sourceGone: string | null = null;
        if (typeof member.path === "string") {
          const memberPath = member.path;
          // WORKSPACE.json stores member paths relative to the workspace root, which is one
          // directory above the snapshot root for a workspace run. A single-snapshot index at the
          // repository root uses the snapshot parent instead. Try each anchor lexically, then
          // choose the one that lands inside this member's repository; never stat a candidate
          // outside it.
          // A member path is workspace-relative for --all-members and for a member health run;
          // repoDir is the workspace root in the first case and the member repository in the
          // second. The workspace root is one directory above the snapshot root. Exclude the
          // snapshot root itself: a missing member source there is a directory in the snapshot,
          // not the repository the manifest describes.
          const candidates = [path.dirname(indexParent), repoDir]
            .map((anchor) => path.resolve(anchor, memberPath))
            .filter((candidate) => {
              const relative = path.relative(repoDir, candidate);
              return (
                relative !== ".." &&
                !relative.startsWith(".." + path.sep) &&
                !path.isAbsolute(relative)
              );
            });
          // Prefer a candidate that exists; when none does, the first one is the missing source
          // path we want to report.
          const resolved = candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
          if (resolved === undefined) {
            sourceGone =
              "Member " + memberName + " source directory resolves outside the repository; not inspected.";
          } else {
            let canonical: string | null = null;
            try {
              canonical = fs.realpathSync(resolved);
            } catch {
              canonical = null;
            }
            const canonicalRelative =
              canonical === null ? null : path.relative(repoDir, canonical);
            const canonicalInside =
              canonical !== null &&
              (canonicalRelative === "" ||
                (canonicalRelative !== null &&
                  canonicalRelative !== ".." &&
                  !canonicalRelative.startsWith(`..${path.sep}`) &&
                  !canonicalRelative.startsWith("../") &&
                  !path.isAbsolute(canonicalRelative)));
            if (canonical !== null && !canonicalInside) {
              sourceGone =
                "Member " + memberName + " source directory resolves outside the repository; not inspected.";
            } else if (canonical === null || !fs.existsSync(resolved)) {
              sourceGone =
                "Member " + memberName + " source directory is gone (" + member.path +
                "); the snapshot still describes it. Regenerate the workspace.";
            }
          }
        }
        checks.push(
          sourceGone !== null
            ? check("workspace.index", "The workspace index agrees with this member", "warning", "warn", sourceGone)
            : disagreements.length === 0
              ? check("workspace.index", "The workspace index agrees with this member", "warning", "pass",
                  "Member " + memberName + " matches the index fingerprint and file count.")
              : check("workspace.index", "The workspace index agrees with this member", "warning", "warn",
                  "The index disagrees with this member on: " + disagreements.join(", ") + ". Regenerate the workspace.")
        );
      }
    }

  // Leaks
  const rules = [...compileSecretRules(DEFAULT_SECRET_PATTERNS), ...(options.secretRules ?? [])];
  const scanBudget = options.maxScanBytes ?? 32 * 1024 * 1024;
  const leakHits: string[] = [];
  let scannedBytes = 0;
  let skippedArtifacts = 0;
  for (const relative of walk(snapshotDir)) {
    if (!TEXT_ARTIFACT.test(relative)) continue;
    // The signature record is scanned below, without its key material: a random ed25519 public
    // key or signature contains a 52-character alphanumeric run often enough (about one run in
    // forty) to match the Azure DevOps token shape, and the audit then failed the snapshot it had
    // just signed. That is a false positive with a concrete cost: `--sign` failed `health`
    // intermittently.
    if (relative === SIGNATURE_FILE) continue;
    let size: number;
    try {
      size = fs.statSync(path.join(snapshotDir, relative)).size;
    } catch {
      continue;
    }
    if (scannedBytes + size > scanBudget) {
      // Keep scanning the smaller artifacts. Breaking here reported "Scanned 0 B" as a pass when
      // the first file in the walk was larger than the caller's budget.
      skippedArtifacts += 1;
      continue;
    }
    const text = snapshotText(snapshotDir, relative);
    if (text === null) continue;
    scannedBytes += Buffer.byteLength(text, "utf8");
    // A part is scanned section by section with the path the section came from. The generator
    // redacted each file under that path, and the rules are path-aware: an unquoted right-hand
    // side in a source file is an expression, not a credential, while the same text in a part is
    // read as markdown. Scanning the whole part under `parts/part-007.md` therefore flagged
    // comments that describe a rule (`DB_PASSWORD=envpass!@#$%^&*()`) as a leak — findings the
    // generator had deliberately not made, because the source-file rule exempts them.
    let findingCount = 0;
    if (/^parts[\\/].*\.md$/i.test(relative)) {
      // Bodies are scanned under their source path; everything else in the part (the heading, the
      // meta and summary lines, the file list) is scanned as the part. Removing the bodies from a
      // copy keeps that coverage — a path or summary is text too, and dropping it would trade one
      // false positive for a blind spot.
      let headerText = text;
      for (const section of parsePartSections(text)) {
        findingCount += scanAndRedactSecrets(section.body, rules, section.path).findings.length;
        headerText = headerText.replace(section.body, "");
      }
      findingCount += scanAndRedactSecrets(headerText, rules, relative).findings.length;
    } else {
      findingCount = scanAndRedactSecrets(text, rules, relative).findings.length;
    }
    if (findingCount > 0) {
      leakHits.push(relative + " (" + findingCount + " line(s))");
    }
  }
  // The record's non-key fields are still scanned for secret shapes. Its public key, signature,
  // fingerprint and manifest digest are random by construction and are verified against the
  // manifest by the signature check, so scanning those bytes can only produce false positives.
  const signatureRecordPath = path.join(snapshotDir, SIGNATURE_FILE);
  if (fs.existsSync(signatureRecordPath)) {
    const recordText = snapshotText(snapshotDir, SIGNATURE_FILE);
    if (recordText !== null) {
      scannedBytes += Buffer.byteLength(recordText, "utf8");
      let scanText = recordText;
      try {
        const record = JSON.parse(recordText) as Record<string, unknown>;
        const rest: Record<string, unknown> = { ...record };
        delete rest.publicKey;
        delete rest.signature;
        delete rest.manifestSha256;
        delete rest.fingerprint;
        scanText = JSON.stringify(rest, null, 2);
      } catch {
        // A malformed record is a signature-check failure; scan it as text as well.
      }
      const found = scanAndRedactSecrets(scanText, rules, SIGNATURE_FILE);
      if (found.findings.length > 0) {
        leakHits.push(SIGNATURE_FILE + " (" + found.findings.length + " line(s))");
      }
    }
  }

  checks.push(
    leakHits.length > 0
      ? check("secrets.artifacts", "No unmasked secret survives in an artifact", "critical", "fail",
          leakHits.length + " artifact(s) contain a secret-shaped value: " + sample(leakHits))
      : skippedArtifacts > 0
        ? check("secrets.artifacts", "No unmasked secret survives in an artifact", "critical", "warn",
            "Scanned " + formatBytes(scannedBytes) + " and skipped " + skippedArtifacts +
              " artifact(s) larger than the remaining scan budget; the snapshot was not fully checked.")
        : check("secrets.artifacts", "No unmasked secret survives in an artifact", "critical", "pass",
            "Scanned " + formatBytes(scannedBytes) + " across the written artifacts.")
  );

  const skippedSensitive = manifest.skipped.filter((record) =>
    record.reason.startsWith("sensitive")
  );
  const leakedFrom: string[] = [];
  let compared = 0;
  // Read once even when nothing sensitive was excluded: the cost is one walk, and it keeps the
  // per-token check below from re-reading the directory hundreds of times.
  const artifactScan = readArtifactTexts(snapshotDir, scanBudget);
  const artifactTexts = artifactScan.texts;
  const artifactContains = (token: string): boolean =>
    artifactTexts.some((text) => text.includes(token));
  for (const record of skippedSensitive.slice(0, 40)) {
    if (record.path.includes("[REDACTED") || compared > 400) continue;
    try {
      // Do not allocate a multi-megabyte excluded file just to compare sixty tokens.
      if (fs.statSync(path.join(repoDir, record.path)).size > scanBudget) continue;
    } catch {
      continue;
    }
    const repoRead = readConfinedText(repoDir, record.path);
    const text = repoRead.ok ? repoRead.text : null;
    if (text === null) continue;
    for (const token of secretTokens(text)) {
      compared += 1;
      if (artifactContains(token)) leakedFrom.push(record.path);
    }
  }
  checks.push(
    leakedFrom.length > 0
      ? check("secrets.skipped", "No value from an excluded sensitive file appears in an artifact",
          "critical", "fail",
          "A value from " + sample([...new Set(leakedFrom)]) + " appears in the snapshot.")
      : artifactScan.truncated
        ? check("secrets.skipped", "No value from an excluded sensitive file appears in an artifact",
            "critical", "warn",
            skippedSensitive.length + " sensitive path(s) excluded; " + compared +
              " value(s) compared, but some artifacts were larger than the scan budget and were not checked.")
        : check("secrets.skipped", "No value from an excluded sensitive file appears in an artifact",
            "critical", "pass",
            skippedSensitive.length + " sensitive path(s) excluded; " + compared + " value(s) compared.")
  );

  const pii = findHostPaths(snapshotDir, repoDir, scanBudget);
  checks.push(
    pii.hits.length > 0
      ? check("pii.paths", "No host path or machine identity leaks into the text", "warning", "warn",
          pii.hits.length + " hit(s): " + sample(pii.hits) +
            (pii.truncated ? " (scan stopped at the byte budget; more may remain)" : ""))
      : pii.truncated
        ? check("pii.paths", "No host path or machine identity leaks into the text", "warning", "warn",
            "Some artifacts were larger than the scan budget and were not checked for host paths.")
        : check("pii.paths", "No host path or machine identity leaks into the text", "warning", "pass",
            "No absolute home path or repository root found.")
  );

  // Cost
  // Estimate from the emitted text, not from a byte count: estimateTokens takes a string, and
  // handing it the digits of the size produced "recorded 383, recomputed 1" as a warning.
  let recomputed = 0;
  const partTokens = new Map<string, number>();
  for (const part of manifest.parts) {
    const text = partTexts.get(part.filename);
    if (text === undefined) continue;
    const tokens = estimateTokens(text);
    partTokens.set(part.filename, tokens);
    recomputed += tokens;
  }
  const recorded = manifest.totals.estimatedTokens ?? null;
  checks.push(
    recorded === null
      ? check("tokens.count", "The token estimate is recorded and plausible", "warning", "skip",
          "The manifest predates token accounting; recomputed " + recomputed + ".")
      : Math.abs(recomputed - recorded) / Math.max(1, recorded) <= 0.25
        ? check("tokens.count", "The token estimate is recorded and plausible", "warning", "pass",
            "Recorded " + recorded + ", recomputed " + recomputed + ".")
        : check("tokens.count", "The token estimate is recorded and plausible", "warning", "warn",
            "Recorded " + recorded + ", recomputed " + recomputed +
              ": the manifest no longer describes these parts.")
  );

  // A part that is within the byte budget can still be too large to paste into a context window.
  // The estimate is the same one the manifest publishes; this check only asks which windows the
  // largest part and the largest single file fit.
  const partSizes = [...partTokens.values()];
  const largestPart = partSizes.length === 0 ? 0 : Math.max(...partSizes);
  const largestFile = manifest.files.reduce((largest, file) => {
    const body = bodyByPath.get(file.relativePath);
    return body === undefined ? largest : Math.max(largest, estimateTokens(body));
  }, 0);
  const fits = (window: number): number => partSizes.filter((tokens) => tokens <= window).length;
  checks.push(
    check(
      "tokens.fit",
      "The parts fit a context window",
      "warning",
      largestPart > 200000 || largestFile > 200000 ? "warn" : "pass",
      manifest.parts.length + " part(s); largest about " + largestPart + " tokens, " +
        fits(32000) + " fit 32k, " + fits(128000) + " fit 128k, " + fits(200000) +
        " fit 200k; largest single file about " + largestFile + " tokens."
    )
  );

  const overBudget = manifest.parts.filter(
    (part) => part.byteSize > manifest.budgets.maxPartBytes
  );
  checks.push(
    overBudget.length === 0
      ? check("tokens.budget", "Every part honours the budget the manifest publishes", "warning",
          "pass", "Ceiling " + formatBytes(manifest.budgets.maxPartBytes) + ".")
      : check("tokens.budget", "Every part honours the budget the manifest publishes", "warning",
          "warn",
          overBudget.length + " part(s) exceed " + formatBytes(manifest.budgets.maxPartBytes) + ": " +
            sample(overBudget.map((part) => part.filename)))
  );

  // Truthfulness
  const badSkips = manifest.skipped.filter((record) => !record.reason || !record.path);
  checks.push(
    badSkips.length === 0 && manifest.skipped.length === manifest.totals.skippedFiles
      ? check("skips", "Every excluded path is recorded with a reason", "critical", "pass",
          manifest.skipped.length + " skip record(s).")
      : check("skips", "Every excluded path is recorded with a reason", "critical", "fail",
          badSkips.length + " record(s) lack a path or reason; totals say " +
            manifest.totals.skippedFiles + ".")
  );

  const stale = staleAgainstRepository(manifest, repoDir);
  checks.push(
    stale === null
      ? check("freshness", "The snapshot still describes the repository", "warning", "pass",
          "HEAD matches the recorded commit.")
      : check("freshness", "The snapshot still describes the repository", "warning", "warn", stale)
  );

  return report(snapshotDir, repoDir, checks);
}

function report(snapshotDir: string, repoDir: string, checks: HealthCheck[]): HealthReport {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const item of checks) counts[item.status] += 1;
  return {
    snapshotDir,
    repoDir,
    generatedAt: new Date().toISOString(),
    score: scoreOf(checks),
    checks,
    counts,
  };
}
