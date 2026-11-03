import type { LanguageProfile } from "./shared.js";
import {
  eachLine,
  emptySummary,
  finalizeSummary,
  isCapitalizedName,
  isTopLevel,
} from "./shared.js";

const FUNC = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/;
const TYPE = /^type\s+([A-Za-z_]\w*)\s+(.*)$/;
const VAR_CONST = /^(?:var|const)\s+([A-Za-z_]\w*)/;
const IMPORT_SINGLE = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/;
const IMPORT_OPEN = /^import\s*\(/;
const IMPORT_ENTRY = /^\s*(?:[\w.]+\s+)?"([^"]+)"/;

/**
 * Go: imports (single and block form), functions and methods, type
 * declarations, package-level var/const.
 *
 * A capitalised identifier is exported, which is the whole visibility model.
 */
export const goProfile: LanguageProfile = {
  id: "go",
  extensions: [".go"],
  summarize(_path, content) {
    const summary = emptySummary();
    let inImportBlock = false;

    eachLine(content, (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) return;

      if (inImportBlock) {
        if (trimmed.startsWith(")")) {
          inImportBlock = false;
          return;
        }
        const entry = IMPORT_ENTRY.exec(line);
        if (entry) summary.imports.push(entry[1]);
        return;
      }

      if (IMPORT_OPEN.test(trimmed)) {
        inImportBlock = true;
        return;
      }

      const single = IMPORT_SINGLE.exec(trimmed);
      if (single) {
        summary.imports.push(single[1]);
        return;
      }

      if (!isTopLevel(line)) return;

      const method = FUNC.exec(line);
      if (method) {
        const name = method[1];
        summary.functions.push(name);
        if (isCapitalizedName(name)) summary.exports.push(name);
        return;
      }

      const declared = TYPE.exec(line);
      if (declared) {
        const name = declared[1];
        const body = declared[2].trim();
        if (body.startsWith("struct")) summary.classes.push(name);
        else if (body.startsWith("interface")) summary.interfaces.push(name);
        else summary.types.push(name);
        if (isCapitalizedName(name)) summary.exports.push(name);
        return;
      }

      const value = VAR_CONST.exec(line);
      if (value) {
        summary.variables.push(value[1]);
        if (isCapitalizedName(value[1])) summary.exports.push(value[1]);
      }
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
