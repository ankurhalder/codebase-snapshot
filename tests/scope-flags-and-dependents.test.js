import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildAgentContract } from "../dist/cli.js";

/**
 * Flags that generate accepts and the commands that have to read them back, from the 0.9.12 audit.
 *
 * The defect was circular: `generate --skeleton` recorded a configuration digest that includes
 * `skeleton`, `validate` resolved `skeleton: false` and failed with "the settings differ from the
 * ones this snapshot was generated with", and `validate --skeleton` — the obvious repair — was
 * rejected as a flag that "does not apply to validate". Neither message named the other, and there
 * was no way to validate a skeleton snapshot at all.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

const run = (cwd, ...args) => {
  const result = spawnSync(process.execPath, [BIN, ...args, "--cwd", cwd, "--no-update-check"], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const git = (cwd, ...args) =>
  spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function makeRepo(t, files = {}, { git: useGit = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-flags-"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  if (useGit) {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "test");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "fixture");
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GENERATION_FLAGS = [
  ["--skeleton", undefined],
  ["--sarif", undefined],
  ["--max-part-tokens", "32k"],
  ["--changed-since", "HEAD"],
  ["--staged", undefined],
];

test("every generation setting validate must compare is in validate's published scope", () => {
  const contract = buildAgentContract();
  const scopeFor = (option) => {
    const found = contract.options.find((entry) => entry.flag === option);
    assert.ok(found, `${option} is in the contract`);
    return found.appliesTo.split("/");
  };

  for (const [flag] of GENERATION_FLAGS) {
    assert.ok(
      scopeFor(flag).includes("validate"),
      `${flag} must be accepted by validate, or a snapshot generated with it cannot be validated`
    );
  }
  // `--with-dependents` alone is a no-op without a scope, so it is exercised with --changed-since.
  assert.ok(scopeFor("--with-dependents").includes("validate"));
  assert.ok(scopeFor("--with-dependents").includes("explain"));
});

test("validate accepts the flag its own digest comparison needs", (t) => {
  const dir = makeRepo(t, {
    "src/a.ts": "export function add(a: number, b: number): number { return a + b; }\n",
  });

  const generated = run(dir, "generate", "--skeleton");
  assert.equal(generated.code, 0, generated.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
  assert.equal(manifest.config.skeleton, true, "the manifest records what the run used");
  assert.match(
    fs.readFileSync(path.join(dir, "snapshot", "parts", "part-001.md"), "utf8"),
    /\{ \/\* \.\.\. \*\/ \}/,
    "and the body really is a signature"
  );

  // Without the flag the digest cannot match — that part is correct and must stay correct.
  const plain = run(dir, "validate");
  assert.equal(plain.code, 1, "a snapshot generated with --skeleton is not current without it");
  assert.match(plain.stdout + plain.stderr, /settings differ|configuration/i);

  // With the flag it is the same configuration, so it is current.
  const same = run(dir, "validate", "--skeleton");
  assert.equal(same.code, 0, same.stdout + same.stderr);
});

test("validate accepts --sarif and --max-part-tokens for the same reason", (t) => {
  const dir = makeRepo(t, { "src/a.ts": "export const a = 1;\n" });
  assert.equal(run(dir, "generate", "--sarif", "--max-part-tokens", "32k").code, 0);
  const result = run(dir, "validate", "--sarif", "--max-part-tokens", "32k");
  assert.equal(result.code, 0, result.stdout + result.stderr);
});

test("explain accepts the scope flags it has to read", (t) => {
  const dir = makeRepo(t, { "src/a.ts": "export const a = 1;\n" }, { git: true });
  // Change it after the commit, so the file is what "changed since HEAD" means.
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 2;\n");
  assert.equal(run(dir, "generate", "--changed-since", "HEAD").code, 0);
  const result = run(dir, "explain", "src/a.ts", "--changed-since", "HEAD");
  assert.equal(result.code, 0, result.stdout + result.stderr);
  // The text rendering goes through `info`, which writes to stderr.
  assert.match(result.stdout + result.stderr, /included\s+yes/, "a modified file is in the scope");
});

test("a flag a command cannot honour is still refused, and names the commands that can", () => {
  // `report` reads the manifest and nothing else, so a generation setting would change nothing.
  // Accepting it there would be the silent fallback this whole table exists to prevent.
  const contract = buildAgentContract();
  const reportScope = contract.options
    .find((entry) => entry.flag === "--skeleton")
    .appliesTo.split("/");
  assert.equal(reportScope.includes("report"), false, "--skeleton does nothing for report");
});

test("setup writes a config that a plain validate agrees with", (t) => {
  // `setup` forwarded `--discovery` and `--large-file-bytes` into the generation but wrote the
  // defaults into the config beside it, so a brand-new project finished its one-command setup and
  // immediately failed `validate` with three configuration mismatches.
  const dir = makeRepo(t, { "src/a.ts": "export const a = 1;\n" });
  const setup = run(dir, "setup", "--yes", "--no-install", "--discovery", "walk", "--large-file-bytes", "100000");
  assert.equal(setup.code, 0, setup.stdout + setup.stderr);

  const result = run(dir, "validate");
  assert.equal(result.code, 0, `setup's own output must validate:\n${result.stdout}${result.stderr}`);

  const configText = fs.readFileSync(
    path.join(dir, fs.readdirSync(dir).find((name) => /^snapshot\.config\./.test(name))),
    "utf8"
  );
  assert.match(configText, /discovery: "walk"/);
  assert.match(configText, /largeFileBytes: 100000/);
});

test("setup persists the compression settings it was asked for", (t) => {
  const dir = makeRepo(t, { "src/a.ts": "export function a(): void { return; }\n" });
  const setup = run(dir, "setup", "--yes", "--no-install", "--skeleton", "--sarif", "--max-part-tokens", "32k");
  assert.equal(setup.code, 0, setup.stdout + setup.stderr);

  const result = run(dir, "validate");
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);

  const configText = fs.readFileSync(
    path.join(dir, fs.readdirSync(dir).find((name) => /^snapshot\.config\./.test(name))),
    "utf8"
  );
  assert.match(configText, /skeleton: true/);
  assert.match(configText, /sarif: true/);
  assert.match(configText, /maxPartTokens: 32768/);
  assert.ok(fs.existsSync(path.join(dir, "snapshot", "reports", "audit.sarif")));
});

// --------------------------------------------------------------------------- dependents

const DEPENDENT_FILES = {
  "src/used.ts": "export const used = 1;\n",
  "src/importer.ts": 'import { used } from "./used.js";\nexport const value = used + 1;\n',
  "src/bystander.ts": "export const bystander = 1;\n",
};

test("explain agrees with generate when --with-dependents widened the scope", (t) => {
  // The generator kept one hop of importers and both readers compared the raw path set, so a file
  // that is *in* the snapshot was explained as `included: false, reason: "unchanged"`.
  const dir = makeRepo(t, DEPENDENT_FILES, { git: true });
  fs.writeFileSync(path.join(dir, "src", "used.ts"), "export const used = 2;\n");

  const generated = run(dir, "generate", "--changed-since", "HEAD", "--with-dependents");
  assert.equal(generated.code, 0, generated.stdout + generated.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "snapshot", "manifest.json"), "utf8"));
  const included = manifest.files.map((file) => file.relativePath).sort();
  assert.deepEqual(included, ["src/importer.ts", "src/used.ts"], "the importer is in the snapshot");

  const dependent = run(dir, "explain", "src/importer.ts", "--changed-since", "HEAD", "--with-dependents");
  assert.equal(dependent.code, 0, dependent.stdout + dependent.stderr);
  assert.match(
    dependent.stdout + dependent.stderr,
    /included\s+yes/,
    "explain must agree that a file the snapshot contains is included"
  );

  const bystander = run(dir, "explain", "src/bystander.ts", "--changed-since", "HEAD", "--with-dependents");
  assert.match(
    bystander.stdout + bystander.stderr,
    /reason\s+unchanged/,
    "and a file that imports nothing changed stays out"
  );
});

test("validate notices a file that became an importer of a changed file", (t) => {
  // `validate` compared the recorded `unchanged` skips against the raw changed set, so a file that
  // did not move but now imports something that did was called correctly excluded — the one drift
  // the snapshot was built to avoid.
  const dir = makeRepo(t, DEPENDENT_FILES, { git: true });

  const first = run(dir, "generate", "--changed-since", "HEAD", "--with-dependents");
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(
    run(dir, "validate", "--changed-since", "HEAD", "--with-dependents").code,
    0,
    "an empty-but-correct scoped snapshot validates with the selection it was generated with"
  );

  fs.writeFileSync(path.join(dir, "src", "used.ts"), "export const used = 3;\n");
  const result = run(dir, "validate", "--changed-since", "HEAD", "--with-dependents", "--format", "json");
  assert.equal(result.code, 1, "the snapshot is now stale");
  const drift = JSON.parse(result.stdout).drift;
  assert.ok(
    drift.missingInSnapshot.includes("src/importer.ts"),
    `the new dependent must be reported: ${JSON.stringify(drift.missingInSnapshot)}`
  );
  assert.ok(
    drift.missingInSnapshot.includes("src/used.ts"),
    "and so must the changed file itself"
  );
  assert.equal(
    drift.missingInSnapshot.includes("src/bystander.ts"),
    false,
    "a file that imports nothing changed is still correctly excluded"
  );
});
