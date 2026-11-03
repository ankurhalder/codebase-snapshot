// A13 (03 §9, LOW) — unpinned Actions, no lint/coverage/audit/pack gates, an
// unguarded workflow_dispatch publish, no concurrency, no least-privilege
// permissions. Static inspection of the workflow files (CI cannot be executed
// from here), plus tsconfig checks for the dead-code gate.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { REPO, assert, assertEqual, check, finish, selfTest, tmp } from "./v-lib.mjs";

selfTest();

const ci = fs.readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8");
const publish = fs.readFileSync(path.join(REPO, ".github/workflows/publish.yml"), "utf8");

check("A13.pinned", "every third-party action is pinned to a 40-hex commit SHA", () => {
  const uses = [...ci.matchAll(/uses:\s*([^\s#]+)/g), ...publish.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
  assert(uses.length > 0, "no actions found");
  const unpinned = uses.filter((ref) => !/@[0-9a-f]{40}$/.test(ref));
  assertEqual(unpinned.length, 0, `unpinned: ${unpinned.join(", ")}`);
  return `${uses.length} uses, all pinned`;
});

check("A13.permissions", "both workflows declare least-privilege permissions", () => {
  assert(/permissions:\s*\n\s*contents:\s*read/.test(ci), "ci.yml has no contents: read");
  assert(/permissions:\s*\n\s*contents:\s*read/.test(publish), "publish.yml has no contents: read");
  assert(/id-token:\s*write/.test(publish), "publish.yml lost id-token: write (needed for provenance)");
  return "contents: read (+ id-token: write for provenance)";
});

check("A13.concurrency", "both workflows declare concurrency", () => {
  assert(/concurrency:\s*\n\s*group:/.test(ci), "ci.yml has no concurrency");
  assert(/cancel-in-progress:\s*true/.test(ci), "ci.yml does not cancel superseded runs");
  assert(/concurrency:\s*\n\s*group:/.test(publish), "publish.yml has no concurrency");
  assert(/cancel-in-progress:\s*false/.test(publish), "publish must not cancel an in-flight publish");
  return "ci cancels superseded runs; publish serialises";
});

check("A13.gates", "typecheck / coverage / pack gates exist in CI", () => {
  assert(/tsc --noEmit/.test(ci), "no typecheck step");
  assert(/--experimental-test-coverage/.test(ci), "no coverage step");
  assert(/pack --dry-run/.test(ci), "no npm pack verification");
  assert(/tarball must not contain \.map/.test(ci), "pack gate does not check for sourcemaps");
  return "typecheck + coverage + tarball contract";
});

check("A13.publish-guard", "workflow_dispatch publishing is gated to main", () => {
  assert(/workflow_dispatch:/.test(publish), "workflow_dispatch missing");
  assert(
    /if:\s*github\.event_name == 'release' \|\| github\.ref == 'refs\/heads\/main'/.test(publish),
    "no branch guard on workflow_dispatch"
  );
  return "gated to main, release events allowed";
});

check("A13.unused-locals", "noUnusedLocals/noUnusedParameters are on (dead-code gate)", () => {
  const tsconfig = JSON.parse(
    fs.readFileSync(path.join(REPO, "tsconfig.json"), "utf8").replace(/^\uFEFF/, "")
  );
  assertEqual(tsconfig.compilerOptions.noUnusedLocals, true, "noUnusedLocals");
  assertEqual(tsconfig.compilerOptions.noUnusedParameters, true, "noUnusedParameters");
  return "both on";
});

// ----------------------------------------------------------------- lint gate
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

check("A13.lint-wired", "the lint gate is a package script and a CI step", () => {
  assertEqual(pkg.scripts?.lint, "node scripts/lint.mjs", "package.json scripts.lint");
  assert(fs.existsSync(path.join(REPO, "scripts/lint.mjs")), "scripts/lint.mjs missing");
  assert(/run: npm run lint/.test(ci) && /- name: Lint[\s\S]{0,80}run: npm run lint/.test(ci), "ci.yml has no Lint step running npm run lint");
  assertIncludeDetail(pkg.scripts?.check);
  return "npm run lint + CI step + npm run check";
});

function assertIncludeDetail(checkScript) {
  assert(checkScript && /lint/.test(checkScript) && /typecheck/.test(checkScript) && /test/.test(checkScript), `scripts.check = ${checkScript}`);
}

check("A13.lint-clean", "the real tree passes its own lint gate (no false positives)", () => {
  const result = spawnSync(process.execPath, [path.join(REPO, "scripts/lint.mjs")], { cwd: REPO, encoding: "utf8", timeout: 120_000 });
  assertEqual(result.status, 0, `lint exited ${result.status}: ${result.stderr.slice(0, 400)}`);
  assert(/clean/.test(result.stdout), `unexpected output: ${result.stdout}`);
  return result.stdout.trim();
});

check("A13.lint-fails", "the gate fails on injected violations and names the rule", () => {
  const scratch = tmp("lint");
  for (const dir of ["src", "tests", "scripts"]) {
    fs.cpSync(path.join(REPO, dir), path.join(scratch, dir), { recursive: true });
  }
  // One file carrying six independent violations.
  fs.writeFileSync(
    path.join(scratch, "src/violations.ts"),
    [
      "export const trailing = 1;   ",
      "console.log('nope');",
      "try { throw new Error('x'); } catch { }",
      "export function fn(value: any) { return value; }",
      "// TODO: remove me",
      "export const fine = 2;",
    ].join("\n") + "\n"
  );
  // CRLF must be its own file so it does not mask the trailing-whitespace rule.
  fs.writeFileSync(path.join(scratch, "src/crlf.ts"), "export const crlf = 1;\r\nexport const two = 2;\r\n");
  const result = spawnSync(process.execPath, [path.join(scratch, "scripts/lint.mjs")], {
    cwd: scratch,
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  assertEqual(result.status, 1, `lint exited ${result.status} on a dirty tree: ${output.slice(0, 300)}`);
  const rules = ["trailing-ws", "src-console", "empty-catch", "explicit-any", "stray-todo", "eol"];
  const missing = rules.filter((rule) => !output.includes(`[${rule}]`));
  assertEqual(missing.length, 0, `rules not reported: ${missing.join(", ")}`);
  assert(output.includes("violations.ts"), "the offending file is not named");
  return `${rules.length} rules fired on an injected file`;
});

check("A13.lint-scope", "the gate enforces the advertised rules (structural)", () => {
  const body = fs.readFileSync(path.join(REPO, "scripts/lint.mjs"), "utf8");
  for (const rule of ["src-console", "empty-catch", "explicit-any", "stray-todo", "tabs", "trailing-ws", "eol", "test-only", "no-debugger"]) {
    assert(body.includes(`"${rule}"`), `rule ${rule} is not implemented`);
  }
  assert(/CONSOLE_ALLOWED/.test(body) && /src\/cli\.ts/.test(body), "console allowlist missing");
  return "9 rules + console allowlist";
});

// ------------------------------------------------------------- dependabot + audit
check("A13.dependabot", "dependabot.yml parses as YAML with grouped npm + actions updates", () => {
  const file = path.join(REPO, ".github/dependabot.yml");
  assert(fs.existsSync(file), ".github/dependabot.yml missing");
  const parsed = execFileSync(
    "python",
    ["-c", "import json,sys,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1],encoding='utf-8'))))", file],
    { encoding: "utf8", timeout: 60_000 }
  );
  const config = JSON.parse(parsed);
  assertEqual(config.version, 2, "version");
  const ecosystems = (config.updates ?? []).map((entry) => entry["package-ecosystem"]);
  assert(ecosystems.includes("npm"), `ecosystems: ${ecosystems.join(",")}`);
  assert(ecosystems.includes("github-actions"), `ecosystems: ${ecosystems.join(",")}`);
  const npmEntry = config.updates.find((entry) => entry["package-ecosystem"] === "npm");
  const groups = npmEntry.groups ?? {};
  const groupNames = Object.keys(groups);
  assert(groupNames.length >= 2, `npm groups: ${groupNames.join(",")}`);
  assert(
    groupNames.some((name) => groups[name]["dependency-type"] === "production") &&
      groupNames.some((name) => groups[name]["dependency-type"] === "development"),
    "grouped by dependency type missing"
  );
  assert(npmEntry.schedule?.interval === "weekly", `schedule: ${JSON.stringify(npmEntry.schedule)}`);
  const actionsEntry = config.updates.find((entry) => entry["package-ecosystem"] === "github-actions");
  assert((actionsEntry.groups?.actions?.patterns ?? []).includes("*"), "actions group patterns missing");
  return `yaml ok: ${ecosystems.join(" + ")}, npm groups ${groupNames.join("/")}`;
});

check("A13.audit-step", "CI runs npm audit at a defined level", () => {
  assert(/npm audit --audit-level=high/.test(ci), "no npm audit step with a level");
  const step = ci.split("\n").find((line) => line.includes("npm audit"));
  return step.trim();
});

finish();


