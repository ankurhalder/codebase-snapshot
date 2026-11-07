import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary, isPublicName, isTopLevel } from "./shared.js";

const IMPORT = /^import\s+(.+)$/;
const FROM_IMPORT = /^from\s+([\w.]+)\s+import\s+(.+)$/;
const CLASS = /^class\s+([A-Za-z_]\w*)/;
const DEF = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const CONSTANT = /^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/;
const ALL_DUNDER = /^__all__\s*=\s*\[([^\]]*)\]/;
/** `@app.get(...)`, `@router.post(...)`, `@bp.route(...)` — web handler decorators. */
const ROUTE_DECORATOR = /^\s*@[\w.]*\b(?:get|post|put|patch|delete|head|options|route)\s*\(/i;

/**
 * Python: imports, top-level classes and functions, module constants and
 * `__all__`.
 *
 * Only top-level declarations are recorded — a method inside a class is not a
 * module export, and pretending otherwise would fill `exports` with noise.
 */
export const pythonProfile: LanguageProfile = {
  id: "python",
  extensions: [".py", ".pyi"],
  summarize(_path, content) {
    const summary = emptySummary();
    let routePending = false;

    eachLine(content, (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;

      if (ROUTE_DECORATOR.test(line)) {
        routePending = true;
        return;
      }

      const from = FROM_IMPORT.exec(trimmed);
      if (from) {
        const module = from[1];
        // `from . import models` is the same edge as `from .models import …` — the module is the
        // name, and the leading dots are the package. Recording it as the bare `.` lost the edge:
        // the resolver had a package directory and no module in it. Only the name list form (which
        // the module path cannot spell) is expanded, and each name is its own edge because a
        // package's `__init__` and each submodule are separate files.
        if (/^\.+$/.test(module)) {
          for (const name of from[2].split(",")) {
            const imported = name.replace(/[()]/g, "").trim().split(/\s+as\s+/)[0].trim();
            if (/^[A-Za-z_]\w*$/.test(imported)) summary.imports.push(`${module}${imported}`);
          }
        } else {
          summary.imports.push(module);
        }
        routePending = false;
        return;
      }

      const imported = IMPORT.exec(trimmed);
      if (imported) {
        for (const part of imported[1].split(",")) {
          const name = part.trim().split(/\s+as\s+/)[0].trim();
          if (name) summary.imports.push(name);
        }
        routePending = false;
        return;
      }

      if (isTopLevel(line)) {
        const klass = CLASS.exec(line);
        if (klass) {
          summary.classes.push(klass[1]);
          if (isPublicName(klass[1])) summary.exports.push(klass[1]);
          routePending = false;
          return;
        }

        const definition = DEF.exec(line);
        if (definition) {
          const name = definition[1];
          summary.functions.push(name);
          if (routePending) {
            summary.routeHandlers.push(name);
            routePending = false;
          }
          if (isPublicName(name)) summary.exports.push(name);
          return;
        }

        const all = ALL_DUNDER.exec(trimmed);
        if (all) {
          for (const entry of all[1].split(",")) {
            const name = entry.trim().replace(/['"]/g, "").trim();
            if (name) summary.exports.push(name);
          }
          return;
        }

        const constant = CONSTANT.exec(line);
        if (constant) summary.variables.push(constant[1]);
      }
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
