import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary, isTopLevel } from "./shared.js";

const REQUIRE = /^require(?:_relative)?\s+["']([^"']+)["']/;
const CLASS_OR_MODULE = /^(?:class|module)\s+([A-Z][\w:]*)/;
const METHOD = /^def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/;

/** Ruby: `require`, classes and modules, method definitions. */
export const rubyProfile: LanguageProfile = {
  id: "ruby",
  extensions: [".rb", ".rake", ".gemspec"],
  summarize(_path, content) {
    const summary = emptySummary();

    eachLine(content, (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;

      const required = REQUIRE.exec(trimmed);
      if (required) {
        summary.imports.push(required[1]);
        return;
      }

      if (!isTopLevel(line)) return;

      const declaration = CLASS_OR_MODULE.exec(line);
      if (declaration) {
        summary.classes.push(declaration[1]);
        summary.exports.push(declaration[1]);
        return;
      }

      const method = METHOD.exec(line);
      if (method) {
        summary.functions.push(method[1]);
        summary.exports.push(method[1]);
      }
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
