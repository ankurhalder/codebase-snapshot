import type { LanguageProfile } from "./shared.js";
import { eachLine, emptySummary, finalizeSummary } from "./shared.js";

/**
 * SQL: the objects a migration or schema file creates.
 *
 * A `.sql` file is not a program with functions in it, it is a set of definitions — so
 * tables and views are recorded as classes (the nouns of the schema), routines as functions,
 * and every created object as an export, because creating it is the file's whole effect.
 *
 * The match is case-insensitive: `create table`, `CREATE TABLE` and `Create Table` all occur
 * in the wild, and a schema dump is Windows-friendly about it.
 */
const CREATE =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|INDEX|TYPE|SCHEMA|TRIGGER|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"][\w."]*)/i;
const ALTER = /^\s*ALTER\s+(TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?([A-Za-z_"][\w."]*)/i;

/** Strips the parts of a qualified, quoted identifier: `public."Users"` → `Users`. */
function bareName(identifier: string): string {
  const last = identifier.split(".").pop() ?? identifier;
  return last.replace(/["`[\]]/g, "");
}

export const sqlProfile: LanguageProfile = {
  id: "sql",
  extensions: [".sql"],
  summarize(_path, content) {
    const summary = emptySummary();
    const seen = new Set<string>();

    /** Records a definition once, however many statements name it. */
    const declare = (kind: string, identifier: string): void => {
      const name = bareName(identifier);
      if (!name || seen.has(`${kind}:${name}`)) return;
      seen.add(`${kind}:${name}`);
      const normalized = kind.toUpperCase().replace(/\s+/g, " ");
      if (normalized === "TABLE" || normalized.endsWith("VIEW")) summary.classes.push(name);
      else if (normalized === "TYPE" || normalized === "SCHEMA" || normalized === "SEQUENCE") {
        summary.types.push(name);
      } else summary.functions.push(name);
      summary.exports.push(name);
    };

    eachLine(content, (line) => {
      const trimmed = line.trim();
      // `--` is the line comment; a block comment is rare enough in a definitions file that
      // treating its contents as statements would do more harm than ignoring it.
      if (!trimmed || trimmed.startsWith("--")) return;

      const created = CREATE.exec(trimmed);
      if (created) {
        declare(String(created[1]), String(created[2]));
        return;
      }
      // A second migration that alters an existing table is where the definition now lives,
      // so an ALTER names the same object the CREATE would have.
      const altered = ALTER.exec(trimmed);
      if (altered) declare(String(altered[1]), String(altered[2]));
    });

    return { summary: finalizeSummary(summary), quality: "heuristic" };
  },
};
