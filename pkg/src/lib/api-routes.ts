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
import { join, resolve, relative, extname } from "node:path";
import { existsSync } from "node:fs";
import { BascikConfig } from "./config.ts";
import { extractRouteParamNames, isDynamicRoute } from "./routes.ts";
import { withBasePath, stripBasePath } from "./base-path.ts";

export interface ApiRouteDefinition {
  /** Normalized route path, e.g. "/api/users" or "/api/users/[id]" (including base if applicable) */
  path: string;
  /** Absolute file path on disk */
  filePath: string;
  /** Ordered list of param names extracted from `[param]` segments */
  paramNames: string[];
  /** Whether the route contains any dynamic segment */
  isDynamic: boolean;
  /** Regex for matching dynamic paths */
  regex?: RegExp;
}

export interface ApiRouteMatch {
  route: ApiRouteDefinition;
  params: Record<string, string>;
}

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
 * Builds a regex to match a dynamic route path with `[param]` segments.
 */
export const createRouteRegex = (routePath: string): { regex: RegExp; paramNames: string[] } => {
  const paramNames: string[] = [];
  const escaped = routePath
    .replace(/\/+$/, "")
    .replace(/\[([^\]/\\\s]+)\]/g, (_match, paramName) => {
      paramNames.push(paramName);
      return "([^/]+)";
    });

  const regex = new RegExp(`^${escaped}/?$`);
  return { regex, paramNames };
};

export const sortApiRoutes = (routes: ApiRouteDefinition[]): ApiRouteDefinition[] => {
  return [...routes].sort((a, b) => {
    if (!a.isDynamic && b.isDynamic) return -1;
    if (a.isDynamic && !b.isDynamic) return 1;

    // Segment count comparison
    const aSegments = a.path.split("/").filter(Boolean);
    const bSegments = b.path.split("/").filter(Boolean);

    for (let i = 0; i < Math.min(aSegments.length, bSegments.length); i++) {
      const aIsParam = aSegments[i].startsWith("[");
      const bIsParam = bSegments[i].startsWith("[");
      if (!aIsParam && bIsParam) return -1;
      if (aIsParam && !bIsParam) return 1;
    }

    if (aSegments.length !== bSegments.length) {
      return bSegments.length - aSegments.length;
    }

    return a.path.localeCompare(b.path);
  });
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
    const regex = isDynamic ? createRouteRegex(routePath).regex : undefined;

    const routeDef: ApiRouteDefinition = {
      path: routePath,
      filePath,
      paramNames,
      isDynamic,
      regex,
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

export const normalizeApiRouteDefinition = (
  def: Omit<ApiRouteDefinition, "regex"> & { regex?: RegExp }
): ApiRouteDefinition => {
  const isDynamic = def.isDynamic ?? isDynamicRoute(def.path);
  const paramNames =
    def.paramNames.length > 0
      ? def.paramNames
      : isDynamic
        ? extractRouteParamNames(def.path)
        : [];
  const regex =
    def.regex ?? (isDynamic ? createRouteRegex(def.path).regex : undefined);
  return {
    path: def.path,
    filePath: def.filePath,
    isDynamic,
    paramNames,
    regex,
  };
};

/**
 * Match an incoming request pathname against registered API routes.
 */
export const matchApiRoute = (
  routes: ApiRouteDefinition[],
  pathname: string
): ApiRouteMatch | null => {
  // Normalize pathname: ensure leading slash, decode if needed, strip trailing slash except root
  const cleanPath = "/" + pathname.replace(/^\/+/, "").replace(/\/+$/, "");

  for (const rawRoute of routes) {
    const route = rawRoute.regex || !rawRoute.isDynamic ? rawRoute : normalizeApiRouteDefinition(rawRoute);
    if (!route.isDynamic) {
      const cleanRoute = "/" + route.path.replace(/^\/+/, "").replace(/\/+$/, "");
      if (cleanPath === cleanRoute) {
        return { route, params: {} };
      }
    } else if (route.regex) {
      const match = route.regex.exec(cleanPath);
      if (match) {
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
          const rawVal = match[i + 1];
          try {
            params[route.paramNames[i]] = decodeURIComponent(rawVal);
          } catch {
            params[route.paramNames[i]] = rawVal;
          }
        }
        return { route, params };
      }
    }
  }

  return null;
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
    `  Deploy with \`bascik --server\`, or port them to your host's function runtime.\n` +
    `  Routes: ${routeList}`
  );
};
