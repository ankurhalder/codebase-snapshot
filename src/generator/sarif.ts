/**
 * SARIF 2.1.0, so a redacted secret becomes a finding a CI gate can see.
 *
 * `reports/audit.md` tells a human what was masked. Nothing could *gate* on it: a CI job that
 * wanted to fail a build over a leaked key had to scrape markdown, and an uploaded finding had
 * to be re-derived by whatever security scanner the repository already ran. SARIF is the format
 * GitHub Code Scanning reads, so the same facts go straight into a code-scanning alert.
 *
 * The findings are the redaction events this run produced — one per line, with the rule names
 * that matched. The line content is deliberately **not** included: this artifact is meant to be
 * uploaded to a third party, and quoting the matched span would be a second copy of the secret
 * in a place with a different retention policy. A code-scanning alert with a path and a line
 * number is enough to act on.
 */
import type { Manifest, SecretFinding, SecretRule } from "../types.js";

/** SARIF's document version and schema. */
const SARIF_VERSION = "2.1.0";
const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

/**
 * Rule identifiers: `CS001`-style, stable across runs.
 *
 * A rule id that changed between versions would orphan every open alert that referenced it, so
 * these are derived from the rule's *name* by ordering the names once. A custom rule from the
 * user's config gets an id from its own name, hashed, so it stays stable without depending on
 * the order rules happen to be in.
 */
function ruleIdFor(name: string, seen: Map<string, string>): string {
  const existing = seen.get(name);
  if (existing !== undefined) return existing;
  const id = `CS${String(seen.size + 1).padStart(3, "0")}`;
  seen.set(name, id);
  return id;
}

/**
 * Renders the findings as a SARIF log.
 *
 * Every result carries the file and line, a `level` of `note` — a redaction is the tool doing
 * its job, not a build failure — and the rule that matched. `partialFingerprints` gives Code
 * Scanning a stable identity for an alert across commits, built from the path, the rules and
 * the line, so re-running `generate` does not close and reopen every alert.
 */
export function generateSarifReport(
  manifest: Manifest,
  findings: readonly SecretFinding[],
  rules: readonly SecretRule[],
  toolVersion: string
): string {
  const ids = new Map<string, string>();
  // The rule catalogue comes from the rules the run actually used, in a stable order, so the
  // same configuration always produces the same document.
  const ruleNames = Array.from(
    new Set([...rules.map((rule) => rule.rule), ...findings.flatMap((finding) => finding.rules)])
  ).sort();

  const ruleIndex = new Map<string, number>();
  const sarifRules = ruleNames.map((name, index) => {
    ruleIndex.set(name, index);
    const id = ruleIdFor(name, ids);
    return {
      id,
      name,
      shortDescription: { text: `Credential-shaped value masked by the "${name}" rule` },
      defaultConfiguration: { level: "note" },
      help: {
        text:
          "A value in this line matched a secret pattern and was replaced with a redaction " +
          "marker in the snapshot. If this is a real credential, rotate it; if it is a fixture, " +
          "the placeholder can be made unmistakable.",
      },
    };
  });

  const results = findings
    .filter((finding) => typeof finding.path === "string" && finding.path.length > 0)
    .map((finding) => {
      const primary = finding.rules[0] ?? "unknown";
      const line = Math.max(1, finding.line);
      const findingPath = String(finding.path).replace(/\\/g, "/");
      return {
        ruleId: ruleIdFor(primary, ids),
        ruleIndex: ruleIndex.get(primary) ?? 0,
        level: "note" as const,
        message: {
          text: `Credential-shaped value masked (rule${finding.rules.length === 1 ? "" : "s"}: ${finding.rules.join(", ")})`,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: findingPath, uriBaseId: "%SRCROOT%" },
              region: { startLine: line },
            },
          },
        ],
        partialFingerprints: {
          // Stable across commits for the same finding, which is what keeps an alert open
          // instead of closing and reopening it on every run.
          codebaseSnapshotFinding: `${findingPath}#L${line}#${finding.rules.join("+")}`,
        },
      };
    })
    .sort(
      (a, b) =>
        a.locations[0].physicalLocation.artifactLocation.uri.localeCompare(
          b.locations[0].physicalLocation.artifactLocation.uri
        ) || a.locations[0].physicalLocation.region.startLine - b.locations[0].physicalLocation.region.startLine
    );

  const log = {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: "codebase-snapshot",
            version: toolVersion,
            informationUri: "https://github.com/ankurhalder/codebase-snapshot",
            rules: sarifRules,
          },
        },
        automationDetails: {
          // The snapshot's own fingerprint: two uploads of the same snapshot are the same run,
          // so Code Scanning can tell an unchanged upload from a new one.
          id: `codebase-snapshot/${manifest.fingerprint}`,
        },
        originalUriBaseIds: { "%SRCROOT%": { uri: "file:///" } },
        results,
      },
    ],
  };

  return `${JSON.stringify(log, null, 2)}\n`;
}
