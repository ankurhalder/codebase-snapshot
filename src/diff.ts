import * as fs from "node:fs";
import * as path from "node:path";
import type { Manifest } from "./types.js";

export interface ManifestDiff {
  before: DiffSide;
  after: DiffSide;
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
}

interface DiffSide {
  generatedAt: string;
  fingerprint: string;
  fileCount: number;
  partsCount: number;
}

function side(manifest: Manifest): DiffSide {
  return {
    generatedAt: manifest.generatedAt,
    fingerprint: manifest.fingerprint,
    fileCount: manifest.counts.totalFiles,
    partsCount: manifest.counts.partsCount,
  };
}

function hashMap(manifest: Manifest): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of manifest.files) {
    if (file && typeof file.relativePath === "string") {
      map.set(file.relativePath, file.hashSha256);
    }
  }
  return map;
}

/**
 * Describes why a parsed value cannot be used as a snapshot manifest.
 *
 * A parseable JSON object is not necessarily a manifest: `{ "counts": {},
 * "files": [] }` used to be accepted, and `diff` then printed
 * `before  undefined  undefined file(s)` and exited 0. The checks mirror what
 * `validate` requires before it will inspect a manifest at all.
 */
function manifestProblem(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "not a JSON object";
  const candidate = value as Record<string, unknown>;

  if (!Array.isArray(candidate.files)) return 'no "files" array';
  for (const entry of candidate.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return 'a "files" entry is not an object';
    }
    if (typeof (entry as Record<string, unknown>).relativePath !== "string") {
      return 'a "files" entry has no "relativePath"';
    }
  }

  const counts = candidate.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    return 'no "counts" object';
  }
  for (const key of ["totalFiles", "totalLines", "totalSizeBytes", "partsCount"]) {
    if (typeof (counts as Record<string, unknown>)[key] !== "number") {
      return `no numeric "counts.${key}"`;
    }
  }

  if (typeof candidate.generatedAt !== "string") return 'no "generatedAt"';
  if (typeof candidate.fingerprint !== "string") return 'no "fingerprint"';
  return null;
}

function assertUsableManifest(value: unknown, label: string): asserts value is Manifest {
  const problem = manifestProblem(value);
  if (problem) {
    throw new Error(`The ${label} manifest is not a snapshot manifest this tool wrote: ${problem}.`);
  }
}

/** Compares two manifests file by file. */
export function compareManifests(before: Manifest, after: Manifest): ManifestDiff {
  // Validated here as well as in `loadManifest`, so a caller that builds its own
  // objects gets a clear error naming the side instead of `undefined` in output.
  assertUsableManifest(before, "before");
  assertUsableManifest(after, "after");

  const left = hashMap(before);
  const right = hashMap(after);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;

  for (const [filePath, hash] of right) {
    const previous = left.get(filePath);
    if (previous === undefined) added.push(filePath);
    else if (previous !== hash) changed.push(filePath);
    else unchanged += 1;
  }
  for (const filePath of left.keys()) {
    if (!right.has(filePath)) removed.push(filePath);
  }

  const sort = (values: string[]): string[] =>
    values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    before: side(before),
    after: side(after),
    added: sort(added),
    removed: sort(removed),
    changed: sort(changed),
    unchanged,
  };
}

/** Loads a manifest from a snapshot directory or a `manifest.json` path. */
export function loadManifest(target: string): Manifest {
  // `statSync` used to be unguarded, so `diff nope nope` printed a raw
  // "ENOENT: no such file or directory, stat ..." instead of saying what failed.
  let isDirectory: boolean;
  try {
    isDirectory = fs.statSync(target).isDirectory();
  } catch {
    throw new Error(`No snapshot found at ${target}: the path does not exist.`);
  }

  const manifestPath = isDirectory ? path.join(target, "manifest.json") : target;

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(`Could not read a manifest at ${manifestPath}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not parse ${manifestPath}: ${(err as Error).message}`);
  }

  const problem = manifestProblem(parsed);
  if (problem) {
    throw new Error(
      `${manifestPath} is not a usable snapshot manifest: ${problem}. ` +
        `Point diff at a manifest.json written by \`generate\` (or at the directory that holds it).`
    );
  }
  return parsed as Manifest;
}

/** Renders a diff for a terminal. */
export function renderDiffText(diff: ManifestDiff): string {
  const lines: string[] = [];
  lines.push(`before  ${diff.before.generatedAt}  ${diff.before.fileCount} file(s), ${diff.before.partsCount} part(s)`);
  lines.push(`after   ${diff.after.generatedAt}  ${diff.after.fileCount} file(s), ${diff.after.partsCount} part(s)`);
  lines.push("");
  lines.push(`  + ${diff.added.length} added`);
  lines.push(`  - ${diff.removed.length} removed`);
  lines.push(`  ~ ${diff.changed.length} changed`);
  lines.push(`  = ${diff.unchanged} unchanged`);

  const section = (title: string, values: string[]): void => {
    if (values.length === 0) return;
    lines.push("", title);
    for (const value of values.slice(0, 200)) lines.push(`  ${value}`);
    if (values.length > 200) lines.push(`  ... and ${values.length - 200} more`);
  };

  section("added:", diff.added);
  section("removed:", diff.removed);
  section("changed:", diff.changed);

  return lines.join("\n");
}
