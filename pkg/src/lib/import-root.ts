/**
 * @module import-root
 *
 * The one place that turns `scripts.importRoot` into an absolute directory.
 *
 * `@/` and `/` specifiers inside `<script data-bascik-build>`,
 * `<script data-bascik-server>`, and `<script data-bascik-routes>` blocks (and
 * the `src=` attribute on those tags) resolve against this directory. It is
 * independent of `directory.pages` and `directory.components` and may point
 * outside the project (for example `../shared/scripts` in a monorepo).
 *
 * The config keeps the value as the author wrote it; it is resolved against
 * `process.cwd()` here so worker threads and the main thread agree.
 */

import { resolve } from "node:path";
import { BascikConfig } from "./config.ts";

export const DEFAULT_IMPORT_ROOT = "src";

export const getImportRoot = (): string =>
  resolve(process.cwd(), BascikConfig.scripts?.importRoot ?? DEFAULT_IMPORT_ROOT);
