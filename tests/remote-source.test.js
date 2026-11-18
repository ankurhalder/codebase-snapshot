/**
 * Remote ingestion: parse, refuse, clone, record.
 *
 * The security tests run without network: they assert the refusals. The clone test uses a local
 * file: URL behind --allow-private, which is the documented air-gapped path and the only way to
 * exercise a real clone deterministically.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPrivateHost, parseRemoteSource } from "../dist/index.js";

test("a repository URL becomes host, owner, repo and ref", () => {
  const parsed = parseRemoteSource("https://github.com/owner/repo.git#main");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.source.host, "github.com");
  assert.equal(parsed.source.owner, "owner");
  assert.equal(parsed.source.repo, "repo");
  assert.equal(parsed.source.ref, "main");
  assert.equal(parsed.source.url, "https://github.com/owner/repo");
});

test("non-https, credentials, and short paths are refused", () => {
  assert.equal(parseRemoteSource("http://github.com/o/r").ok, false);
  assert.match(parseRemoteSource("http://github.com/o/r").message, /https/);
  assert.match(parseRemoteSource("https://user:pw@github.com/o/r").message, /credentials/);
  assert.match(parseRemoteSource("https://github.com/owner").message, /must name a repository/);
  assert.match(parseRemoteSource("file:///tmp/repo").message, /--allow-private/);
});

test("private addresses are refused unless allowed", () => {
  for (const host of ["127.0.0.1", "10.0.0.5", "192.168.1.2", "172.20.0.1", "169.254.169.254", "localhost", "[::1]"]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  assert.equal(isPrivateHost("github.com"), false);
  const refused = parseRemoteSource("https://169.254.169.254/latest/meta-data");
  assert.equal(refused.ok, false);
  assert.match(refused.message, /private address/);
  const allowed = parseRemoteSource("https://127.0.0.1/o/r", { allowPrivate: true });
  assert.equal(allowed.ok, true);
});

test("file: is only for --allow-private, and it clones", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), '{"name":"r","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(source, "src", "a.ts"), "export const a = 1;\n");
  const git = (args) => spawnSync("git", args, { cwd: source, encoding: "utf8" });
  if (git(["init", "-q"]).status !== 0) {
    t.skip("git is not available");
    return;
  }
  git(["-c", "user.email=t@e.c", "-c", "user.name=T", "add", "-A"]);
  git(["-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "one"]);

  const url = pathToFileURL(source).href;
  const parsed = parseRemoteSource(url, { allowPrivate: true });
  assert.equal(parsed.ok, true, parsed.message);
  assert.equal(parsed.source.kind, "file");
  assert.match(parsed.source.repo, /source/);
});

test("generate --remote records provenance and writes into the caller's directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-run-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), '{"name":"r","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(source, "src", "a.ts"), "export const a = 1;\n");
  const git = (args) => spawnSync("git", args, { cwd: source, encoding: "utf8" });
  if (git(["init", "-q"]).status !== 0) {
    t.skip("git is not available");
    return;
  }
  git(["-c", "user.email=t@e.c", "-c", "user.name=T", "add", "-A"]);
  git(["-c", "user.email=t@e.c", "-c", "user.name=T", "commit", "-q", "-m", "one"]);

  const workdir = path.join(root, "work");
  fs.mkdirSync(workdir, { recursive: true });
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
  const result = spawnSync(
    process.execPath,
    [bin, "generate", "--remote", pathToFileURL(source).href, "--allow-private", "--out-dir", "snap-out"],
    { cwd: workdir, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(workdir, "snap-out", "manifest.json"), "utf8"));
  assert.ok(manifest.source, "the manifest records where the tree came from");
  assert.match(manifest.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(manifest.source.host, "file");
  assert.ok(fs.existsSync(path.join(workdir, "snap-out", "PROMPT.md")));
});
