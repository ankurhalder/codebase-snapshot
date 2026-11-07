import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { explainPath, generateSnapshot, resolveConfig, validateSnapshot } from "../dist/index.js";
import { buildResourceProvider, buildTools } from "../dist/mcp.js";
import { DEFAULT_SECRET_PATTERNS, scanAndRedactSecrets } from "../dist/index.js";

/**
 * The security findings from the architecture audit.
 *
 * Two classes: the MCP server honouring a path out of `manifest.json` as though a repository author
 * were a trusted caller, and redaction declining to mask a credential because the *shape* of the
 * value looked like code.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "security-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const configFor = (root, extra = {}) =>
  resolveConfig(
    { cwd: root, outDir: "snapshot", tmpDir: "snapshot.tmp", discovery: "walk", ...extra },
    {},
    root
  );

const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
const contextFor = (root) => ({ cwd: root, roots: [root], log: () => {} });

test("a part filename in the manifest cannot reach outside snapshot/parts", async (t) => {
  // `validateSnapshot` grew `confineToDirectory` for exactly this, but `manifest.json` is an input
  // on disk and the *server* still resolved `parts[].filename` with a bare `path.resolve`. A
  // repository under review could commit a manifest naming `../../../.env` and an MCP client —
  // which auto-approves resource reads because they are read-only — was handed that file's
  // contents. `describeManifestShapeProblem` accepted any string.
  const root = makeRepo(t, {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "index.ts": "export const app = 1;\n",
  });
  const outsidePath = path.join(root, "..", `${path.basename(root)}-outside.env`);
  fs.writeFileSync(outsidePath, "DATABASE_PASSWORD=not-for-the-model\n");
  t.after(() => fs.rmSync(outsidePath, { force: true }));

  const config = configFor(root);
  generateSnapshot(config);

  const manifestPath = path.join(root, "snapshot", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.parts[0].filename = `../../${path.basename(outsidePath)}`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const provider = buildResourceProvider();
  const resource = await provider.read("snapshot://parts/1", contextFor(root));
  assert.equal(resource, null, "the resource read must not return a file outside parts/");

  const read = await tools.get("snapshot_read").handler(
    { path: "index.ts" },
    contextFor(root)
  );
  assert.equal(read.isError, true, "snapshot_read refuses a manifest it cannot trust");
  assert.doesNotMatch(read.text, /not-for-the-model/, "and never echoes the target's contents");

  const result = validateSnapshot(config);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((error) => /not a snapshot manifest/.test(error)),
    `a traversal filename is a shape problem: ${result.errors.join("; ")}`
  );

  // The message names the rule, so the reader knows what to fix.
  assert.ok(
    result.errors.some((error) => /bare filename/.test(error)),
    `the reason is stated: ${result.errors.join("; ")}`
  );
});

test("snapshot_explain will not probe a path outside the root", async (t) => {
  // `normalizeTarget` returned any relative path starting with `..` unchanged, and `explainPath`
  // then joined it to `cwd` and called `existsSync`. `toRelativePath` had the same hole: it
  // resolved *after* the "is it absolute?" test. So a prompt-injected agent could ask
  // `snapshot_explain` whether any path on the host exists — one read-only, auto-approved call per
  // probe.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "explain-root-"));
  const root = path.join(parent, "repo");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "..foo.ts"), "export const dotted = 1;\n");
  fs.writeFileSync(path.join(parent, "target.env"), "SECRET=1\n");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  const config = configFor(root);

  const escaped = explainPath(config, "../target.env");
  assert.equal(escaped.exists, false, "an out-of-root path is not even stat-ed");
  assert.equal(escaped.reason, "outside-root");
  assert.equal(escaped.included, false);

  // `../../../etc/passwd` must be refused the same way, whatever is on the host.
  assert.equal(explainPath(config, "../../../etc/passwd").reason, "outside-root");

  // A file whose name merely *starts* with two dots is an ordinary in-repo file. The old test was
  // `relative.startsWith("..")`, which classified it as a parent traversal.
  const dotted = explainPath(config, "..foo.ts");
  assert.notEqual(dotted.reason, "outside-root", "a name starting with `..` is not a traversal");
  assert.equal(dotted.exists, true);

  // The same refusal through the tool, which is where an agent actually asks.
  const explained = await tools.get("snapshot_explain").handler(
    { path: "../target.env" },
    contextFor(root)
  );
  assert.equal(explained.isError, true, "the tool answers with an error, not a existence oracle");
  assert.match(explained.text, /outside/);
});

test("a template interpolation with a fallback secret is still a secret", () => {
  // `isTemplateInterpolation` tested only `${` … `}`, so any quoted value that started with `$`
  // and ended with `}` was exempt — including the Docker Compose and shell idiom for a default,
  // which is *a hardcoded credential*.
  const compose = 'POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-MyProdPassword123!}"\n';
  const maskedCompose = scanAndRedactSecrets(compose, DEFAULT_SECRET_PATTERNS);
  assert.equal(
    maskedCompose.redacted.includes("MyProdPassword123!"),
    false,
    `the fallback must not survive: ${maskedCompose.redacted}`
  );
  assert.equal(maskedCompose.findings.length > 0, true);

  // A backtick-delimited value the credential rules *do* match, carrying a shell-style default.
  const js = "const password = `${PASSWORD:-hunter2_prod_fallback}`;\n";
  assert.equal(
    scanAndRedactSecrets(js, DEFAULT_SECRET_PATTERNS).redacted.includes("hunter2_prod_fallback"),
    false,
    "a shell-style fallback inside a template literal is a secret too"
  );

  const flanked = 'token: "${prefix}-real_secret-${suffix}"\n';
  assert.equal(
    scanAndRedactSecrets(flanked, DEFAULT_SECRET_PATTERNS).redacted.includes("real_secret"),
    false,
    "two interpolations flanking a literal do not make it an interpolation"
  );

  // The reason the guard exists: a value that is *only* an interpolation is an expression, and
  // masking it rewrote an assertion message in this repository's own tests.
  const pure = 'const message = `an empty token: "${appliesTo}"`;\n';
  assert.equal(
    scanAndRedactSecrets(pure, DEFAULT_SECRET_PATTERNS).redacted,
    pure,
    "a bare identifier interpolation is not a credential"
  );
  const dotted = 'const message = `token: "${process.env.TOKEN}"`;\n';
  assert.equal(
    scanAndRedactSecrets(dotted, DEFAULT_SECRET_PATTERNS).redacted,
    dotted,
    "a dotted reference interpolation is not a credential either"
  );
});

test("`export name=value` in a shell script is an assignment, not a declaration", () => {
  // `DECLARATION_KEYWORDS` listed bare `export`, so `export api_key=…` was read as a *binding*
  // whose initializer is an expression — and left in clear text. `export` is never followed by a
  // bare assignment in JavaScript or TypeScript (`export foo = 1` does not parse), so the keyword
  // only ever suppressed redaction for shell and `.envrc` files.
  const shell = "#!/bin/sh\nexport api_key=hunter2_live_secret\n";
  const masked = scanAndRedactSecrets(shell, DEFAULT_SECRET_PATTERNS);
  assert.equal(
    masked.redacted.includes("hunter2_live_secret"),
    false,
    `a lowercase export assignment is a credential: ${masked.redacted}`
  );

  const token = "export auth_token=my_secret_token\n";
  assert.equal(
    scanAndRedactSecrets(token, DEFAULT_SECRET_PATTERNS).redacted.includes("my_secret_token"),
    false
  );

  // And the declarations the guard exists for still survive: `export` is *not* what makes the
  // difference there — `const`, `let`, `var`, `readonly` and the modifiers are.
  const declaration = "export const SINGLE_TOKEN = /[^\\sA-Za-z0-9_]/g;\n";
  assert.equal(
    scanAndRedactSecrets(declaration, DEFAULT_SECRET_PATTERNS).redacted,
    declaration,
    "a declared regex literal is not a credential"
  );
});

test("an indented, unterminated private key does not leak its body", () => {
  // The unterminated-PEM rule required base64 at column 0 and knew nothing about RFC 1421 header
  // lines. A key inside a YAML block scalar — `privateKey: |` — or inside an indented template
  // literal therefore never matched it, so Pass 2 masked the `-----BEGIN…-----` line only and left
  // every body line of the key in the snapshot.
  const yaml = [
    "service:",
    "  privateKey: |",
    "    -----BEGIN RSA PRIVATE KEY-----",
    "    MIIEowIBAAKCAQEAq7Zr8kLmnOpQrStUvWxYz0123456789abcdefghij",
    "    KLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/AB",
    "  other: value",
    "",
  ].join("\n");
  const masked = scanAndRedactSecrets(yaml, DEFAULT_SECRET_PATTERNS);
  assert.equal(
    masked.redacted.includes("MIIEowIBAAKCAQEAq7Zr8kLmnOpQrStUvWxYz0123456789abcdefghij"),
    false,
    `the key body must be gone: ${masked.redacted}`
  );
  assert.equal(masked.redacted.includes("KLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(masked.findings.length > 0, true, "and the finding is recorded");
  // Text after the key is untouched, so the rule stopped where the key did.
  assert.match(masked.redacted, /other: value/);

  // RFC 1421 header lines between the marker and the body are part of the same key.
  const encrypted = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "Proc-Type: 4,ENCRYPTED",
    "DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF",
    "",
    "MIIEowIBAAKCAQEAq7Zr8kLmnOpQrStUvWxYz0123456789abcdefghij",
    "",
  ].join("\n");
  const maskedEncrypted = scanAndRedactSecrets(encrypted, DEFAULT_SECRET_PATTERNS);
  assert.equal(maskedEncrypted.redacted.includes("MIIEowIBAAKCAQEAq7Zr8kLmnOpQrStUvWxYz"), false);
});

test("a CR-only file keeps its line count through a private key", () => {
  // Pass 1 counted `\n` only, so in a CR-delimited file (old-Mac endings, which `decodeText` will
  // hand over unchanged) the whole matched block was replaced by a marker carrying *no* line
  // breaks — every reported line number after it was wrong.
  const crOnly = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAq7Zr8kLmnOpQrStUvWxYz0123456789abcdefghij",
    "-----END RSA PRIVATE KEY-----",
    "const apiKey = 1;",
  ].join("\r");
  const masked = scanAndRedactSecrets(crOnly, DEFAULT_SECRET_PATTERNS);
  assert.equal(masked.redacted.includes("MIIEowIBAAKCAQEAq7Zr8kLmn"), false, "the key is masked");
  assert.equal(
    masked.redacted.split(/\r\n|\n|\r/).length,
    crOnly.split(/\r\n|\n|\r/).length,
    "the block still occupies the same number of lines"
  );
});

test("no workflow interpolates a dispatch input into a shell script", () => {
  // `${{ inputs.spec }}` was written straight into `run:` in a job carrying `NODE_AUTH_TOKEN`, so
  // a dispatch input containing `"; curl … $NODE_AUTH_TOKEN` ran as shell. Inputs reach the script
  // through `env:` and are quoted, or they do not reach it at all.
  const workflowDir = path.join(HERE, "..", ".github", "workflows");
  const offenders = [];
  for (const file of fs.readdirSync(workflowDir)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const lines = fs.readFileSync(path.join(workflowDir, file), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.includes("${{ inputs.")) return;
      const trimmed = line.trim();
      // The only acceptable place is an `env:` entry, which the shell never re-parses.
      if (/^(SPEC|MESSAGE|CONFIRM):/.test(trimmed)) return;
      offenders.push(`${file}:${index + 1}: ${trimmed}`);
    });
  }
  assert.deepEqual(offenders, [], `dispatch inputs must not be interpolated into run: ${offenders.join("\n")}`);

  // And the values really do arrive through the environment, quoted.
  const deprecate = fs.readFileSync(path.join(workflowDir, "deprecate.yml"), "utf8");
  assert.match(deprecate, /env:\s*\n\s*SPEC: \$\{\{ inputs\.spec \}\}/);
  assert.match(deprecate, /npm deprecate "\$SPEC" "\$MESSAGE"/);
});
