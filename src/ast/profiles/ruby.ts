import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary, isTopLevel } from "./shared.js";

const REQUIRE_RELATIVE = /^require_relative\s+["']([^"']+)["']/;
const REQUIRE = /^require\s+["']([^"']+)["']/;
const CLASS_OR_MODULE = /^(?:class|module)\s+([A-Z][\w:]*)/;
const METHOD = /^def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/;

/** Ruby: `require`, `require_relative`, classes and modules, method definitions. */
export const rubyProfile: LanguageProfile = {
  id: "ruby",
  extensions: [".rb", ".rake", ".gemspec"],
  summarize(_path, content) {
    const summary = emptySummary();

    eachLine(content, (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;

      // The two forms are recorded differently on purpose: `require_relative "user"` is a path
      // beside this file, and `require "json"` is a gem. Recording both as the bare string they
      // were written with left the resolver unable to tell which was which, so it resolved
      // neither — and resolving a gem name as a path would invent an edge to any `json.rb` in the
      // repository.
      const relative = REQUIRE_RELATIVE.exec(trimmed);
      if (relative) {
        summary.imports.push(`./${relative[1]}`);
        return;
      }

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
