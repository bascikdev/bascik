/**
 * @module route-matching
 *
 * Pure API route matching (prompt 132). Extracted from `api-routes.ts` so the
 * same algorithm runs inside a serverless function without dragging in the
 * filesystem scanner. `api-routes.ts` re-exports these; there is exactly one
 * matcher. No Node imports.
 *
 * Route paths use the page syntax: `/api/users/[id]`. Static segments win over
 * dynamic segments (see `sortApiRoutes`), and `[param]` values are
 * percent-decoded when possible.
 */

/** Match dynamic bracket segments like `[slug]` or `[category]`. */
const DYNAMIC_ROUTE_RE = /\[([^\]/\\\s]+)\]/g;

/** True when any path segment is a [param] placeholder. */
export const isDynamicRoute = (pagePath: string): boolean => {
  DYNAMIC_ROUTE_RE.lastIndex = 0;
  return DYNAMIC_ROUTE_RE.test(pagePath);
};

/** Ordered param names from the path, e.g. ['category', 'slug']. */
export const extractRouteParamNames = (pagePath: string): string[] => {
  const matches = pagePath.match(DYNAMIC_ROUTE_RE);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
};

/**
 * A route the matcher understands. `filePath` is whatever identity the host
 * uses to find the handler: an absolute source path on Node, a module id in a
 * serverless bundle.
 */
export interface ApiRouteDefinition {
  /** Normalized route path, e.g. "/api/users" or "/api/users/[id]" (including base if applicable) */
  path: string;
  /** Handler identity for the host. */
  filePath: string;
  /** Ordered list of param names extracted from `[param]` segments */
  paramNames: string[];
  /** Whether the route contains any dynamic segment */
  isDynamic: boolean;
}

export interface ApiRouteMatch {
  route: ApiRouteDefinition;
  params: Record<string, string>;
}

/** Static routes first, then more specific dynamic routes, then by path. */
export const sortApiRoutes = (routes: ApiRouteDefinition[]): ApiRouteDefinition[] => {
  return [...routes].sort((a, b) => {
    if (!a.isDynamic && b.isDynamic) return -1;
    if (a.isDynamic && !b.isDynamic) return 1;

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

export const normalizeApiRouteDefinition = (def: ApiRouteDefinition): ApiRouteDefinition => {
  const isDynamic = def.isDynamic ?? isDynamicRoute(def.path);
  const paramNames =
    def.paramNames && def.paramNames.length > 0
      ? def.paramNames
      : isDynamic
        ? extractRouteParamNames(def.path)
        : [];
  return { path: def.path, filePath: def.filePath, isDynamic, paramNames };
};

/**
 * Match an incoming request pathname against registered API routes.
 * Exact segment matching for static paths and deterministic parameter
 * extraction for `[param]` segments, with no dynamic regular expressions.
 */
export const matchApiRoute = <R extends ApiRouteDefinition>(routes: R[], pathname: string): (ApiRouteMatch & { route: R }) | null => {
  const pathSegments = pathname.split("/").filter(Boolean);

  for (const rawRoute of routes) {
    const normalized = normalizeApiRouteDefinition(rawRoute);
    // Return the caller's object (with any host-specific fields such as a
    // module loader) but decide with the normalized view.
    const route: R = { ...rawRoute, isDynamic: normalized.isDynamic, paramNames: normalized.paramNames };
    const routeSegments = route.path.split("/").filter(Boolean);

    if (pathSegments.length !== routeSegments.length) continue;

    if (!route.isDynamic) {
      if (routeSegments.every((seg, i) => seg === pathSegments[i])) {
        return { route, params: {} };
      }
      continue;
    }

    const params: Record<string, string> = {};
    let isMatch = true;

    for (let i = 0; i < routeSegments.length; i++) {
      const rSeg = routeSegments[i];
      const pSeg = pathSegments[i];

      if (rSeg.startsWith("[") && rSeg.endsWith("]")) {
        const paramName = rSeg.slice(1, -1);
        try {
          params[paramName] = decodeURIComponent(pSeg);
        } catch {
          params[paramName] = pSeg;
        }
      } else if (rSeg !== pSeg) {
        isMatch = false;
        break;
      }
    }

    if (isMatch) return { route, params };
  }

  return null;
};

/**
 * Deployment control files that live in the public upload tree of a
 * serverless bundle. The emitter routes them to the worker and the worker
 * refuses them, so the bundle can never be downloaded from the public origin.
 * One list, imported by both sides, so the two can never disagree.
 */
export const GENERATED_CONTROL_PATHS: readonly string[] = Object.freeze(["/_worker.js", "/_routes.json"]);

// ─── Path normalization shared with page lookup ──────────────────────────────

/**
 * Normalize a base-relative pathname for page lookup the way `server.ts`
 * does: strip `.html`, map `/index` to `/`, and `x/index` to `x/`.
 */
export const normalizePagePathname = (pathname: string): { cleanPathname: string; normalizedPath: string } => {
  const cleanPathname = pathname.replace(/\.html$/i, "");
  const normalizedPath = cleanPathname === "/index" ? "/" : cleanPathname.replace(/\/index$/, "/");
  return { cleanPathname, normalizedPath };
};

/**
 * Every alias a request may use for a stored page, in the order `server.ts`
 * tries them: the literal path, the normalized form, the `.html`-stripped
 * form, and the trailing-slash toggle.
 */
export const pageLookupCandidates = (pathname: string): string[] => {
  const { cleanPathname, normalizedPath } = normalizePagePathname(pathname);
  const toggled = cleanPathname.endsWith("/") ? cleanPathname.slice(0, -1) : `${cleanPathname}/`;
  const out: string[] = [];
  for (const candidate of [pathname, normalizedPath, cleanPathname, toggled]) {
    if (candidate && !out.includes(candidate)) out.push(candidate);
  }
  return out;
};

/**
 * Whether a decoded pathname is unsafe to route at all: control characters,
 * null bytes, or dot-dot traversal. Mirrors the guards in `server.ts`.
 */
export const isUnsafePathname = (pathname: string): boolean =>
  pathname.includes("\0") ||
  /[\r\n\t]/.test(pathname) ||
  pathname.includes("/../") ||
  pathname.startsWith("../") ||
  pathname.endsWith("/..") ||
  pathname === "..";

/** Whether any segment of the pathname is a dotfile or dot-directory. */
export const hasHiddenSegment = (pathname: string): boolean =>
  pathname.split("/").some((segment) => segment.startsWith("."));
