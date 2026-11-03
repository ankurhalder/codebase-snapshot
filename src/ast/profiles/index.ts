import { cfamilyProfile } from "./cfamily.js";
import { dotnetProfile } from "./dotnet.js";
import { goProfile } from "./go.js";
import { jvmProfile } from "./jvm.js";
import { phpProfile } from "./php.js";
import { pythonProfile } from "./python.js";
import { rubyProfile } from "./ruby.js";
import { rustProfile } from "./rust.js";
import { sfcProfile } from "./sfc.js";
import type { HeuristicResult, LanguageProfile } from "./shared.js";

/**
 * Every heuristic profile, in no particular order — lookup is by extension.
 *
 * Adding a language is one file exporting a `LanguageProfile` plus one line
 * here; nothing else in the pipeline changes.
 */
export const LANGUAGE_PROFILES: readonly LanguageProfile[] = [
  pythonProfile,
  goProfile,
  rustProfile,
  jvmProfile,
  dotnetProfile,
  phpProfile,
  rubyProfile,
  cfamilyProfile,
  sfcProfile,
];

const BY_EXTENSION = new Map<string, LanguageProfile>();
for (const profile of LANGUAGE_PROFILES) {
  for (const extension of profile.extensions) {
    BY_EXTENSION.set(extension.toLowerCase(), profile);
  }
}

/** The profile that owns `path`, or `null` when no profile claims it. */
export function profileForPath(path: string): LanguageProfile | null {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  return BY_EXTENSION.get(lower.slice(dot)) ?? null;
}

/**
 * Summarizes `path` with whichever profile claims it.
 *
 * Returns `null` for files no profile handles — those still enter the snapshot,
 * they just carry no structural summary.
 */
export function summarizeWithProfile(path: string, content: string): HeuristicResult | null {
  const profile = profileForPath(path);
  return profile ? profile.summarize(path, content) : null;
}

export { pythonProfile, goProfile, rustProfile, jvmProfile, dotnetProfile, phpProfile, rubyProfile, cfamilyProfile, sfcProfile };
export type { HeuristicResult, LanguageProfile } from "./shared.js";
