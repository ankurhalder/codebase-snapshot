import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary } from "./shared.js";

const USING = /^using\s+([\w.]+)\s*;/;
const TYPE_DECL =
  /^\s*(?:public\s+|internal\s+|private\s+|protected\s+|sealed\s+|abstract\s+|static\s+|partial\s+|readonly\s+)*(class|interface|struct|record|enum)\s+([A-Za-z_]\w*)/;
const METHOD =
  /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?(?:virtual\s+|override\s+|sealed\s+)?[\w<>[\],?]+\s+([A-Za-z_]\w*)\s*[<(]/;

/** C#: `using` directives, type declarations and members with an access modifier. */
export const dotnetProfile: LanguageProfile = {
  id: "dotnet",
  extensions: [".cs"],
  summarize(_path, content) {
    const summary = emptySummary();

    eachLine(content, (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        return;
      }

      const used = USING.exec(trimmed);
      if (used) {
        summary.imports.push(used[1]);
        return;
      }

      const declaration = TYPE_DECL.exec(line);
      if (declaration) {
        const kind = declaration[1];
        const name = declaration[2];
        if (kind === "interface") summary.interfaces.push(name);
        else if (kind === "enum") summary.enums.push(name);
        else summary.classes.push(name);
        if (/^\s*public\b/.test(line)) summary.exports.push(name);
        return;
      }

      const method = METHOD.exec(line);
      if (method) {
        summary.functions.push(method[1]);
        if (/^\s*public\b/.test(line)) summary.exports.push(method[1]);
      }
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
