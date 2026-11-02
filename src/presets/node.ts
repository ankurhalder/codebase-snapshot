import type { KindRule, LayerRule } from "../types.js";

export const NODE_LAYERS: LayerRule[] = [
  { name: "core", match: (p) => p.startsWith("src/core/") || p.startsWith("core/") },
  { name: "protocols", match: (p) => p.startsWith("src/protocols/") || p.startsWith("protocols/") },
  { name: "providers", match: (p) => p.startsWith("src/providers/") || p.startsWith("providers/") },
  { name: "security", match: (p) => p.startsWith("src/security/") || p.startsWith("security/") },
  { name: "db", match: (p) => p.startsWith("src/db/") || p.startsWith("db/") || p.startsWith("prisma/") },
  { name: "api", match: (p) => p.startsWith("src/api/") || p.startsWith("api/") || p.startsWith("routes/") },
  { name: "services", match: (p) => p.startsWith("src/services/") || p.startsWith("services/") },
  { name: "controllers", match: (p) => p.startsWith("src/controllers/") || p.startsWith("controllers/") },
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

export const NODE_KINDS: KindRule[] = [
  { kind: "test", match: (p) => /\.(test|spec)\.[jt]sx?$/.test(p.toLowerCase()) },
  { kind: "route", match: (p) => p.includes("/routes/") || p.includes("route.") || p.includes("/api/") },
  { kind: "controller", match: (p) => p.includes("controller") },
  { kind: "service", match: (p) => p.includes("service") },
  { kind: "provider", match: (p) => p.includes("provider") },
  { kind: "model", match: (p) => p.includes("model") || p.includes("entity") },
  { kind: "schema", match: (p) => p.includes("schema") || p.includes("zod") || p.includes("dto") },
  { kind: "type", match: (p) => p.endsWith(".d.ts") || p.includes("types.") || p.includes("type.") },
  { kind: "security", match: (p) => p.includes("auth") || p.includes("security") || p.includes("guard") },
  { kind: "db", match: (p) => p.includes("db") || p.includes("database") || p.includes("migration") },
  { kind: "data", match: (p) => p.endsWith(".json") || p.endsWith(".csv") },
  { kind: "doc", match: (p) => p.endsWith(".md") || p.endsWith(".mdx") },
  { kind: "script", match: (p) => p.startsWith("scripts/") || p.endsWith(".sh") || p.endsWith(".ps1") },
  {
    kind: "config",
    match: (p) => {
      const base = p.split("/").pop() || "";
      return ["package.json", "tsconfig.json", "Dockerfile"].includes(base) || base.startsWith(".");
    },
  },
];

