import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The agent path, executed exactly as the bundled skill and the shipped contract
 * describe it: read `--help`, discover `describe`, follow the six workflow steps
 * in order, and only then consume the output.
 *
 * This test exists because the documentation claimed such a simulation existed
 * when it did not. Every step below is the literal command from
 * `describe --format json` workflow[i], run against a real fixture, with the
 * assertions the contract promises. If an agent following the published
 * instructions would fail, this test fails.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "dist", "bin.js");

function runCli(cliArgs, options = {}) {
  const result = spawnSync(process.execPath, [BIN, ...cliArgs], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A Django project: eight files, no package.json, no git. */
const DJANGO_FILES = {
  "manage.py": 'import os\nimport sys\n\nif __name__ == "__main__":\n    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "shop.settings")\n    from django.core.management import execute_from_command_line\n\n    execute_from_command_line(sys.argv)\n',
  "shop/__init__.py": "",
  "shop/settings.py": 'DEBUG = True\nINSTALLED_APPS = ["shop.orders"]\nDATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3"}}\n',
  "shop/urls.py": 'from django.urls import path\nfrom orders import views\n\nurlpatterns = [path("orders/", views.index)]\n',
  "orders/__init__.py": "",
  "orders/models.py": 'from django.db import models\n\n\nclass Order(models.Model):\n    total = models.DecimalField(max_digits=8, decimal_places=2)\n',
  "orders/views.py": 'from django.http import JsonResponse\nfrom .models import Order\n\n\ndef index(request):\n    return JsonResponse({"count": Order.objects.count()})\n',
  "requirements.txt": "Django==5.0\n",
};

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-agent-sim-"));
  for (const [rel, content] of Object.entries(DJANGO_FILES)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test("an agent following describe's own workflow reaches a validated snapshot", () => {
  const cwd = makeFixture();

  // ---- Step 1: verify. "prints v<version> on stdout and exits 0".
  const help = runCli(["--help"], { cwd });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /describe/);
  assert.match(help.stdout, /generate/);

  const version = runCli(["--version"], { cwd });
  assert.equal(version.code, 0, version.stderr);
  assert.match(version.stdout.trim(), /^v\d+\.\d+\.\d+/);

  // ---- Step 2: understand. "the full contract as JSON".
  const described = runCli(["describe", "--format", "json"], { cwd });
  assert.equal(described.code, 0, described.stderr);
  const contract = JSON.parse(described.stdout);

  assert.equal(contract.workflow.length, 6);
  for (const step of contract.workflow) {
    assert.equal(typeof step.run, "string");
    assert.equal(typeof step.expect, "string");
  }
  // The contract must not tell an agent to expect a version this build is not.
  assert.match(contract.workflow[0].expect, new RegExp(`v${contract.version.replace(/\./g, "\\.")}`));

  // Every published option must state where it applies, or an agent will pass it
  // to a command that silently ignores it.
  for (const option of contract.options) {
    assert.ok(option.appliesTo && option.appliesTo.length > 0, `${option.flag} has no appliesTo`);
  }
  assert.ok(contract.commands.length >= 8);
  assert.ok(contract.presets.length >= 20);
  assert.equal(typeof contract.exitCodes["2"], "string");

  // ---- Step 3: configure. "writes <config> listing every setting at its current value".
  const init = runCli(["init", "--yes"], { cwd });
  assert.equal(init.code, 0, init.stderr);
  const configName = fs
    .readdirSync(cwd)
    .find((name) => /^snapshot\.config\.(ts|mjs|cjs|js)$/.test(name));
  assert.ok(configName, "init wrote no config file");
  const configText = fs.readFileSync(path.join(cwd, configName), "utf8");
  for (const setting of contract.config.settings) {
    assert.match(
      configText,
      new RegExp(`\\b${setting.key}\\b`),
      `config is missing ${setting.key}, which the contract promises it lists`
    );
  }

  // ---- Step 4: generate. "exit 0, and ./snapshot/ written".
  const generated = runCli(["generate", "--format", "json"], { cwd });
  assert.equal(generated.code, 0, generated.stderr);
  const manifest = JSON.parse(generated.stdout);
  assert.ok(fs.existsSync(path.join(cwd, "snapshot", "manifest.json")));
  assert.equal(manifest.validation.status, "passed");

  // The fixture is a Django project and the contract publishes that preset, so an
  // agent that reads the preset list can predict this.
  assert.equal(manifest.config.preset, "python-django");

  // Every fixture file is accounted for, either included or explained.
  const included = new Set(manifest.files.map((file) => file.relativePath));
  const skipped = new Set(manifest.skipped.map((entry) => entry.path));
  for (const rel of Object.keys(DJANGO_FILES)) {
    assert.ok(
      included.has(rel) || skipped.has(rel),
      `${rel} is neither included nor explained in skipped[]`
    );
  }
  assert.equal(included.size + skipped.size >= Object.keys(DJANGO_FILES).length, true);

  // The contract tells agents manifest.files[] carries layer, kind, language and part.
  for (const file of manifest.files) {
    for (const key of [
      "relativePath",
      "layer",
      "kind",
      "language",
      "part",
      "sizeBytes",
      "lines",
      "hashSha256",
      "inclusionMode",
    ]) {
      assert.ok(file[key] !== undefined, `manifest.files[] entry missing ${key}`);
    }
  }

  // ---- Step 5: verify-output. "exit 0 means the snapshot matches the files on disk".
  const validated = runCli(["validate"], { cwd });
  assert.equal(validated.code, 0, validated.stderr);

  // ---- Step 6: consume. "read parts, then manifest, then audit".
  for (const part of manifest.parts) {
    assert.ok(fs.existsSync(path.join(cwd, "snapshot", "parts", part.filename)), part.filename);
  }
  const partText = fs.readFileSync(
    path.join(cwd, "snapshot", "parts", manifest.parts[0].filename),
    "utf8"
  );
  assert.match(partText, /orders\/models\.py/);
  assert.ok(fs.existsSync(path.join(cwd, "snapshot", "reports", "audit.md")));
});

test("the bundled skill is machine-readable too", () => {
  const cwd = makeFixture();
  const plain = runCli(["skill"], { cwd });
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /codebase-snapshot/);

  const json = runCli(["skill", "--format", "json"], { cwd });
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(typeof payload.skill, "string");
  assert.ok(payload.skill.length > 500);
  assert.match(payload.skill, /codebase-snapshot/);
});
