#!/usr/bin/env node
/**
 * @module cli
 *
 * `bascik-netlify-install`: run after `bascik --build --target @bascik/adapter-netlify`.
 */

import { FUNCTION_FILE, NETLIFY_FUNCTION_DIR, PUBLISH_DIR } from "./paths.js";
import { installNetlifyOutput } from "./install.js";

try {
  const result = await installNetlifyOutput(process.cwd());
  console.log(
    `[netlify-install] ${PUBLISH_DIR}/ updated${result.functionPath ? `, function at ${NETLIFY_FUNCTION_DIR}/${FUNCTION_FILE}` : ", no dynamic pages"}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
