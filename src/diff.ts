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
 * Compares two manifests file by file.
 *
 * The per-file hashes and the content fingerprint already make this exact, so
 * nothing is inferred: a path is added, removed or changed, never "maybe".
 */
export function compareManifests(before: Manifest, after: Manifest): ManifestDiff {
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
  const manifestPath = fs.statSync(target).isDirectory()
    ? path.join(target, "manifest.json")
    : target;

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(`Could not read a manifest at ${manifestPath}.`);
  }

  let parsed: Manifest;
  try {
    parsed = JSON.parse(raw) as Manifest;
  } catch (err) {
    throw new Error(`Could not parse ${manifestPath}: ${(err as Error).message}`);
  }

  if (!parsed || !Array.isArray(parsed.files)) {
    throw new Error(`${manifestPath} is not a snapshot manifest (no "files" array).`);
  }
  return parsed;
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
