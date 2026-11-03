// S1 (01 §1 / C2) — reports/audit.md re-printed the raw source line of every
// detected secret. Old behaviour: `SecretFinding.snippet` held the untouched
// line and `generateAuditReport` rendered it into a Markdown table.
//
// Check: generate a snapshot of a repo containing 9 realistic secrets and grep
// EVERY emitted file for every secret value. The same grep is proven able to
// fail by asserting the values ARE present in the fixture sources.
import * as fs from "node:fs";
import * as path from "node:path";
import { generateSnapshot, resolveConfig } from "../../dist/index.js";
import {
  assert,
  assertIncludes,
  assertNotIncludes,
  check,
  finish,
  gitInit,
  readTree,
  selfTest,
  tmp,
  write,
} from "./v-lib.mjs";

selfTest();

const AWS_ID = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const MONGO = "mongodb://appuser:pa55w0rd@db.internal:27017/prod";
const OPENAI = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const NPM = "npm_9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c";
const GH = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
const SENDGRID = "SG.aBcDeFgHiJkLmNoPqRsTuV.WxYz0123456789ABCDEFGHIJKLMNOPQRSTUVWxyz012";
const FM = "frontmatter-Sup3rS3cret-xyz";
const ENVVAL = "env-Sup3rS3cret-abc123";
const KEY_BODY = [
  "MIIEowIBAAKCAQEAzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
  "PEMBODYSECRETLINE2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "PEMBODYSECRETLINE3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
];

const dir = tmp("s1");
const git = gitInit(dir);

write(
  dir,
  "src/aws.ts",
  `// ordinary source with a key on a shared line
export const awsKey = "${AWS_ID}"; export const region = "us-east-1"; const retries = 3;
`
);
write(dir, "config/creds.json", `{\n  "aws_secret_access_key": "${AWS_SECRET}",\n  "jwt": "${JWT}"\n}\n`);
write(dir, "src/db.ts", `export const url = "${MONGO}";\n`);
write(dir, "src/llm.ts", `export const key = "${OPENAI}";\nexport const sg = "${SENDGRID}";\n`);
write(dir, "src/gh.ts", `export const pat = "${GH}";\n`);
write(dir, "keys/id_rsa", `-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY.join("\n")}\n-----END RSA PRIVATE KEY-----\n`);
write(dir, ".npmrc", `//registry.npmjs.org/:_authToken=${NPM}\n`);
write(
  dir,
  "docs/infra.md",
  `# Infra\n\n## Prod database: ${MONGO}\n\n### Deploy key id: ${AWS_ID}\n\nBody text.\n`
);
write(dir, "docs/front.md", `---\ndb_password: "${FM}"\n---\n\n# Title\n`);
write(dir, "src/settings.ts", `export const apiKey = "${OPENAI}";\n`);
git.add(".");
git.commit();

const config = resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" });
const manifest = generateSnapshot(config);
const tree = readTree(path.join(dir, "snapshot"));
const all = Object.entries(tree)
  .map(([name, text]) => `\n<<<${name}>>>\n${text}`)
  .join("");
const files = Object.keys(tree);

check("S1.0", "fixture sources really contain the secrets (grep is able to fail)", () => {
  const sources = readTree(path.join(dir, "src"));
  assertIncludes(JSON.stringify(sources) + tree["config/creds.json"], AWS_ID, "fixture");
  return `${files.length} artifacts emitted`;
});

const NEEDLES = [
  ["aws access key id", AWS_ID],
  ["aws secret key", AWS_SECRET],
  ["jwt", JWT],
  ["mongo uri creds", MONGO],
  ["openai key", OPENAI],
  ["npm token", NPM],
  ["github pat", GH],
  ["sendgrid key", SENDGRID],
  ["frontmatter password", FM],
  ["pem body line 1", "MIIEowIBAAKCAQEAzzzz"],
  ["pem body line 2", "PEMBODYSECRETLINE2"],
  ["pem body line 3", "PEMBODYSECRETLINE3"],
];

for (const [label, needle] of NEEDLES) {
  check(`S1.${label.replace(/\s+/g, "-")}`, `no emitted artifact contains the ${label}`, () => {
    assertNotIncludes(all, needle, `leak of ${label}`);
    return "absent from all files";
  });
}

check("S1.audit-md", "reports/audit.md carries no source excerpt at all", () => {
  const audit = tree["reports/audit.md"];
  assert(audit, "reports/audit.md was not emitted");
  for (const marker of ["export const", "awsKey", "process.env", "const "]) {
    assert(!audit.includes(marker), `audit.md still contains source text: ${marker}`);
  }
  assertIncludes(audit, "| File | Line | Rule |", "audit report table header");
  return "only path/line/rule columns";
});

check("S1.findings", "the scan still reports the findings it redacted", () => {
  assert(manifest.warnings.length >= 8, `expected >=8 warning/findings, got ${manifest.warnings.length}`);
  assert(
    manifest.warnings.every((w) => !NEEDLES.some(([, needle]) => w.includes(needle))),
    "a manifest warning contains a secret value"
  );
  return `${manifest.warnings.length} findings, none carrying a value`;
});

check("S1.monolith", "full-codebase.json/.md are also clean (includeMonolith)", () => {
  const dir2 = tmp("s1m");
  write(dir2, "src/a.ts", `export const k = "${AWS_ID}";\n`);
  generateSnapshot(resolveConfig({ cwd: dir2, outDir: "snapshot", tmpDir: "snapshot.tmp", includeMonolith: true }));
  const t = readTree(path.join(dir2, "snapshot"));
  const body = Object.entries(t).map(([n, v]) => `\n<<<${n}>>>\n${v}`).join("");
  assertNotIncludes(body, AWS_ID, "monolith leak");
  assert(Object.keys(t).some((n) => n === "full-codebase.md"), "monolith md missing");
  return "monolith artifacts clean";
});

check("S1.env-sensitive", ".env is skipped by default (so its value cannot leak either)", () => {
  const dir3 = tmp("s1e");
  write(dir3, ".env", `DATABASE_PASSWORD=${ENVVAL}\n`);
  write(dir3, "src/a.ts", "export const a = 1;\n");
  generateSnapshot(resolveConfig({ cwd: dir3, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  const body = JSON.stringify(readTree(path.join(dir3, "snapshot")));
  assertNotIncludes(body, ENVVAL, "env leak");
  assert(fs.existsSync(path.join(dir3, ".env")), "fixture lost its .env");
  return ".env not emitted";
});

finish();
