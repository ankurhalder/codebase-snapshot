// S4 (01 §4 / H6) — a caller-supplied `/g` rule was stateful: `pattern.test()`
// advanced lastIndex across lines AND files, so every other secret survived with
// no warning. S7 (01 §7) — redaction replaced the whole line, destroying
// neighbouring code. S9 (01 §9) — a JSON config could only supply a string
// pattern, which made the scanner throw `pattern.test is not a function`.
import * as path from "node:path";
import {
  generateSnapshot,
  isResolvedConfig,
  loadConfigFileDetailed,
  resolveConfig,
  scanAndRedactSecrets,
} from "../../dist/index.js";
import {
  assert,
  assertEqual,
  assertIncludes,
  check,
  finish,
  readTree,
  selfTest,
  tmp,
  write,
} from "./v-lib.mjs";

selfTest();

check("S4.g-flag", "a /g custom rule redacts every match, not every other one", () => {
  const lines = Array.from({ length: 8 }, (_, i) => `X=SECRET_LINE${i}A`).join("\n");
  const rule = { rule: "custom-token", pattern: /^X=SECRET_[A-Z0-9]+$/g };
  const { redacted, findings } = scanAndRedactSecrets(lines, [rule], "a");
  const survivors = redacted.split("\n").filter((line) => line.startsWith("X=SECRET"));
  assertEqual(survivors.length, 0, "unredacted lines");
  assertEqual(findings.length, 8, "findings recorded");
  return "8/8 lines redacted (old: 4/8)";
});

check("S4.determinism", "identical files produce identical redaction (no cross-file lastIndex)", () => {
  const input = Array.from({ length: 8 }, (_, i) => `X=SECRET_LINE${i}A`).join("\n");
  const rule = { rule: "custom-token", pattern: /^X=SECRET_[A-Z0-9]+$/g };
  const a = scanAndRedactSecrets(input, [rule], "f1").redacted;
  const b = scanAndRedactSecrets(input, [rule], "f2").redacted;
  assertEqual(a, b, "same input, different output");
  return "byte-identical across files";
});

check("S4.lastIndex", "the caller's RegExp object is not left mutated", () => {
  const rule = { rule: "custom-token", pattern: /SECRET_[A-Z0-9]+/g };
  const { redacted } = scanAndRedactSecrets("SECRET_AAA\nSECRET_BBB\n", [rule], "f");
  assert(!redacted.includes("SECRET_AAA"), "first secret survived");
  assert(!redacted.includes("SECRET_BBB"), "second secret survived");
  assertEqual(rule.pattern.lastIndex, 0, "caller pattern.lastIndex after scan");
  return "both lines masked, lastIndex=0";
});

check("S4.overlap", "overlapping rules mask the span without leaking or looping", () => {
  const rules = [
    { rule: "wide", pattern: /SECRET_[A-Z0-9]{10}/ },
    { rule: "narrow", pattern: /SECRET_[A-Z0-9]{4}/ },
    { rule: "same-span", pattern: /SECRET_[A-Z0-9]{10}/ },
  ];
  const line = `x = "SECRET_ABCDEFGHIJ"; y = 2;`;
  const { redacted, findings } = scanAndRedactSecrets(line, rules, "f");
  assert(!redacted.includes("SECRET_ABCDEFGHIJ"), `value survived: ${redacted}`);
  assertIncludes(redacted, "y = 2;", "unrelated code");
  assert(findings.length >= 1, "no findings recorded");
  return `${findings.length} findings, one mask per span`;
});

check("S4.marker-rule", "a rule matching the redaction marker cannot resurrect a secret", () => {
  const rules = [{ rule: "marker-eater", pattern: /\[REDACTED:[^\]]*\]/ }];
  const { redacted } = scanAndRedactSecrets(
    `k = "AKIAIOSFODNN7EXAMPLE";\n`,
    [...resolveConfig({}).secretRules, ...rules],
    "f"
  );
  assert(!redacted.includes("AKIAIOSFODNN7EXAMPLE"), "secret survived");
  return "secret still gone";
});

check("S7.span-only", "only the matched span is replaced; neighbouring code survives", () => {
  const line = `export const awsKey = "AKIAIOSFODNN7EXAMPLE"; export const region = "us-east-1"; const retries = 3;`;
  const { redacted } = scanAndRedactSecrets(line, resolveConfig({}).secretRules, "f");
  for (const kept of ["export const region", "us-east-1", "retries = 3", "export const awsKey"]) {
    assertIncludes(redacted, kept, `lost unrelated code (${kept})`);
  }
  assert(!redacted.includes("AKIAIOSFODNN7EXAMPLE"), "secret survived");
  assertIncludes(redacted, "[REDACTED: potential secret-like value omitted from snapshot]", "marker");
  return "unrelated code preserved (old: whole line lost)";
});

check("S7.multi", "two secrets on one line are both masked and code between them survives", () => {
  const line = `const a = "AKIAIOSFODNN7EXAMPLE"; doWork(); const b = "npm_9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c";`;
  const { redacted } = scanAndRedactSecrets(line, resolveConfig({}).secretRules, "f");
  assert(!redacted.includes("AKIAIOSFODNN7EXAMPLE"), "aws survived");
  assert(!redacted.includes("npm_9f8e7d6c5b4a39281706f5e4d3c2b1a0"), "npm token survived");
  assertIncludes(redacted, "doWork();", "code between the secrets");
  return "both masked, doWork() preserved";
});

// `check` is synchronous; the loader is async, so run this one by hand in the
// same output format.
{
  const started = process.hrtime.bigint();
  try {
    const detail = await (async () => {
      const dir = tmp("s9");
      write(
        dir,
        ".snapshotrc.json",
        JSON.stringify({
          secrets: { customPatterns: [{ rule: "acme-token", pattern: "ACME_[A-Za-z0-9]{12}" }] },
        })
      );
      write(dir, "src/a.ts", `export const t = "ACME_abcdefgh1234";\n`);
      const loaded = await loadConfigFileDetailed(dir);
      assert(loaded.config, `config not loaded: ${loaded.warnings.join("; ")}`);
      assertEqual(loaded.warnings.length, 0, "unexpected warnings");
      const config = resolveConfig(loaded.config, undefined, dir);
      // Pass the branded resolved config through unchanged: resolveConfig already
      // applied outDir/tmpDir defaults ("snapshot" / "snapshot.tmp").
      const manifest = generateSnapshot(config);
      const body = JSON.stringify(readTree(path.join(dir, "snapshot")));
      assert(!body.includes("ACME_abcdefgh1234"), "JSON-config string pattern did not redact");
      assert(manifest.warnings.some((w) => w.includes("acme-token")), "no finding recorded");
      // Observation: spreading a resolved config drops its brand, so the compiled
      // secretRules are silently replaced by the defaults again.
      const spread = { ...config, outDir: "snapshot" };
      const viaSpread = generateSnapshot(spread);
      const spreadBody = JSON.stringify(readTree(path.join(dir, "snapshot")));
      const spreadKeptRule = viaSpread.warnings.some((w) => w.includes("acme-token"));
      const spreadLeaked = spreadBody.includes("ACME_abcdefgh1234");
      console.log(
        `    OBS S9.brand-spread (re-test): {...resolvedConfig} keeps secretRules (custom rule kept: ${spreadKeptRule}, value leaked: ${spreadLeaked})`
      );
      return "loaded, compiled, redacted (old: pattern.test is not a function)";
    })();
    console.log(`PASS S9.json-config :: awaitable loader path :: ${detail}`);
  } catch (err) {
    console.log(`FAIL S9.json-config :: awaitable loader path :: ${err.message}`);
    process.exitCode = 1;
  }
  void started;
}

check("S9.invalid-regex", "an invalid pattern string raises a clear error, not a TypeError", () => {
  let message = "";
  try {
    resolveConfig({ secrets: { customPatterns: [{ rule: "bad", pattern: "([unclosed" }] } });
  } catch (err) {
    message = err.message;
  }
  assertIncludes(message, "Invalid regular expression for secret rule", "error text");
  assertIncludes(message, "bad", "rule name in error");
  return message.slice(0, 78);
});

check("S9.type-error", "a non-string, non-RegExp pattern is rejected with a clear message", () => {
  let message = "";
  try {
    resolveConfig({ secrets: { customPatterns: [{ rule: "num", pattern: 42 }] } });
  } catch (err) {
    message = err.message;
  }
  assertIncludes(message, "neither a RegExp nor a string", "error text");
  return message.slice(0, 78);
});

// ---------------------------------------------------------------------------
// R2 (regression found in the first verification pass, fixed before freeze #2):
// `{ ...resolvedConfig, override }` lost the non-enumerable brand, so the object
// was re-resolved as a USER config and every custom `secretRules` entry vanished.
// `isResolvedConfig` now also accepts a structural match whose discriminator is
// `secretRules` (a field `SnapshotConfig` can never express).
const ACME = "ACME_abcdefgh1234";

function r2Fixture(name, value = ACME) {
  const dir = tmp(name);
  write(dir, "src/a.ts", `export const t = "${value}";\n`);
  return dir;
}

function r2Config(dir, overrides = {}) {
  return resolveConfig(
    {
      cwd: dir,
      outDir: "snapshot",
      tmpDir: "snapshot.tmp",
      secrets: {
        customPatterns: [{ rule: "acme-token", pattern: "ACME_[A-Za-z0-9]{12}" }],
        ...(overrides.secrets ?? {}),
      },
      ...(overrides.config ?? {}),
    },
    undefined,
    dir
  );
}

function r2Measure(dir, config) {
  const manifest = generateSnapshot(config);
  const body = JSON.stringify(readTree(path.join(dir, "snapshot")));
  return {
    findings: manifest.warnings.filter((warning) => warning.includes("acme-token")).length,
    leaked: body.includes(ACME),
  };
}

check("R2.spread", "FIXED — {...resolvedConfig, override} keeps the compiled secret rules", () => {
  const dir = r2Fixture("r2");
  const config = r2Config(dir);
  const direct = r2Measure(dir, config);
  const spread = r2Measure(dir, { ...config, outDir: "snapshot" });
  console.log(
    `    OBS R2.spread: direct findings=${direct.findings} leaked=${direct.leaked} | spread findings=${spread.findings} leaked=${spread.leaked}`
  );
  assert(direct.findings === 1 && !direct.leaked, "baseline direct run is broken");
  assert(spread.findings === 1, `spread run recorded ${spread.findings} findings (expected 1)`);
  assert(!spread.leaked, "the secret was emitted in clear after the spread");
  return "spread keeps the rule; secret absent";
});

check("R2.structuredClone", "a structuredClone of a function-free resolved config keeps the rules", () => {
  const dir = r2Fixture("r2c");
  // Preset layer/kind rules use function matchers, and functions are not
  // cloneable; a config with string matchers is a fair clone test.
  const config = resolveConfig(
    {
      cwd: dir,
      outDir: "snapshot",
      tmpDir: "snapshot.tmp",
      layers: [{ name: "src", match: "src/**" }],
      kinds: [{ kind: "source", match: "src/**" }],
      secrets: { customPatterns: [{ rule: "acme-token", pattern: "ACME_[A-Za-z0-9]{12}" }] },
    },
    undefined,
    dir
  );
  const cloned = structuredClone(config);
  const result = r2Measure(dir, cloned);
  console.log(
    `    OBS R2.structuredClone: findings=${result.findings} leaked=${result.leaked} isResolvedConfig(clone)=${isResolvedConfig(cloned)}`
  );
  assert(result.findings === 1, `clone recorded ${result.findings} findings`);
  assert(!result.leaked, "secret leaked after structuredClone");
  return "clone keeps the rule (structural match, no brand needed)";
});

check("R2.structuredClone-preset", "OBSERVE — the default preset makes structuredClone throw (function matchers)", () => {
  const dir = r2Fixture("r2cp");
  const config = r2Config(dir);
  let error = null;
  try {
    structuredClone(config);
  } catch (err) {
    error = err;
  }
  console.log(
    `    OBS R2.structuredClone-preset: threw=${Boolean(error)} name=${error?.name ?? "-"} (preset layers/kinds carry function matchers)`
  );
  assert(error, "expected the preset config to be uncloneable");
  return `${error.name}: inherent to function matchers, unrelated to the brand`;
});

check("R2.spread-gflag", "a spread config with a /g custom rule stays stateless after recompilation", () => {
  const dir = tmp("r2g");
  const lines = Array.from({ length: 8 }, (_, i) => `X=TOK_${String(i).repeat(8)}`).join("\n");
  write(dir, "src/a.ts", `${lines}\n`);
  const config = resolveConfig(
    { cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", secrets: { customPatterns: [{ rule: "tok", pattern: /TOK_[0-9]{8}/g }] } },
    undefined,
    dir
  );
  const manifest = generateSnapshot({ ...config, outDir: "snapshot" });
  const body = JSON.stringify(readTree(path.join(dir, "snapshot")));
  const survivors = (body.match(/TOK_\d{8}/g) ?? []).length;
  console.log(`    OBS R2.gflag: findings=${manifest.warnings.filter((w) => w.includes("tok")).length} survivors=${survivors}`);
  assert(survivors === 0, `${survivors} token(s) survived a /g rule after the spread`);
  return "8/8 masked through the spread";
});

check("R2.spread-string-pattern", "a spread config whose secretRules hold string patterns still compiles", () => {
  const dir = r2Fixture("r2s");
  const config = r2Config(dir);
  const spread = { ...config, secretRules: config.secretRules.map((rule) => ({ rule: rule.rule, pattern: rule.pattern.source })) };
  const manifest = generateSnapshot(spread);
  const body = JSON.stringify(readTree(path.join(dir, "snapshot")));
  console.log(`    OBS R2.stringPattern: findings=${manifest.warnings.filter((w) => w.includes("acme-token")).length} leaked=${body.includes(ACME)}`);
  assert(manifest.warnings.some((warning) => warning.includes("acme-token")), "string pattern was not compiled");
  assert(!body.includes(ACME), "secret leaked with a string pattern");
  return "compiled from source text";
});

check("R2.almost-resolved", "an object missing one resolved-only field is treated as a USER config (no crash)", () => {
  const dir = r2Fixture("r2a");
  const config = r2Config(dir);
  const almost = { ...config };
  delete almost.includeSensitiveFiles;
  assertEqual(isResolvedConfig(almost), false, "isResolvedConfig(almost-resolved)");
  // As a user config it is re-resolved: `maxPartBytes` is honoured, `secretRules`
  // is not a user-config field, and the run must still succeed.
  const manifest = generateSnapshot(almost);
  const body = JSON.stringify(readTree(path.join(dir, "snapshot")));
  assertEqual(manifest.budgets.maxPartBytes, config.maxPartBytes, "user-config budget");
  console.log(
    `    OBS R2.almost: reResolved=true budget=${manifest.budgets.maxPartBytes} findings=${manifest.warnings.filter((w) => w.includes("acme-token")).length} leaked=${body.includes(ACME)}`
  );
  return "re-resolved as a user config, defaults applied, no crash";
});

check("R2.user-contract", "the documented user-config path still applies custom patterns", () => {
  const dir = r2Fixture("r2u");
  const manifest = generateSnapshot(
    resolveConfig(
      { cwd: dir, outDir: "snapshot", tmpDir: "snapshot.tmp", secrets: { customPatterns: [{ rule: "acme-token", pattern: "ACME_[A-Za-z0-9]{12}" }] } },
      undefined,
      dir
    )
  );
  const body = JSON.stringify(readTree(path.join(dir, "snapshot")));
  assert(manifest.warnings.some((warning) => warning.includes("acme-token")), "custom pattern ignored");
  assert(!body.includes(ACME), "secret leaked");
  return "user config path unchanged";
});

check("R2.json-round-trip", "OBSERVE — JSON.parse(JSON.stringify(resolved)) cannot carry RegExp rules", () => {
  const dir = r2Fixture("r2j");
  const config = r2Config(dir);
  const roundTripped = JSON.parse(JSON.stringify(config));
  assertEqual(isResolvedConfig(roundTripped), false, "isResolvedConfig(JSON round-trip)");
  const manifest = generateSnapshot(roundTripped);
  const body = JSON.stringify(readTree(path.join(dir, "snapshot")));
  const leaked = body.includes(ACME);
  console.log(
    `    OBS R2.json: isResolved=false findings=${manifest.warnings.filter((w) => w.includes("acme-token")).length} leaked=${leaked} (RegExp serialises to {})`
  );
  // Recorded, not scored: JSON destroys the regex source, so the rules cannot be
  // recovered by any implementation. What would be fixable is a loud error.
  assertEqual(leaked, true, "unexpectedly survived a JSON round-trip");
  return "reverts to defaults by construction (RegExp → {}); no signal raised";
});

finish();


