import type { KindRule, LayerRule } from "../types.js";

export const NEXTJS_LAYERS: LayerRule[] = [
  { name: "app", match: (p) => p.startsWith("src/app/") || p.startsWith("app/") },
  { name: "features", match: (p) => p.startsWith("src/features/") || p.startsWith("features/") },
  { name: "shared", match: (p) => p.startsWith("src/shared/") || p.startsWith("shared/") },
  { name: "layout", match: (p) => p.startsWith("src/layout/") || p.startsWith("layout/") },
  { name: "scripts", match: (p) => p.startsWith("scripts/") },
  { name: "docs", match: (p) => p.startsWith("docs/") },
  {
    name: "config",
    match: (p) =>
      p.startsWith(".github/") ||
      p.startsWith(".husky/") ||
      p.startsWith(".vscode/") ||
      p.startsWith(".") ||
      p.includes("config"),
  },
  { name: "root", match: (p) => !p.includes("/") },
];

export const NEXTJS_KINDS: KindRule[] = [
  { kind: "test", match: (p) => /\.(test|spec)\.[jt]sx?$/.test(p.toLowerCase()) },
  {
    kind: "route",
    match: (p) => {
      const l = p.toLowerCase();
      return l.endsWith("/route.ts") || l.endsWith("/route.tsx") || l.startsWith("src/app/api/");
    },
  },
  { kind: "handler", match: (p) => p.includes(".handler.") || p.endsWith(".handler.ts") },
  { kind: "repository", match: (p) => p.includes("repositories/") || p.includes("repository") },
  { kind: "service", match: (p) => p.includes("service") || p.includes(".factory.") },
  { kind: "schema", match: (p) => p.includes("schema") || p.includes("zod") },
  { kind: "model", match: (p) => p.includes("model") || p.includes("types/") },
  { kind: "type", match: (p) => p.endsWith(".d.ts") || p.includes("types.ts") },
  {
    kind: "hook",
    match: (p) => {
      const base = p.split("/").pop() || "";
      return p.includes("/hooks/") || /^use[A-Z]/.test(base);
    },
  },
  {
    kind: "component",
    match: (p) => {
      const base = p.split("/").pop() || "";
      return p.includes("/components/") || base.endsWith(".tsx") || base.endsWith(".jsx");
    },
  },
  { kind: "data", match: (p) => p.endsWith(".json") || p.endsWith(".csv") },
  { kind: "doc", match: (p) => p.endsWith(".md") || p.endsWith(".mdx") },
  { kind: "script", match: (p) => p.startsWith("scripts/") || p.endsWith(".sh") || p.endsWith(".ps1") },
  {
    kind: "config",
    match: (p) => {
      const base = p.split("/").pop() || "";
      return (
        ["package.json", "tsconfig.json", "next.config.ts", "next.config.js", "eslint.config.mjs"].includes(base) ||
        base.startsWith(".")
      );
    },
  },
];

