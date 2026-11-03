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
  detect(context: PresetContext): boolean;
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
}

function compare(a: PresetDefinition, b: PresetDefinition): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Every preset, ordered by priority.
 *
 * Ordering is the whole detection model: the first definition whose `detect`
 * returns true wins, so the list is sorted once at module load rather than being
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
 * Resolves a preset from an already-built context.
 *
 * A preset can be forced by name; an unknown name is a caller error and is
 * reported by `resolveConfig` rather than silently ignored.
 */
export function detectPresetFromContext(context: PresetContext, forced?: string): DetectedPreset {
  if (forced !== undefined) {
    const preset = BY_NAME.get(forced);
    if (!preset) return detectPresetFromContext(context);
    return toDetected(preset);
  }

  for (const preset of PRESETS) {
    if (preset.detect(context)) return toDetected(preset);
  }
  // `generic` detects everything, so this is unreachable in practice.
  return toDetected(PRESETS[PRESETS.length - 1]);
}

function toDetected(preset: PresetDefinition): DetectedPreset {
  return {
    presetName: preset.name,
    layers: preset.layers,
    kinds: preset.kinds,
    exclude: preset.exclude ? [...preset.exclude] : [],
    recommendedBudget: preset.recommendedBudget ?? null,
  };
}

/** Detects the preset for `cwd`, reading the repository once. */
export function detectPreset(cwd: string, forced?: string): DetectedPreset {
  return detectPresetFromContext(buildPresetContext(cwd), forced);
}
