import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DEFAULT_SECRET_PATTERNS } from "../security/patterns.js";
import { compileSecretRules, scanAndRedactSecrets } from "../security/redact.js";
import { estimateTokens } from "../tokenize.js";
import { describeManifestShapeProblem } from "../validator/validate.js";
import { verifySnapshotSignature } from "../signing.js";
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
  fullJson: "full-codebase.json",
  fullMarkdown: "full-codebase.md",
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
    /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g,
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

  const known = new Set<string>([
    ".codebase-snapshot",
    "manifest.json",
    ...Object.values(ARTIFACT_FILES),
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
