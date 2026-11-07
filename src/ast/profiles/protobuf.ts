import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary } from "./shared.js";

/**
 * Protocol Buffers: messages, enums, services and their RPCs.
 *
 * A `.proto` file is an interface definition, so `message` lands in `classes`, `service` in
 * `interfaces` and each `rpc` in `functions` — the same mapping a `.d.ts` gets, which is what
 * lets an agent read a service and its TypeScript client as the same shape.
 *
 * Fields are deliberately not collected: a message with forty fields would bury the
 * structure the summary exists to show, and the body is in the part anyway.
 */
const DECLARATION = /^(?:message|enum|service|extend)\s+([A-Za-z_]\w*)/;
const RPC = /^\s*rpc\s+([A-Za-z_]\w*)/;
const IMPORT = /^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"/;
const PACKAGE = /^\s*package\s+([\w.]+)\s*;/;

export const protobufProfile: LanguageProfile = {
  id: "protobuf",
  extensions: [".proto"],
  summarize(_path, content) {
    const summary = emptySummary();

    eachLine(content, (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) return;

      const imported = IMPORT.exec(line);
      if (imported) {
        summary.imports.push(imported[1]);
        return;
      }

      const pkg = PACKAGE.exec(line);
      if (pkg) {
        summary.directives.push(`package ${pkg[1]}`);
        return;
      }

      const rpc = RPC.exec(line);
      if (rpc) {
        const name = (rpc as RegExpExecArray & [string, string])[1];
        summary.functions.push(name);
        return;
      }

      const declaration = DECLARATION.exec(trimmed);
      if (!declaration) return;
      const name = (declaration as RegExpExecArray & [string, string])[1];
      const keyword = /^\w+/.exec(trimmed)?.[0] ?? "";
      if (keyword === "service") summary.interfaces.push(name);
      else if (keyword === "enum") summary.enums.push(name);
      else summary.classes.push(name);
      summary.exports.push(name);
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
