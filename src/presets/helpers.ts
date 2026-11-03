import type { KindRule, LayerRule } from "../types.js";

/** Shorthand: a layer that matches any of the given path prefixes. */
export function layer(name: string, ...prefixes: string[]): LayerRule {
  return {
    name,
    match: (filePath) => prefixes.some((prefix) => filePath.startsWith(prefix)),
  };
}

/** Shorthand: a layer keyed on a file suffix, for language-shaped layouts. */
export function suffixLayer(name: string, ...suffixes: string[]): LayerRule {
  return {
    name,
    match: (filePath) => suffixes.some((suffix) => filePath.endsWith(suffix)),
  };
}

export function kindOf(name: string, ...needles: string[]): KindRule {
  return {
    kind: name,
    match: (filePath) => needles.some((needle) => filePath.includes(needle)),
  };
}

export function suffixKind(name: string, ...suffixes: string[]): KindRule {
  return {
    kind: name,
    match: (filePath) => suffixes.some((suffix) => filePath.endsWith(suffix)),
  };
}

/** The `scripts`, `docs`, `config` and `root` layers nearly every preset wants. */
export function commonLayers(): LayerRule[] {
  return [
    layer("scripts", "scripts/", "tools/"),
    layer("docs", "docs/", "documentation/"),
    {
      name: "config",
      match: (filePath) =>
        filePath.startsWith(".github/") ||
        filePath.startsWith(".husky/") ||
        filePath.startsWith(".vscode/") ||
        filePath.startsWith(".") ||
        filePath.includes("config"),
    },
    { name: "root", match: (filePath) => !filePath.includes("/") },
  ];
}

/** The `test`, `doc`, `data`, `script` and `config` kinds nearly every preset wants. */
export function commonKinds(): KindRule[] {
  return [
    {
      kind: "test",
      match: (filePath) => {
        const lower = filePath.toLowerCase();
        return (
          lower.includes(".test.") ||
          lower.includes(".spec.") ||
          lower.startsWith("test/") ||
          lower.startsWith("tests/") ||
          lower.includes("_test.") ||
          lower.endsWith("_test.go") ||
          lower.includes("__tests__")
        );
      },
    },
    suffixKind("doc", ".md", ".mdx", ".rst", ".txt"),
    suffixKind("data", ".json", ".yaml", ".yml", ".csv", ".toml"),
    {
      kind: "script",
      match: (filePath) => filePath.startsWith("scripts/") || /\.(sh|ps1|bat)$/i.test(filePath),
    },
    {
      kind: "config",
      match: (filePath) =>
        filePath.startsWith(".") ||
        filePath.includes("config") ||
        filePath === "package.json" ||
        filePath === "tsconfig.json",
    },
  ];
}
