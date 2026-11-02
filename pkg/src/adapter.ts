/**
 * @module adapter
 *
 * Hosting adapter contract and types for Bascik serverless targets (prompt 142).
 */

export * from "./lib/adapter-contract.ts";
export { resolveAdapterProjectPaths } from "./lib/adapter-project-paths.ts";
export {
  resolvePlatformCli,
  availableDevPort,
} from "./lib/adapter-dev-platform.ts";
export {
  readSiteGraph,
  pageAliasesFor,
  detectPublicCollisions,
  isPublicAssetPath,
  splitDistPageIntoSegments,
  type ReadSiteGraphOptions,
} from "./lib/site-graph.ts";
