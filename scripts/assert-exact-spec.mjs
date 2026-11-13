#!/usr/bin/env node
/**
 * Refuses anything but an exact `name@x.y.z` spec for the release workflows.
 *
 * `npm deprecate` and `npm unpublish` accept semver ranges and apply the operation to every
 * matching version. The shell glob that guarded these jobs (`*@*.*.*`) accepted `pkg@>=1.2.3`,
 * `pkg@1.x.x` and `pkg@^1.2.3`, so one dispatch with a typo could deprecate every published
 * version above a floor. The check lives here, where it can be tested, instead of in YAML.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedName = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name;
const spec = process.argv[2] ?? "";

const at = spec.lastIndexOf("@");
const name = at > 0 ? spec.slice(0, at) : "";
const version = at > 0 ? spec.slice(at + 1) : "";
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const failure =
  at <= 0
    ? `spec must be an exact version like ${expectedName}@1.2.3 (received ${JSON.stringify(spec)})`
    : name !== expectedName
      ? `spec must name this package (${expectedName}), not ${JSON.stringify(name)}`
      : !exactVersion.test(version)
        ? `version must be exact (1.2.3 or 1.2.3-rc.1), not ${JSON.stringify(version)}`
        : null;

if (failure !== null) {
  console.error(`::error::${failure}`);
  process.exit(1);
}

console.log(`exact spec: ${spec}`);
