// S6 (01 §6) — AST/structured summaries were computed from RAW content, so a
// secret in a Markdown heading was redacted in the body but emitted verbatim in
// parts/*.md and manifest.json. Check: the summary must be built from the
// redacted text (the heading survives, the secret does not).
import * as path from "node:path";
import { generateSnapshot, resolveConfig } from "../../dist/index.js";
import {
  assert,
  assertEqual,
  assertNotIncludes,
  check,
  finish,
  readTree,
  selfTest,
  tmp,
  write,
} from "./v-lib.mjs";

selfTest();

const MONGO = "mongodb://appuser:pa55w0rd@db.internal:27017/prod";
const AWS = "AKIAIOSFODNN7EXAMPLE";
const dir = tmp("s6");
write(dir, ".gitignore", "snapshot/\n");
write(
  dir,
  "docs/infra.md",
  `# Infra\n\n## Prod database: ${MONGO}\n\n### Deploy key id: ${AWS}\n\nBody mentions ${MONGO} too.\n`
);
write(dir, "docs/front.md", `---\ntitle: hello\ndb_password: "SuperSecretFrontmatter"\n---\n\n# Title\n`);
const manifest = generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
const tree = readTree(path.join(dir, "snapshot"));
const all = JSON.stringify(tree);

check("S6.manifest-summary", "manifest summaries carry no secret", () => {
  assertNotIncludes(all, MONGO, "manifest/parts leak (mongo)");
  assertNotIncludes(all, AWS, "manifest/parts leak (aws)");
  assertNotIncludes(all, "SuperSecretFrontmatter", "manifest leak (frontmatter)");
  return "absent from every emitted artifact";
});

check("S6.summary-shape", "the summary still describes the document, from redacted text", () => {
  const infra = manifest.files.find((file) => file.relativePath === "docs/infra.md");
  assert(infra && infra.summary, "no Markdown summary");
  const headings = infra.summary.headings.join("\n");
  assert(headings.includes("# Infra"), `heading list lost the safe heading: ${headings}`);
  assert(headings.includes("REDACTED"), `heading text was not redacted: ${headings}`);
  assertNotIncludes(headings, MONGO, "heading summary");
  assert(!headings.includes("Deploy key id: AKIA"), "AWS id survived in a heading");
  return `${infra.summary.headings.length} headings, secrets replaced by the marker`;
});

check("S6.frontmatter", "frontmatter values are not emitted; ordinary keys survive", () => {
  const front = manifest.files.find((file) => file.relativePath === "docs/front.md");
  assert(front && front.summary, "no summary");
  const keys = front.summary.frontmatterKeys;
  assert(keys.includes("title"), `ordinary frontmatter key lost: ${JSON.stringify(keys)}`);
  // The secret-bearing line is redacted before summarisation, which also erases
  // the key name on that line — recorded here, not treated as a leak.
  console.log(
    `    OBS S6: frontmatterKeys=${JSON.stringify(keys)} (db_password name lost with its redacted value)`
  );
  assertNotIncludes(JSON.stringify(front.summary), "SuperSecretFrontmatter", "summary value leak");
  return `keys=${keys.join(",")}`;
});

check("S6.body", "the emitted body is redacted too (control)", () => {
  assertEqual(tree["parts/part-001.md"].includes("REDACTED"), true, "no redaction marker in the part");
  return "marker present";
});

finish();
