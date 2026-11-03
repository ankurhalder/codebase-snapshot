import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary } from "./shared.js";

const IMPORT = /^import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?;?\s*$/;
const TYPE_DECL =
  /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:final\s+|abstract\s+|open\s+|sealed\s+|data\s+|static\s+|partial\s+)*(class|interface|enum|record|object|trait)\s+(?:class\s+)?([A-Za-z_]\w*)/;
const KOTLIN_FUN =
  /^\s*(?:public\s+|private\s+|protected\s+|internal\s+|override\s+|suspend\s+|inline\s+|open\s+|operator\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/;
const SCALA_DEF = /^\s*def\s+([A-Za-z_]\w*)/;
/** A Java method needs an explicit access modifier; that keeps `if (…)` out. */
const JAVA_METHOD =
  /^\s+(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:abstract\s+)?[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\(/;

/**
 * Java, Kotlin and Scala share enough surface to live in one profile.
 *
 * Visibility differs, so each declaration is judged on its own line: Java needs
 * `public`, Kotlin and Scala are public unless marked private/internal.
 */
export const jvmProfile: LanguageProfile = {
  id: "jvm",
  extensions: [".java", ".kt", ".kts", ".scala"],
  summarize(path, content) {
    const summary = emptySummary();
    const lower = path.toLowerCase();
    const isJava = lower.endsWith(".java");
    const isKotlin = lower.endsWith(".kt") || lower.endsWith(".kts");

    eachLine(content, (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        return;
      }

      const imported = IMPORT.exec(trimmed);
      if (imported) {
        summary.imports.push(imported[1]);
        return;
      }

      const declaration = TYPE_DECL.exec(line);
      if (declaration) {
        const kind = declaration[1];
        const name = declaration[2];
        if (kind === "interface" || kind === "trait") summary.interfaces.push(name);
        else if (kind === "enum") summary.enums.push(name);
        else summary.classes.push(name);

        const hidden = /^\s*(?:private|protected|internal)\b/.test(line);
        if (isJava ? /^\s*public\b/.test(line) : !hidden) summary.exports.push(name);
        return;
      }

      const kotlinFunction = KOTLIN_FUN.exec(line);
      if (kotlinFunction && isKotlin) {
        summary.functions.push(kotlinFunction[1]);
        const hidden = /^\s*(?:private|protected|internal)\b/.test(line);
        if (!hidden) summary.exports.push(kotlinFunction[1]);
        return;
      }

      const scalaFunction = SCALA_DEF.exec(line);
      if (scalaFunction && !isJava && !isKotlin) {
        summary.functions.push(scalaFunction[1]);
        const hidden = /^\s*(?:private|protected)\b/.test(line);
        if (!hidden) summary.exports.push(scalaFunction[1]);
        return;
      }

      if (isJava) {
        const method = JAVA_METHOD.exec(line);
        if (method) {
          summary.functions.push(method[1]);
          if (/^\s*public\b/.test(line)) summary.exports.push(method[1]);
        }
      }
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
