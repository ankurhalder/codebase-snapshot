# Project matrix — what 2.1.0 recognises

Every row is a preset: a detection rule, a set of layers and kinds, and a
recommended part budget. Detection is first-match-wins by priority, so a
Next.js repo inside a pnpm workspace is detected as `nextjs`, not `monorepo`.

`Summary` is the structural extraction available for that project's main
language: **ast** = real TypeScript compiler, **heuristic** = line-pattern
extraction (labelled as such in the manifest), **—** = files are included but
carry no structural summary.

---

## JS / TS frameworks

| Preset | Detection signal | Layers | Kinds | Summary | Budget |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `nextjs` | `next.config.*` or `next` in deps | app, features, shared, layout, scripts, docs, config, root | route, handler, repository, service, schema, model, type, hook, component, data, doc, script, config | **ast** | 300k |
| `react-vite` | `vite.config.*` + `react` dep | pages, components, hooks, services, shared, styles, scripts, docs, config, root | component, hook, service, type, style, data, doc, script, config | **ast** | 120k |
| `vue-vite` | `vite.config.*` + `vue` dep | pages, components, composables, stores, services, shared, styles, …, root | component (`.vue`), composable, store, service, style, … | **heuristic** (SFC) | 120k |
| `nuxt` | `nuxt.config.*` or `nuxt` dep | pages, components, composables, server, stores, layouts, …, root | component, composable, api-route, store, … | **heuristic** (SFC) | 200k |
| `sveltekit` | `svelte.config.*` or `@sveltejs/kit` | routes, lib, components, stores, params, … | route (`+page`/`+server`), component, store, … | **heuristic** | 200k |
| `angular` | `angular.json` or `@angular/core` | app, features, shared, core, assets, … | component (`*.component.ts`), service, module, guard, pipe, directive | **ast** | 200k |
| `astro` | `astro.config.*` | pages, layouts, components, content, … | page, layout, component, content | **heuristic** | 150k |
| `remix` | `@remix-run/*` dep | routes, components, lib, … | loader/action route, component, … | **ast** | 200k |
| `solid` | `vite.config.*` + `solid-js` | pages, components, … | component, hook, … | **ast** | 120k |

## Node backends

| Preset | Detection signal | Layers | Kinds | Summary | Budget |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `nest` | `@nestjs/core` dep | core, modules, controllers, providers, security, db, … | controller, service, module, guard, dto, entity, repository, migration | **ast** | 200k |
| `node-express` | `express` / `fastify` dep | core, protocols, providers, security, db, api, services, controllers, … | route, controller, service, provider, model, schema, security, db | **ast** | 200k |
| `node-lib` | `main`/`exports` + no framework | src, lib, test, scripts, docs, config, root | module, type, test, doc, config | **ast** | 120k |

## Other languages

| Preset | Detection signal | Layers | Kinds | Summary | Budget |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `python-django` | `manage.py` + `django` dep | apps, models, views, serializers, urls, migrations, settings, tests | model, view, serializer, urlconf, migration, test, settings, script | **heuristic** | 150k |
| `python-fastapi` | `fastapi` / `flask` dep | routers, models, schemas, services, core, tests, … | router, model, schema, service, dependency, test | **heuristic** | 150k |
| `python-lib` | `pyproject.toml` / `setup.py` | src, package, tests, docs, scripts, config | module, test, doc, config | **heuristic** | 120k |
| `go` | `go.mod` | cmd, internal, pkg, api, migrations, scripts, docs, config | main, handler, service, repository, model, migration, test | **heuristic** | 200k |
| `rust` | `Cargo.toml` | src, bins, crates, tests, benches, docs, config | module, bin, test, bench, config | **heuristic** | 200k |
| `java-spring` | `pom.xml` / `build.gradle` + `spring` | api, domain, service, repository, config, test | controller, service, repository, entity, dto, config, test | **heuristic** | 200k |
| `dotnet` | `*.csproj` / `*.sln` | web, domain, infrastructure, tests, config | controller, service, repository, model, dto, test | **heuristic** | 200k |
| `php-laravel` | `artisan` + `laravel/framework` | app, routes, http, models, providers, database, tests | controller, model, migration, middleware, request, provider, test | **heuristic** | 150k |
| `ruby-rails` | `Gemfile` + `rails` | app, config, db, lib, spec, … | controller, model, migration, job, mailer, test | **heuristic** | 150k |

## Repository shapes

| Preset | Detection signal | Layers | Summary | Budget |
| :--- | :--- | :--- | :--- | :--- |
| `monorepo` | `pnpm-workspace.yaml`, `workspaces` in package.json, `nx.json`, `turbo.json`, `lerna.json` | per-app (`apps/*`), per-package (`packages/*`), tooling, docs, config | per workspace language | 200k |
| `docs` | majority `.md`/`.mdx` | content, assets, config | — | 100k |
| `infra` | `*.tf`, `Dockerfile`, `helm/`, `k8s/` | modules, environments, manifests, scripts | — | 100k |
| `generic` | fallback | src, packages, scripts, docs, test, config, root | whatever profiles match | 120k |

---

## What **every** project gets, regardless of preset

These already work today and do not depend on language:

- Git-aware discovery (`git ls-files -z`), `.gitignore`, non-ASCII paths, symlink cycle guards
- Default ignore lists per ecosystem (see below)
- Credential deny list — `.env*`, `*.pem`, `*.key`, `.npmrc`, `.netrc`, `/.ssh/`, `/.aws/`, `/.kube/config`, `*.tfstate`
- All 21 redaction rules, span-only masking, whole-block PEM handling
- Byte-bounded parts, adaptive fences, previews for oversized files
- `navigation.md`, `project-tree.md`, `audit.md`, `manifest.json`, optional monolith
- `validate` drift detection, `explain`, `diff`, `--watch`

---

## Per-ecosystem default excludes (new)

Each preset contributes ignore patterns the generic list cannot know:

| Ecosystem | Added excludes |
| :--- | :--- |
| Python | `__pycache__`, `.venv`, `venv`, `*.pyc`, `.mypy_cache`, `.pytest_cache`, `.tox`, `*.egg-info` |
| Go | `vendor` (opt-in), `*.test`, `*.out` |
| Rust | `target` |
| Java / Kotlin | `build`, `.gradle`, `out`, `*.class` |
| .NET | `bin`, `obj`, `*.dll` |
| PHP | `vendor`, `storage`, `bootstrap/cache` |
| Ruby | `.bundle`, `tmp`, `log`, `vendor/bundle` |
| JS/TS | `node_modules`, `dist`, `.next`, `.turbo`, `coverage` (already present) |

These merge with `excludePatterns` rather than replacing it, and every excluded
file is recorded with its reason — so `snap explain` keeps working for all of them.

---

## Language coverage summary

| Language | Tagged | Summary | Notes |
| :--- | :--- | :--- | :--- |
| TypeScript / JavaScript | ✅ | **ast** | Real compiler API |
| JSON / JSONC | ✅ | structured | Key shapes, comment-aware |
| Markdown / MDX | ✅ | structured | Headings + frontmatter |
| Python | ✅ | heuristic | class / def / import |
| Go | ✅ | heuristic | func / type / import |
| Rust | ✅ | heuristic | fn / struct / trait / impl |
| Java, Kotlin, Scala | ✅ | heuristic | package / class / methods |
| C# | ✅ | heuristic | namespace / class / methods |
| PHP | ✅ | heuristic | namespace / class / function |
| Ruby | ✅ | heuristic | class / module / def |
| C, C++ | ✅ | heuristic | `#include` / functions / types |
| Vue, Svelte, Astro | ✅ | heuristic | SFC script-block extraction |
| Everything else | ✅ | — | Included and redacted, no summary |

Anything not on this table still produces a valid, safe, bounded snapshot — it
simply arrives as plain text. That is the existing behaviour and it does not
regress.
