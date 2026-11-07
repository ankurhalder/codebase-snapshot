import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary, isPublicName, isTopLevel } from "./shared.js";

/**
 * Dart and Flutter: types, mixins, extensions, top-level functions and imports.
 *
 * Dart privacy is the leading underscore, the same rule as Python and Ruby, so
 * `isPublicName` is the export test — a `_private` class belongs to its library, not to the
 * package.
 *
 * `part of` / `part` are recorded as directives: they are how a Flutter codebase splits one
 * library across files, and an outline that omits them makes the split invisible.
 */
const IMPORT = /^import\s+['"]([^'"]+)['"]/;
const PART = /^part(?:\s+of)?\s+['"]?([\w./]+)['"]?/;
const TYPE = /^(?:abstract\s+|base\s+|final\s+|sealed\s+|interface\s+)*(class|mixin|enum|extension|typedef)\s+([A-Za-z_]\w*)/;
const FUNC =
  /^(?:Future<[^>]*>|Stream<[^>]*>|void|bool|int|double|num|String|dynamic|var|[A-Z][\w<>, ?]*)\s+([A-Za-z_]\w*)\s*[(<]/;
/**
 * A top-level declaration, with an optional explicit type.
 *
 * `const int maxEntries = 10` is the ordinary Dart spelling, and a pattern that captured the
 * first word after the keyword recorded the *type* as the variable's name — `int` became a
 * symbol in the manifest. The `=` is what distinguishes a declaration from a call or a
 * control statement, so it is required.
 */
const VARIABLE =
  /^(?:late\s+)?(?:final|const|var)\s+(?:[\w<>?,. ]+?\s+)?([A-Za-z_]\w*)\s*=/;

export const dartProfile: LanguageProfile = {
  id: "dart",
  extensions: [".dart"],
  summarize(_path, content) {
    const summary = emptySummary();

    eachLine(content, (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) return;

      const imported = IMPORT.exec(trimmed);
      if (imported) {
        summary.imports.push(imported[1]);
        return;
      }
      if (/^part\b/.test(trimmed)) {
        const part = PART.exec(trimmed);
        summary.directives.push(part ? `part ${part[1]}` : "part");
        return;
      }

      if (!isTopLevel(line)) return;

      const type = TYPE.exec(trimmed);
      if (type) {
        const [, keyword, name] = type as RegExpExecArray & [string, string, string];
        if (keyword === "mixin" || keyword === "extension") summary.types.push(name);
        else if (keyword === "enum") summary.enums.push(name);
        else if (keyword === "typedef") summary.types.push(name);
        else summary.classes.push(name);
        if (isPublicName(name)) summary.exports.push(name);
        return;
      }

      const func = FUNC.exec(trimmed);
      if (func) {
        const name = (func as RegExpExecArray & [string, string])[1];
        summary.functions.push(name);
        if (isPublicName(name)) summary.exports.push(name);
        return;
      }

      const variable = VARIABLE.exec(trimmed);
      if (variable) {
        const name = (variable as RegExpExecArray & [string, string])[1];
        summary.variables.push(name);
        if (isPublicName(name)) summary.exports.push(name);
      }
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
