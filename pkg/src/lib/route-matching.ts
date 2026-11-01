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
 *
 * Catch-all (API routes only): a final `[...name]` segment matches ONE OR MORE
 * remaining path segments and exposes them as `string[]` in `params[name]`.
 * Precedence is static, then `[param]`, then catch-all, compared segment by
 * segment from the left and independent of discovery order. Catch-all
 * captures are split on `/` BEFORE decoding, from the raw request path, and
 * each segment is decoded exactly once (see `matchApiRoute`).
 */

/** Match dynamic bracket segments like `[slug]` or `[category]`. */
const DYNAMIC_ROUTE_RE = /\[([^\[\]/\\\s]+)\]/g;

/** A whole path segment that is a catch-all: `[...name]`. Capture 1 is the name. */
const CATCH_ALL_SEGMENT_RE = /^\[\.\.\.([^\]/\\\s.][^\]/\\\s]*)\]$/;

/** Values an API route captures: `[param]` is a string, `[...rest]` is a string array. */
export type ApiRouteParams = Record<string, string | string[]>;

/**
 * Thrown by `matchApiRoute` when a catch-all route is the best match but the
 * request path cannot be captured safely (malformed percent-encoding, an
 * encoded `/` or `\`, a `.`/`..` segment, a control character, or an empty
 * interior segment). Hosts answer 400.
 */
export class InvalidApiPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApiPathError";
  }
}

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
 * API-route variant of `extractRouteParamNames`: a catch-all `[...rest]`
 * contributes the name `rest` (without the dots). Page routing keeps using
 * `extractRouteParamNames`, which is unchanged.
 */
export const extractApiRouteParamNames = (routePath: string): string[] =>
  extractRouteParamNames(routePath).map((name) =>
    name.startsWith("...") ? name.slice(3) : name,
  );

/** True when the route's final segment is a well-formed catch-all `[...name]`. */
export const isCatchAllRoute = (routePath: string): boolean => {
  const segments = routePath.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last !== undefined && CATCH_ALL_SEGMENT_RE.test(last);
};

/** 0 = static, 1 = `[param]`, 2 = catch-all. Lower is more specific. */
const segmentRank = (segment: string): number => {
  if (CATCH_ALL_SEGMENT_RE.test(segment)) return 2;
  return segment.startsWith("[") ? 1 : 0;
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
  params: ApiRouteParams;
}

/**
 * Specificity order: static routes first, then dynamic routes compared segment
 * by segment from the left (static < `[param]` < catch-all), then longer paths,
 * then by path text so the result is fully deterministic.
 */
const compareApiRoutes = (
  a: ApiRouteDefinition,
  b: ApiRouteDefinition,
): number => {
  if (!a.isDynamic && b.isDynamic) return -1;
  if (a.isDynamic && !b.isDynamic) return 1;

  const aSegments = a.path.split("/").filter(Boolean);
  const bSegments = b.path.split("/").filter(Boolean);

  for (let i = 0; i < Math.min(aSegments.length, bSegments.length); i++) {
    const delta = segmentRank(aSegments[i]) - segmentRank(bSegments[i]);
    if (delta !== 0) return delta;
  }

  if (aSegments.length !== bSegments.length) {
    return bSegments.length - aSegments.length;
  }

  return a.path.localeCompare(b.path);
};

/** Static routes first, then more specific dynamic routes, catch-all last, then by path. */
export const sortApiRoutes = (
  routes: ApiRouteDefinition[],
): ApiRouteDefinition[] => {
  return [...routes].sort(compareApiRoutes);
};

export interface ApiRoutePatternProblem {
  kind: "invalid-catch-all" | "ambiguous";
  message: string;
  /** Handler identities involved (one for invalid, two or more for ambiguous). */
  filePaths: string[];
}

/**
 * Static validation of a route table. Reports:
 * - a `[...` segment that is not a named whole segment (`[...path]`);
 * - a catch-all that is not the final segment;
 * - a parameter name repeated in a route that contains a catch-all;
 * - two catch-all routes whose patterns are identical once param names are
 *   ignored (`/api/[...a]` and `/api/[...b]`, or `/api/[x]/[...a]` and
 *   `/api/[y]/[...b]`).
 * Plain `[a]` vs `[b]` siblings are unchanged: they keep the deterministic
 * sort order they had before catch-all existed.
 */
export const findApiRoutePatternProblems = (
  routes: ReadonlyArray<{ path: string; filePath: string }>,
): ApiRoutePatternProblem[] => {
  const problems: ApiRoutePatternProblem[] = [];
  const bySignature = new Map<
    string,
    Array<{ path: string; filePath: string }>
  >();

  for (const route of routes) {
    const segments = route.path.split("/").filter(Boolean);
    let valid = true;
    let hasCatchAll = false;
    const names: string[] = [];

    segments.forEach((segment, i) => {
      if (segment.includes("[...")) {
        const match = CATCH_ALL_SEGMENT_RE.exec(segment);
        if (!match) {
          valid = false;
          problems.push({
            kind: "invalid-catch-all",
            message: `Invalid catch-all segment "${segment}" in API route "${route.path}": use a named whole segment such as [...path].`,
            filePaths: [route.filePath],
          });
          return;
        }
        hasCatchAll = true;
        names.push(match[1]);
        if (i !== segments.length - 1) {
          valid = false;
          problems.push({
            kind: "invalid-catch-all",
            message: `Catch-all segment "${segment}" must be the last segment of API route "${route.path}".`,
            filePaths: [route.filePath],
          });
        }
      } else if (segment.startsWith("[") && segment.endsWith("]")) {
        names.push(segment.slice(1, -1));
      }
    });

    if (valid && hasCatchAll) {
      const repeated = names.find((name, i) => names.indexOf(name) !== i);
      if (repeated !== undefined) {
        valid = false;
        problems.push({
          kind: "invalid-catch-all",
          message: `API route "${route.path}" declares the parameter name "${repeated}" more than once.`,
          filePaths: [route.filePath],
        });
      }
    }

    if (valid && hasCatchAll) {
      const signature = segments
        .map((s) =>
          segmentRank(s) === 2 ? "[...]" : segmentRank(s) === 1 ? "[]" : s,
        )
        .join("/");
      const list = bySignature.get(signature) ?? [];
      list.push(route);
      bySignature.set(signature, list);
    }
  }

  for (const group of bySignature.values()) {
    if (group.length > 1) {
      problems.push({
        kind: "ambiguous",
        message: `Ambiguous API routes ${group.map((r) => `"${r.path}"`).join(" and ")} match the same requests.`,
        filePaths: group.map((r) => r.filePath),
      });
    }
  }

  return problems;
};

export const normalizeApiRouteDefinition = (
  def: ApiRouteDefinition,
): ApiRouteDefinition => {
  const isDynamic = def.isDynamic ?? isDynamicRoute(def.path);
  const paramNames =
    def.paramNames && def.paramNames.length > 0
      ? def.paramNames
      : isDynamic
        ? extractApiRouteParamNames(def.path)
        : [];
  return { path: def.path, filePath: def.filePath, isDynamic, paramNames };
};

/** Decode one raw path segment exactly once; `null` on malformed percent-encoding. */
const decodeSegmentOnce = (segment: string): string | null => {
  // Without a `%` there is nothing to decode (decodeURIComponent returns it
  // unchanged), and most request segments have none.
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

/** Why a decoded segment must never reach a handler as a catch-all element, or `null` when safe. */
const unsafeDecodedSegment = (decoded: string | null): string | null => {
  if (decoded === null) return "malformed percent-encoding";
  if (decoded === "") return "empty path segment";
  if (decoded === "." || decoded === "..") return "dot path segment";
  if (decoded.includes("/") || decoded.includes("\\"))
    return "encoded path separator";
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return "control character";
  return null;
};

/** Split a raw pathname into segments, keeping interior empties and dropping one trailing slash. */
const splitRawPathname = (rawPathname: string): string[] => {
  const parts = rawPathname.split("/");
  if (parts[0] === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
};

type CatchAllOutcome =
  { params: ApiRouteParams } | { invalid: InvalidApiPathError } | null;

/**
 * Match a route whose last segment is `[...name]` against raw path segments.
 * A structural mismatch yields `null`; a structural match with an unsafe
 * capture yields `{ invalid }` so precedence is decided before any rejection.
 */
const matchCatchAll = (
  routeSegments: string[],
  name: string,
  rawSegments: string[],
): CatchAllOutcome => {
  const prefixLength = routeSegments.length - 1;
  // Required catch-all: at least one remaining segment.
  if (rawSegments.length < prefixLength + 1) return null;

  const params: ApiRouteParams = {};
  let invalid: InvalidApiPathError | undefined;
  for (let i = 0; i < prefixLength; i++) {
    const routeSegment = routeSegments[i];
    const decoded = decodeSegmentOnce(rawSegments[i]);
    if (routeSegment.startsWith("[") && routeSegment.endsWith("]")) {
      const reason = unsafeDecodedSegment(decoded);
      if (reason)
        invalid ??= new InvalidApiPathError(`Invalid API path: ${reason}`);
      else params[routeSegment.slice(1, -1)] = decoded as string;
    } else if (decoded !== routeSegment) {
      return null;
    }
  }

  const captured: string[] = [];
  for (let i = prefixLength; i < rawSegments.length; i++) {
    const decoded = decodeSegmentOnce(rawSegments[i]);
    const reason = unsafeDecodedSegment(decoded);
    if (reason) {
      invalid ??= new InvalidApiPathError(`Invalid API path: ${reason}`);
      continue;
    }
    captured.push(decoded as string);
  }
  if (invalid) return { invalid };
  params[name] = captured;
  return { params };
};

/**
 * Exact and `[param]` matching. An exact (static) route matches the decoded
 * path segments, as hosts always have. A `[param]` route matches the raw
 * request segments instead (doubled slashes collapse, as on the decoded
 * path): each is decoded exactly once, so an encoded `%2F` can never forge a
 * segment boundary and `100%2520` stays `100%20`. A structural match whose
 * `[param]` value is unsafe (an encoded `/` or `\`, a dot segment, a control
 * character) yields `{ invalid }`, so precedence is decided before the
 * request is rejected, as for catch-all routes.
 */
const matchExactOrParam = (
  route: ApiRouteDefinition,
  routeSegments: string[],
  pathSegments: string[],
  rawNonEmptySegments: string[],
): CatchAllOutcome => {
  if (!route.isDynamic) {
    if (pathSegments.length !== routeSegments.length) return null;
    return routeSegments.every((seg, i) => seg === pathSegments[i])
      ? { params: {} }
      : null;
  }

  if (rawNonEmptySegments.length !== routeSegments.length) return null;
  const params: Record<string, string> = {};
  let invalid: InvalidApiPathError | undefined;
  for (let i = 0; i < routeSegments.length; i++) {
    const rSeg = routeSegments[i];
    const decoded = decodeSegmentOnce(rawNonEmptySegments[i]);
    if (rSeg.startsWith("[") && rSeg.endsWith("]")) {
      // Malformed encoding keeps the raw text, as it always has (hosts
      // answer 400 for it before matching).
      const reason = decoded === null ? null : unsafeDecodedSegment(decoded);
      if (reason)
        invalid ??= new InvalidApiPathError(`Invalid API path: ${reason}`);
      else params[rSeg.slice(1, -1)] = decoded ?? rawNonEmptySegments[i];
    } else if (decoded !== rSeg) {
      return null;
    }
  }
  return invalid ? { invalid } : { params };
};

/**
 * Match an incoming request pathname against registered API routes.
 * Exact segment matching for static paths and deterministic parameter
 * extraction for `[param]` segments, with no dynamic regular expressions.
 *
 * `pathname` is what exact routes match against (hosts pass the decoded path).
 * Dynamic `[param]` and catch-all routes extract parameter values from
 * `rawPathname` (the undecoded request path), decoding each segment exactly
 * once, so an encoded `%2F` can never forge a segment boundary and values like
 * `100%2520` are not decoded twice into spaces.
 *
 * Of all matching routes the most specific wins regardless of array order.
 * Throws `InvalidApiPathError` when the winner is a `[param]` or catch-all
 * route whose capture is unsafe (malformed encoding, encoded separator, dot
 * or empty segment, control character).
 */
export const matchApiRoute = <R extends ApiRouteDefinition>(
  routes: R[],
  pathname: string,
  rawPathname: string = pathname,
): (ApiRouteMatch & { route: R }) | null => {
  const pathSegments = pathname.split("/").filter(Boolean);
  const rawSegments = splitRawPathname(rawPathname);

  let best: {
    route: R;
    normalized: ApiRouteDefinition;
    outcome: { params: ApiRouteParams } | { invalid: InvalidApiPathError };
  } | null = null;

  for (const rawRoute of routes) {
    const normalized = normalizeApiRouteDefinition(rawRoute);
    // Return the caller's object (with any host-specific fields such as a
    // module loader) but decide with the normalized view.
    const route: R = {
      ...rawRoute,
      isDynamic: normalized.isDynamic,
      paramNames: normalized.paramNames,
    };
    const routeSegments = route.path.split("/").filter(Boolean);

    const lastSegment = routeSegments[routeSegments.length - 1];
    const catchAllName =
      lastSegment === undefined
        ? null
        : (CATCH_ALL_SEGMENT_RE.exec(lastSegment)?.[1] ?? null);

    let outcome:
      { params: ApiRouteParams } | { invalid: InvalidApiPathError } | null;
    if (catchAllName !== null) {
      outcome = matchCatchAll(routeSegments, catchAllName, rawSegments);
    } else {
      outcome = matchExactOrParam(
        route,
        routeSegments,
        pathSegments,
        rawSegments.filter(Boolean),
      );
    }

    if (
      outcome &&
      (!best || compareApiRoutes(normalized, best.normalized) < 0)
    ) {
      best = { route, normalized, outcome };
    }
  }

  if (!best) return null;
  if ("invalid" in best.outcome) throw best.outcome.invalid;
  return { route: best.route, params: best.outcome.params };
};

/**
 * Deployment control files that live in the public upload tree of a
 * serverless bundle. The emitter routes them to the worker and the worker
 * refuses them, so the bundle can never be downloaded from the public origin.
 * One list, imported by both sides, so the two can never disagree.
 */
export const GENERATED_CONTROL_PATHS: readonly string[] = Object.freeze([
  "/_worker.js",
  "/_routes.json",
]);

// ─── Path normalization shared with page lookup ──────────────────────────────

/**
 * Normalize a base-relative pathname for page lookup the way `server.ts`
 * does: strip `.html`, map `/index` to `/`, and `x/index` to `x/`.
 */
export const normalizePagePathname = (
  pathname: string,
): { cleanPathname: string; normalizedPath: string } => {
  const cleanPathname = pathname.replace(/\.html$/i, "");
  const normalizedPath =
    cleanPathname === "/index" ? "/" : cleanPathname.replace(/\/index$/, "/");
  return { cleanPathname, normalizedPath };
};

/**
 * Every alias a request may use for a stored page, in the order `server.ts`
 * tries them: the literal path, the normalized form, the `.html`-stripped
 * form, and the trailing-slash toggle.
 */
export const pageLookupCandidates = (pathname: string): string[] => {
  const { cleanPathname, normalizedPath } = normalizePagePathname(pathname);
  const toggled = cleanPathname.endsWith("/")
    ? cleanPathname.slice(0, -1)
    : `${cleanPathname}/`;
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

/** The RFC 8615 well-known URI segment: the one dot-directory a site may publish. */
export const WELL_KNOWN_SEGMENT = ".well-known";

/**
 * Whether any segment of a decoded pathname (or a publish-root-relative file
 * path) is a dotfile or dot-directory, which is never served or published.
 *
 * The single exception is RFC 8615 `.well-known` as the FIRST segment below
 * the site root, so `/.well-known/security.txt` and
 * `/.well-known/agent-skills/index.json` are public. The match is exact and
 * case-sensitive, it never applies deeper in the path (`/blog/.well-known/`),
 * and dot segments inside it (`/.well-known/.env`) stay hidden. Internal
 * artifacts such as `/.bascik/` therefore remain private.
 *
 * `base` is the normalized deployment base (`/` or `/docs/`). Under a
 * non-root base the site root is the base, so `/docs/.well-known/...` is the
 * well-known directory; a path outside the base uses the root rule and is
 * rejected by base matching anyway.
 */
/**
 * Segment boundaries for the private-path rules: `/`, and `\` because
 * Windows `path.resolve` treats a backslash as a separator, so `/a\.env`
 * opens `dist\a\.env` there. Treating it as a boundary everywhere keeps the
 * rule the same on every platform (a POSIX file name with a backslash before
 * a dot is refused too, which is the safe side).
 */
const PATH_SEGMENT_SEPARATOR = /[/\\]/;

export const hasHiddenSegment = (pathname: string, base = "/"): boolean => {
  let path = pathname;
  if (base !== "/" && base.length > 1) {
    const prefix = base.endsWith("/") ? base : `${base}/`;
    if (path.startsWith(prefix)) path = path.slice(prefix.length - 1);
  }
  const segments = path
    .split(PATH_SEGMENT_SEPARATOR)
    .filter((segment) => segment.length > 0);
  return segments.some(
    (segment, index) =>
      segment.startsWith(".") &&
      !(index === 0 && segment === WELL_KNOWN_SEGMENT),
  );
};

/**
 * Whether a request path is never served. With `security.hideDotfiles` on
 * (the default) that is `hasHiddenSegment`: every dot segment but a leading
 * /.well-known/. Off, dotfiles are public, but a first segment of `.bascik`
 * below the base (in any letter case, see `isBascikFolderName`) still is not: that folder holds the build's sidecars,
 * manifests and adapter output. Traversal and null bytes are refused with a
 * 400 before this check, either way.
 */
export const isPrivatePathname = (
  pathname: string,
  base = "/",
  hideDotfiles = true,
): boolean => {
  if (hideDotfiles) return hasHiddenSegment(pathname, base);
  let path = pathname;
  if (base !== "/" && base.length > 1) {
    const prefix = base.endsWith("/") ? base : `${base}/`;
    if (path.startsWith(prefix)) path = path.slice(prefix.length - 1);
  }
  const first = path
    .split(PATH_SEGMENT_SEPARATOR)
    .find((segment) => segment.length > 0);
  return first !== undefined && isBascikFolderName(first);
};

/**
 * Whether a path segment names the private `.bascik` folder on disk. macOS
 * and Windows filesystems ignore letter case, and Windows drops trailing dots
 * and spaces, so `.BASCIK`, `.Bascik` and `.bascik.` open the same folder.
 */
export const isBascikFolderName = (segment: string): boolean => {
  // A scan from the end, not /[. ]+$/: that regex is quadratic on a request
  // segment of many dots and spaces followed by another character.
  let end = segment.length;
  while (end > 0 && (segment[end - 1] === "." || segment[end - 1] === " "))
    end--;
  return segment.slice(0, end).toLowerCase() === ".bascik";
};
