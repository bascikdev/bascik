/**
 * @module api-routes
 *
 * File-based API Routing Engine
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Scans and matches routes in `directory.api` (default 'src/api').
 * Route paths map to `/api/...`, respecting `base` prefix if set.
 * Dynamic segments use the same `[param]` syntax as page routes.
 * Static segments take precedence over dynamic segments.
 * Duplicate route definitions throw an explicit error naming both files.
 */

import { readdir } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { existsSync } from "node:fs";
import { withBasePath } from "./base-path.ts";
import {
  extractRouteParamNames,
  isDynamicRoute,
  matchApiRoute,
  normalizeApiRouteDefinition,
  sortApiRoutes,
  type ApiRouteDefinition,
  type ApiRouteMatch,
} from "./route-matching.ts";

// The matcher itself is host-neutral and lives in `route-matching.ts` so a
// serverless function can run it without this module's filesystem imports.
export { matchApiRoute, normalizeApiRouteDefinition, sortApiRoutes };
export type { ApiRouteDefinition, ApiRouteMatch };

/**
 * Normalizes an API route file path relative to the api directory into a route path.
 * e.g.
 * - 'health.ts' -> '/api/health'
 * - 'users/index.ts' -> '/api/users'
 * - 'users/[id].ts' -> '/api/users/[id]'
 * - 'index.ts' -> '/api'
 */
export const fileToApiRoutePath = (relPath: string, basePath = "/"): string => {
  const normalized = relPath.replace(/\\/g, "/");
  const withoutExt = normalized.replace(/\.[a-zA-Z0-9]+$/, "");

  let routeSegment: string;
  if (withoutExt === "index" || withoutExt === "") {
    routeSegment = "/api";
  } else if (withoutExt.endsWith("/index")) {
    routeSegment = `/api/${withoutExt.slice(0, -"/index".length)}`;
  } else {
    routeSegment = `/api/${withoutExt}`;
  }

  // Ensure clean leading slash and no trailing slash except root
  routeSegment = "/" + routeSegment.replace(/^\/+/, "").replace(/\/+$/, "");
  return withBasePath(routeSegment, basePath);
};

/**
 * Builds the list of sorted API route definitions from a list of absolute file paths.
 * Throws an error if duplicate routes resolve to the same route path.
 */
export const buildApiRouteTree = (
  filePaths: string[],
  apiDir: string,
  basePath = "/"
): ApiRouteDefinition[] => {
  const routesByPath = new Map<string, { route: ApiRouteDefinition; filePaths: string[] }>();
  // Normalize apiDir with forward slashes for relative pathing
  const normalizedApiDir = apiDir.replace(/\\/g, "/");

  for (const filePath of filePaths) {
    const normalizedFilePath = filePath.replace(/\\/g, "/");
    let rel: string;
    if (normalizedFilePath.startsWith(normalizedApiDir + "/")) {
      rel = normalizedFilePath.slice(normalizedApiDir.length + 1);
    } else {
      rel = relative(apiDir, filePath);
    }

    const routePath = fileToApiRoutePath(rel, basePath);

    const isDynamic = isDynamicRoute(routePath);
    const paramNames = isDynamic ? extractRouteParamNames(routePath) : [];

    const routeDef: ApiRouteDefinition = {
      path: routePath,
      filePath,
      paramNames,
      isDynamic,
    };

    const existing = routesByPath.get(routePath);
    if (existing) {
      existing.filePaths.push(filePath);
    } else {
      routesByPath.set(routePath, { route: routeDef, filePaths: [filePath] });
    }
  }

  // Check for duplicates
  for (const [routePath, entry] of routesByPath.entries()) {
    if (entry.filePaths.length > 1) {
      const fileList = entry.filePaths.map((f) => `  - ${f}`).join("\n");
      throw new Error(
        `Duplicate API route "${routePath}" declared in multiple files:\n${fileList}`
      );
    }
  }

  const routes = Array.from(routesByPath.values()).map((e) => e.route);
  return sortApiRoutes(routes);
};

/**
 * Recursively scans directory for API route source files (.ts, .js, .mjs).
 */
export const scanApiRouteFiles = async (dir: string): Promise<string[]> => {
  if (!existsSync(dir)) {
    return [];
  }

  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await scanApiRouteFiles(fullPath)));
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ext === ".ts" || ext === ".js" || ext === ".mjs") {
        results.push(fullPath);
      }
    }
  }

  return results.sort();
};

/**
 * Format warning for static builds when API routes are present in src/api.
 */
export const formatApiRouteWarning = (routes: string[], apiDir = "src/api"): string => {
  const count = routes.length;
  const routeList = routes.join(", ");
  return (
    `warning: ${count} API route${count === 1 ? "" : "s"} found in ${apiDir}/ but static builds cannot serve them.\n` +
    `  Deploy with \`bascik --server\`, build a serverless bundle with \`bascik --build --target <name>\`, or port them to your host's function runtime.\n` +
    `  Routes: ${routeList}`
  );
};
