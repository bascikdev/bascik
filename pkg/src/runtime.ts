/**
 * @module runtime
 *
 * Host-neutral runtime export for serverless and edge adapters (prompt 142).
 * Re-exports ONLY the portable request-execution graph: request-execution,
 * web-response, route-matching.
 */

export * from "./lib/request-execution.ts";
export * from "./lib/web-response.ts";
export * from "./lib/route-matching.ts";
