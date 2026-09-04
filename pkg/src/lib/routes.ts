import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { BascikConfig } from "./config.ts";
import { getSiteUrl } from "./environment.ts";
import { cleanStackTrace } from "./stack-trace.ts";
import { getRelativePath } from "./file-system.ts";
import { getHttpPath } from "./paths.ts";
import { runModule } from "./script-runner.ts";
import { LeadingSlashSpecifierError, resolveScriptSrcPath, rewriteModuleSpecifiers } from "./module-specifiers.ts";
import { getImportRoot } from "./import-root.ts";
import {
  ATTR,
  ROUTES_FLAG,
  BUILD_FLAG,
  SERVER_FLAG,
  SCRIPT_TAG_PREFIX,
} from "./html-patterns.ts";
import type { RouteEntry } from "./types.ts";

/** Match dynamic bracket segments like `[slug]` or `[category]`. */
const DYNAMIC_ROUTE_RE = /\[([^\]/\\\s]+)\]/g;

/** Match invalid filename / path traversal characters in route param values. */
const INVALID_PARAM_CHARS_RE = /[<>:"/\\|?*\x00-\x1F#%&'+ ]/;
const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

const ROUTES_SCRIPT_RE = new RegExp(
  `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${ROUTES_FLAG}(?:\\s+${ATTR})*\\s*>([\\s\\S]*?)<\\/script>`,
  "gi",
);

const ROUTES_BUILD_CONFLICT_RE = new RegExp(
  `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${BUILD_FLAG}(?:\\s+${ATTR})*\\s*>`,
  "i",
);

const ROUTES_SERVER_CONFLICT_RE = new RegExp(
  `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*\\s+${SERVER_FLAG}(?:\\s+${ATTR})*\\s*>`,
  "i",
);

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

/** Substitute params into the template path to get the source-relative output path. */
export const resolveRoutePath = (
  pagePath: string,
  params: Record<string, string | number>,
): string => {
  return pagePath.replace(DYNAMIC_ROUTE_RE, (_match, paramName) => {
    const val = params[paramName];
    return val !== undefined ? String(val) : _match;
  });
};

/**
 * Compute the normalized root-relative route path for a page file.
 * e.g.
 * - '/app/src/pages/index.html' -> '/'
 * - '/app/src/pages/about.html' -> '/about'
 * - '/app/src/pages/blog/index.html' -> '/blog/'
 * - '/app/src/pages/guides/getting-started.html' -> '/guides/getting-started'
 * - '/app/src/pages/posts/[slug].html' with { params: { slug: 'hello-world' } } -> '/posts/hello-world'
 */
export const computePagePath = (
  pageFilePath: string,
  pagesDir: string = BascikConfig.directory?.pages ?? "src/pages",
  dynamicRoute?: { params?: Record<string, string | number> } | RouteEntry | null,
): string => {
  let resolvedPagePath = pageFilePath;
  if (dynamicRoute && dynamicRoute.params) {
    resolvedPagePath = resolveRoutePath(resolvedPagePath, dynamicRoute.params);
  }
  return getHttpPath(resolvedPagePath, pagesDir);
};

/** Parse + validate routes-script stdout. Returns valid entries and warning strings. */
export const parseRouteList = (
  stdout: string,
  paramNames: string[],
): { routes: RouteEntry[]; warnings: string[]; error?: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const preview = stdout.trim().slice(0, 200);
    return {
      routes: [],
      warnings: [],
      error: `Invalid JSON returned by routes script: "${preview}"`,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      routes: [],
      warnings: [],
      error: `Routes script stdout must be an array of route objects, received: ${typeof parsed}`,
    };
  }

  const routes: RouteEntry[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (
      item === null ||
      typeof item !== "object" ||
      !("params" in item) ||
      item.params === null ||
      typeof item.params !== "object" ||
      Array.isArray(item.params)
    ) {
      warnings.push(
        `Route item at index ${i} is missing required "params" object: ${JSON.stringify(item)} (shorthand [{ key: value }] is not supported)`,
      );
      continue;
    }

    const params = (item as { params: Record<string, unknown>; data?: unknown }).params;
    let valid = true;

    for (const paramName of paramNames) {
      if (!(paramName in params)) {
        warnings.push(
          `Route item at index ${i} is missing required param "${paramName}": ${JSON.stringify(params)}`,
        );
        valid = false;
        break;
      }

      const val = params[paramName];
      if (typeof val !== "string" && typeof val !== "number") {
        warnings.push(
          `Route item at index ${i} has invalid param "${paramName}": expected string or number, received ${typeof val}`,
        );
        valid = false;
        break;
      }

      const strVal = String(val);
      if (strVal.length === 0) {
        warnings.push(
          `Route item at index ${i} has empty param "${paramName}"`,
        );
        valid = false;
        break;
      }

      if (strVal === ".." || strVal.includes("..") || strVal.includes("/") || strVal.includes("\\")) {
        warnings.push(
          `Route item at index ${i} contains illegal path traversal characters in param "${paramName}": "${strVal}"`,
        );
        valid = false;
        break;
      }

      if (strVal.startsWith(".")) {
        warnings.push(
          `Route item at index ${i} has leading dot in param "${paramName}": "${strVal}"`,
        );
        valid = false;
        break;
      }

      if (WINDOWS_RESERVED_NAMES.has(strVal.toLowerCase())) {
        warnings.push(
          `Route item at index ${i} uses Windows reserved device name in param "${paramName}": "${strVal}"`,
        );
        valid = false;
        break;
      }

      if (INVALID_PARAM_CHARS_RE.test(strVal)) {
        warnings.push(
          `Route item at index ${i} contains illegal filename or URL characters in param "${paramName}": "${strVal}"`,
        );
        valid = false;
        break;
      }
    }

    if (valid) {
      const cleanParams: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === "string" || typeof v === "number") {
          cleanParams[k] = v;
        }
      }
      routes.push({
        params: cleanParams,
        ...(item.data !== undefined ? { data: item.data } : {}),
      });
    }
  }

  return { routes, warnings };
};

/** Detect exact and case-insensitive duplicate output paths. */
export const dedupeRoutes = (
  pagePath: string,
  routes: RouteEntry[],
): { routes: RouteEntry[]; warnings: string[] } => {
  const seenExact = new Set<string>();
  const seenCaseInsensitive = new Map<string, string>();
  const deduped: RouteEntry[] = [];
  const warnings: string[] = [];

  for (const route of routes) {
    const resolvedPath = resolveRoutePath(pagePath, route.params);
    if (seenExact.has(resolvedPath)) {
      warnings.push(`Duplicate route output path "${resolvedPath}", skipping duplicate`);
      continue;
    }

    const lowerPath = resolvedPath.toLowerCase();
    if (seenCaseInsensitive.has(lowerPath)) {
      const first = seenCaseInsensitive.get(lowerPath);
      warnings.push(
        `Case-insensitive route output collision between "${first}" and "${resolvedPath}", skipping duplicate`,
      );
      continue;
    }

    seenExact.add(resolvedPath);
    seenCaseInsensitive.set(lowerPath, resolvedPath);
    deduped.push(route);
  }

  return { routes: deduped, warnings };
};

export interface ExecuteRoutesResult {
  routes: RouteEntry[] | null;
  cleanedHtml: string;
}

/**
 * Execute `<script data-bascik-routes>` in the given page HTML.
 *
 * - If the file has bracket placeholders and a routes script, runs it and returns the route list.
 * - Removes the `<script data-bascik-routes>` tag from the HTML.
 * - If the file is not dynamic, returns `routes: null` and strips any misplaced routes tags with a warning.
 * - If the file is dynamic but has no routes script, warns and returns `routes: []`.
 */
export const executeRoutesScript = async (
  html: string,
  filePath?: string,
): Promise<ExecuteRoutesResult> => {
  const matches = [...html.matchAll(ROUTES_SCRIPT_RE)];
  const relPath = filePath
    ? relative(process.cwd(), filePath).replace(/\\/g, "/")
    : "unknown";

  if (matches.length > 1) {
    const index = matches[1].index ?? 0;
    const prefix = html.slice(0, index);
    const prefixLines = prefix.split(/\r?\n/);
    const loc = filePath
      ? ` in "${getRelativePath(filePath, "pages")}" at (line ${prefixLines.length}, column ${prefixLines[prefixLines.length - 1].length + 1})`
      : "";
    throw new Error(
      `[bascik] error: More than one <script data-bascik-routes> tag found${loc}. A page has exactly one route list.`,
    );
  }

  if (matches.length === 0) {
    if (filePath && isDynamicRoute(filePath)) {
      console.warn(
        `[bascik] warning: Bracket filename "${getRelativePath(filePath, "pages")}" has no <script data-bascik-routes> tag. Skipping template.`,
      );
      return { routes: [], cleanedHtml: html };
    }
    return { routes: null, cleanedHtml: html };
  }

  const match = matches[0];
  const [fullTag, scriptContent] = match;
  const index = match.index ?? 0;
  const openTag = fullTag.slice(
    0,
    fullTag.length - scriptContent.length - "</script>".length,
  );

  if (ROUTES_BUILD_CONFLICT_RE.test(openTag)) {
    const prefix = html.slice(0, index);
    const prefixLines = prefix.split(/\r?\n/);
    const loc = filePath
      ? ` in "${getRelativePath(filePath, "pages")}" at (line ${prefixLines.length}, column ${prefixLines[prefixLines.length - 1].length + 1})`
      : "";
    throw new Error(
      `[bascik] error: <script> tag has both data-bascik-routes and data-bascik-build${loc}. Remove one of the attributes.`,
    );
  }

  if (ROUTES_SERVER_CONFLICT_RE.test(openTag)) {
    const prefix = html.slice(0, index);
    const prefixLines = prefix.split(/\r?\n/);
    const loc = filePath
      ? ` in "${getRelativePath(filePath, "pages")}" at (line ${prefixLines.length}, column ${prefixLines[prefixLines.length - 1].length + 1})`
      : "";
    throw new Error(
      `[bascik] error: <script> tag has both data-bascik-routes and data-bascik-server${loc}. Remove one of the attributes.`,
    );
  }

  const cleanedHtml = html.slice(0, index) + html.slice(index + fullTag.length);

  const isComponent =
    filePath &&
    (filePath.includes("/components/") ||
      filePath.includes("\\components\\") ||
      filePath.startsWith("components/") ||
      filePath.startsWith("components\\"));
  if (isComponent) {
    console.warn(
      `[bascik] warning: <script data-bascik-routes> inside a component ("${getRelativePath(filePath, "components")}") will be ignored.`,
    );
    return { routes: null, cleanedHtml };
  }

  if (filePath && !isDynamicRoute(filePath)) {
    console.warn(
      `[bascik] warning: <script data-bascik-routes> found in "${getRelativePath(filePath, "pages")}" which has no bracket parameters. The tag will be ignored.`,
    );
    return { routes: null, cleanedHtml };
  }

  const importRoot = getImportRoot();

  // A leading-slash specifier or src= is a hard error regardless of
  // onRoutesScriptError: it is a syntax mistake in the author's HTML, not a
  // runtime failure of their script.
  const locate = (): string => {
    if (!filePath) return "";
    const pfx = html.slice(0, index);
    const lns = pfx.split(/\r?\n/);
    return ` (in "${getRelativePath(filePath, "pages")}" at line ${lns.length}, column ${lns[lns.length - 1].length + 1})`;
  };
  const rethrowLeadingSlash = (err: unknown): never => {
    if (err instanceof LeadingSlashSpecifierError) {
      throw new Error(`[bascik] error: ${err.message}${locate()}`, { cause: err });
    }
    throw err;
  };

  let trimmedScript = scriptContent.trim();
  let moduleFilePath: string | undefined;
  if (!trimmedScript) {
    const srcMatch = openTag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (srcMatch) {
      const srcPath = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3];
      const containingDir = filePath
        ? dirname(resolve(process.cwd(), filePath))
        : process.cwd();
      let resolvedPath: string;
      try {
        resolvedPath = resolveScriptSrcPath(srcPath, containingDir, importRoot);
      } catch (err) {
        return rethrowLeadingSlash(err);
      }
      moduleFilePath = resolvedPath;
      try {
        trimmedScript = await readFile(resolvedPath, "utf8");
      } catch (err) {
        console.warn(
          '[bascik] warning: Failed to read routes script src "%s":',
          srcPath,
          err,
        );
      }
    }
  }

  const prefix = html.slice(0, index);
  const lines = prefix.split(/\r?\n/);
  const lineOffset = lines.length;
  const openTagLines = openTag.split(/\r?\n/).length - 1;
  const startLine = lineOffset + openTagLines;

  const tempDir = join(process.cwd(), "node_modules", ".cache", "bascik");
  await mkdir(tempDir, { recursive: true });
  const tmpPath = join(
    tempDir,
    `routes-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  );

  const sourceUrlComment = filePath ? `\n//# sourceURL=${relPath}` : "";

  const siteUrl = getSiteUrl();
  const extraEnv: Record<string, string> = {
    BASCIK_SOURCE_FILE: filePath ?? "",
    BASCIK_PAGE_FILE: filePath ?? "",
    BASCIK_PAGE_PATH: filePath
      ? computePagePath(filePath, BascikConfig.directory?.pages ?? "src/pages")
      : "",
    BASCIK_PAGES_DIR: resolve(process.cwd(), BascikConfig.directory.pages),
    BASCIK_BUILD: BascikConfig.isBuild ? "1" : "0",
  };
  // Only set BASCIK_SITE_URL when a value exists: an absent key lets scripts
  // distinguish "unset" from "empty".
  if (siteUrl !== undefined) {
    extraEnv.BASCIK_SITE_URL = siteUrl;
  }

  const scriptBaseDir = moduleFilePath
    ? dirname(moduleFilePath)
    : filePath
      ? dirname(resolve(process.cwd(), filePath))
      : process.cwd();
  let preparedScript: string;
  try {
    preparedScript = rewriteModuleSpecifiers(trimmedScript, scriptBaseDir, { importRoot });
  } catch (err) {
    return rethrowLeadingSlash(err);
  }

  let stdout = "";
  let stderr = "";
  try {
    await writeFile(tmpPath, preparedScript + sourceUrlComment, "utf8");
    const result = await runModule(tmpPath, extraEnv);
    stdout = result.stdout;
    stderr = result.stderr;
    if (stderr) process.stderr.write(stderr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cleanedMsg = cleanStackTrace(msg, tmpPath, relPath, startLine);
    let errorMsg = `[bascik] routes script error`;
    if (filePath) {
      const pfx = html.slice(0, index);
      const lns = pfx.split(/\r?\n/);
      errorMsg += ` in "${getRelativePath(filePath, "pages")}" at (line ${lns.length}, column ${lns[lns.length - 1].length + 1})`;
    }
    const behavior = BascikConfig.scripts?.onRoutesScriptError ?? "error";
    if (behavior === "error") {
      console.error(`${errorMsg}:\n${cleanedMsg}`);
      throw new Error(`${errorMsg}:\n${cleanedMsg}`);
    } else {
      console.warn(`${errorMsg}:\n${cleanedMsg}`);
    }
    return { routes: [], cleanedHtml };
  } finally {
    await unlink(tmpPath).catch(() => { });
  }

  const paramNames = filePath ? extractRouteParamNames(filePath) : [];
  const {
    routes: parsedRoutes,
    warnings: parseWarnings,
    error: parseError,
  } = parseRouteList(stdout, paramNames);

  if (parseError) {
    let errorMsg = `[bascik] routes script error`;
    if (filePath) {
      const pfx = html.slice(0, index);
      const lns = pfx.split(/\r?\n/);
      errorMsg += ` in "${getRelativePath(filePath, "pages")}" at (line ${lns.length}, column ${lns[lns.length - 1].length + 1})`;
    }
    const behavior = BascikConfig.scripts?.onRoutesScriptError ?? "error";
    if (behavior === "error") {
      console.error(`${errorMsg}:\n${parseError}`);
      throw new Error(`${errorMsg}:\n${parseError}`);
    } else {
      console.warn(`${errorMsg}:\n${parseError}`);
    }
    return { routes: [], cleanedHtml };
  }

  for (const w of parseWarnings) {
    console.warn(`[bascik] route warning in "${relPath}": ${w}`);
  }

  const { routes: dedupedRoutes, warnings: dedupeWarnings } = dedupeRoutes(
    filePath ?? "",
    parsedRoutes,
  );
  for (const w of dedupeWarnings) {
    console.warn(`[bascik] route warning in "${relPath}": ${w}`);
  }

  if (dedupedRoutes.length === 0) {
    console.warn(`[bascik] warning: routes template "${relPath}" produced 0 routes.`);
  }

  return { routes: dedupedRoutes, cleanedHtml };
};

