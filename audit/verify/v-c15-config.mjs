// C§15 (02 §15, LOW) — config loading swallowed every error (`catch { continue; }`),
// broke on `#`/`%` in the directory name, and `resolveConfig(loaded)` ignored the
// config's own directory (writing into process.cwd()). A12 (03 §12) is the same
// cwd footgun seen from the API side.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadConfigFileDetailed,
  resolveConfig,
  supportsTypeScriptImports,
} from "../../dist/index.js";
import {
  REPO,
  assert,
  assertEqual,
  assertIncludes,
  check,
  checkAsync,
  finish,
  selfTest,
  tmp,
  write,
} from "./v-lib.mjs";

selfTest();

await checkAsync("C15.hash-percent-dir", "a config in a directory containing # and % still loads", async () => {
  const base = tmp("c15a");
  const dir = path.join(base, "hash#dir", "percent%41dir");
  fs.mkdirSync(dir, { recursive: true });
  write(dir, "snapshot.config.js", `export default { maxPartBytes: 123456 };\n`);
  const loaded = await loadConfigFileDetailed(dir);
  assert(loaded.config, `config not loaded (warnings: ${loaded.warnings.join("; ")})`);
  assertEqual(loaded.config.maxPartBytes, 123456, "maxPartBytes");
  assertEqual(loaded.warnings.length, 0, `unexpected warnings: ${loaded.warnings.join("; ")}`);
  return `loaded from ${path.basename(dir)}`;
});

await checkAsync("C15.error-not-swallowed", "a broken config is reported, not silently ignored", async () => {
  const dir = tmp("c15b");
  write(dir, "snapshot.config.js", `export default { maxPartBytes: ;\n`);
  const loaded = await loadConfigFileDetailed(dir);
  assertEqual(loaded.config, null, "config should be null");
  assert(loaded.warnings.length >= 1, "no warning recorded — the error was swallowed again");
  assertIncludes(loaded.warnings.join(" "), "Could not load", "warning text");
  return loaded.warnings[0].replace(/^.*snapshot\.config\.js/, "…snapshot.config.js").slice(0, 90);
});

await checkAsync("C15.ts-config", "a .ts config loads on this Node and is gated by supportsTypeScriptImports", async () => {
  assertEqual(supportsTypeScriptImports(), true, "Node 24 should support type stripping");
  const dir = tmp("c15c");
  write(dir, "snapshot.config.ts", `export default { maxPartBytes: 98304 };\n`);
  const loaded = await loadConfigFileDetailed(dir);
  assert(loaded.config, `not loaded: ${loaded.warnings.join("; ")}`);
  assertEqual(loaded.config.maxPartBytes, 98304, "maxPartBytes");
  return "loaded";
});

await checkAsync("C15.invalid-json", "a malformed JSON config is reported", async () => {
  const dir = tmp("c15d");
  write(dir, "snapshot.config.json", `{ "maxPartBytes": }`);
  const loaded = await loadConfigFileDetailed(dir);
  assertEqual(loaded.config, null, "config");
  assert(
    loaded.warnings.some((warning) => /Could not parse/.test(warning)),
    JSON.stringify(loaded.warnings)
  );
  return loaded.warnings[0].slice(0, 70);
});

await checkAsync("C15.package-json-key", "the package.json snapshot key is still honoured", async () => {
  const dir = tmp("c15e");
  write(dir, "package.json", JSON.stringify({ name: "x", snapshot: { maxPartBytes: 65536 } }));
  const loaded = await loadConfigFileDetailed(dir);
  assert(loaded.config, "not loaded");
  assertEqual(loaded.config.maxPartBytes, 65536, "maxPartBytes");
  return "loaded from package.json";
});

// ---------------------------------------------------------------- A12
await checkAsync("A12.baseDir", "resolveConfig(cfg, undefined, dir) uses the config's directory", async () => {
  const dir = tmp("c15f");
  write(dir, "src/a.ts", "export const a = 1;\n");
  const loaded = await loadConfigFileDetailed(dir);
  const resolved = resolveConfig(loaded.config, undefined, dir);
  assertEqual(resolved.cwd, fs.realpathSync.native(dir), "resolved cwd");
  assert(resolved.cwd !== REPO, "cwd fell back to the caller's directory");
  return resolved.cwd.split(path.sep).pop();
});

check("A12.cwd-validated", "a nonexistent cwd is rejected up front", () => {
  let message = "";
  try {
    resolveConfig({ cwd: path.join(tmp("c15g"), "does-not-exist") });
  } catch (err) {
    message = err.message;
  }
  assertIncludes(message, "Working directory does not exist", "error text");
  return message.slice(0, 70);
});

check("A12.file-as-cwd", "a file used as cwd is rejected", () => {
  const dir = tmp("c15h");
  const file = write(dir, "not-a-dir.txt", "x");
  let message = "";
  try {
    resolveConfig({ cwd: file });
  } catch (err) {
    message = err.message;
  }
  assertIncludes(message, "not a directory", "error text");
  return message.slice(0, 70);
});

finish();
