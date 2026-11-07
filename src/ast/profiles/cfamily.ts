import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary, isTopLevel } from "./shared.js";

const INCLUDE = /^#\s*include\s*([<"])([^>"]+)[>"]/;
const DEFINE = /^#\s*define\s+([A-Za-z_]\w*)/;
const USING = /^using\s+(?:namespace\s+)?([\w:]+)\s*;/;
const TYPE_DECL = /^(?:typedef\s+)?(?:struct|union|class|enum)\s+([A-Za-z_]\w*)/;
const TYPEDEF = /^typedef\b[^;{}]*?\b([A-Za-z_]\w*)\s*;/;
const FUNCTION = /^[A-Za-z_][\w \t*&:<>,]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/;
const NOT_A_FUNCTION = /^(?:if|for|while|switch|return|else|do|case|sizeof|catch|throw)\b/;

/**
 * C and C++: `#include`, `using`, type definitions, and function definitions.
 *
 * A function definition is recognised as a top-level line whose parameter list
 * closes at end of line and is followed by `{` — control-flow keywords are
 * excluded explicitly, because `if (x) {` looks identical otherwise.
 */
export const cfamilyProfile: LanguageProfile = {
  id: "cfamily",
  extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".m", ".mm"],
  summarize(_path, content) {
    const summary = emptySummary();

    eachLine(content, (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        return;
      }

      const included = INCLUDE.exec(trimmed);
      if (included) {
        // `#include "board.h"` is a header in this repository; `#include <stdio.h>` is a system
        // one. The two are recorded differently so the resolver can tell them apart — the quoted
        // form gets a `./` prefix, which is also how the local form is searched first.
        summary.imports.push(included[1] === '"' ? `./${included[2]}` : included[2]);
        return;
      }

      const used = USING.exec(trimmed);
      if (used) {
        summary.imports.push(used[1]);
        return;
      }

      const macro = DEFINE.exec(trimmed);
      if (macro) {
        summary.variables.push(macro[1]);
        return;
      }

      if (!isTopLevel(line)) return;

      const declared = TYPE_DECL.exec(line);
      if (declared) {
        const kind = /^typedef\s+enum/.test(line) || /^enum\b/.test(trimmed) ? "enum" : "type";
        if (kind === "enum") summary.enums.push(declared[1]);
        else summary.classes.push(declared[1]);
        summary.exports.push(declared[1]);
        return;
      }

      const aliased = TYPEDEF.exec(line);
      if (aliased) {
        summary.types.push(aliased[1]);
        summary.exports.push(aliased[1]);
        return;
      }

      if (NOT_A_FUNCTION.test(trimmed)) return;

      const fn = FUNCTION.exec(line);
      if (fn) {
        summary.functions.push(fn[1]);
        summary.exports.push(fn[1]);
      }
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
