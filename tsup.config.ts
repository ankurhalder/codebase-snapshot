import { defineConfig } from "tsup";

/**
 * No source maps in the published bundle.
 *
 * `package.json#files` does not ship `*.map`, and `scripts/pack-check.mjs` enforces that — but the
 * build still emitted `//# sourceMappingURL=index.js.map` at the end of every `dist/*.js`, `*.cjs`
 * and `*.d.ts`. Every consumer's debugger therefore resolved the comment, found nothing, and
 * reported a missing source map for a file it had just loaded. A comment pointing at a file that
 * is deliberately not shipped is a wrong answer at the exact moment someone is debugging.
 */
export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      cli: "src/cli.ts",
      // The MCP server is its own entry, not part of the root export: it imports the generator,
      // so re-exporting it from `index` would create an import cycle, and nobody who only wants
      // `generateSnapshot` should ship a protocol implementation.
      mcp: "src/mcp/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: false,
    clean: true,
    treeshake: true,
    target: "node18",
    external: ["typescript"],
  },
  {
    // Thin executable shim: keeps `src/cli.ts` free of side effects so the
    // `./cli` subpath can be imported (ESM *and* CJS) without running the CLI.
    // The `#!/usr/bin/env node` shebang lives in `src/bin.ts`; adding a banner
    // here would emit it twice and produce an unparsable second line.
    entry: { bin: "src/bin.ts" },
    format: ["esm"],
    sourcemap: false,
    target: "node18",
    external: ["typescript"],
  },
]);
