import type { KindRule, LayerRule } from "../types.js";

export const DEFAULT_LAYERS: LayerRule[] = [
  { name: "src", match: (p) => p.startsWith("src/") },
  { name: "packages", match: (p) => p.startsWith("packages/") },
  { name: "scripts", match: (p) => p.startsWith("scripts/") },
  { name: "docs", match: (p) => p.startsWith("docs/") },
  { name: "test", match: (p) => p.startsWith("test/") || p.startsWith("tests/") },
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

export const DEFAULT_KINDS: KindRule[] = [
  { kind: "test", match: (p) => /\.(test|spec)\.[jt]sx?$/.test(p.toLowerCase()) },
  {
    kind: "component",
    match: (p) => {
      const base = p.split("/").pop() || "";
      return base.endsWith(".tsx") || base.endsWith(".jsx") || p.includes("component");
    },
  },
  {
    kind: "hook",
    match: (p) => {
      const base = p.split("/").pop() || "";
      return /^use[A-Z]/.test(base) || p.includes("/hooks/");
    },
  },
  { kind: "type", match: (p) => p.endsWith(".d.ts") || p.includes("type") },
  { kind: "data", match: (p) => p.endsWith(".json") || p.endsWith(".csv") || p.endsWith(".yaml") || p.endsWith(".yml") },
  { kind: "doc", match: (p) => p.endsWith(".md") || p.endsWith(".mdx") || p.endsWith(".txt") },
  { kind: "script", match: (p) => p.startsWith("scripts/") || p.endsWith(".sh") || p.endsWith(".ps1") },
  {
    kind: "config",
    match: (p) => {
      const base = p.split("/").pop() || "";
      return base.startsWith(".") || base.includes("config") || base === "package.json";
    },
  },
];

