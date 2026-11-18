import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DEFAULT_SECRET_PATTERNS } from "../security/patterns.js";
import { compileSecretRules, scanAndRedactSecrets } from "../security/redact.js";
import { estimateTokens } from "../tokenize.js";
import { describeManifestShapeProblem } from "../validator/validate.js";
import { verifySnapshotSignature } from "../signing.js";
import { findSection, parsePartSections } from "../partitioner/part-format.js";
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
  fullJson: "full-codebase.json",
  fullMarkdown: "full-codebase.md",
  fullXml: "full-codebase.xml",
  sarif: "reports/audit.sarif",
};

const TEXT_ARTIFACT = /\.(md|json|txt|sarif)$/i;

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function readBytes(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  const text = readText(file);
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

function artifactTextContains(snapshotDir: string, token: string): boolean {
  for (const relative of walk(snapshotDir)) {
    if (!TEXT_ARTIFACT.test(relative)) continue;
    const text = readText(path.join(snapshotDir, relative));
    if (text !== null && text.includes(token)) return true;
  }
  return false;
}

function findHostPaths(snapshotDir: string, repoDir: string): string[] {
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
  for (const relative of walk(snapshotDir)) {
    if (!TEXT_ARTIFACT.test(relative)) continue;
    const text = readText(path.join(snapshotDir, relative));
    if (text === null) continue;
    for (const pattern of patterns) {
      for (const match of text.match(pattern) ?? []) hits.add(relative + ": " + match);
    }
    repoPattern.lastIndex = 0;
    if (repoPattern.test(text)) hits.add(relative + ": the repository absolute path");
  }
  return [...hits];
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
    const bytes = readBytes(path.join(snapshotDir, "parts", part.filename));
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
    const bytes = readBytes(path.join(snapshotDir, relative));
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

  // The manifest says how many bytes and lines each file contributed. The parts are the only
  // place that claim can be checked, and a part whose section is shorter than the manifest says
  // is a snapshot that under-delivers while its hashes still agree. One parse per part, then
  // every file in it is looked up by anchor.
  const bodyProblems: string[] = [];
  let bodiesChecked = 0;
  for (const part of manifest.parts) {
    const partText = readText(path.join(snapshotDir, "parts", part.filename));
    if (partText === null) continue;
    const sections = parsePartSections(partText);
    for (const file of manifest.files) {
      if (file.part !== part.filename) continue;
      const section = findSection(sections, file.relativePath);
      if (section === null) {
        bodyProblems.push(file.relativePath + " has no section in " + part.filename);
        continue;
      }
      bodiesChecked += 1;
      const bytes = Buffer.byteLength(section.body, "utf8");
      // The body keeps the file's final newline, so a split counts one more than the manifest's
      // line count (countLines does not count the empty element after a trailing newline).
      const bodyLines =
        section.body === ""
          ? 0
          : section.body.split("\n").length - (section.body.endsWith("\n") ? 1 : 0);
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

  // A workspace index describes its members. When this snapshot is one of them, the two records
  // have to agree, or the deliverable says two different things about the same directory.
  const indexParent = path.dirname(snapshotDir);
  const indexPath = path.join(indexParent, "WORKSPACE.json");
  if (fs.existsSync(indexPath)) {
    const indexText = readText(indexPath);
    let members: Array<{ name?: unknown; path?: unknown; fingerprint?: unknown; files?: unknown }> = [];
    let problem: string | null = null;
    try {
      const parsed = JSON.parse(indexText ?? "null") as { members?: unknown };
      if (!Array.isArray(parsed?.members)) problem = "its members field is not an array";
      else members = parsed.members as typeof members;
    } catch (error) {
      problem = (error as Error).message;
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
      checks.push(
        disagreements.length === 0
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
  for (const relative of walk(snapshotDir)) {
    if (!TEXT_ARTIFACT.test(relative) || scannedBytes > scanBudget) continue;
    const text = readText(path.join(snapshotDir, relative));
    if (text === null) continue;
    scannedBytes += Buffer.byteLength(text, "utf8");
    const found = scanAndRedactSecrets(text, rules, relative);
    if (found.findings.length > 0) {
      leakHits.push(relative + " (" + found.findings.length + " line(s))");
    }
  }
  checks.push(
    leakHits.length === 0
      ? check("secrets.artifacts", "No unmasked secret survives in an artifact", "critical", "pass",
          "Scanned " + formatBytes(scannedBytes) + " across the written artifacts.")
      : check("secrets.artifacts", "No unmasked secret survives in an artifact", "critical", "fail",
          leakHits.length + " artifact(s) contain a secret-shaped value: " + sample(leakHits))
  );

  const skippedSensitive = manifest.skipped.filter((record) =>
    record.reason.startsWith("sensitive")
  );
  const leakedFrom: string[] = [];
  let compared = 0;
  for (const record of skippedSensitive.slice(0, 40)) {
    if (record.path.includes("[REDACTED") || compared > 400) continue;
    const text = readText(path.join(repoDir, record.path));
    if (text === null) continue;
    for (const token of secretTokens(text)) {
      compared += 1;
      if (artifactTextContains(snapshotDir, token)) leakedFrom.push(record.path);
    }
  }
  checks.push(
    leakedFrom.length === 0
      ? check("secrets.skipped", "No value from an excluded sensitive file appears in an artifact",
          "critical", "pass",
          skippedSensitive.length + " sensitive path(s) excluded; " + compared + " value(s) compared.")
      : check("secrets.skipped", "No value from an excluded sensitive file appears in an artifact",
          "critical", "fail",
          "A value from " + sample([...new Set(leakedFrom)]) + " appears in the snapshot.")
  );

  const pii = findHostPaths(snapshotDir, repoDir);
  checks.push(
    pii.length === 0
      ? check("pii.paths", "No host path or machine identity leaks into the text", "warning", "pass",
          "No absolute home path or repository root found.")
      : check("pii.paths", "No host path or machine identity leaks into the text", "warning", "warn",
          pii.length + " hit(s): " + sample(pii))
  );

  // Cost
  // Estimate from the emitted text, not from a byte count: estimateTokens takes a string, and
  // handing it the digits of the size produced "recorded 383, recomputed 1" as a warning.
  let recomputed = 0;
  for (const part of manifest.parts) {
    const text = readText(path.join(snapshotDir, "parts", part.filename));
    if (text !== null) recomputed += estimateTokens(text);
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
