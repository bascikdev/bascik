/**
 * @module runtime
 *
 * Host-neutral runtime export for serverless and edge adapters (prompt 142).
 * Re-exports ONLY the portable graph: request-execution, web-response,
 * route-matching, and the request-time component renderer with the modules
 * it is built on (prompt 157: component-expansion-core, scoping-instantiate),
 * plus what a host needs to run component scripts as Node does: the output
 * scope a component script's markup receives, the scoped-name hash from the
 * host's own sha256, and the ANSI stripping every script's output gets.
 */

export * from "./lib/request-execution.ts";
export * from "./lib/web-response.ts";
export * from "./lib/route-matching.ts";
export * from "./lib/request-render.ts";
export * from "./lib/component-expansion-core.ts";
export * from "./lib/scoping-instantiate.ts";
export * from "./lib/output-scope.ts";
export * from "./lib/name-hash.ts";
export * from "./lib/ansi-escapes.ts";
