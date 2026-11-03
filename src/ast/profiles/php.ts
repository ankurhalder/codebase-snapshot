import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary } from "./shared.js";

const USE = /^use\s+([\w\\]+)\s*(?:as\s+\w+)?;/;
const DECLARE = /^(?:abstract\s+|final\s+|readonly\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/;
const FUNCTION = /^(?:public\s+|protected\s+|private\s+|static\s+|final\s+|abstract\s+)*function\s+([A-Za-z_]\w*)/;

/** PHP: `namespace`/`use` imports, type declarations and functions. */
export const phpProfile: LanguageProfile = {
  id: "php",
  extensions: [".php"],
  summarize(_path, content) {
    const summary = emptySummary();

    eachLine(content, (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*")) {
        return;
      }

      const used = USE.exec(trimmed);
      if (used) {
        summary.imports.push(used[1].replace(/\\\\/g, "\\"));
        return;
      }

      const declaration = DECLARE.exec(trimmed);
      if (declaration) {
        const kind = declaration[1];
        const name = declaration[2];
        if (kind === "interface" || kind === "trait") summary.interfaces.push(name);
        else if (kind === "enum") summary.enums.push(name);
        else summary.classes.push(name);
        summary.exports.push(name);
        return;
      }

      const fn = FUNCTION.exec(trimmed);
      if (fn) {
        summary.functions.push(fn[1]);
        if (!/^private\b/.test(trimmed)) summary.exports.push(fn[1]);
      }
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
