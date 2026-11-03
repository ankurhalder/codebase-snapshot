#!/usr/bin/env node
import { main } from "./cli.js";

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`❌ ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
);
