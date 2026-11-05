import { fileEvidence, manifestEvidence, suffixEvidence } from "./evidence.js";
import type { PresetDefinition } from "./registry.js";
import { commonKinds, commonLayers, kindOf, layer, suffixKind } from "./helpers.js";

const DIR = (name: string): string => `${name}/`;

/**
 * Project shapes for non-JavaScript ecosystems.
 *
 * Each one also contributes the ignore rules that only make sense for that
 * language — `__pycache__`, `target`, `vendor` — because the generic list cannot
 * know them.
 *
 * Every detector reports the manifest or source file it matched, so the wizard can
 * say `Because go.mod` instead of asking the developer to trust the verdict.
 */
export const LANGUAGE_PRESETS: PresetDefinition[] = [
  {
    name: "python-django",
    priority: 56,
    detect: (context) =>
      fileEvidence(context, "manage.py") ??
      manifestEvidence(context, "pyproject.toml", "django") ??
      manifestEvidence(context, "requirements.txt", "django"),
    layers: [
      layer("views", DIR("views"), DIR("app/views"), DIR("apps/views")),
      layer("models", DIR("models"), DIR("app/models"), DIR("apps/models")),
      layer("serializers", DIR("serializers")),
      layer("urls", "urls.py"),
      layer("migrations", DIR("migrations")),
      layer("settings", "settings.py", "settings/"),
      layer("templates", DIR("templates")),
      ...commonLayers(),
    ],
    kinds: [
      suffixKind("model", "models.py"),
      suffixKind("view", "views.py"),
      suffixKind("serializer", "serializers.py"),
      suffixKind("urlconf", "urls.py"),
      kindOf("migration", "migrations/"),
      suffixKind("settings", "settings.py"),
      ...commonKinds(),
    ],
    exclude: ["__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".tox", ".eggs", "staticfiles", "media"],
    recommendedBudget: "150k",
  },
  {
    name: "python-fastapi",
    priority: 54,
    detect: (context) =>
      manifestEvidence(context, "requirements.txt", "fastapi") ??
      manifestEvidence(context, "requirements.txt", "flask") ??
      manifestEvidence(context, "pyproject.toml", "fastapi") ??
      manifestEvidence(context, "pyproject.toml", "flask"),
    layers: [
      layer("routers", DIR("routers"), DIR("routes"), DIR("api")),
      layer("models", DIR("models"), DIR("db")),
      layer("schemas", DIR("schemas")),
      layer("services", DIR("services")),
      layer("core", DIR("core")),
      layer("tests", DIR("tests")),
      ...commonLayers(),
    ],
    kinds: [
      kindOf("router", "routers/", "routes/", "api/"),
      kindOf("model", "models/"),
      kindOf("schema", "schemas/"),
      kindOf("service", "services/"),
      ...commonKinds(),
    ],
    exclude: ["__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".tox", ".eggs"],
    recommendedBudget: "150k",
  },
  {
    name: "python-lib",
    // Below node-lib: a Node repo with a stray .py file is still a Node repo.
    priority: 30,
    detect: (context) =>
      fileEvidence(context, "pyproject.toml") ??
      fileEvidence(context, "setup.py") ??
      fileEvidence(context, "requirements.txt") ??
      suffixEvidence(context, ".py"),
    layers: [
      layer("package", DIR("src"), DIR("lib")),
      layer("tests", DIR("tests"), DIR("test")),
      ...commonLayers(),
    ],
    kinds: [suffixKind("module", ".py"), ...commonKinds()],
    exclude: ["__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".tox", ".eggs"],
    recommendedBudget: "120k",
  },
  {
    name: "go",
    priority: 50,
    detect: (context) => fileEvidence(context, "go.mod"),
    layers: [
      layer("cmd", "cmd/"),
      layer("internal", "internal/"),
      layer("pkg", "pkg/"),
      layer("api", "api/", "proto/"),
      layer("migrations", "migrations/"),
      ...commonLayers(),
    ],
    kinds: [
      kindOf("main", "cmd/"),
      kindOf("handler", "handler", "server", "http"),
      kindOf("service", "service"),
      kindOf("repository", "repository", "store", "repo"),
      kindOf("model", "model", "entity"),
      suffixKind("test", "_test.go"),
      ...commonKinds(),
    ],
    exclude: ["vendor", "testdata"],
    recommendedBudget: "200k",
  },
  {
    name: "rust",
    priority: 48,
    detect: (context) => fileEvidence(context, "Cargo.toml"),
    layers: [
      layer("src", "src/"),
      layer("crates", "crates/"),
      layer("bins", "src/bin/"),
      layer("tests", "tests/"),
      layer("benches", "benches/"),
      ...commonLayers(),
    ],
    kinds: [suffixKind("module", ".rs"), suffixKind("test", "_test.rs"), ...commonKinds()],
    exclude: ["target"],
    recommendedBudget: "200k",
  },
  {
    name: "java-spring",
    priority: 46,
    detect: (context) =>
      fileEvidence(context, "pom.xml") ??
      fileEvidence(context, "build.gradle") ??
      fileEvidence(context, "build.gradle.kts"),
    layers: [
      layer("api", "src/main/java/"),
      layer("test", "src/test/java/"),
      layer("resources", "src/main/resources/"),
      layer("migrations", "src/main/resources/db/"),
      ...commonLayers(),
    ],
    kinds: [
      kindOf("controller", "controller"),
      kindOf("service", "service"),
      kindOf("repository", "repository", "dao"),
      kindOf("entity", "entity", "model"),
      kindOf("dto", "dto", "request", "response"),
      kindOf("migration", "migration", "db/migration"),
      ...commonKinds(),
    ],
    exclude: [".gradle", "out", "target"],
    recommendedBudget: "200k",
  },
  {
    name: "dotnet",
    priority: 44,
    detect: (context) =>
      suffixEvidence(context, ".csproj") ??
      suffixEvidence(context, ".sln") ??
      fileEvidence(context, "global.json"),
    layers: [
      layer("web", "src/", "Web/"),
      layer("domain", "Domain/", "Core/"),
      layer("infrastructure", "Infrastructure/", "Data/"),
      layer("tests", "Tests/", "test/"),
      ...commonLayers(),
    ],
    kinds: [
      kindOf("controller", "Controller"),
      kindOf("service", "Service"),
      kindOf("repository", "Repository"),
      kindOf("model", "Model", "Entity"),
      kindOf("dto", "Dto", "Request", "Response"),
      suffixKind("test", "Tests.cs"),
      ...commonKinds(),
    ],
    exclude: ["bin", "obj", ".vs"],
    recommendedBudget: "200k",
  },
  {
    name: "php-laravel",
    priority: 42,
    detect: (context) =>
      fileEvidence(context, "artisan") ??
      manifestEvidence(context, "composer.json", "laravel") ??
      fileEvidence(context, "composer.json"),
    layers: [
      layer("app", "app/"),
      layer("routes", "routes/"),
      layer("http", "app/Http/"),
      layer("models", "app/Models/"),
      layer("providers", "app/Providers/"),
      layer("database", "database/"),
      layer("tests", "tests/"),
      ...commonLayers(),
    ],
    kinds: [
      kindOf("controller", "Http/Controllers/"),
      kindOf("model", "Models/"),
      kindOf("migration", "migrations/"),
      kindOf("middleware", "Middleware/"),
      kindOf("request", "Requests/"),
      kindOf("provider", "Providers/"),
      ...commonKinds(),
    ],
    exclude: ["vendor", "storage", "bootstrap/cache", "public/build"],
    recommendedBudget: "150k",
  },
  {
    name: "ruby-rails",
    priority: 40,
    detect: (context) =>
      fileEvidence(context, "Gemfile") ??
      fileEvidence(context, "config.ru") ??
      fileEvidence(context, "Rakefile"),
    layers: [
      layer("app", "app/"),
      layer("controllers", "app/controllers/"),
      layer("models", "app/models/"),
      layer("config", "config/"),
      layer("db", "db/"),
      layer("spec", "spec/", "test/"),
      ...commonLayers(),
    ],
    kinds: [
      kindOf("controller", "controllers/"),
      kindOf("model", "models/"),
      kindOf("migration", "migrate/"),
      kindOf("job", "jobs/"),
      kindOf("mailer", "mailers/"),
      suffixKind("test", "_spec.rb", "_test.rb"),
      ...commonKinds(),
    ],
    exclude: [".bundle", "log", "tmp", "vendor/bundle", "public/assets"],
    recommendedBudget: "150k",
  },
];
