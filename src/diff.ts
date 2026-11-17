import * as fs from "node:fs";
import * as path from "node:path";
import { findSecretInPath } from "./scanner/files.js";
import { describeManifestShapeProblem } from "./validator/validate.js";
import type { Manifest, SecretRule } from "./types.js";

export interface ManifestDiff {
  before: DiffSide;
  after: DiffSide;
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
  /** What differs beyond the per-file list: the configuration and the emitted payload. */
  payload: PayloadDiff;
}

/**
 * A difference the per-file list cannot express.
 *
 * Per-file comparison is `relativePath + hashSha256`, so a run that changes only
 * the *emitted* payload — `--large-file-bytes` turning a large preview into its
 * full body, different preview head/tail counts, different redaction rules,
 * different artifact selection — used to report "0 changed, N unchanged" and
 * nothing else. The manifests already record the effective-settings digest, the
 * content fingerprint and the part count, so this block says plainly when the
 * source files are identical but the snapshot handed to the model is not.
 */
export interface PayloadDiff {
  /** No source file was added, removed or changed. */
  sourceFilesIdentical: boolean;
  /** The emitted payload, or the configuration that produced it, differs. */
  differs: boolean;
  /** The generator or the effective settings differ, independent of any source edit. */
  configurationDiffers: boolean;
  generator: { before: string; after: string };
  /** `null` when the manifest predates the digest (written before 4.0.5). */
  configDigest: { before: string | null; after: string | null };
  fingerprint: { before: string; after: string };
  partsCount: { before: number; after: number };
  /**
   * The `schemaVersion` of both manifests.
   *
   * Two snapshots written under different schema versions can carry the same file
   * hashes and still mean different things, so a mismatch is reported as a
   * difference (never as a crash) and turns the payload block on.
   */
  schemaVersion: { before: string; after: string };
  /**
   * The `parts` array compared entry by entry: a part added, removed, or
   * re-rendered (different `byteSize`, `sha256`, `lines` or `fileCount`).
   *
   * The per-file list compares `relativePath + hashSha256` only, so a hand-edited
   * or older manifest whose parts were repacked, renamed or deleted used to produce
   * "+0 -0 ~0 =N unchanged" and exit 0. This block is rendered independently of
   * `differs`, because a source edit already legitimately turns the file lists on.
   */
  partsManifest: { differs: boolean; changes: string[] };
  layers: { before: Record<string, number>; after: Record<string, number> };
  /** Human-readable statements, rendered by the terminal form. */
  reasons: string[];
  /**
   * A stable code per statement in `reasons`, in the same order.
   *
   * `reasons` is prose for a human; a program reading `diff --format json` had to match on that
   * prose to decide what changed. The codes are the vocabulary: `schema-version`,
   * `config-digest`, `config-digest-missing`, `generator`, `fingerprint`, `parts-count` and
   * `layer-changed`.
   */
  codes: string[];
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

/** Twelve hex characters are enough to compare two digests by eye. */
function shortDigest(value: string | null): string {
  return value === null ? "not recorded" : `${value.slice(0, 12)}…`;
}

/** `layer "api": 2 file(s) → 3 file(s)` for every layer whose count moved. */
function describeLayerChanges(
  before: Record<string, number>,
  after: Record<string, number>,
  secretRules?: readonly SecretRule[]
): string[] {
  const names = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  const changes: string[] = [];
  for (const name of names) {
    const was = before[name] ?? 0;
    const now = after[name] ?? 0;
    if (was === now) continue;
    // A layer name is config-supplied and lands in every artifact; mask it like a path.
    const label = findSecretInPath(name, secretRules)?.masked ?? name;
    changes.push(`layer "${label}": ${was} file(s) → ${now} file(s)`);
  }
  return changes;
}

type PartMetadata = Manifest["parts"][number];

/**
 * One statement for every part that was added, removed or re-rendered.
 *
 * Compared by `filename`, then by the metadata that makes the part a different
 * artifact: `sha256`, `byteSize`, `lines` and `fileCount`. Part names are our own
 * (`part-001.md`), but a hand-edited manifest can hold anything, and these lines
 * are printed and serialized, so a token in a name is masked like every other path.
 */
function describePartChanges(
  before: readonly PartMetadata[],
  after: readonly PartMetadata[],
  secretRules?: readonly SecretRule[]
): string[] {
  const index = (parts: readonly PartMetadata[]): Map<string, PartMetadata> => {
    const map = new Map<string, PartMetadata>();
    for (const part of parts) {
      if (part && typeof part.filename === "string") map.set(part.filename, part);
    }
    return map;
  };
  const left = index(before);
  const right = index(after);
  const label = (filename: string): string =>
    findSecretInPath(filename, secretRules)?.masked ?? filename;
  const changes: string[] = [];

  for (const [filename, part] of right) {
    const previous = left.get(filename);
    if (previous === undefined) {
      changes.push(`part added: ${label(filename)}`);
      continue;
    }
    const moved: string[] = [];
    if (previous.sha256 !== part.sha256) {
      moved.push(`sha256 ${shortDigest(previous.sha256)} → ${shortDigest(part.sha256)}`);
    }
    if (previous.byteSize !== part.byteSize) {
      moved.push(`byteSize ${previous.byteSize} → ${part.byteSize}`);
    }
    if (previous.lines !== part.lines) {
      moved.push(`lines ${previous.lines} → ${part.lines}`);
    }
    if (previous.fileCount !== part.fileCount) {
      moved.push(`fileCount ${previous.fileCount} → ${part.fileCount}`);
    }
    if (moved.length > 0) changes.push(`part ${label(filename)}: ${moved.join(", ")}`);
  }
  for (const filename of left.keys()) {
    if (!right.has(filename)) changes.push(`part removed: ${label(filename)}`);
  }
  return changes;
}

/**
 * The layer counts with credential-shaped names masked.
 *
 * `Object.fromEntries` rather than assignment: a layer called `__proto__` is a legal name, and
 * `out["__proto__"] = n` would set the prototype instead of an own key.
 */
function maskLayerNames(
  layers: Record<string, number> | undefined,
  secretRules?: readonly SecretRule[]
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(layers ?? {}).map(([name, count]) => [
      findSecretInPath(name, secretRules)?.masked ?? name,
      count,
    ])
  );
}

/**
 * Builds the payload/configuration block.
 *
 * `differs` is true when the settings or the generator differ, or when the source
 * set is identical yet the content fingerprint or the part count moved — the two
 * cases in which the per-file list says "0 changed" while the emitted snapshot is
 * different. A source edit alone is already reported by the file list and does
 * not turn this block on.
 */
function describePayloadDiff(
  before: Manifest,
  after: Manifest,
  sourceFilesIdentical: boolean,
  secretRules?: readonly SecretRule[]
): PayloadDiff {
  const generatorBefore = before.generator?.version ?? "unknown";
  const generatorAfter = after.generator?.version ?? "unknown";
  const digestBefore = typeof before.config?.digest === "string" ? before.config.digest : null;
  const digestAfter = typeof after.config?.digest === "string" ? after.config.digest : null;
  // A hand-built object can omit either side; say "unknown" rather than print
  // `undefined` into the reason line and the JSON payload.
  const schemaBefore = typeof before.schemaVersion === "string" ? before.schemaVersion : "unknown";
  const schemaAfter = typeof after.schemaVersion === "string" ? after.schemaVersion : "unknown";

  const generatorDiffers = generatorBefore !== generatorAfter;
  const digestDiffers =
    digestBefore !== null && digestAfter !== null && digestBefore !== digestAfter;
  const schemaDiffers = schemaBefore !== schemaAfter;
  const configurationDiffers = generatorDiffers || digestDiffers || schemaDiffers;

  const fingerprintDiffers = before.fingerprint !== after.fingerprint;
  const partsDiffer = before.counts.partsCount !== after.counts.partsCount;
  const partChanges = describePartChanges(before.parts ?? [], after.parts ?? [], secretRules);
  const layerChanges = describeLayerChanges(before.layers ?? {}, after.layers ?? {}, secretRules);

  const reasons: string[] = [];
  const codes: string[] = [];
  if (schemaDiffers) {
    codes.push("schema-version");
    reasons.push(
      `schema version ${schemaBefore} → ${schemaAfter} (the two manifests describe different formats)`
    );
  }
  if (digestDiffers) {
    codes.push("config-digest");
    reasons.push(
      `configuration digest ${shortDigest(digestBefore)} → ${shortDigest(digestAfter)} ` +
        "(budgets, preview thresholds, redaction rules, artifact selection, the prompt task and the " +
      "owner brief all count)"
    );
  } else if (digestBefore === null || digestAfter === null) {
    const missing = digestBefore === null && digestAfter !== null
      ? "before"
      : digestAfter === null && digestBefore !== null
        ? "after"
        : "both";
    codes.push("config-digest-missing");
    reasons.push(
      `configuration digest not recorded on the ${missing} side (manifest written before 4.0.5); ` +
        "compared the content fingerprint and part count instead"
    );
  }
  if (generatorDiffers) {
    codes.push("generator");
    reasons.push(`generator ${generatorBefore} → ${generatorAfter}`);
  }
  if (fingerprintDiffers && (sourceFilesIdentical || configurationDiffers)) {
    codes.push("fingerprint");
    reasons.push(
      `content fingerprint ${shortDigest(before.fingerprint)} → ${shortDigest(after.fingerprint)}` +
        (sourceFilesIdentical ? " (same source files, packed or configured differently)" : "")
    );
  }
  if (partsDiffer) {
    codes.push("parts-count");
    reasons.push(`${before.counts.partsCount} part(s) → ${after.counts.partsCount} part(s)`);
  }
  for (let index = 0; index < layerChanges.length; index += 1) codes.push("layer-changed");
  reasons.push(...layerChanges);

  return {
    sourceFilesIdentical,
    differs:
      configurationDiffers ||
      (sourceFilesIdentical && (fingerprintDiffers || partsDiffer || layerChanges.length > 0)),
    configurationDiffers,
    generator: { before: generatorBefore, after: generatorAfter },
    configDigest: { before: digestBefore, after: digestAfter },
    fingerprint: { before: before.fingerprint, after: after.fingerprint },
    partsCount: { before: before.counts.partsCount, after: after.counts.partsCount },
    schemaVersion: { before: schemaBefore, after: schemaAfter },
    partsManifest: { differs: partChanges.length > 0, changes: partChanges },
    // The layer maps are printed and serialized, so a layer named after a project token leaks the
    // token here even though every reason line above is masked. Found while testing the rules
    // parameter: masking the prose and not the data it describes is the same bug one layer down.
    layers: { before: maskLayerNames(before.layers, secretRules), after: maskLayerNames(after.layers, secretRules) },
    reasons,
    codes,
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
 * The narrow precondition of the in-memory comparison.
 *
 * `loadManifest` enforces the full manifest shape with `describeManifestShapeProblem`
 * — the same guard `validate` and `report` use — so everything the CLI compares has
 * been checked there. `compareManifests` is also a library entry point, and comparing
 * two file lists reads only `files` and the counts, so this checks exactly that and
 * names the side that is malformed instead of letting `undefined` reach the output.
 */
function comparableProblem(value: unknown): string | null {
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
  for (const key of ["totalFiles", "partsCount"]) {
    if (typeof (counts as Record<string, unknown>)[key] !== "number") {
      return `no numeric "counts.${key}"`;
    }
  }

  if (typeof candidate.generatedAt !== "string") return 'no "generatedAt"';
  return null;
}

function assertUsableManifest(value: unknown, label: string): asserts value is Manifest {
  const problem = comparableProblem(value);
  if (problem) {
    throw new Error(`The ${label} manifest is not a snapshot manifest: ${problem}.`);
  }
}

/**
 * Compares two manifests file by file.
 *
 * `secretRules` is the resolved rule list of the caller (`config.secretRules` — built-ins plus
 * `secrets.customPatterns`, or only the custom ones when the defaults are disabled). Without it
 * every masking call in this file used the built-ins alone, so a token a repository had declared
 * in `secretRules` — the reason the setting exists — was printed in clear by `diff` while
 * `generate`, `validate`, `explain` and the MCP server all masked it.
 */
export function compareManifests(
  before: Manifest,
  after: Manifest,
  secretRules?: readonly SecretRule[]
): ManifestDiff {
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

  const sourceFilesIdentical = added.length === 0 && removed.length === 0 && changed.length === 0;
  const payload = describePayloadDiff(before, after, sourceFilesIdentical, secretRules);

  // `diff` prints these paths and `--format json` ships them: a token in a
  // filename must not come back out of the comparison. Default rules plus the
  // rules `resolveConfig` registered apply.
  const mask = (values: string[]): string[] =>
    values.map((value) => findSecretInPath(value, secretRules)?.masked ?? value);

  return {
    before: side(before),
    after: side(after),
    added: mask(sort(added)),
    removed: mask(sort(removed)),
    changed: mask(sort(changed)),
    unchanged,
    payload,
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

  // One shared guard with `validate` and `report`: a manifest whose `fingerprint`,
  // `generatedAt`, `schemaVersion` or required arrays are missing is rejected here,
  // before the comparison can report "+0 -0 ~0 =N unchanged" for it.
  const problem = describeManifestShapeProblem(parsed);
  if (problem) {
    // The same sentence `validate` and `report` use, so one malformed manifest reads the same in
    // all three commands. It used to say "usable … this tool wrote", a fourth phrasing of one fact.
    throw new Error(
      `${manifestPath} is not a snapshot manifest: ${problem}. ` +
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

  // The per-file list cannot see a settings change that repacks the same sources.
  // Say it plainly rather than printing "0 changed" and letting the reader assume
  // the snapshot handed to the model is unchanged.
  if (diff.payload.differs) {
    lines.push("", "payload/configuration differs:");
    for (const reason of diff.payload.reasons) lines.push(`  ! ${reason}`);
    lines.push(
      diff.payload.sourceFilesIdentical
        ? `  source files are identical (${diff.unchanged} unchanged); the snapshot handed to the model differs.`
        : "  source files differ too; see the file lists above."
    );
  } else if (
    diff.payload.sourceFilesIdentical &&
    (diff.payload.configDigest.before === null || diff.payload.configDigest.after === null)
  ) {
    // Without a digest there is nothing to compare the settings with. Silence
    // here would read as "the configuration is identical".
    lines.push(
      "",
      "configuration not compared: a manifest has no config digest (written before 4.0.5)."
    );
  }

  // The file list compares paths and hashes; a part that was renamed, re-packed or
  // hand-edited is invisible there. Rendered whether or not the block above fired,
  // because a source edit legitimately turns the block above on by itself.
  if (diff.payload.partsManifest.differs) {
    lines.push("", "parts manifest differs:");
    for (const change of diff.payload.partsManifest.changes) lines.push(`  ! ${change}`);
  }

  return lines.join("\n");
}
