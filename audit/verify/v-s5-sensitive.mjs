// S5 (01 §5 / H1) — no deny list for credential-bearing files: `.npmrc`,
// `.git-credentials`, `id_rsa`, `*.pem` were collected and emitted verbatim in
// every git layout. Checked in the git path, the no-git walk fallback, the
// `.env` variants, the template allowlist and the includeSensitiveFiles opt-in.
import * as fs from "node:fs";
import * as path from "node:path";
import { collectFiles, generateSnapshot, isSensitivePath, resolveConfig } from "../../dist/index.js";
import {
  assert,
  assertEqual,
  check,
  finish,
  gitInit,
  readTree,
  selfTest,
  tmp,
  write,
} from "./v-lib.mjs";

selfTest();

const MARKER = "SENSITIVE_FILE_MARKER_9x8y7z";
const SECRET_FILES = {
  ".env": `DATABASE_PASSWORD=${MARKER}\n`,
  ".npmrc": `//registry.npmjs.org/:_authToken=${MARKER}\n`,
  ".git-credentials": `https://user:${MARKER}@github.com\n`,
  "id_rsa": `-----BEGIN RSA PRIVATE KEY-----\n${MARKER}\n-----END RSA PRIVATE KEY-----\n`,
  "keys/id_ed25519": `-----BEGIN OPENSSH PRIVATE KEY-----\n${MARKER}\n-----END OPENSSH PRIVATE KEY-----\n`,
  "certs/server.pem": `-----BEGIN CERTIFICATE-----\n${MARKER}\n-----END CERTIFICATE-----\n`,
  "certs/server.key": `${MARKER}\n`,
  ".aws/credentials": `[default]\naws_secret_access_key = ${MARKER}\n`,
  ".docker/config.json": `{"auths":{"r.io":{"auth":"${MARKER}"}}}\n`,
  ".htpasswd": `admin:${MARKER}\n`,
  ".netrc": `machine github.com password ${MARKER}\n`,
  ".pgpass": `localhost:5432:db:user:${MARKER}\n`,
  "deploy.pfx": MARKER,
  "state.tfstate": `{"secret":"${MARKER}"}\n`,
};
const TEMPLATE_FILES = {
  ".env.example": `DATABASE_PASSWORD=changeme\n`,
  ".env.sample": `DATABASE_PASSWORD=changeme\n`,
  ".env.template": `DATABASE_PASSWORD=changeme\n`,
};

function fixture(name, { git = true } = {}) {
  const dir = tmp(name);
  for (const [rel, body] of Object.entries({ ...SECRET_FILES, ...TEMPLATE_FILES })) {
    write(dir, rel, body);
  }
  write(dir, "src/app.ts", "export const a = 1;\n");
  if (git) {
    const g = gitInit(dir);
    g.add("-f", ".");
    g.commit();
  }
  return dir;
}

function snapshotBody(dir) {
  return JSON.stringify(readTree(path.join(dir, "snapshot")));
}

check("S5.git-path", "every credential file is skipped with reason sensitive-file (git layout)", () => {
  const dir = fixture("s5g");
  const manifest = generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  const body = snapshotBody(dir);
  const skipped = new Map(manifest.skipped.map((entry) => [entry.path, entry.reason]));
  const missing = [];
  const leaked = [];
  for (const rel of Object.keys(SECRET_FILES)) {
    if (skipped.get(rel) !== "sensitive-file") missing.push(`${rel}=${skipped.get(rel) ?? "not-skipped"}`);
    if (manifest.files.some((file) => file.relativePath === rel)) missing.push(`${rel}=still-included`);
  }
  if (body.includes(MARKER)) leaked.push(MARKER);
  assert(missing.length === 0, `not skipped as sensitive-file: ${missing.join(", ")}`);
  assert(leaked.length === 0, `marker reached an artifact`);
  return `${Object.keys(SECRET_FILES).length}/${Object.keys(SECRET_FILES).length} skipped, 0 leaked`;
});

check("S5.templates", "template .env files are still included (allowlist works)", () => {
  const dir = fixture("s5t");
  const manifest = generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  const included = new Set(manifest.files.map((file) => file.relativePath));
  for (const rel of Object.keys(TEMPLATE_FILES)) {
    assert(included.has(rel), `${rel} was dropped by the sensitive filter`);
  }
  return `${Object.keys(TEMPLATE_FILES).length} templates included`;
});

check("S5.walk-fallback", "the non-git walk path applies the same deny list", () => {
  const dir = fixture("s5w", { git: false });
  assert(!fs.existsSync(path.join(dir, ".git")), "fixture unexpectedly has git");
  const collected = collectFiles(dir, {});
  const included = new Set(collected.files);
  const notSkipped = Object.keys(SECRET_FILES).filter((rel) => included.has(rel));
  assert(notSkipped.length === 0, `walk fallback collected: ${notSkipped.join(", ")}`);
  assert(
    collected.skipped.filter((s) => s.reason === "sensitive-file").length >= Object.keys(SECRET_FILES).length,
    "skip records missing"
  );
  return `${Object.keys(SECRET_FILES).length} files skipped in walk mode`;
});

check("S5.opt-in", "includeSensitiveFiles:true emits them, and detectable values are redacted", () => {
  // Opting in is an explicit "emit credential files" request, so the assertion is
  // narrow on purpose: the files appear, and the values a default rule recognises
  // are still masked.
  const dir = tmp("s5o");
  write(dir, ".env", `DATABASE_PASSWORD=Sup3rS3cretEnvValue\nNEXT_PUBLIC_LABEL=hello\n`);
  write(dir, "id_rsa", `-----BEGIN RSA PRIVATE KEY-----\nPEMOPTBODYLINEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n-----END RSA PRIVATE KEY-----\n`);
  write(dir, "src/a.ts", "export const a = 1;\n");
  const manifest = generateSnapshot(
    resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", includeSensitiveFiles: true })
  );
  const included = new Set(manifest.files.map((file) => file.relativePath));
  assert(included.has(".env"), ".env was not included despite the opt-in");
  assert(included.has("id_rsa"), "id_rsa was not included despite the opt-in");
  const body = snapshotBody(dir);
  assert(!body.includes("Sup3rS3cretEnvValue"), ".env secret value was not redacted after opt-in");
  assert(!body.includes("PEMOPTBODYLINE"), "id_rsa body was not redacted after opt-in");
  return ".env + id_rsa included, both values masked";
});

const ENV_VARIANTS = [
  [".env", true],
  [".env.local", true],
  [".env.production", true],
  [".env.production.local", true],
  [".env.development.local", true],
  [".env.a.b.c", true],
  [".env_backup", true],
  [".env-bak", true],
  [".env.old", true],
  [".envrc", true],
];

check("S5.env-variants", "every real-world .env.<suffix> variant is treated as sensitive", () => {
  const dir = tmp("s5v");
  for (const [name] of ENV_VARIANTS) write(dir, name, `SMTP_CRED=hunter2hunter2\n`);
  write(dir, "src/a.ts", "export const a = 1;\n");
  const collected = collectFiles(dir, {});
  const skipped = new Set(
    collected.skipped.filter((s) => s.reason === "sensitive-file").map((s) => s.path)
  );
  const holes = ENV_VARIANTS.filter(([name]) => !skipped.has(name)).map(([name]) => name);
  assert(holes.length === 0, `collected by default: ${holes.join(", ")}`);
  return `${ENV_VARIANTS.length}/${ENV_VARIANTS.length} variants skipped`;
});

check("S5.residuals-covered", "the credential filenames recorded in the first pass are now denied", () => {
  const mustDeny = [
    ".env_backup",
    ".env-bak",
    ".envrc",
    "credentials.json",
    "service-account.json",
    "secrets.json",
    "terraform.tfvars",
  ];
  const mustAllow = [".env.example", ".env.production.example", ".env.sample", ".env.template", "src/app.ts", "README.md"];
  const wronglyAllowed = mustDeny.filter((name) => !isSensitivePath(name));
  const wronglyDenied = mustAllow.filter((name) => isSensitivePath(name));
  assertEqual(wronglyAllowed.length, 0, `still allowed: ${wronglyAllowed.join(", ")}`);
  assertEqual(wronglyDenied.length, 0, `wrongly denied: ${wronglyDenied.join(", ")}`);
  return `${mustDeny.length} denied, ${mustAllow.length} allowed`;
});

check("S5.observed-gaps", "OBSERVE — remaining allowed shapes of the same class (recorded, not scored)", () => {
  // Backups of other credential files are not covered by the `.env`-family regex,
  // and `.env-`/`.env_` (no dot separator) are outside its grammar.
  const stillAllowed = [".env-", ".env_", ".netrc.bak"].filter((name) => !isSensitivePath(name));
  console.log(`    OBS S5.remaining-allowed: ${stillAllowed.join(", ")}`);
  assertEqual(stillAllowed.length, 3, "the recorded gap list changed unexpectedly");
  return `${stillAllowed.join(", ")} still allowed`;
});

check("S5.templates-new", "template variants stay includable, including multi-suffix ones", () => {
  const mustInclude = [
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
    ".env.production.example",
  ];
  const mustSkip = [".env.example.local", ".env.local.example.bak"];
  const wrongInclude = mustInclude.filter((name) => isSensitivePath(name));
  const wrongSkip = mustSkip.filter((name) => !isSensitivePath(name));
  assertEqual(wrongInclude.length, 0, `templates wrongly blocked: ${wrongInclude.join(", ")}`);
  assertEqual(wrongSkip.length, 0, `non-templates wrongly allowed: ${wrongSkip.join(", ")}`);
  return `${mustInclude.length} templates allowed, ${mustSkip.length} look-alikes blocked`;
});

check("S5.bypass-hunt", "adversarial .env-adjacent names: record which are (not) denied", () => {
  const probes = [
    ".env-",
    ".env_",
    ".ENV",
    ".Env.Local",
    ".env.",
    ".env-bak",
    ".env_backup",
    ".env.bak",
    ".env.backup",
    ".env.old",
    ".envrc",
    "env",
    "ENV",
    ".env.prod.d/.env",
    "config/.env.local",
    "keys/id_rsa.pub",
    "id_ed25519.pub",
    "service-account.json",
    "credentials.json",
    ".aws/config",
    ".netrc.bak",
  ];
  const denied = probes.filter((name) => isSensitivePath(name));
  const allowed = probes.filter((name) => !isSensitivePath(name));
  console.log(`    OBS S5.bypass-hunt: DENIED   ${denied.join(", ")}`);
  console.log(`    OBS S5.bypass-hunt: ALLOWED  ${allowed.join(", ")}`);
  // The two shapes that are genuinely credential-bearing backups of .env must be denied.
  assertEqual(isSensitivePath(".env.bak"), true, ".env.bak");
  assertEqual(isSensitivePath(".env.backup"), true, ".env.backup");
  assertEqual(isSensitivePath("config/.env.local"), true, "nested .env.local");
  assertEqual(isSensitivePath(".ENV"), true, "uppercase .ENV on a case-insensitive filesystem");
  assertEqual(isSensitivePath(".Env.Local"), true, "mixed-case .Env.Local");
  return `${denied.length} denied / ${allowed.length} allowed of ${probes.length} probes`;
});

check("S5.env-double-suffix-repro", "reproduce .env.production.local end-to-end", () => {
  const dir = tmp("s5r");
  write(dir, ".env.production.local", `SMTP_CRED=hunter2hunter2\n`);
  write(dir, "src/a.ts", "export const a = 1;\n");
  const manifest = generateSnapshot(resolveConfig({ cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp" }));
  const body = snapshotBody(dir);
  const emitted = manifest.files.some((file) => file.relativePath === ".env.production.local");
  const skippedAsSensitive = manifest.skipped.some(
    (entry) => entry.path === ".env.production.local" && entry.reason === "sensitive-file"
  );
  console.log(
    `    OBS S5: isSensitivePath(".env.production.local")=${isSensitivePath(".env.production.local")} emitted=${emitted} value-leaked=${body.includes("hunter2hunter2")}`
  );
  assertEqual(emitted, false, "still emitted");
  assertEqual(skippedAsSensitive, true, "not recorded as a sensitive-file skip");
  return "skipped as sensitive-file, value absent";
});

finish();
