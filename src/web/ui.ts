/**
 * The page `snapshot serve` serves.
 *
 * One file, no framework, no build step: the same rule that keeps the package dependency-free. It
 * is a form (a path or a repository URL), a status line, the brief, the file tree and a download.
 * The token is not baked into the page — the page asks for it and keeps it in localStorage — so an
 * exposed server cannot leak its own credential by serving /.
 */
export const SERVE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>codebase-snapshot</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #c9d1d9; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { padding: 18px 22px; border-bottom: 1px solid #21262d; display: flex; gap: 14px; align-items: baseline; }
  header b { color: #f0f6fc; font-size: 16px; }
  header span { color: #8b949e; }
  main { max-width: 1100px; margin: 0 auto; padding: 22px; display: grid; gap: 18px; }
  form { display: flex; gap: 8px; flex-wrap: wrap; }
  input, button { font: inherit; background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 8px 10px; }
  input { flex: 1 1 420px; }
  button { cursor: pointer; }
  button:hover { border-color: #58a6ff; color: #ffffff; }
  button:disabled { opacity: .5; cursor: default; }
  #status { color: #8b949e; min-height: 22px; white-space: pre-wrap; }
  .ok { color: #3fb950; } .bad { color: #f85149; } .warn { color: #d29922; }
  section { border: 1px solid #21262d; border-radius: 8px; overflow: hidden; }
  section h2 { margin: 0; padding: 10px 14px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #8b949e; background: #161b22; border-bottom: 1px solid #21262d; display: flex; justify-content: space-between; }
  pre { margin: 0; padding: 14px; overflow: auto; max-height: 320px; white-space: pre-wrap; word-break: break-word; }
  ul { margin: 0; padding: 10px 14px 10px 28px; columns: 2; }
  li { break-inside: avoid; color: #8b949e; }
  li b { color: #c9d1d9; font-weight: 500; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 760px) { .row { grid-template-columns: 1fr; } ul { columns: 1; } }
  code { color: #79c0ff; }
</style>
</head>
<body>
<header><b>codebase-snapshot</b><span>a snapshot an agent can trust</span></header>
<main>
  <form id="gen">
    <input id="source" placeholder="/absolute/path/to/repo   or   https://github.com/owner/repo" spellcheck="false" autofocus>
    <select id="mode" title="What to generate">
      <option value="full">whole repository</option>
      <option value="slice">a slice for a question</option>
      <option value="budget">fit a token budget</option>
    </select>
    <input id="question" placeholder="the question (slice mode)" spellcheck="false" hidden>
    <input id="budget" type="number" min="500" step="500" value="30000" title="token budget" hidden>
    <button id="run" type="submit">Generate</button>
    <button id="download" type="button" disabled>Download .zip</button>
  </form>
  <div id="status">Paste an absolute path, or a repository URL (https://github.com/owner/repo). Remote fetches are shallow and public-only.</div>
  <div id="auth" hidden>
    <form id="token-form"><input id="token" type="password" placeholder="paste the token printed by snapshot serve" style="flex:1"><button type="submit">Use token</button></form>
  </div>
  <div class="row">
    <section><h2>Brief <span id="fingerprint"></span></h2><pre id="brief">No snapshot loaded.</pre></section>
    <section><h2>Files <span id="counts"></span></h2><ul id="files"></ul></section>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let token = localStorage.getItem("snapshot-token") || "";
  let snapshotPath = "";
  const auth = (headers = {}) => token ? { ...headers, authorization: "Bearer " + token } : headers;
  const showAuth = (yes) => { $("auth").hidden = !yes; };
  const status = (text, kind) => { $("status").className = kind || ""; $("status").textContent = text; };
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: auth(options.headers || {}) });
    if (response.status === 401) { showAuth(true); throw new Error("token required"); }
    if (!response.ok) throw new Error((await response.text()) || response.statusText);
    return response;
  }
  $("token-form").addEventListener("submit", (event) => {
    event.preventDefault();
    token = $("token").value.trim();
    localStorage.setItem("snapshot-token", token);
    showAuth(false);
    status("Token stored.");
  });
  $("mode").addEventListener("change", () => {
    const mode = $("mode").value;
    $("question").hidden = mode !== "slice";
    $("budget").hidden = mode !== "budget";
  });
  $("gen").addEventListener("submit", async (event) => {
    event.preventDefault();
    const source = $("source").value.trim();
    if (!source) return;
    $("run").disabled = true;
    status("Generating...");
    try {
      const response = await api("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source,
          mode: $("mode").value,
          question: $("question").value.trim(),
          budgetTokens: Number($("budget").value),
        }),
      });
      const result = await response.json();
      snapshotPath = result.path;
      $("download").disabled = false;
      status(
        "Generated " + result.files + " files (" + (result.mode || "full") + ") in " + result.seconds + "s, " +
          result.parts + " part(s), " + result.tokens + " estimated tokens." +
          (result.dropped === undefined ? "" : " " + result.dropped + " path(s) not selected.") +
          (result.warning ? " " + result.warning : ""),
        result.warning ? "warn" : "ok"
      );
      await load();
    } catch (error) {
      status(String(error.message || error), "bad");
    } finally {
      $("run").disabled = false;
    }
  });
  async function load() {
    const info = await (await api("/api/snapshot?path=" + encodeURIComponent(snapshotPath))).json();
    $("fingerprint").textContent = info.fingerprint.slice(0, 12);
    $("brief").textContent = info.prompt;
    $("counts").textContent = info.included + " included / " + info.skipped + " skipped";
    $("files").innerHTML = "";
    for (const file of info.files.slice(0, 400)) {
      const li = document.createElement("li");
      li.innerHTML = "<b>" + file.path.replace(/[<>&]/g, "") + "</b> " + file.part;
      $("files").appendChild(li);
    }
  }
  $("download").addEventListener("click", async () => {
    const response = await api("/api/snapshot.zip?path=" + encodeURIComponent(snapshotPath));
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "snapshot.zip";
    link.click();
    URL.revokeObjectURL(link.href);
  });
</script>
</body>
</html>`;
