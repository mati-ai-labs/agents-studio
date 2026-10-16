#!/usr/bin/env node
import { run } from "./cli.js";

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("ERROR: " + msg);
    process.exitCode = 1;
  },
);
