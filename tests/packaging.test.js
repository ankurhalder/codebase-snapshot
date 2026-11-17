/**
 * Packaging: the Dockerfile and its entrypoint stay in step with the files they copy.
 *
 * Docker is not available in this environment, so the build itself is not exercised here. What is
 * checked is the class of mistake that makes a Dockerfile rot: a COPY of a path that no longer
 * exists, an unpinned base image, and an entrypoint that starts the server without a token.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..");

test("every COPY source in the Dockerfile exists", () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const copies = dockerfile.split("\n").filter((line) => line.startsWith("COPY "));
  assert.ok(copies.length >= 3, "the Dockerfile copies the bundle and the entrypoint");
  for (const line of copies) {
    const parts = line.replace("COPY ", "").trim().split(/\s+/);
    const sources = parts.slice(0, -1);
    for (const source of sources) {
      assert.ok(!source.startsWith("--"), "no COPY flags expected: " + line);
      assert.ok(fs.existsSync(path.join(ROOT, source)), "COPY source missing: " + source);
    }
  }
});

test("the base image is pinned to a version, not latest", () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const from = /^FROM\s+(\S+)/m.exec(dockerfile);
  assert.ok(from, "a FROM line exists");
  assert.doesNotMatch(from[1], /:latest$/, "no floating latest tag");
  assert.match(from[1], /:[0-9]/, "a version tag is present");
});

test("the entrypoint refuses to start without a token", () => {
  const script = fs.readFileSync(path.join(ROOT, "scripts", "docker-entrypoint.sh"), "utf8");
  assert.match(script, /SNAPSHOT_TOKEN/);
  assert.match(script, /-z "\$\{SNAPSHOT_TOKEN:-\}"/);
  assert.match(script, /exit 1/);
  assert.match(script, /serve --host 0\.0\.0\.0/);
  assert.match(script, /--token "\$SNAPSHOT_TOKEN"/);
});

test("the dockerignore keeps the image small and free of repository state", () => {
  const ignore = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8").split("\n");
  for (const entry of ["node_modules", ".git", "snapshot", "tests"]) {
    assert.ok(ignore.includes(entry), ".dockerignore excludes " + entry);
  }
});
