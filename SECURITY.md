# Security policy

## Supported versions

Only the latest published release receives security fixes.

| Version | Supported |
| :--- | :--- |
| <!--@majorMinor-->0.9<!--/@majorMinor-->.x | ✅ |
| anything older | ❌ |

The number line restarted at 0.9.0 when the package moved to the unscoped `codebase-snapshot` name,
so <!--@majorMinor-->0.9<!--/@majorMinor-->.x is newer than 4.4.1, not older. That is explained in full in the
[changelog](CHANGELOG.md#a-note-on-version-numbers).

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Email **ankur.halder12345@gmail.com** with:

- what the issue is and which version you reproduced it on,
- the smallest reproduction you can construct,
- the impact you believe it has.

You can expect an acknowledgement within a few days. If the report is valid, a fix and a
release will follow, and you will be credited in the release notes unless you ask otherwise.

## Scope

`codebase-snapshot` reads a repository and writes files. The security-relevant surfaces are:

**Secret handling.** Credential-bearing files (`.env`, `*.pem`, `*.key`, `.npmrc`, `.netrc`,
`.git-credentials`, `id_rsa`, `.kube/config`, `*.tfstate` and similar) are excluded by default.
Secret-shaped strings inside ordinary files are redacted in the emitted parts; only the matched
span is masked and no excerpt of a matched line is written to any artifact.

Detection is **pattern-based**, so it recognises the shapes it knows and nothing else. A
secret deliberately split across two string literals, joined with a backslash line
continuation, or assembled by template-literal concatenation can be missed, because the
pattern never sees the whole value on one line.

In YAML and similar `key: value` files, the file type decides how an **unquoted** value is read.
A strong credential name in colon form — `password:`, `token:`, `api_key:` — makes the rest of
the line a value, and in a data or shell file that value is masked whole whatever symbols it
holds: `password: pa&ss` and `password: getPassword() & 0xff` are masked in a `.yaml`, while the
same lines in a `.ts` are left as written, because there they are expressions and the tool does
not edit expressions. In a source file a value that reads like a reference —
`password: opts.db.password` — is emitted as written; an unquoted value in a declaration is an
initializer, not a credential.

A punctuation-led value is masked when the token also carries a digit or a second punctuation
character — `token: !hunter2hunter2` is masked, while YAML tags such as `!Ref` and prose words such
as `!important` stay readable. Quote the value — `password: "…"` — when you need certainty: a
quoted value under a credential-shaped name is masked whatever it contains.

In a data or shell file a **colon-form** assignment is masked whole even when a symbol would make
the value impossible to bound — it runs to the end of the line (a trailing `#` comment is kept, and
the match is capped at 300 characters). In source code such a match is dropped instead, so no
marker is written in front of an expression. The `.env`/shell `NAME=value` rule also masks its
whole value, comment aside. The `=` form outside those files is the remaining gap: it expects the
uppercase names `.env`-style formats use, so a lowercase `key=value` in an INI or properties file
is masked only while its value stays inside the rules' alphabet — one containing `&`, `<`, `>`,
`|` or a backslash can be left unmasked.

A clean audit is therefore evidence that the known patterns did not fire — not a guarantee
that the repository holds no credentials.

Reports we want to hear about: a pattern that is *not* detected, a redaction that leaves the
secret readable elsewhere (a report file, the manifest, a navigation index), or a way to make
the tool emit a sensitive file without `--include-sensitive-files`.

**Filesystem safety.** The output directory is written to a scratch directory and swapped in
atomically, and it is only replaced when a previous run wrote it. Ownership is proved by the
`.codebase-snapshot` marker — a JSON object naming this generator, with a schema version, a
per-snapshot id and the entries it wrote — not by a filename and not by a manifest alone.
`outDir`/`tmpDir` may not be the working directory, an ancestor, or the filesystem root, and
may not contain one another.

The marker is **evidence, not authentication**. It is unsigned and carries no secret, so anyone
who can write a marker and a stub manifest with a matching digest can satisfy the check — but
anyone who can write those files can also delete the directory by hand. The guard exists to stop
the tool from deleting a directory *it* did not create; it is not a defence against an attacker
who already has write access to the output path.

Reports we want to hear about: any path configuration that deletes or overwrites files the tool
did not create.

**Supply chain.** The package has exactly one runtime dependency (`typescript`), publishes with
provenance from a pinned GitHub Actions workflow, and every third-party action in that workflow is pinned
to a full commit SHA.

## Trust boundary

A configuration file is **code, and it runs**.

`snapshot.config.ts`, `.js`, `.mjs` and `.cjs` are imported by the CLI and executed in your
Node process. That is deliberate and cannot be avoided: a config that can express a `RegExp`
or a `match` function — and both are documented — has to be evaluable code. Only
`snapshot.config.json`, `.snapshotrc`, `.snapshotrc.json` and the `"snapshot"` key of
`package.json` are inert: they are parsed as data, never executed.

So running the tool inside a repository loads the code that repository's config contains. The
repository you scan is not necessarily a repository you own — a vendor drop, a dependency
checkout, a pull request under review, a CI job that scans contributed code.

- **`--no-config` avoids it.** The flag ignores every config file and runs on the built-in
  defaults plus the detected preset, so nothing from the repository is imported.
- **Do not run the tool in a repository you do not trust** without `--no-config` — and do not
  point `--cwd` at one. Review the config first, or run the scan somewhere with no credentials
  in reach.
- **`hooks.afterGenerate` is the same surface.** It is a function in the config, called after
  a successful run, in the process working directory, with the manifest as its argument.

This is a property of configuration-as-code, not a bug to be reported. What *is* in scope is
anything that widens it: a config format that executes when the documentation says it is
inert, a config loaded from a location the docs do not name, or a path where config code runs
when `--no-config` was passed.

## Not in scope

- The declared behaviour of `--include-sensitive-files` or a `customPatterns` redaction rule the
  user configured themselves.
- Obfuscated forms: a credential packed inside an archive, compressed, or otherwise not
  recognisable by shape is not something the redaction rules can find, and a report that one
  survived this way is out of scope rather than a defect. One obfuscation *is* covered: a
  base64-encoded PEM file, whose encoded form begins `LS0tLS1CRUdJTi` (`-----BEGIN `), is matched
  by the `base64-private-key` rule without decoding it.
- Secrets that are already committed to a public repository, unless the tool emits them into a
  snapshot they would otherwise not appear in.
- Anything that requires an attacker to already control the machine running the tool.
