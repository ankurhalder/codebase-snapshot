import type { KindRule, LayerRule } from "../types.js";

export const VITE_LAYERS: LayerRule[] = [
  { name: "pages", match: (p) => p.startsWith("src/pages/") || p.startsWith("src/views/") },
  { name: "components", match: (p) => p.startsWith("src/components/") },
  { name: "hooks", match: (p) => p.startsWith("src/hooks/") },
  { name: "services", match: (p) => p.startsWith("src/services/") || p.startsWith("src/api/") },
  { name: "shared", match: (p) => p.startsWith("src/shared/") || p.startsWith("src/common/") },
  { name: "styles", match: (p) => p.startsWith("src/styles/") || p.startsWith("src/assets/") },
  { name: "scripts", match: (p) => p.startsWith("scripts/") },
  { name: "docs", match: (p) => p.startsWith("docs/") },
  {
    name: "config",
    match: (p) =>
      p.startsWith(".github/") ||
      p.startsWith(".husky/") ||
      p.startsWith(".") ||
      p.includes("config"),
  },
  { name: "root", match: (p) => !p.includes("/") },
];

export const VITE_KINDS: KindRule[] = [
  { kind: "test", match: (p) => /\.(test|spec)\.[jt]sx?$/.test(p.toLowerCase()) },
  {
    kind: "component",
    match: (p) => {
      const base = p.split("/").pop() || "";
      return p.includes("/components/") || base.endsWith(".tsx") || base.endsWith(".jsx") || base.endsWith(".vue");
    },
  },
  {
    kind: "hook",
    match: (p) => {
      const base = p.split("/").pop() || "";
      return p.includes("/hooks/") || /^use[A-Z]/.test(base);
    },
  },
  { kind: "service", match: (p) => p.includes("service") || p.includes("api") },
  { kind: "type", match: (p) => p.endsWith(".d.ts") || p.includes("types") },
  { kind: "style", match: (p) => p.endsWith(".css") || p.endsWith(".scss") },
  { kind: "data", match: (p) => p.endsWith(".json") || p.endsWith(".csv") },
  { kind: "doc", match: (p) => p.endsWith(".md") || p.endsWith(".mdx") },
  { kind: "script", match: (p) => p.startsWith("scripts/") || p.endsWith(".sh") || p.endsWith(".ps1") },
  {
    kind: "config",
    match: (p) => {
      const base = p.split("/").pop() || "";
      return ["package.json", "tsconfig.json", "vite.config.ts", "vite.config.js"].includes(base) || base.startsWith(".");
    },
  },
];

