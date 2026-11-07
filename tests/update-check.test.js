/**
 * The update notice.
 *
 * Every test injects the fetcher, so the suite never touches the network — and the cases that
 * matter are the ones where a network call would be wrong: a cold cache, a warm cache, a hostile
 * network, and every invocation shape that must not ask at all.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  CHECK_INTERVAL_MS,
  FAILURE_INTERVAL_MS,
  cacheFilePath,
  checkForUpdate,
  formatUpdateNotice,
  installKind,
  isNewer,
  shouldCheck,
} from "../dist/index.js";

function tempCache(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "update-check.json");
}

/** A fetcher that records calls and answers with whatever the test says. */
function stubFetcher(answer) {
  const calls = [];
  const fetchLatest = async (url) => {
    calls.push(url);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, fetchLatest };
}

test("version comparison", async (t) => {
  await t.test("a higher patch, minor and major are each newer", () => {
    assert.equal(isNewer("0.9.6", "0.9.5"), true);
    assert.equal(isNewer("0.10.0", "0.9.9"), true);
    assert.equal(isNewer("1.0.0", "0.9.9"), true);
  });

  await t.test("equal and older versions are not newer", () => {
    assert.equal(isNewer("0.9.5", "0.9.5"), false);
    assert.equal(isNewer("0.9.4", "0.9.5"), false);
  });

  await t.test("a prerelease compares equal to its release, never newer", () => {
    assert.equal(isNewer("0.9.5-beta.1", "0.9.5"), false);
  });

  await t.test("a leading v is tolerated", () => {
    assert.equal(isNewer("v0.9.6", "0.9.5"), true);
  });
});

test("which invocations may ask", async (t) => {
  const plain = (argv, env = {}) => shouldCheck(argv, env);

  await t.test("a human-facing command in a terminal may ask", () => {
    assert.equal(plain([]), true);
    assert.equal(plain(["generate"]), true);
    assert.equal(plain(["validate"]), true);
  });

  await t.test("the notice never runs where it would cost something", () => {
    for (const argv of [["mcp"], ["describe"], ["skill"], ["--version"], ["-v"], ["--help"]]) {
      assert.equal(plain(argv), false, `${argv.join(" ")} must not check`);
    }
  });

  await t.test("a JSON invocation must not check", () => {
    assert.equal(plain(["generate", "--format", "json"]), false);
    assert.equal(plain(["generate", "--format=json"]), false);
  });

  await t.test("CI and explicit opt-outs are honoured", () => {
    assert.equal(plain(["generate"], { CI: "true" }), false);
    assert.equal(plain(["generate"], { CODEBASE_SNAPSHOT_NO_UPDATE_CHECK: "1" }), false);
    assert.equal(plain(["generate", "--no-update-check"]), false);
  });

  await t.test("CI=false is not CI", () => {
    assert.equal(plain(["generate"], { CI: "false" }), true);
  });
});

test("the cache decides whether the network is touched", async (t) => {
  await t.test("a cold cache asks once and remembers the answer", async () => {
    const cacheFile = tempCache(t);
    const fetcher = stubFetcher("0.9.9");

    const notice = await checkForUpdate({
      current: "0.9.5",
      cacheFile,
      fetchLatest: fetcher.fetchLatest,
      now: () => 1000,
    });

    assert.deepEqual(notice, { current: "0.9.5", latest: "0.9.9" });
    assert.equal(fetcher.calls.length, 1);
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert.deepEqual(cached, { checkedAt: 1000, latest: "0.9.9" });
  });

  await t.test("a warm cache does not ask again", async () => {
    const cacheFile = tempCache(t);
    fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: 1000, latest: "0.9.9" }));
    const fetcher = stubFetcher("ignored");

    const notice = await checkForUpdate({
      current: "0.9.5",
      cacheFile,
      fetchLatest: fetcher.fetchLatest,
      now: () => 1000 + CHECK_INTERVAL_MS - 1,
    });

    assert.equal(notice.latest, "0.9.9");
    assert.equal(fetcher.calls.length, 0, "a cached answer costs no request");
  });

  await t.test("a stale cache asks again", async () => {
    const cacheFile = tempCache(t);
    fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: 1000, latest: "0.9.6" }));
    const fetcher = stubFetcher("0.9.9");

    await checkForUpdate({
      current: "0.9.5",
      cacheFile,
      fetchLatest: fetcher.fetchLatest,
      now: () => 1000 + CHECK_INTERVAL_MS + 1,
    });

    assert.equal(fetcher.calls.length, 1);
  });

  await t.test("a failed check is remembered for the short interval, not the long one", async () => {
    const cacheFile = tempCache(t);
    const fetcher = stubFetcher(null);

    const first = await checkForUpdate({
      current: "0.9.5",
      cacheFile,
      fetchLatest: fetcher.fetchLatest,
      now: () => 1000,
    });
    assert.equal(first, null);

    const second = await checkForUpdate({
      current: "0.9.5",
      cacheFile,
      fetchLatest: fetcher.fetchLatest,
      now: () => 1000 + FAILURE_INTERVAL_MS - 1,
    });
    assert.equal(second, null);
    assert.equal(fetcher.calls.length, 1, "one blip does not retry on every run");

    await checkForUpdate({
      current: "0.9.5",
      cacheFile,
      fetchLatest: fetcher.fetchLatest,
      now: () => 1000 + FAILURE_INTERVAL_MS + 1,
    });
    assert.equal(fetcher.calls.length, 2, "but it does not hide a release for a day either");
  });

  await t.test("an exception from the fetcher is never thrown at the caller", async () => {
    const cacheFile = tempCache(t);
    const fetcher = stubFetcher(new Error("offline"));

    const notice = await checkForUpdate({
      current: "0.9.5",
      cacheFile,
      fetchLatest: fetcher.fetchLatest,
      now: () => 1000,
    });
    assert.equal(notice, null);
  });

  await t.test("a corrupt cache is treated as a miss", async () => {
    const cacheFile = tempCache(t);
    fs.writeFileSync(cacheFile, "{not json");
    const fetcher = stubFetcher("0.9.9");

    const notice = await checkForUpdate({
      current: "0.9.5",
      cacheFile,
      fetchLatest: fetcher.fetchLatest,
      now: () => 1000,
    });
    assert.equal(notice.latest, "0.9.9");
  });

  await t.test("being up to date produces no notice", async () => {
    const cacheFile = tempCache(t);
    const fetcher = stubFetcher("0.9.5");
    const notice = await checkForUpdate({
      current: "0.9.5",
      cacheFile,
      fetchLatest: fetcher.fetchLatest,
      now: () => 1000,
    });
    assert.equal(notice, null);
  });

  await t.test("a local build newer than the registry says nothing", async () => {
    const cacheFile = tempCache(t);
    const fetcher = stubFetcher("0.9.5");
    const notice = await checkForUpdate({
      current: "0.9.6",
      cacheFile,
      fetchLatest: fetcher.fetchLatest,
      now: () => 1000,
    });
    assert.equal(notice, null);
  });

  await t.test("disabled means no request and no cache read", async () => {
    const cacheFile = tempCache(t);
    const fetcher = stubFetcher("0.9.9");
    const notice = await checkForUpdate({
      current: "0.9.5",
      cacheFile,
      fetchLatest: fetcher.fetchLatest,
      enabled: false,
      now: () => 1000,
    });
    assert.equal(notice, null);
    assert.equal(fetcher.calls.length, 0);
  });
});

test("the notice names both versions and the command to run", () => {
  const text = formatUpdateNotice({ current: "0.9.5", latest: "0.9.6" }, "global");
  assert.match(text, /0\.9\.6 is available/);
  assert.match(text, /you have 0\.9\.5/);
  assert.match(text, /npm install -g codebase-snapshot/);
  assert.equal(text.split("\n").length, 2, "two lines, not a paragraph");
});

test("the command it suggests matches how the tool was reached", () => {
  const notice = { current: "0.9.5", latest: "0.9.6" };
  // A global install is replaced by a global install.
  assert.match(formatUpdateNotice(notice, "global"), /^ {2}npm install -g codebase-snapshot$/m);
  // A devDependency keeps its place: `-g` would install a second copy that shadows the pinned one.
  assert.match(formatUpdateNotice(notice, "local"), /^ {2}npm install codebase-snapshot@latest$/m);
  // An npx invocation is a cache entry; the documented way to move it is the next run.
  assert.match(formatUpdateNotice(notice, "npx"), /^ {2}npx -y codebase-snapshot@latest$/m);
});

test("installKind reads the script path, not a guess", () => {
  const project = path.join("C:", "work", "app");
  assert.equal(
    installKind(path.join(project, "node_modules", "codebase-snapshot", "dist", "bin.js"), project),
    "local"
  );
  assert.equal(
    installKind(
      "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\codebase-snapshot\\dist\\bin.js",
      project
    ),
    "npx"
  );
  assert.equal(
    installKind("C:\\nvm4w\\nodejs\\node_modules\\codebase-snapshot\\dist\\bin.js", project),
    "global"
  );
  // A global install whose own path happens to sit under the working directory is not a dependency
  // of it; the `node_modules` segment is what makes that distinction.
  assert.equal(installKind(path.join(project, "dist", "bin.js"), project), "global");
  assert.equal(installKind("", project), "global");
});

test("the cache lives under the platform's cache directory", () => {
  assert.match(cacheFilePath({ LOCALAPPDATA: "C:/cache" }), /codebase-snapshot/);
  assert.ok(cacheFilePath({}).endsWith(path.join("codebase-snapshot", "update-check.json")));
});
