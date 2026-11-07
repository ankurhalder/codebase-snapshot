import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary, isPublicName, isTopLevel } from "./shared.js";

/**
 * Swift: types, functions, properties and imports.
 *
 * The declaration keywords are usually preceded by modifiers (`public final class`,
 * `fileprivate struct`, `@objc protocol`), so the pattern consumes any run of attribute and
 * modifier words before the keyword. `protocol` is Swift's interface, and `actor` is a
 * concurrency-constrained class — both are classes to a reader who wants an outline.
 *
 * Visibility is explicit in Swift: only `public` and `open` leave the module, so only those
 * are recorded as exports. A `internal` (the default) declaration is not an export and
 * saying it is would make the index lie about the API.
 */
/**
 * Declaration modifiers, including attributes with arguments (`@available(iOS 15, *)`).
 *
 * `class` is deliberately *not* in this list even though `class func` exists: consuming it as
 * a modifier made `public final class Cache` parse as "modifiers, then a declaration starting
 * at `Cache`", so every type declaration in the language was missed.
 */
const MODIFIERS =
  "(?:@\\w+(?:\\([^)]*\\))?\\s+|(?:public|open|internal|fileprivate|private|final|static|mutating|nonmutating|override|required|convenience|lazy|weak|unowned)\\s+)*";

const TYPE = new RegExp(`^${MODIFIERS}(class|struct|enum|protocol|actor|extension)\\s+([A-Za-z_]\\w*)`);
const FUNC = new RegExp(`^${MODIFIERS}func\\s+([A-Za-z_]\\w*)`);
const PROPERTY = new RegExp(`^${MODIFIERS}(?:let|var)\\s+([A-Za-z_]\\w*)`);
const IMPORT = /^import\s+([A-Za-z_][\w.]*)/;

export const swiftProfile: LanguageProfile = {
  id: "swift",
  extensions: [".swift"],
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

      if (!isTopLevel(line)) return;
      // `public`/`open` is what makes a declaration part of the module's API.
      const exported = /\b(?:public|open)\b/.test(trimmed);

      const type = TYPE.exec(trimmed);
      if (type) {
        const [, keyword, name] = type as RegExpExecArray & [string, string, string];
        if (keyword === "protocol") summary.interfaces.push(name);
        else if (keyword === "enum") summary.enums.push(name);
        else if (keyword === "extension") summary.types.push(name);
        else summary.classes.push(name);
        if (exported) summary.exports.push(name);
        return;
      }

      const func = FUNC.exec(trimmed);
      if (func) {
        const name = (func as RegExpExecArray & [string, string])[1];
        summary.functions.push(name);
        if (exported) summary.exports.push(name);
        return;
      }

      const property = PROPERTY.exec(trimmed);
      if (property) {
        const name = (property as RegExpExecArray & [string, string])[1];
        summary.variables.push(name);
        if (exported && isPublicName(name)) summary.exports.push(name);
      }
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
