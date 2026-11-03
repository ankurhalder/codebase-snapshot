import { hasFile, manifestContains } from "./context.js";
import type { PresetDefinition } from "./registry.js";
import { commonKinds, commonLayers, layer } from "./helpers.js";
import { DEFAULT_LAYERS, DEFAULT_KINDS } from "./default.js";

/**
 * Repository shapes that cut across languages.
 *
 * Priority sits below every framework preset: a Next.js app inside a pnpm
 * workspace is a Next.js project, and the workspace layer only matters when
 * nothing more specific matched.
 */
export const SHAPE_PRESETS: PresetDefinition[] = [
  {
    name: "monorepo",
    priority: 70,
    detect: (context) =>
      hasFile(context, "pnpm-workspace.yaml") ||
      hasFile(context, "nx.json") ||
      hasFile(context, "turbo.json") ||
      hasFile(context, "lerna.json") ||
      manifestContains(context, "package.json", "\"workspaces\""),
    layers: [
      layer("apps", "apps/"),
      layer("packages", "packages/"),
      layer("tooling", "tooling/", "tools/", "scripts/"),
      ...commonLayers(),
    ],
    kinds: commonKinds(),
    exclude: [".turbo", ".nx"],
    recommendedBudget: "200k",
  },
  {
    name: "infra",
    priority: 24,
    detect: (context) =>
      Array.from(context.files).some((file) => file.endsWith(".tf")) ||
      hasFile(context, "Chart.yaml") ||
      hasFile(context, "kustomization.yaml") ||
      hasFile(context, "docker-compose.yml") ||
      hasFile(context, "docker-compose.yaml"),
    layers: [
      layer("modules", "modules/"),
      layer("environments", "env/", "environments/"),
      layer("manifests", "k8s/", "helm/", "charts/", "deploy/"),
      ...commonLayers(),
    ],
    kinds: [
      { kind: "terraform", match: (filePath) => filePath.endsWith(".tf") },
      { kind: "kubernetes", match: (filePath) => /\.(ya?ml)$/i.test(filePath) && /k8s|helm|charts|deploy/.test(filePath) },
      ...commonKinds(),
    ],
    exclude: [".terraform", ".terragrunt-cache"],
    recommendedBudget: "100k",
  },
  {
    name: "docs",
    priority: 22,
    // The count is `PresetContext.markdownCount`, which includes `docs/*.md`
    // up to two directories down (bounded in the context builder). Counting
    // only the root turned every real documentation repository — README.md plus
    // the pages under `docs/` — into `generic`.
    detect: (context) => context.markdownCount >= 3 && !hasFile(context, "package.json"),
    layers: [
      layer("content", "content/", "docs/"),
      layer("assets", "assets/", "static/", "public/"),
      ...commonLayers(),
    ],
    kinds: commonKinds(),
    exclude: [".docusaurus", ".vitepress/dist", "site"],
    recommendedBudget: "100k",
  },
  {
    name: "generic",
    priority: 0,
    detect: () => true,
    layers: DEFAULT_LAYERS,
    kinds: DEFAULT_KINDS,
    exclude: [],
    recommendedBudget: "120k",
  },
];
