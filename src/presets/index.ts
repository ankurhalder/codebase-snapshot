import * as fs from "node:fs";
import * as path from "node:path";
import { NEXTJS_LAYERS, NEXTJS_KINDS } from "./nextjs.js";
import { VITE_LAYERS, VITE_KINDS } from "./vite.js";
import { NODE_LAYERS, NODE_KINDS } from "./node.js";
import { DEFAULT_LAYERS, DEFAULT_KINDS } from "./default.js";
import type { KindRule, LayerRule } from "../types.js";

export function detectPreset(cwd: string): {
  presetName: string;
  layers: LayerRule[];
  kinds: KindRule[];
} {
  const hasNextConfig =
    fs.existsSync(path.join(cwd, "next.config.ts")) ||
    fs.existsSync(path.join(cwd, "next.config.js")) ||
    fs.existsSync(path.join(cwd, "next.config.mjs"));

  const hasViteConfig =
    fs.existsSync(path.join(cwd, "vite.config.ts")) ||
    fs.existsSync(path.join(cwd, "vite.config.js")) ||
    fs.existsSync(path.join(cwd, "vite.config.mjs"));

  const pkgJsonPath = path.join(cwd, "package.json");
  let pkgDependencies: Record<string, string> = {};

  if (fs.existsSync(pkgJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      pkgDependencies = {
        ...(parsed.dependencies || {}),
        ...(parsed.devDependencies || {}),
      };
    } catch {}
  }

  if (hasNextConfig || pkgDependencies["next"]) {
    return {
      presetName: "nextjs",
      layers: NEXTJS_LAYERS,
      kinds: NEXTJS_KINDS,
    };
  }

  if (hasViteConfig || pkgDependencies["vite"]) {
    return {
      presetName: "vite",
      layers: VITE_LAYERS,
      kinds: VITE_KINDS,
    };
  }

  if (
    pkgDependencies["express"] ||
    pkgDependencies["fastify"] ||
    pkgDependencies["@nestjs/core"] ||
    fs.existsSync(path.join(cwd, "src/core")) ||
    fs.existsSync(path.join(cwd, "src/protocols"))
  ) {
    return {
      presetName: "node",
      layers: NODE_LAYERS,
      kinds: NODE_KINDS,
    };
  }

  return {
    presetName: "default",
    layers: DEFAULT_LAYERS,
    kinds: DEFAULT_KINDS,
  };
}

export {
  NEXTJS_LAYERS,
  NEXTJS_KINDS,
  VITE_LAYERS,
  VITE_KINDS,
  NODE_LAYERS,
  NODE_KINDS,
  DEFAULT_LAYERS,
  DEFAULT_KINDS,
};

