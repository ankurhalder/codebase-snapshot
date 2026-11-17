import { createHash } from "node:crypto";

/**
 * The owner-written half of the brief.
 *
 * A generated brief can state the job, the map and the standard; it cannot say what the software
 * is for, what has already gone wrong, or which failures this team would recognise. Those are
 * judgement, so they are supplied as a file and spliced in at fixed slots.
 *
 * The parse is deliberately strict: a heading the merge does not know is kept under "Owner
 * notes" rather than dropped, and a heading that redefines a *measured* section is refused,
 * because letting prose overwrite the coverage or the fingerprint would make the document lie.
 */

/** Headings the merge understands, in the order they appear in the rendered brief. */
export const OWNER_SECTIONS = ["Stakes", "The system", "What came before", "The bar", "Calibration"] as const;

/** Headings that are measured, so the brief may not redefine them. */
export const RESERVED_SECTIONS = [
  "The job",
  "What you have",
  "Coverage",
  "What a useful answer contains",
  "This snapshot",
  "Attaching this",
  "Your task",
] as const;

export interface OwnerBrief {
  /** Path as the user wrote it, for provenance in the rendered brief. */
  path: string;
  /** sha256 of the file as read, so changing it is configuration drift. */
  digest: string;
  /** The body of each recognised heading, when the file has one. */
  stakes?: string;
  system?: string;
  history?: string;
  bar?: string;
  calibration?: string;
  /** Everything the merge did not recognise, kept rather than dropped. */
  notes: Array<{ heading: string; body: string }>;
  /** Text before the first heading, when there is any. */
  preamble?: string;
}

/**
 * Parses the owner brief and reports what cannot be honoured.
 *
 * Problems are returned rather than thrown so the caller can decide: `resolveConfig` turns them
 * into a configuration error, which is what a mistyped heading deserves.
 */
export function parseOwnerBrief(
  filePath: string,
  text: string
): { brief: OwnerBrief; problems: string[] } {
  const problems: string[] = [];
  // A byte-order mark is not a heading: a brief saved by a Windows editor would otherwise
  // lose its first section and produce a snapshot that silently omitted it.
  // Comments are guidance, not content: the scaffold `init` writes is nothing but comments,
  // and an untouched one must render no section rather than an empty one with a provenance line.
  const source = text.replace(/^\uFEFF/, "").replace(/<!--[\s\S]*?-->/g, "");
  const preamble: string[] = [];
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } | null = null;
  // A fenced code block can contain anything, including a line that looks like a heading. The
  // first version parsed one as a real section: a brief that *showed* the format with a sample
  // "## Coverage" was refused for redefining a measured section that it never defined.
  let fence: { char: string; length: number } | null = null;
  for (const line of source.split(/\r?\n/)) {
    const fenceLine = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceLine) {
      const marker = fenceLine[1] as string;
      const char = marker[0] as string;
      if (fence === null) fence = { char, length: marker.length };
      else if (char === fence.char && marker.length >= fence.length) fence = null;
      if (current) current.body.push(line);
      else preamble.push(line);
      continue;
    }
    if (fence !== null) {
      if (current) current.body.push(line);
      else preamble.push(line);
      continue;
    }
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { heading: heading[1] as string, body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
    else preamble.push(line);
  }

  const recognised: Record<string, string> = {};
  const notes: Array<{ heading: string; body: string }> = [];
  // Headings are matched case-insensitively, so "## coverage" cannot smuggle prose past the
  // reservation, and a heading defined twice is ambiguous rather than last-wins.
  const canonical = (heading: string): string =>
    heading
      .trim()
      // "## Stakes:" is the same intent as "## Stakes"; treating it as an unknown heading sent
      // the owner stakes to Owner notes while the generic prose rendered in their place.
      .replace(/[:.]+$/, "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  const canonicalOwner = new Map(OWNER_SECTIONS.map((name) => [canonical(name), name]));
  const canonicalReserved = new Set(RESERVED_SECTIONS.map(canonical));
  const seen = new Set<string>();
  for (const section of sections) {
    const body = section.body.join("\n").trim();
    const key = canonical(section.heading);
    if (seen.has(key)) {
      problems.push(
        `the brief defines "${section.heading}" twice; a section cannot say two things.`
      );
      continue;
    }
    seen.add(key);
    if (canonicalReserved.has(key)) {
      problems.push(
        `the brief may not define "${section.heading}": that section is rendered from the manifest, ` +
          "and letting prose overwrite a measured section would make the document lie."
      );
      continue;
    }
    const ownerName = canonicalOwner.get(key);
    if (ownerName !== undefined) {
      // An empty section is a template someone has not filled in yet, not an assertion.
      if (body.length > 0) recognised[ownerName] = body;
      continue;
    }
    // Unknown headings are kept, not dropped: a brief is the owner's text, and silently
    // discarding a section would be the one thing this tool never does.
    notes.push({ heading: section.heading, body });
  }

  const preambleText = preamble.join("\n").trim();
  return {
    brief: {
      path: filePath,
      digest: createHash("sha256").update(text, "utf8").digest("hex"),
      ...(recognised["Stakes"] ? { stakes: recognised["Stakes"] } : {}),
      ...(recognised["The system"] ? { system: recognised["The system"] } : {}),
      ...(recognised["What came before"] ? { history: recognised["What came before"] } : {}),
      ...(recognised["The bar"] ? { bar: recognised["The bar"] } : {}),
      ...(recognised["Calibration"] ? { calibration: recognised["Calibration"] } : {}),
      notes,
      ...(preambleText.length > 0 ? { preamble: preambleText } : {}),
    },
    problems,
  };
}
