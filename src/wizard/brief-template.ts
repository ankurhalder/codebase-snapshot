/**
 * The file `init` writes for the half of the brief only the owner can write.
 *
 * It is all comments on purpose: the parser strips them, so an untouched scaffold renders no
 * section at all, and filling one heading in turns that section on. A scaffold with placeholder
 * prose would print a placeholder into every model's instructions until someone deleted it.
 */
export const BRIEF_SCAFFOLD_FILE = "BRIEF.md";

export const BRIEF_SCAFFOLD = [
  "<!-- BRIEF.md — the half of PROMPT.md only you can write.",
  "",
  "     `snapshot generate` writes the facts: which files are here, which were skipped and why,",
  "     the system map, the history, the standard, the coverage. It cannot know what the software",
  "     is for, what has already gone wrong, or which failures this team would recognise.",
  "     That is judgement, so it lives here.",
  "",
  "     Five headings are merged into PROMPT.md:",
  "       ## Stakes            what breaks if this is wrong, and who carries it",
  "       ## The system        how the pieces fit, in your words",
  "       ## What came before  the rounds you have already run, and what they cost",
  "       ## The bar           what a finding has to do to be believed here",
  "       ## Calibration       failures from your own history, one line each",
  "",
  "     Any other `##` heading is kept under Owner notes. A measured heading (Coverage,",
  "     This snapshot, ...) is refused, because prose must not overwrite a measurement.",
  "     Leave a section empty and it is simply not rendered. The file is capped at 64 KiB.",
  " -->",
  "",
  "## Stakes",
  "",
  "<!-- What breaks if this is wrong? Who carries the consequence? One paragraph. -->",
  "",
  "## The system",
  "",
  "<!-- How the pieces fit: the boundaries, the protocol between them, the rule that holds it",
  "     together. The generated brief adds the file counts, importers and entry points beside",
  "     this, under \"What the index records\". -->",
  "",
  "## What came before",
  "",
  "<!-- The rounds already run: what was found, what was fixed, what keeps coming back. -->",
  "",
  "## The bar",
  "",
  "<!-- What a finding must do to be believed here: the lines, the state that reaches them, the",
  "     test that would have caught it. Drop this section to keep the built-in standard. -->",
  "",
  "## Calibration",
  "",
  "<!-- Two or three real failures, one line each, in the shape you want them reported:",
  "       - a grant signed for one recipe executing another recipe's deletions",
  "       - a recipe that never worked, because its test supplied a number where the daemon sends a string",
  " -->",
  ""
].join("\n");
