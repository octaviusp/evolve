#!/usr/bin/env node
import { buildCli } from "./cli.js";

try {
  await buildCli().parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
