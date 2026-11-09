#!/usr/bin/env node
/**
 * @module cli
 *
 * `bascik-netlify-install`: run after `bascik --build --target netlify`.
 */

import { FUNCTION_FILE, NETLIFY_FUNCTION_DIR, PUBLISH_DIR } from "./paths.js";
import { installNetlifyOutput } from "./install.js";

try {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith("--config=") && arg.slice("--config=".length)) continue;
    if (
      arg === "--config" &&
      args[index + 1] &&
      !args[index + 1]!.startsWith("-")
    ) {
      index++;
      continue;
    }
    throw new Error(
      `[netlify-install] unsupported argument ${JSON.stringify(arg)}. Use --config <path> to select a configuration file.`,
    );
  }
  const result = await installNetlifyOutput(process.cwd(), undefined, args);
  console.log(
    `[netlify-install] ${PUBLISH_DIR}/ updated${result.functionPath ? `, function at ${NETLIFY_FUNCTION_DIR}/${FUNCTION_FILE}` : ", no dynamic pages"}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
