/**
 * @module adapter
 *
 * Hosting adapter contract and types for Bascik serverless targets (prompt 142).
 */

export * from "./lib/adapter-contract.ts";
export {
  readSiteGraph,
  pageAliasesFor,
  detectPublicCollisions,
  isPublicAssetPath,
  splitDistPageIntoSegments,
  type ReadSiteGraphOptions,
} from "./lib/site-graph.ts";
