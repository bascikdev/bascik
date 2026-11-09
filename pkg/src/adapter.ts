/**
 * @module adapter
 *
 * Hosting adapter contract and types for Bascik serverless targets (prompt 142).
 *
 * Importing this entry must not load bascik.config (finding 16): nothing it
 * imports statically reaches config.ts, so it can be `require()`d and a
 * broken config in the working directory does not break the import.
 * `readSiteGraph` reads the resolved config for its defaults, so it loads
 * site-graph.ts (and with it the config) on first call; a config error
 * rejects that call with the loader's located `[bascik]` message.
 */

import type { SiteGraph } from "./lib/adapter-contract.ts";
import type { ReadSiteGraphOptions } from "./lib/site-graph.ts";

export * from "./lib/adapter-contract.ts";
export { resolveAdapterProjectPaths } from "./lib/adapter-project-paths.ts";
export {
  resolvePlatformCli,
  availableDevPort,
} from "./lib/adapter-dev-platform.ts";
export {
  pageAliasesFor,
  detectPublicCollisions,
  isPublicAssetPath,
  splitDistPageIntoSegments,
} from "./lib/site-graph-paths.ts";
export type { ReadSiteGraphOptions };

/** Read the built site graph from `distDir` (the build's `.bascik/` metadata). */
export const readSiteGraph = async (
  options: ReadSiteGraphOptions,
): Promise<SiteGraph> =>
  (await import("./lib/site-graph.ts")).readSiteGraph(options);
