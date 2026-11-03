/**
 * @module paths
 *
 * Output layout shared by the adapter and the install step. Kept free of
 * `@bascik/bascik/adapter` imports so the install step loads on its own.
 */

import { join } from "node:path";

export const ADAPTER_NAME = "netlify";
/** Static files, inside the adapter's target folder and at the project root. */
export const PUBLISH_DIR = "publish";
/** The function, inside the adapter's target folder. */
export const FUNCTION_DIR = "functions";
/** Where Netlify's Frameworks API looks for generated functions. */
export const NETLIFY_FUNCTION_DIR = join(".netlify", "v1", "functions");
export const FUNCTION_FILE = "bascik-pages.mjs";
