import type { ByteSize, KindRule, LayerRule } from "../types.js";
import { buildPresetContext } from "./context.js";
import type { PresetContext } from "./context.js";
import { JS_PRESETS } from "./js-presets.js";
import { LANGUAGE_PRESETS } from "./lang-presets.js";
import { SHAPE_PRESETS } from "./shape-presets.js";

export interface PresetDefinition {
  readonly name: string;
  /** Higher wins. Framework presets outrank repository shapes. */
  readonly priority: number;
  /**
   * Why this preset matches, or null. Absent on the fallback preset only.
   *
   * Returning the reason rather than `true` is what lets the wizard print
   * `Because next.config.ts` instead of asking the developer to trust a verdict they
   * cannot check — and it is what makes an `--autopilot` decision auditable after
   * the fact. See `evidence.ts` for the helpers the detectors are built from.
   */
  detect?(context: PresetContext): string | null;
  /** Matches everything, and is only reached when no detector reported evidence. */
  readonly fallback?: boolean;
  readonly layers: LayerRule[];
  readonly kinds: KindRule[];
  /** Ecosystem-specific ignores, merged with the user's `excludePatterns`. */
  readonly exclude?: string[];
  /** Advice for the setup wizard. Never applied automatically. */
  readonly recommendedBudget?: ByteSize;
}

export interface DetectedPreset {
  presetName: string;
  layers: LayerRule[];
  kinds: KindRule[];
  /** Ecosystem ignores the scanner should apply in addition to the user's. */
  exclude: string[];
  recommendedBudget: ByteSize | null;
  /**
   * The signal that matched, e.g. `next.config.ts`.
   *
   * Null when the preset was forced by name — nothing was detected, so there is
   * nothing to report — and null for the fallback preset.
   */
  reason: string | null;
  /**
   * True only when nothing matched and the fallback preset was used.
   *
   * A forced preset is never a fallback: the developer asked for it. The first-run
   * wizard keys its "could not tell what this is, please choose" prompt off this.
   */
  fallback: boolean;
}

function compare(a: PresetDefinition, b: PresetDefinition): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Every preset, ordered by priority.
 *
 * Ordering is the whole detection model: the first definition whose detector reports
 * evidence wins, so the list is sorted once at module load rather than being
 * hand-maintained in the right order.
 */
export const PRESETS: readonly PresetDefinition[] = [
  ...JS_PRESETS,
  ...LANGUAGE_PRESETS,
  ...SHAPE_PRESETS,
].sort(compare);

const BY_NAME = new Map(PRESETS.map((preset) => [preset.name, preset]));

/** Every preset name, in priority order — used by the CLI and the wizard. */
export function listPresetNames(): string[] {
  return PRESETS.map((preset) => preset.name);
}

export function getPreset(name: string): PresetDefinition | undefined {
  return BY_NAME.get(name);
}

/**
 * The error text for an unknown preset name.
 *
 * Shared so every entry point — config validation, `detectPreset`, and the
 * `init` CLI flag — fails with the same message and the same list.
 */
export function unknownPresetMessage(name: string): string {
  return `Unknown preset "${name}". Expected one of: ${listPresetNames().join(", ")}.`;
}

/**
 * Resolves a preset from an already-built context.
 *
 * A preset can be forced by name, and an unknown name throws. It used to fall
 * back to detection instead, which meant `init --preset <typo>` wrote a config
 * for a preset the developer never asked for and exited 0.
 */
export function detectPresetFromContext(context: PresetContext, forced?: string): DetectedPreset {
  if (forced !== undefined) {
    const preset = BY_NAME.get(forced);
    if (!preset) throw new Error(unknownPresetMessage(forced));
    return toDetected(preset, null);
  }

  for (const preset of PRESETS) {
    const reason = preset.detect?.(context) ?? null;
    if (reason !== null) return toDetected(preset, reason);
  }

  // A missing fallback would mean a repository that matches nothing has no preset at
  // all, and the caller would have to invent one. Fail here, loudly, instead.
  const fallback = PRESETS.find((preset) => preset.fallback === true);
  if (fallback === undefined) {
    throw new Error('No fallback preset is defined. Exactly one preset must set `fallback: true`.');
  }
  return toDetected(fallback, null, true);
}

function toDetected(
  preset: PresetDefinition,
  reason: string | null,
  fallback = false
): DetectedPreset {
  return {
    presetName: preset.name,
    layers: preset.layers,
    kinds: preset.kinds,
    exclude: preset.exclude ? [...preset.exclude] : [],
    recommendedBudget: preset.recommendedBudget ?? null,
    reason,
    fallback,
  };
}

/** Detects the preset for `cwd`, reading the repository once. */
export function detectPreset(cwd: string, forced?: string): DetectedPreset {
  return detectPresetFromContext(buildPresetContext(cwd), forced);
}
