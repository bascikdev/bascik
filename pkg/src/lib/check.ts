/**
 * @module check
 *
 * Static analysis for Bascik projects (`bascik --check`).
 *
 * This module owns the questions that need the whole project:
 *  - Config, site URL, and pages directory validity
 *  - Component names, references, cycles, and components that are never used
 *  - Routes that collide, for pages and for API routes
 *  - Whether the compiled `dist/` HTML parses (optional parse5)
 *
 * Questions about one file (an attribute typo, CSS that cannot be scoped, an API route that exports no handler)
 * belong to `@bascik/language-server`, the engine the editor uses. When it is installed, `bascik --check` runs it
 * over the project's pages, components, and API routes and merges the findings. Each rule lives in exactly one
 * place; see docs/content/internals/diagnostics.md for which.
 *
 * Returns a structured data model of findings. Output formatting is separated
 * into human and JSON formatters.
 */

import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { existsSync } from "node:fs";
import { listPages, getRelativePath, deepReadDirFlat } from "./file-system.ts";
import { findComponentRoot } from "./component-roots.ts";
import { listComponents } from "./components.ts";
import { BascikConfig } from "./config.ts";
import { maskElementContents } from "./shielding.ts";
import { createExternalTagMatcher } from "./external-components.ts";
import {
  scanApiRouteFiles,
  fileToApiRoutePath,
  findApiRoutePatternProblems,
} from "./api-routes.ts";
import {
  LanguageServerRequiredError,
  languageServerFixMessage,
  languageServerHint,
  runLanguageServerCheck,
  type LanguageServerDiagnostic,
} from "./check-language-server.ts";
import { getHttpPath } from "./paths.ts";
import { buildMissingSiteUrlError } from "./sitemap.ts";
import { getSiteUrl, SITE_URL_ENV_VAR } from "./environment.ts";
import { config as userConfig, modeOverrides } from "./userConfig.ts";
import {
  validateUserConfig,
  type ConfigValidationError,
  PLAUSIBLE_TAG_NAME,
  PRESERVE_WILDCARD_PATTERN,
} from "./config-validation.ts";
import { stdout } from "./colors.ts";
import { BUILD_ATTR_NAME, BUILD_ONCE_ATTR_NAME } from "./html-patterns.ts";
import type { ComponentList } from "./types.ts";

export type FindingSeverity = "error" | "warning";

export interface FindingLocation {
  filePath: string;
  line?: number;
  column?: number;
}

export interface CheckFinding {
  /** The rule id. For per-file findings this is the language server's rule id. */
  category: string;
  severity: FindingSeverity;
  message: string;
  locations: FindingLocation[];
  suggestion?: string;
  /** `language-server` for per-file findings; absent for the project checks this module owns. */
  source?: "language-server";
}

export interface CheckFindings {
  errors: number;
  warnings: number;
  pagesChecked: number;
  componentsChecked: number;
  items: CheckFinding[];
  /** Number of dist/ HTML files validated against the WHATWG spec, or null when dist/ does not exist or is empty. */
  distHtmlChecked: number | null;
  /** True when dist/ has HTML files but parse5 is not installed. */
  distHtmlSpecHintNeeded: boolean;
  /** Number of files the language server checked, or null when it is not installed or too old. */
  perFileChecked: number | null;
  /** Why the per-file checks did not run, when they did not. Absent when they ran. */
  perFileHint?: string;
  /** Files `--fix` rewrote, relative to the project. */
  fixedFiles: string[];
  /** The language server's own one-line rendering of a finding. Absent when the per-file checks did not run. */
  perFileFormat?: (
    diagnostic: LanguageServerDiagnostic,
    color?: boolean,
  ) => string;
}

/**
 * Attempt to load parse5 as an optional dependency.
 * Returns null silently when parse5 is not installed.
 */
async function loadParse5(): Promise<
  | ((
      html: string,
      opts: {
        sourceCodeLocationInfo: boolean;
        onParseError: (e: {
          code: string;
          startLine?: number;
          startCol?: number;
        }) => void;
      },
    ) => void)
  | null
> {
  try {
    const mod = (await import("parse5")) as {
      parse: (html: string, opts: unknown) => void;
    };
    return mod.parse;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
      return null;
    throw err;
  }
}

/** Recursively collect files with a given extension under a directory. */
async function walkFiles(dir: string, ext: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full, ext)));
    else if (entry.isFile() && entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** Simple edit distance (Levenshtein) with no external dependencies. */
const editDistance = (a: string, b: string): number => {
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  const curr: number[] = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
};

/** Suggest closest component name if within edit distance <= 2. */
export const suggestComponentName = (
  tag: string,
  knownComponents: Iterable<string>,
): string | undefined => {
  const normTag = tag.toLowerCase();
  let bestMatch: { candidate: string; distance: number } | undefined;
  for (const candidate of knownComponents) {
    const normCandidate = candidate.toLowerCase();
    const distance = editDistance(normTag, normCandidate);
    if (
      distance <= 2 &&
      (bestMatch === undefined || distance < bestMatch.distance)
    ) {
      bestMatch = { candidate, distance };
    }
  }
  return bestMatch?.candidate;
};

/**
 * Strip the inner content of elements that can legitimately contain raw,
 * non-markup text — `script`, `style`, `textarea`, plus whatever the user
 * configured in `scoping.preserve` (defaults to `["code"]`).
 */
const stripElementContents = (html: string): string => {
  // Keep entries that satisfy the scoping.preserve validation rule (tag names
  // and `*` wildcard patterns) and drop anything else.
  const extra = (BascikConfig.scoping?.preserve ?? [])
    .map((t) => String(t))
    .filter(
      (t) => PLAUSIBLE_TAG_NAME.test(t) || PRESERVE_WILDCARD_PATTERN.test(t),
    );
  const protectedTags = ["script", "style", "textarea", ...extra];
  return maskElementContents(html, protectedTags);
};

export interface TagOccurrence {
  tag: string;
  line: number;
}

/**
 * Extract all hyphenated tag names from an HTML string along with line numbers.
 */
export const extractCustomTagOccurrences = (html: string): TagOccurrence[] => {
  // Strip comments first while preserving newlines
  const noComments = html.replace(/<!--[\s\S]*?-->/g, (match) => {
    const newlines = match.match(/\n/g);
    return newlines ? newlines.join("") : " ";
  });
  const stripped = stripElementContents(noComments);
  const occurrences: TagOccurrence[] = [];
  const lines = stripped.split("\n");
  const re = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s\/>]/gi;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineText = lines[lineIndex];
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(lineText)) !== null) {
      occurrences.push({
        tag: m[1].toLowerCase(),
        line: lineIndex + 1,
      });
    }
  }

  return occurrences;
};

/**
 * Extract all hyphenated tag names from an HTML string (legacy helper).
 */
export const extractCustomTags = (html: string): Set<string> => {
  const occs = extractCustomTagOccurrences(html);
  const tags = new Set<string>();
  for (const o of occs) {
    tags.add(o.tag);
  }
  return tags;
};

/** Return a human-readable relative path for a file. */
const toDisplay = (filePath: string): string => {
  try {
    const normalized = filePath.replace(/\\/g, "/");
    if (
      normalized.includes(
        BascikConfig.directory?.pages?.replace(/\\/g, "/") ?? "src/pages",
      )
    ) {
      return getRelativePath(filePath, "pages");
    }
    if (findComponentRoot(normalized) !== undefined) {
      return getRelativePath(filePath, "components");
    }
  } catch {
    // fall through
  }
  try {
    return relative(process.cwd(), filePath).replace(/\\/g, "/");
  } catch {
    return filePath;
  }
};

/**
 * Extract all `<script data-bascik-build>` block contents from an HTML string.
 */
const extractBuildScripts = (html: string): string[] => {
  const scripts: string[] = [];
  const scriptRegex =
    /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const attrs = match[1];
    const content = match[2];
    if (BUILD_DIRECTIVE_RE.test(attrs)) {
      scripts.push(content);
    }
  }
  return scripts;
};

const maskPreservedSubtrees = (html: string): string => {
  let result = html;
  const re =
    /(<([a-z][a-z0-9:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*\bdata-bascik-preserve\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2(?:[\t\n\f\r /][^>]*)?>)/gi;
  let previous = "";
  while (previous !== result) {
    previous = result;
    result = result.replace(
      re,
      (_m, open: string, _tag: string, inner: string, close: string) => {
        return `${open}${" ".repeat(inner.length)}${close}`;
      },
    );
  }
  return result;
};

// Whole-attribute-name directive test (prompt 65 step 0).
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const BUILD_DIRECTIVE_RE = new RegExp(
  String.raw`(?:^|\s)(?:${BUILD_ATTR_NAME}|${BUILD_ONCE_ATTR_NAME})`,
  "i",
);

const mapConfigErrorSeverity = (
  error: ConfigValidationError,
): FindingSeverity => {
  if (error.key.startsWith("pipeline.watchPaths[")) return "warning";
  if (error.key.startsWith("assets.inlineStyles[")) return "warning";
  return "error";
};

const resolveConfigSourcePath = (): string => {
  const argv = process.argv.slice(2);
  const inline = argv.find((arg) => arg.startsWith("--config="));
  const inlinePath = inline ? inline.slice("--config=".length) : undefined;
  const configFlagIndex = argv.indexOf("--config");
  const flaggedPath =
    configFlagIndex !== -1 &&
    argv[configFlagIndex + 1] &&
    !argv[configFlagIndex + 1].startsWith("-")
      ? argv[configFlagIndex + 1]
      : undefined;
  const explicitPath = inlinePath || flaggedPath;
  if (explicitPath) {
    return relative(
      process.cwd(),
      resolve(process.cwd(), explicitPath),
    ).replace(/\\/g, "/");
  }

  const jsPath = resolve(process.cwd(), "bascik.config.js");
  if (existsSync(jsPath)) return "bascik.config.js";
  const tsPath = resolve(process.cwd(), "bascik.config.ts");
  if (existsSync(tsPath)) return "bascik.config.ts";
  return "bascik.config.js";
};

const canonicalPath = (filePath: string): string =>
  resolve(process.cwd(), filePath).replace(/\\/g, "/");

const findComponentCycles = (graph: Map<string, Set<string>>): string[][] => {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    const deps = graph.get(node) ?? new Set<string>();
    for (const dep of deps) {
      const depState = state.get(dep) ?? 0;
      if (depState === 0) {
        visit(dep);
        continue;
      }
      if (depState === 1) {
        const idx = stack.lastIndexOf(dep);
        if (idx >= 0) {
          const cycle = [...stack.slice(idx), dep];
          const key = cycle.join(" -> ");
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(cycle);
          }
        }
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of graph.keys()) {
    if ((state.get(node) ?? 0) === 0) visit(node);
  }

  return cycles;
};

/**
 * Run the static check across pages, components, and API routes.
 * Produces structured data without printing.
 */
export const checkProject = async (
  options: { fix?: boolean } = {},
): Promise<CheckFindings> => {
  const items: CheckFinding[] = [];
  const configSource = resolveConfigSourcePath();

  // The per-file checks run first: `--fix` rewrites files, and everything below should read the fixed text.
  const perFile = await runLanguageServerCheck({ fix: options.fix });
  if (options.fix && perFile.status !== "ran") {
    // Fixes are the language server's. Reporting success with nothing fixed would be a lie.
    throw new LanguageServerRequiredError(languageServerFixMessage(perFile));
  }

  const formatConfigValue = (value: unknown): string => {
    if (typeof value === "string") return `\"${value}\"`;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const configErrors = validateUserConfig(userConfig, modeOverrides, {
    env: process.env,
    cwd: process.cwd(),
  });
  for (const error of configErrors) {
    const valueSuffix =
      error.value === undefined
        ? ""
        : ` (received ${formatConfigValue(error.value)})`;
    items.push({
      category: "config-validation",
      severity: mapConfigErrorSeverity(error),
      message: `${error.key}: ${error.message}${valueSuffix}`,
      locations: [{ filePath: configSource }],
    });
  }

  const needsSiteUrl =
    (BascikConfig.generate?.sitemap ?? true) ||
    (BascikConfig.generate?.robots ?? true);
  if (needsSiteUrl) {
    const siteUrl = getSiteUrl();
    if (!siteUrl) {
      const features: string[] = [];
      if (BascikConfig.generate?.sitemap ?? true)
        features.push("generate.sitemap");
      if (BascikConfig.generate?.robots ?? true)
        features.push("generate.robots");
      items.push({
        category: "missing-site-url",
        severity: "error",
        message: buildMissingSiteUrlError(features).replace(/\s+/g, " ").trim(),
        locations: [{ filePath: configSource }],
      });
    }
  }

  let pageList: string[] = [];
  try {
    pageList = (await listPages()) ?? [];
  } catch (error) {
    items.push({
      category: "pages-directory",
      severity: "error",
      message: `could not read pages directory "${BascikConfig.directory?.pages ?? "src/pages"}": ${error instanceof Error ? error.message : String(error)}`,
      locations: [{ filePath: configSource }],
    });
  }

  const pagesDir = resolve(
    process.cwd(),
    BascikConfig.directory?.pages ?? "src/pages",
  );
  if (existsSync(pagesDir) && pageList.length === 0) {
    items.push({
      category: "pages-directory",
      severity: "error",
      message: `directory.pages "${BascikConfig.directory?.pages ?? "src/pages"}" has no HTML pages.`,
      locations: [{ filePath: configSource }],
    });
  }

  let componentList: ComponentList = {};
  let componentFilePaths: string[] = [];
  try {
    componentList = await (listComponents() as Promise<ComponentList>);
    componentFilePaths = Object.values(componentList)
      .map((c) => c.fileName)
      .filter((f): f is string => Boolean(f));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const duplicateBlockRegex =
      /error:\s*two component files both define the tag <([^>]+)>\s*\n([\s\S]*?)(?:\n\n|$)/gi;
    let matchedDuplicate = false;
    let block: RegExpExecArray | null;
    while ((block = duplicateBlockRegex.exec(message)) !== null) {
      matchedDuplicate = true;
      const tag = (block[1] ?? "").toLowerCase();
      const pathMatches = (block[2] ?? "").match(/^\s+(.+)$/gm) ?? [];
      const locations = pathMatches
        .map((line) => line.trim())
        .filter(Boolean)
        .map((filePath) => ({ filePath: toDisplay(filePath) }));
      items.push({
        category: "duplicate-component-name",
        severity: "error",
        message: `duplicate component tag <${tag}> is defined by multiple files`,
        locations,
      });
    }
    if (!matchedDuplicate) {
      items.push({
        category: "component-list",
        severity: "error",
        message,
        locations: [{ filePath: configSource }],
      });
    }

    // Scan every configured root so components outside the failing one are
    // still known and their tags are not reported as unmatched.
    const componentRoots = (
      BascikConfig.directory?.components ?? ["src/components"]
    )
      .map((root) => resolve(process.cwd(), root))
      .filter((root) => existsSync(root));
    if (componentRoots.length > 0) {
      const htmlFiles = (
        await Promise.all(
          componentRoots.map((root) => deepReadDirFlat(root, /\.html$/i)),
        )
      ).flat();
      const nameToPaths = new Map<string, string[]>();
      for (const filePath of htmlFiles) {
        const componentName = filePath
          .replace(/^.*[\\/]/, "")
          .split(".")[0]
          .toLowerCase();
        const list = nameToPaths.get(componentName) ?? [];
        list.push(filePath);
        nameToPaths.set(componentName, list);
      }
      for (const [name, paths] of nameToPaths.entries()) {
        if (paths.length === 0) continue;
        componentList[name] = componentList[name] ?? {
          fileName: paths[0],
          fileContent: "",
        };
      }
      componentFilePaths = htmlFiles;
    }
  }

  const knownComponents = new Set(Object.keys(componentList));

  // Scan every page AND every component source file for hyphenated tags
  const allFilePaths = [...pageList, ...componentFilePaths];

  const scanResults = await Promise.all(
    allFilePaths.map(async (filePath) => {
      try {
        const html = await readFile(filePath, "utf8");
        return {
          filePath,
          html,
          occurrences: extractCustomTagOccurrences(html),
          buildScripts: extractBuildScripts(html),
        };
      } catch {
        return { filePath, html: "", occurrences: [], buildScripts: [] };
      }
    }),
  );

  const isExternalTag = createExternalTagMatcher(
    BascikConfig.components?.external,
  );
  const usedComponents = new Set<string>();
  const unmatchedTagLocations = new Map<string, FindingLocation[]>();
  const componentGraph = new Map<string, Set<string>>();
  const componentPathByName = new Map<string, string>();
  const componentNameByPath = new Map<string, string>();

  for (const [componentName, componentData] of Object.entries(componentList)) {
    const fileName = componentData.fileName;
    if (!fileName) continue;
    const canonical = canonicalPath(fileName);
    componentPathByName.set(componentName, canonical);
    componentNameByPath.set(canonical, componentName);
    componentGraph.set(canonical, new Set<string>());
  }

  // Check build script sources for string literal references to components
  for (const { buildScripts } of scanResults) {
    for (const scriptContent of buildScripts) {
      for (const comp of knownComponents) {
        // String literal check: e.g. "my-card", 'my-card', `my-card`
        const literalRegex = new RegExp(`["'\`]${comp}["'\`]`);
        if (literalRegex.test(scriptContent)) {
          usedComponents.add(comp);
        }
      }
    }
  }

  for (const { filePath, html, occurrences } of scanResults) {
    const displayPath = toDisplay(filePath);

    const ownerPath = canonicalPath(filePath);
    if (componentNameByPath.has(ownerPath)) {
      const maskedPreserve = maskPreservedSubtrees(html);
      const deps = extractCustomTagOccurrences(maskedPreserve)
        .map((o) => o.tag)
        .filter((tag) => knownComponents.has(tag));
      for (const dep of deps) {
        const depPath = componentPathByName.get(dep);
        if (!depPath) continue;
        const edges = componentGraph.get(ownerPath) ?? new Set<string>();
        edges.add(depPath);
        componentGraph.set(ownerPath, edges);
      }
    }

    for (const { tag, line } of occurrences) {
      if (knownComponents.has(tag)) {
        usedComponents.add(tag);
      } else if (!isExternalTag(tag)) {
        const list = unmatchedTagLocations.get(tag) ?? [];
        list.push({ filePath: displayPath, line });
        unmatchedTagLocations.set(tag, list);
      }
    }
  }

  // Unmatched tags -> warnings
  for (const [tag, locations] of unmatchedTagLocations.entries()) {
    const suggestion = suggestComponentName(tag, knownComponents);
    items.push({
      category: "unmatched-tag",
      severity: "warning",
      message: `<${tag}>`,
      locations,
      suggestion,
    });
  }

  const cycles = findComponentCycles(componentGraph);
  for (const cycle of cycles) {
    const start = cycle[0];
    const sourceName = componentNameByPath.get(start);
    const sourcePath = sourceName
      ? componentList[sourceName]?.fileName
      : undefined;
    items.push({
      category: "circular-component-reference",
      severity: "error",
      message: `component cycle detected: ${cycle.map((path) => `<${componentNameByPath.get(path) ?? path}>`).join(" -> ")}`,
      locations: sourcePath ? [{ filePath: toDisplay(sourcePath) }] : [],
    });
  }

  // Route output collisions from page path resolution.
  const pagesByRouteExact = new Map<string, string[]>();
  const firstRouteByLower = new Map<
    string,
    { route: string; filePath: string }
  >();
  for (const pagePath of pageList) {
    const rel = getRelativePath(pagePath, "pages");
    const route = getHttpPath(
      rel,
      BascikConfig.directory?.pages ?? "src/pages",
    );

    const list = pagesByRouteExact.get(route) ?? [];
    list.push(pagePath);
    pagesByRouteExact.set(route, list);

    const lowerRoute = route.toLowerCase();
    const firstSeen = firstRouteByLower.get(lowerRoute);
    if (firstSeen && firstSeen.route !== route) {
      items.push({
        category: "duplicate-route-resolution",
        severity: "error",
        message: `Case-insensitive route output collision between "${firstSeen.route}" and "${route}", skipping duplicate`,
        locations: [
          { filePath: toDisplay(firstSeen.filePath) },
          { filePath: toDisplay(pagePath) },
        ],
      });
    } else if (!firstSeen) {
      firstRouteByLower.set(lowerRoute, { route, filePath: pagePath });
    }
  }
  for (const [route, files] of pagesByRouteExact.entries()) {
    if (files.length < 2) continue;
    items.push({
      category: "duplicate-route-resolution",
      severity: "error",
      message: `Duplicate route output path "${route}", skipping duplicate`,
      locations: files.map((filePath) => ({ filePath: toDisplay(filePath) })),
    });
  }

  // ── API route table analysis (Prompt 49) ────────────────────────────
  // Whether a route file exports a handler is a per-file question and belongs to the language server. Whether two
  // files claim one URL needs every route at once, so it is checked here.
  const apiDir = resolve(
    process.cwd(),
    BascikConfig.directory?.api ?? "src/api",
  );
  if (existsSync(apiDir)) {
    const apiFiles = await scanApiRouteFiles(apiDir);
    const routesByUrl = new Map<string, string[]>();

    for (const filePath of apiFiles) {
      const normalizedApiDir = apiDir.replace(/\\/g, "/");
      const normalizedFilePath = filePath.replace(/\\/g, "/");
      let rel = normalizedFilePath.startsWith(normalizedApiDir + "/")
        ? normalizedFilePath.slice(normalizedApiDir.length + 1)
        : filePath;
      const routeUrl = fileToApiRoutePath(rel, BascikConfig.base ?? "/");

      const existing = routesByUrl.get(routeUrl);
      if (existing) {
        existing.push(filePath);
      } else {
        routesByUrl.set(routeUrl, [filePath]);
      }
    }

    // Check for collisions
    for (const [url, filePaths] of routesByUrl.entries()) {
      if (filePaths.length > 1) {
        items.push({
          category: "route-collision",
          severity: "error",
          message: `Route URL Collision: "${url}" is declared in multiple route files`,
          locations: filePaths.map((f) => ({ filePath: toDisplay(f) })),
        });
      }
    }

    // Catch-all patterns: malformed `[...name]` segments and ambiguous pairs.
    const uniqueRoutes = [...routesByUrl.entries()].map(([path, files]) => ({
      path,
      filePath: files[0],
    }));
    for (const problem of findApiRoutePatternProblems(uniqueRoutes)) {
      items.push({
        category:
          problem.kind === "ambiguous"
            ? "route-collision"
            : "invalid-catch-all",
        severity: "error",
        message: problem.message,
        locations: problem.filePaths.map((f) => ({ filePath: toDisplay(f) })),
      });
    }
  }

  // Unused components -> warnings
  const unused = [...knownComponents].filter((c) => !usedComponents.has(c));
  for (const comp of unused) {
    const rawPath = componentList[comp]?.fileName;
    const locPath = rawPath ? toDisplay(rawPath) : comp;
    items.push({
      category: "unused-component",
      severity: "warning",
      message: comp,
      locations: [{ filePath: locPath }],
    });
  }

  // ── dist/ HTML spec validation (optional parse5 dep) ─────────────────────
  // When parse5 is installed, walk every compiled HTML file in dist/ and run
  // the WHATWG HTML5 parser over it. Any parse error becomes a "dist-html-spec"
  // finding so the user sees exactly where the output is malformed.
  // When parse5 is not installed, set a hint flag so the formatter can nudge
  // the user toward installing it — without failing the check.
  const distDir = resolve(process.cwd(), BascikConfig.directory?.out ?? "dist");
  let distHtmlChecked: number | null = null;
  let distHtmlSpecHintNeeded = false;

  if (existsSync(distDir)) {
    const distHtmlFiles = await walkFiles(distDir, ".html");
    if (distHtmlFiles.length > 0) {
      const parse5Parse = await loadParse5();
      if (parse5Parse === null) {
        distHtmlSpecHintNeeded = true;
      } else {
        distHtmlChecked = distHtmlFiles.length;
        for (const file of distHtmlFiles) {
          let html: string;
          try {
            html = await readFile(file, "utf-8");
          } catch {
            continue;
          }
          const relPath = relative(distDir, file);
          parse5Parse(html, {
            sourceCodeLocationInfo: true,
            onParseError: (err: {
              code: string;
              startLine?: number;
              startCol?: number;
            }) => {
              items.push({
                category: "dist-html-spec",
                severity: "error",
                message: `[${err.code}]`,
                locations: [{ filePath: relPath, line: err.startLine }],
              });
            },
          });
        }
      }
    }
  }

  // ── Per-file findings from the language server ───────────────────────────
  for (const diagnostic of perFile.status === "ran"
    ? perFile.diagnostics
    : []) {
    items.push({
      category: diagnostic.code ?? "language-server",
      severity: diagnostic.severity,
      message: diagnostic.message,
      locations: [
        {
          filePath: diagnostic.filePath.replace(/\\/g, "/"),
          line: diagnostic.line,
          column: diagnostic.column,
        },
      ],
      source: "language-server",
    });
  }

  const errors = items.filter((i) => i.severity === "error").length;
  const warnings = items.filter((i) => i.severity === "warning").length;

  return {
    errors,
    warnings,
    pagesChecked: pageList.length,
    componentsChecked: knownComponents.size,
    items,
    distHtmlChecked,
    distHtmlSpecHintNeeded,
    perFileChecked: perFile.status === "ran" ? perFile.filesChecked : null,
    perFileHint: languageServerHint(perFile),
    fixedFiles: perFile.status === "ran" ? perFile.fixedFiles : [],
    perFileFormat:
      perFile.status === "ran" ? perFile.formatDiagnostic : undefined,
  };
};

/** Category descriptive headers and explanations. */
const CATEGORY_META: Record<string, { title: string; description: string }> = {
  "unmatched-tag": {
    title: "Components with no matching file",
    description:
      "These are either typos, or third-party web components. Bascik does not\ntranspile them; they are passed through to the browser unchanged.\nDeclare intentional ones in components.external to hide them.",
  },
  "unused-component": {
    title: "Unused components",
    description:
      "Defined but never referenced. Safe to delete, or referenced only from a\nbuild script, which this check cannot always see.",
  },
  "route-collision": {
    title: "API route collisions",
    description:
      "Multiple API route files resolve to the same URL path, or to ambiguous catch-all patterns.",
  },
  "invalid-catch-all": {
    title: "Invalid API catch-all routes",
    description:
      "A catch-all must be a named, whole, final segment such as [...path].",
  },
  "config-validation": {
    title: "Configuration validation",
    description:
      "Configuration keys, values, and path references that need correction.",
  },
  "missing-site-url": {
    title: "Missing site URL",
    description: `Features requiring ${SITE_URL_ENV_VAR} are enabled but no site URL is configured.`,
  },
  "duplicate-component-name": {
    title: "Duplicate component names",
    description: "Multiple component files define the same tag name.",
  },
  "circular-component-reference": {
    title: "Circular component references",
    description:
      "Component templates reference each other in a cycle, which causes runaway expansion.",
  },
  "pages-directory": {
    title: "Pages directory issues",
    description:
      "The configured pages directory must exist, be readable, and contain at least one HTML page.",
  },
  "duplicate-route-resolution": {
    title: "Duplicate route resolution",
    description: "Multiple pages resolve to the same route path.",
  },
  "component-list": {
    title: "Component scan failures",
    description:
      "Component discovery failed and needs correction before a reliable check run.",
  },
  "dist-html-spec": {
    title: "dist/ HTML spec violations (WHATWG HTML5)",
    description:
      "parse5 detected parse errors in compiled HTML files. These represent\n" +
      "structural defects that a spec-compliant parser would reject. Run\n" +
      "`bascik --build` again after fixing the underlying source.",
  },
};

const plural = (count: number, word: string): string =>
  `${count} ${word}${count !== 1 ? "s" : ""}`;

/** The lines under the summary: what else was checked, what was skipped, and what `--fix` rewrote. */
const statusLines = (findings: CheckFindings): string[] => {
  const lines: string[] = [];
  if ((findings.distHtmlChecked ?? null) !== null) {
    lines.push(
      `✓ ${plural(findings.distHtmlChecked as number, "dist/ HTML file")} pass WHATWG spec (parse5)`,
    );
  } else if (findings.distHtmlSpecHintNeeded) {
    lines.push(
      "ℹ  dist/ HTML not validated — install parse5 to enable WHATWG spec checking",
    );
  }
  if ((findings.perFileChecked ?? null) !== null) {
    lines.push(
      `✓ ${plural(findings.perFileChecked as number, "file")} checked by @bascik/language-server`,
    );
  } else if (findings.perFileHint) {
    lines.push(`ℹ  ${findings.perFileHint}`);
  }
  if (findings.fixedFiles?.length) {
    lines.push(
      `✓ fixed ${plural(findings.fixedFiles.length, "file")}: ${findings.fixedFiles.join(", ")}`,
    );
  }
  return lines;
};

/** A per-file finding rebuilt as the language server reports it, so both commands print it the same way. */
const toLanguageServerDiagnostic = (
  item: CheckFinding,
): LanguageServerDiagnostic => ({
  filePath: item.locations[0]?.filePath ?? "",
  line: item.locations[0]?.line ?? 1,
  column: item.locations[0]?.column ?? 1,
  severity: item.severity,
  code: item.category === "language-server" ? undefined : item.category,
  message: item.message,
});

const perFileSection = (
  findings: CheckFindings,
  items: CheckFinding[],
): string => {
  const render =
    findings.perFileFormat ??
    ((d: LanguageServerDiagnostic) =>
      `${d.filePath}:${d.line}:${d.column} - ${d.severity}: ${d.code ? `(${d.code}) ` : ""}${d.message}`);
  const color = stdout.green("x") !== "x";
  const lines = items
    .map(toLanguageServerDiagnostic)
    .sort(
      (a, b) =>
        a.filePath.localeCompare(b.filePath) ||
        a.line - b.line ||
        a.column - b.column,
    )
    .map((diagnostic) => `  ${render(diagnostic, color)}`);
  return (
    `Per-file checks (${items.length})\n` +
    "  Reported by @bascik/language-server, the engine the editor uses. Run it on its own\n" +
    "  with `npx bascik-language-server --check`.\n\n" +
    `${lines.join("\n")}\n`
  );
};

/**
 * Format check findings into human-readable console output.
 */
export const formatFindingsHuman = (findings: CheckFindings): string => {
  const sections: string[] = ["bascik --check\n"];

  // Project findings are grouped by rule. Per-file findings are listed by file, as the editor shows them.
  const grouped = new Map<string, CheckFinding[]>();
  const perFileItems: CheckFinding[] = [];
  for (const item of findings.items) {
    if (item.source === "language-server") {
      perFileItems.push(item);
      continue;
    }
    const list = grouped.get(item.category) ?? [];
    list.push(item);
    grouped.set(item.category, list);
  }

  if (findings.items.length === 0) {
    const warnNote =
      findings.warnings > 0 ? ` (${findings.warnings} warnings)` : "";
    const status = statusLines(findings)
      .map((line) => `\n${line}`)
      .join("");
    return `bascik --check\n\n✓ ${findings.pagesChecked} page${findings.pagesChecked !== 1 ? "s" : ""} and ${findings.componentsChecked} component${findings.componentsChecked !== 1 ? "s" : ""} checked — no errors${warnNote}${status}`;
  }

  for (const [category, items] of grouped.entries()) {
    const meta = CATEGORY_META[category] ?? {
      title: category,
      description: "",
    };
    const count = items.length;
    let section = `${meta.title} (${count})\n`;
    if (meta.description) {
      const indented = meta.description
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      section += `${indented}\n\n`;
    }

    for (const item of items) {
      if (category === "unmatched-tag") {
        const locStr = item.locations
          .map((loc) =>
            loc.line !== undefined
              ? `${loc.filePath}:${loc.line}`
              : loc.filePath,
          )
          .join(", ");
        const tagFormatted = item.message.padEnd(18);
        section += `  ${tagFormatted} ${locStr}\n`;
        if (item.suggestion) {
          section += `                     did you mean <${item.suggestion}>?\n`;
        }
      } else if (category === "unused-component") {
        const loc = item.locations[0]?.filePath ?? item.message;
        section += `  ${loc}\n`;
      } else if (category === "route-collision") {
        section += `  ${item.message}\n`;
        for (const loc of item.locations) {
          section += `    - ${loc.filePath}\n`;
        }
      } else {
        const locStr = item.locations
          .map((loc) =>
            loc.line !== undefined
              ? `${loc.filePath}:${loc.line}`
              : loc.filePath,
          )
          .join(", ");
        section += `  ${item.message} (${locStr})\n`;
      }
    }
    sections.push(section);
  }

  if (perFileItems.length > 0)
    sections.push(perFileSection(findings, perFileItems));

  const symbol = findings.errors > 0 ? "✗" : "✓";
  const summary = [
    `${symbol} ${findings.errors} error${findings.errors !== 1 ? "s" : ""}, ${findings.warnings} warning${findings.warnings !== 1 ? "s" : ""}`,
    ...statusLines(findings),
  ].join("\n");
  sections.push(summary);

  return sections.join("\n");
};

export interface CheckJsonOutput {
  errors: number;
  warnings: number;
  pagesChecked: number;
  componentsChecked: number;
  distHtmlChecked: number | null;
  distHtmlSpecHintNeeded: boolean;
  /** Files the language server checked, or null when it is not installed or too old. */
  perFileChecked: number | null;
  /** True when the per-file checks were skipped because the language server is missing or too old. */
  perFileHintNeeded: boolean;
  fixedFiles: string[];
  findings: Array<{
    category: string;
    severity: FindingSeverity;
    message: string;
    locations: FindingLocation[];
    suggestion?: string;
    /** `language-server` for per-file findings; absent for the project checks. */
    source?: "language-server";
  }>;
}

/**
 * Format check findings as a JSON string matching the documented schema.
 */
export const formatFindingsJson = (findings: CheckFindings): string => {
  const output: CheckJsonOutput = {
    errors: findings.errors,
    warnings: findings.warnings,
    pagesChecked: findings.pagesChecked,
    componentsChecked: findings.componentsChecked,
    distHtmlChecked: findings.distHtmlChecked,
    distHtmlSpecHintNeeded: findings.distHtmlSpecHintNeeded,
    perFileChecked: findings.perFileChecked ?? null,
    perFileHintNeeded: Boolean(findings.perFileHint),
    fixedFiles: findings.fixedFiles ?? [],
    findings: findings.items.map((item) => ({
      category: item.category,
      severity: item.severity,
      message: item.message,
      locations: item.locations,
      ...(item.suggestion ? { suggestion: item.suggestion } : {}),
      ...(item.source ? { source: item.source } : {}),
    })),
  };
  return JSON.stringify(output, null, 2);
};
