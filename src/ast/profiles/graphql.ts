import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary, isTopLevel } from "./shared.js";

/**
 * GraphQL schema and operation files.
 *
 * Schema definitions are types; `query`/`mutation`/`subscription` in an operation file are
 * endpoints, so they are recorded as `routeHandlers` — the same bucket a REST route lands in,
 * which is what makes "where is this endpoint handled?" answerable across both.
 *
 * A definition is matched at any indentation because a schema is commonly written inside
 * `extend type` blocks and a `type` may appear nested in an SDL string; an operation name is
 * top-level by grammar.
 */
const DEFINITION = /^(?:extend\s+)?(type|interface|input|enum|union|scalar|schema)\s+([A-Za-z_]\w*)/;
const OPERATION = /^(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/;
const DIRECTIVE = /^directive\s+@([A-Za-z_]\w*)/;
const IMPORT = /^#import\s+"([^"]+)"/;

export const graphqlProfile: LanguageProfile = {
  id: "graphql",
  extensions: [".graphql", ".gql"],
  summarize(_path, content) {
    const summary = emptySummary();

    eachLine(content, (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") && !IMPORT.test(trimmed)) return;

      const imported = IMPORT.exec(trimmed);
      if (imported) {
        summary.imports.push(imported[1]);
        return;
      }

      const directive = DIRECTIVE.exec(trimmed);
      if (directive) {
        summary.functions.push(`@${directive[1]}`);
        return;
      }

      const definition = DEFINITION.exec(trimmed);
      if (definition) {
        const [, keyword, name] = definition as RegExpExecArray & [string, string, string];
        if (keyword === "interface") summary.interfaces.push(name);
        else if (keyword === "enum") summary.enums.push(name);
        else if (keyword === "input" || keyword === "scalar" || keyword === "union") {
          summary.types.push(name);
        } else summary.classes.push(name);
        summary.exports.push(name);
        return;
      }

      if (!isTopLevel(line)) return;
      const operation = OPERATION.exec(trimmed);
      if (operation) {
        const name = (operation as RegExpExecArray & [string, string])[1];
        summary.functions.push(name);
        summary.routeHandlers.push(name);
      }
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
