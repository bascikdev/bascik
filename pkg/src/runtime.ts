/**
 * @module runtime
 *
 * Host-neutral runtime export for serverless and edge adapters (prompt 142).
 * Re-exports ONLY the portable graph: request-execution, web-response,
 * route-matching, and the request-time component renderer with the modules
 * it is built on (prompt 157: component-expansion-core, scoping-instantiate).
 */

export * from "./lib/request-execution.ts";
export * from "./lib/web-response.ts";
export * from "./lib/route-matching.ts";
export * from "./lib/request-render.ts";
export * from "./lib/component-expansion-core.ts";
export * from "./lib/scoping-instantiate.ts";
