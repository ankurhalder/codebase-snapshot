import type { PresetContext } from "./context.js";
import { hasFile, manifestContains } from "./context.js";
import type { PresetDefinition } from "./registry.js";
import { commonKinds, commonLayers, kindOf, layer, suffixKind } from "./helpers.js";

const anyFileEndingWith = (context: PresetContext, suffix: string): boolean =>
  Array.from(context.files).some((file) => file.endsWith(suffix));

const DIR = (name: string): string => `${name}/`;

/**
 * Project shapes for non-JavaScript ecosystems.
 *
 * Each one also contributes the ignore rules that only make sense for that
 * language — `__pycache__`, `target`, `vendor` — because the generic list cannot
 * know them.
 */
export const LANGUAGE_PRESETS: PresetDefinition[] = [
  {
    name: "python-django",
    priority: 56,
    detect: (context) =>
      hasFile(context, "manage.py") ||
      manifestContains(context, "pyproject.toml", "django") ||
      manifestContains(context, "requirements.txt", "django"),
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
      manifestContains(context, "requirements.txt", "fastapi") ||
      manifestContains(context, "requirements.txt", "flask") ||
      manifestContains(context, "pyproject.toml", "fastapi") ||
      manifestContains(context, "pyproject.toml", "flask"),
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
    priority: 52,
    detect: (context) =>
      hasFile(context, "pyproject.toml") ||
      hasFile(context, "setup.py") ||
      hasFile(context, "requirements.txt") ||
      anyFileEndingWith(context, ".py"),
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
    detect: (context) => hasFile(context, "go.mod"),
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
    detect: (context) => hasFile(context, "Cargo.toml"),
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
      hasFile(context, "pom.xml") ||
      hasFile(context, "build.gradle") ||
      hasFile(context, "build.gradle.kts"),
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
      anyFileEndingWith(context, ".csproj") ||
      anyFileEndingWith(context, ".sln") ||
      hasFile(context, "global.json"),
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
      hasFile(context, "artisan") ||
      manifestContains(context, "composer.json", "laravel") ||
      hasFile(context, "composer.json"),
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
      hasFile(context, "Gemfile") ||
      hasFile(context, "config.ru") ||
      hasFile(context, "Rakefile"),
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
