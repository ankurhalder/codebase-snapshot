import type { PresetDefinition } from "./registry.js";
import { dependencyEvidence, fileEvidence, fileStartingWithEvidence } from "./evidence.js";
import { commonKinds, commonLayers, kindOf, layer, suffixKind } from "./helpers.js";
import { NEXTJS_LAYERS, NEXTJS_KINDS } from "./nextjs.js";
import { NODE_LAYERS, NODE_KINDS } from "./node.js";
import { VITE_LAYERS, VITE_KINDS } from "./vite.js";

const NEXT_LIKE_EXCLUDES = [".svelte-kit", ".astro", ".vite", ".output"];

/**
 * JavaScript and TypeScript project shapes.
 *
 * Detection reads the shared {@link PresetContext}, so a repository is inspected
 * once no matter how many detectors run, and peer dependencies count — a library
 * that only peer-depends on `next` is still a Next.js project.
 *
 * Each detector returns the signal that fired, not a boolean: the first-run wizard
 * prints it back, so a detection can be checked rather than taken on faith.
 */
export const JS_PRESETS: PresetDefinition[] = [
  {
    name: "nextjs",
    priority: 100,
    detect: (context) =>
      fileStartingWithEvidence(context, "next.config") ?? dependencyEvidence(context, "next"),
    layers: NEXTJS_LAYERS,
    kinds: NEXTJS_KINDS,
    exclude: NEXT_LIKE_EXCLUDES,
    recommendedBudget: "300k",
  },
  {
    name: "nuxt",
    priority: 98,
    detect: (context) =>
      fileStartingWithEvidence(context, "nuxt.config") ??
      dependencyEvidence(context, "nuxt", "nuxt3"),
    layers: [
      layer("pages", "pages/", "src/pages/"),
      layer("components", "components/", "src/components/"),
      layer("composables", "composables/", "src/composables/"),
      layer("server", "server/", "src/server/", "api/"),
      layer("stores", "stores/", "src/stores/"),
      layer("layouts", "layouts/", "src/layouts/"),
      ...commonLayers(),
    ],
    kinds: [
      kindOf("api-route", "server/api/", "server/routes/"),
      suffixKind("component", ".vue"),
      kindOf("composable", "composables/"),
      kindOf("store", "stores/", "store/"),
      kindOf("layout", "layouts/"),
      ...commonKinds(),
    ],
    exclude: [".nuxt", ".output"],
    recommendedBudget: "200k",
  },
  {
    name: "sveltekit",
    priority: 96,
    detect: (context) =>
      fileStartingWithEvidence(context, "svelte.config") ??
      dependencyEvidence(context, "@sveltejs/kit", "svelte"),
    layers: [
      layer("routes", "src/routes/", "routes/"),
      layer("lib", "src/lib/", "lib/"),
      layer("components", "src/lib/components/", "src/components/"),
      layer("stores", "src/lib/stores/", "src/stores/"),
      ...commonLayers(),
    ],
    kinds: [
      kindOf("route", "+page.", "+server.", "+layout."),
      suffixKind("component", ".svelte"),
      kindOf("store", "stores/"),
      kindOf("params", "params/"),
      ...commonKinds(),
    ],
    exclude: [".svelte-kit", ".vercel"],
    recommendedBudget: "200k",
  },
  {
    name: "remix",
    priority: 94,
    detect: (context) =>
      dependencyEvidence(context, "@remix-run/react", "@remix-run/node", "@remix-run/dev"),
    layers: [
      layer("routes", "app/routes/", "routes/"),
      layer("components", "app/components/"),
      layer("lib", "app/lib/", "app/utils/"),
      ...commonLayers(),
    ],
    kinds: [kindOf("route", "routes/"), ...commonKinds()],
    exclude: [".cache", "public/build"],
    recommendedBudget: "200k",
  },
  {
    name: "astro",
    priority: 92,
    detect: (context) =>
      fileStartingWithEvidence(context, "astro.config") ?? dependencyEvidence(context, "astro"),
    layers: [
      layer("pages", "src/pages/"),
      layer("layouts", "src/layouts/"),
      layer("components", "src/components/"),
      layer("content", "src/content/"),
      ...commonLayers(),
    ],
    kinds: [suffixKind("page", ".astro"), kindOf("layout", "layouts/"), ...commonKinds()],
    exclude: [".astro", "dist"],
    recommendedBudget: "150k",
  },
  {
    name: "angular",
    priority: 90,
    detect: (context) =>
      fileEvidence(context, "angular.json") ?? dependencyEvidence(context, "@angular/core"),
    layers: [
      layer("app", "src/app/"),
      layer("features", "src/app/features/"),
      layer("shared", "src/app/shared/"),
      layer("core", "src/app/core/"),
      layer("assets", "src/assets/"),
      ...commonLayers(),
    ],
    kinds: [
      suffixKind("component", ".component.ts"),
      suffixKind("service", ".service.ts"),
      suffixKind("module", ".module.ts"),
      suffixKind("guard", ".guard.ts"),
      suffixKind("pipe", ".pipe.ts"),
      suffixKind("directive", ".directive.ts"),
      ...commonKinds(),
    ],
    exclude: [".angular", "dist"],
    recommendedBudget: "200k",
  },
  {
    name: "solid",
    priority: 88,
    detect: (context) => dependencyEvidence(context, "solid-js", "solid-start"),
    layers: [
      layer("pages", "src/routes/", "src/pages/"),
      layer("components", "src/components/"),
      ...commonLayers(),
    ],
    kinds: [kindOf("route", "routes/"), ...commonKinds()],
    exclude: [".solid", "dist"],
    recommendedBudget: "120k",
  },
  {
    name: "vue-vite",
    priority: 86,
    // `vue` is the decisive signal; `vite` (or its config file) only says the app is
    // built with Vite rather than shipped pre-compiled, so it is required but not what
    // gets reported.
    detect: (context) => {
      const framework = dependencyEvidence(context, "vue");
      if (framework === null) return null;
      const build =
        dependencyEvidence(context, "vite") ?? fileStartingWithEvidence(context, "vite.config");
      return build === null ? null : framework;
    },
    layers: [
      layer("pages", "src/pages/", "src/views/"),
      layer("components", "src/components/"),
      layer("composables", "src/composables/", "src/hooks/"),
      layer("stores", "src/stores/", "src/store/"),
      layer("services", "src/services/", "src/api/"),
      layer("shared", "src/shared/", "src/common/"),
      layer("styles", "src/styles/", "src/assets/"),
      ...commonLayers(),
    ],
    kinds: [
      suffixKind("component", ".vue"),
      kindOf("composable", "composables/", "use"),
      kindOf("store", "stores/", "store/"),
      kindOf("service", "services/", "api/"),
      suffixKind("style", ".css", ".scss", ".sass", ".less"),
      ...commonKinds(),
    ],
    exclude: [".vite", "dist"],
    recommendedBudget: "120k",
  },
  {
    name: "react-vite",
    priority: 84,
    detect: (context) => {
      const framework = dependencyEvidence(context, "react");
      if (framework === null) return null;
      const build =
        dependencyEvidence(context, "vite") ?? fileStartingWithEvidence(context, "vite.config");
      return build === null ? null : framework;
    },
    layers: VITE_LAYERS,
    kinds: VITE_KINDS,
    exclude: [".vite", "dist"],
    recommendedBudget: "120k",
  },
  {
    name: "nest",
    priority: 80,
    detect: (context) => dependencyEvidence(context, "@nestjs/core"),
    layers: [
      layer("modules", "src/modules/", "modules/"),
      layer("controllers", "src/controllers/", "controllers/"),
      layer("providers", "src/providers/", "providers/"),
      layer("core", "src/core/"),
      layer("security", "src/security/", "src/auth/"),
      layer("db", "src/db/", "src/database/", "prisma/"),
      ...commonLayers(),
    ],
    kinds: [
      suffixKind("controller", ".controller.ts"),
      suffixKind("service", ".service.ts"),
      suffixKind("module", ".module.ts"),
      suffixKind("guard", ".guard.ts"),
      suffixKind("dto", ".dto.ts"),
      suffixKind("entity", ".entity.ts"),
      kindOf("migration", "migrations/"),
      ...commonKinds(),
    ],
    exclude: ["dist", "node_modules"],
    recommendedBudget: "200k",
  },
  {
    name: "node-express",
    priority: 78,
    detect: (context) => dependencyEvidence(context, "express", "fastify", "koa", "@hapi/hapi"),
    layers: NODE_LAYERS,
    kinds: NODE_KINDS,
    exclude: ["dist"],
    recommendedBudget: "200k",
  },
  {
    name: "node-lib",
    // A bare package.json is often just tooling around a non-JS project, so it
    // ranks below every definitive language manifest.
    priority: 45,
    detect: (context) => fileEvidence(context, "package.json"),
    layers: [
      layer("src", "src/"),
      layer("lib", "lib/"),
      layer("test", "test/", "tests/", "__tests__/"),
      ...commonLayers(),
    ],
    kinds: [suffixKind("type", ".d.ts"), ...commonKinds()],
    exclude: ["dist"],
    recommendedBudget: "120k",
  },
];
