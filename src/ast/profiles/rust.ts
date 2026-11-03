import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary, isTopLevel } from "./shared.js";

const USE = /^use\s+([^;]+);/;
const FN = /^(pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/;
const STRUCT = /^(pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/;
const TRAIT = /^(pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/;
const ENUM = /^(pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/;
const TYPE = /^(pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/;
const MOD = /^(pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/;
const IMPL = /^impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/;

/**
 * Rust: `use` paths, functions, structs, traits, enums, type aliases, modules
 * and `impl` targets. `pub` is the visibility marker.
 */
export const rustProfile: LanguageProfile = {
  id: "rust",
  extensions: [".rs"],
  summarize(_path, content) {
    const summary = emptySummary();

    eachLine(content, (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) return;

      const used = USE.exec(trimmed);
      if (used) {
        summary.imports.push(used[1].trim());
        return;
      }

      if (!isTopLevel(line)) return;

      const isPublic = /^pub\b/.test(trimmed);

      const fn = FN.exec(line);
      if (fn) {
        summary.functions.push(fn[2]);
        if (isPublic) summary.exports.push(fn[2]);
        return;
      }

      const struct = STRUCT.exec(line);
      if (struct) {
        summary.classes.push(struct[2]);
        if (isPublic) summary.exports.push(struct[2]);
        return;
      }

      const trait = TRAIT.exec(line);
      if (trait) {
        summary.interfaces.push(trait[2]);
        if (isPublic) summary.exports.push(trait[2]);
        return;
      }

      const enumeration = ENUM.exec(line);
      if (enumeration) {
        summary.enums.push(enumeration[2]);
        if (isPublic) summary.exports.push(enumeration[2]);
        return;
      }

      const alias = TYPE.exec(line);
      if (alias) {
        summary.types.push(alias[2]);
        if (isPublic) summary.exports.push(alias[2]);
        return;
      }

      const module = MOD.exec(line);
      if (module) {
        summary.variables.push(module[2]);
        if (isPublic) summary.exports.push(module[2]);
        return;
      }

      const implementation = IMPL.exec(line);
      if (implementation) summary.classes.push(implementation[1]);
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
