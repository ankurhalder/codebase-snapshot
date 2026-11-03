import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      cli: "src/cli.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
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
    sourcemap: true,
    target: "node18",
    external: ["typescript"],
  },
]);
