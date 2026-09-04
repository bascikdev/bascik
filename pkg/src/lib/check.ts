/**
 * @module check
 *
 * Static analysis for Bascik projects (`bascik --check`).
 *
 * Scans all pages, component files, and API route files for:
 *  - Hyphenated tags that have no matching component file (warnings)
 *  - Component files that are never referenced anywhere (warnings)
 *  - API route method handler and collision issues (errors / warnings)
 *
 * Returns a structured data model of findings. Output formatting is separated
 * into human and JSON formatters.
 */

import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import { listPages, getRelativePath, deepReadDirFlat } from "./file-system.ts";
import { findComponentRoot } from "./component-roots.ts";
import { listComponents } from "./components.ts";
import { BascikConfig } from "./config.ts";
import { maskElementContents } from "./shielding.ts";
import { scanApiRouteFiles, fileToApiRoutePath } from "./api-routes.ts";
import { getHttpPath } from "./paths.ts";
import { buildMissingSiteUrlError } from "./sitemap.ts";
import { getSiteUrl, SITE_URL_ENV_VAR } from "./environment.ts";
import { config as userConfig, modeOverrides } from "./userConfig.ts";
import { validateUserConfig, type ConfigValidationError } from "./config-validation.ts";
import { BUILD_ATTR_NAME, ROUTES_ATTR_NAME, SERVER_ATTR_NAME, STREAM_ATTR_NAME } from "./html-patterns.ts";
import type { ComponentList } from "./types.ts";

export type FindingSeverity = "error" | "warning";

export interface FindingLocation {
  filePath: string;
  line?: number;
}

export interface CheckFinding {
  category: string;
  severity: FindingSeverity;
  message: string;
  locations: FindingLocation[];
  suggestion?: string;
}

export interface CheckFindings {
  errors: number;
  warnings: number;
  pagesChecked: number;
  componentsChecked: number;
  items: CheckFinding[];
}

const VALID_API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const API_METHOD_LIKE_REGEX = /\bexport\s+(?:async\s+)?(?:const|function|let|var)\s+([a-zA-Z0-9_$]+)\b/g;
const KNOWN_BASCIK_DATA_EXACT = new Set([
  "data-bascik-slot",
  "data-bascik-build",
  "data-bascik-server",
  "data-bascik-routes",
  "data-bascik-stream",
  "data-bascik-preserve",
  "data-bascik-server-id",
]);
const KNOWN_BASCIK_DATA_PREFIX = ["data-bascik-prop-", "data-bascik-attr-"];

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
export const suggestComponentName = (tag: string, knownComponents: Iterable<string>): string | undefined => {
  const normTag = tag.toLowerCase();
  let bestMatch: { candidate: string; distance: number } | undefined;
  for (const candidate of knownComponents) {
    const normCandidate = candidate.toLowerCase();
    const distance = editDistance(normTag, normCandidate);
    if (distance <= 2 && (bestMatch === undefined || distance < bestMatch.distance)) {
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
  const extra = (BascikConfig.scoping?.preserve ?? [])
    .map((t) => String(t).replace(/[^a-zA-Z0-9-]/g, ""))
    .filter(Boolean);
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
    if (normalized.includes(BascikConfig.directory?.pages?.replace(/\\/g, "/") ?? "src/pages")) {
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
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
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

const stripComments = (source: string): string => {
  return source.replace(/<!--[\s\S]*?-->/g, (match) => {
    const newlines = match.match(/\n/g);
    return newlines ? newlines.join("") : " ";
  });
};

const getLineAt = (source: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
};

interface OpenTagData {
  attrs: string;
  line: number;
}

const extractOpenTagData = (html: string): OpenTagData[] => {
  const out: OpenTagData[] = [];
  const noComments = stripComments(html);
  const stripped = stripElementContents(noComments);
  const regex = /<[a-z][a-z0-9:-]*\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stripped)) !== null) {
    out.push({
      attrs: match[1] ?? "",
      line: getLineAt(stripped, match.index),
    });
  }
  return out;
};

const extractAttributeNames = (attrs: string): string[] => {
  const names: string[] = [];
  const attrRegex = /(?:^|\s)([^\s"'<>\/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRegex.exec(attrs)) !== null) {
    names.push((attrMatch[1] ?? "").toLowerCase());
  }
  return names;
};

const extractUnknownBascikAttributes = (
  html: string,
): Array<{ attr: string; line: number }> => {
  const out: Array<{ attr: string; line: number }> = [];
  for (const tag of extractOpenTagData(html)) {
    for (const name of extractAttributeNames(tag.attrs)) {
      if (!name.startsWith("data-bascik-")) continue;
      const isKnownPrefix = KNOWN_BASCIK_DATA_PREFIX.some((prefix) => name.startsWith(prefix));
      if (KNOWN_BASCIK_DATA_EXACT.has(name) || isKnownPrefix) continue;
      out.push({ attr: name, line: tag.line });
    }
  }
  return out;
};

// Whole-attribute-name directive tests (prompt 65 step 0).
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const BUILD_DIRECTIVE_RE = new RegExp(String.raw`(?:^|\s)${BUILD_ATTR_NAME}`, "i");
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const SERVER_DIRECTIVE_RE = new RegExp(String.raw`(?:^|\s)${SERVER_ATTR_NAME}`, "i");
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const ROUTES_DIRECTIVE_RE = new RegExp(String.raw`(?:^|\s)${ROUTES_ATTR_NAME}`, "i");
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const STREAM_DIRECTIVE_RE = new RegExp(String.raw`(?:^|\s)${STREAM_ATTR_NAME}`, "i");

/**
 * The four script directives are mutually exclusive. Returns the pair of
 * directive names present when two or more are, otherwise undefined.
 */
export const findDirectiveConflict = (attrs: string): [string, string] | undefined => {
  const present: string[] = [];
  if (BUILD_DIRECTIVE_RE.test(attrs)) present.push("data-bascik-build");
  if (SERVER_DIRECTIVE_RE.test(attrs)) present.push("data-bascik-server");
  if (ROUTES_DIRECTIVE_RE.test(attrs)) present.push("data-bascik-routes");
  if (STREAM_DIRECTIVE_RE.test(attrs)) present.push("data-bascik-stream");
  return present.length >= 2 ? [present[0], present[1]] : undefined;
};

const hasBuildServerConflict = (attrs: string): boolean => findDirectiveConflict(attrs) !== undefined;

const mapConfigErrorSeverity = (error: ConfigValidationError): FindingSeverity => {
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
    configFlagIndex !== -1 && argv[configFlagIndex + 1] && !argv[configFlagIndex + 1].startsWith("-")
      ? argv[configFlagIndex + 1]
      : undefined;
  const explicitPath = inlinePath || flaggedPath;
  if (explicitPath) {
    return relative(process.cwd(), resolve(process.cwd(), explicitPath)).replace(/\\/g, "/");
  }

  const jsPath = resolve(process.cwd(), "bascik.config.js");
  if (existsSync(jsPath)) return "bascik.config.js";
  const tsPath = resolve(process.cwd(), "bascik.config.ts");
  if (existsSync(tsPath)) return "bascik.config.ts";
  return "bascik.config.js";
};

const canonicalPath = (filePath: string): string => resolve(process.cwd(), filePath).replace(/\\/g, "/");

const maskPreservedSubtrees = (html: string): string => {
  let result = html;
  const re = /(<([a-z][a-z0-9:-]*)\b[^>]*\bdata-bascik-preserve\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi;
  let previous = "";
  while (previous !== result) {
    previous = result;
    result = result.replace(re, (_m, open: string, _tag: string, inner: string, close: string) => {
      return `${open}${" ".repeat(inner.length)}${close}`;
    });
  }
  return result;
};

const findComponentCycles = (
  graph: Map<string, Set<string>>,
): string[][] => {
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
export const checkProject = async (): Promise<CheckFindings> => {
  const items: CheckFinding[] = [];
  const configSource = resolveConfigSourcePath();

  const formatConfigValue = (value: unknown): string => {
    if (typeof value === "string") return `\"${value}\"`;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const configErrors = validateUserConfig(userConfig, modeOverrides, { env: process.env, cwd: process.cwd() });
  for (const error of configErrors) {
    const valueSuffix = error.value === undefined ? "" : ` (received ${formatConfigValue(error.value)})`;
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
      if (BascikConfig.generate?.sitemap ?? true) features.push("generate.sitemap");
      if (BascikConfig.generate?.robots ?? true) features.push("generate.robots");
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

  const pagesDir = resolve(process.cwd(), BascikConfig.directory?.pages ?? "src/pages");
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
    const duplicateBlockRegex = /error:\s*two component files both define the tag <([^>]+)>\s*\n([\s\S]*?)(?:\n\n|$)/gi;
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
    const componentRoots = (BascikConfig.directory?.components ?? ["src/components"])
      .map((root) => resolve(process.cwd(), root))
      .filter((root) => existsSync(root));
    if (componentRoots.length > 0) {
      const htmlFiles = (
        await Promise.all(componentRoots.map((root) => deepReadDirFlat(root, /\.html$/i)))
      ).flat();
      const nameToPaths = new Map<string, string[]>();
      for (const filePath of htmlFiles) {
        const componentName = filePath.replace(/^.*[\\/]/, "").split(".")[0].toLowerCase();
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

  const usedComponents = new Set<string>();
  const unmatchedTagLocations = new Map<string, FindingLocation[]>();
  const unknownBascikAttrs = new Map<string, FindingLocation[]>();
  const componentGraph = new Map<string, Set<string>>();
  const scriptBuildServerConflicts: FindingLocation[] = [];
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

    for (const unknown of extractUnknownBascikAttributes(html)) {
      const list = unknownBascikAttrs.get(unknown.attr) ?? [];
      list.push({ filePath: displayPath, line: unknown.line });
      unknownBascikAttrs.set(unknown.attr, list);
    }

    const scriptTagRegex = /<script\b([^>]*)>/gi;
    let scriptMatch: RegExpExecArray | null;
    while ((scriptMatch = scriptTagRegex.exec(html)) !== null) {
      if (hasBuildServerConflict(scriptMatch[1] ?? "")) {
        scriptBuildServerConflicts.push({ filePath: displayPath, line: getLineAt(html, scriptMatch.index) });
      }
    }

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
      } else {
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

  for (const [attr, locations] of unknownBascikAttrs.entries()) {
    const known = [...KNOWN_BASCIK_DATA_EXACT, ...KNOWN_BASCIK_DATA_PREFIX.map((p) => `${p}...`)]
      .sort()
      .join(", ");
    items.push({
      category: "unknown-bascik-attribute",
      severity: "warning",
      message: `unknown attribute "${attr}". Known attributes: ${known}`,
      locations,
    });
  }

  if (scriptBuildServerConflicts.length > 0) {
    items.push({
      category: "script-mode-conflict",
      severity: "error",
      message: "<script> tag combines two script directives (data-bascik-build, data-bascik-server, data-bascik-routes, data-bascik-stream are mutually exclusive). Remove one attribute.",
      locations: scriptBuildServerConflicts,
    });
  }

  const cycles = findComponentCycles(componentGraph);
  for (const cycle of cycles) {
    const start = cycle[0];
    const sourceName = componentNameByPath.get(start);
    const sourcePath = sourceName ? componentList[sourceName]?.fileName : undefined;
    items.push({
      category: "circular-component-reference",
      severity: "error",
      message: `component cycle detected: ${cycle.map((path) => `<${componentNameByPath.get(path) ?? path}>`).join(" -> ")}`,
      locations: sourcePath ? [{ filePath: toDisplay(sourcePath) }] : [],
    });
  }

  // Route output collisions from page path resolution.
  const pagesByRouteExact = new Map<string, string[]>();
  const firstRouteByLower = new Map<string, { route: string; filePath: string }>();
  for (const pagePath of pageList) {
    const rel = getRelativePath(pagePath, "pages");
    const route = getHttpPath(rel, BascikConfig.directory?.pages ?? "src/pages");

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
        locations: [{ filePath: toDisplay(firstSeen.filePath) }, { filePath: toDisplay(pagePath) }],
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

  // Component template convention: styles first, scripts last.
  for (const filePath of componentFilePaths) {
    try {
      const html = await readFile(filePath, "utf8");
      const noComments = stripComments(html);
      const firstHtmlTag = noComments.search(/<(?!\/?(?:style|script)\b)[a-z]/i);
      const firstScript = noComments.search(/<script\b/i);
      const firstStyle = noComments.search(/<style\b/i);

      if (firstScript >= 0 && (firstHtmlTag < 0 || firstScript < firstHtmlTag)) {
        items.push({
          category: "component-structure-order",
          severity: "warning",
          message: "component template convention: place <script> blocks after HTML markup.",
          // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
          locations: [{ filePath: toDisplay(filePath), line: getLineAt(noComments, firstScript) }],
        });
      }

      if (firstStyle >= 0 && firstHtmlTag >= 0 && firstStyle > firstHtmlTag) {
        items.push({
          category: "component-structure-order",
          severity: "warning",
          message: "component template convention: place <style> blocks above HTML markup.",
          // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
          locations: [{ filePath: toDisplay(filePath), line: getLineAt(noComments, firstStyle) }],
        });
      }
    } catch {
      // Ignore unreadable component files here.
    }
  }

  // ── API route static analysis (Prompt 49) ───────────────────────────
  const apiDir = resolve(process.cwd(), BascikConfig.directory?.api ?? "src/api");
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

      try {
        const content = await readFile(filePath, "utf8");
        API_METHOD_LIKE_REGEX.lastIndex = 0;
        const exportedNames: string[] = [];
        let match: RegExpExecArray | null;

        while ((match = API_METHOD_LIKE_REGEX.exec(content)) !== null) {
          const name = match[1];
          exportedNames.push(name);

          const upper = name.toUpperCase();
          if (VALID_API_METHODS.has(upper) && name !== upper) {
            items.push({
              category: "invalid-method-case",
              severity: "warning",
              message: `method export "${name}" must be uppercase ("${upper}"). Lowercase or mixed-case HTTP methods are not recognized by the dispatcher.`,
              locations: [{ filePath: toDisplay(filePath) }],
            });
          }
        }

        const hasRecognized = exportedNames.some((n) => VALID_API_METHODS.has(n));
        if (!hasRecognized) {
          items.push({
            category: "missing-method-handler",
            severity: "error",
            message: `file exports no recognized HTTP method handler (GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD).`,
            locations: [{ filePath: toDisplay(filePath) }],
          });
        }
      } catch {
        // Skip unreadable files
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

  const errors = items.filter((i) => i.severity === "error").length;
  const warnings = items.filter((i) => i.severity === "warning").length;

  return {
    errors,
    warnings,
    pagesChecked: pageList.length,
    componentsChecked: knownComponents.size,
    items,
  };
};

/** Category descriptive headers and explanations. */
const CATEGORY_META: Record<string, { title: string; description: string }> = {
  "unmatched-tag": {
    title: "Components with no matching file",
    description:
      "These are either typos, or third-party web components. Bascik does not\ntranspile them; they are passed through to the browser unchanged.",
  },
  "unused-component": {
    title: "Unused components",
    description:
      "Defined but never referenced. Safe to delete, or referenced only from a\nbuild script, which this check cannot always see.",
  },
  "missing-method-handler": {
    title: "API routes missing method handler",
    description: "API route files must export at least one standard HTTP method handler.",
  },
  "invalid-method-case": {
    title: "API route method exports with invalid casing",
    description: "HTTP method handlers must be uppercase (e.g. GET, POST).",
  },
  "route-collision": {
    title: "API route collisions",
    description: "Multiple API route files resolve to the same URL path.",
  },
  "config-validation": {
    title: "Configuration validation",
    description: "Configuration keys, values, and path references that need correction.",
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
    description: "Component templates reference each other in a cycle, which causes runaway expansion.",
  },
  "unknown-bascik-attribute": {
    title: "Unknown data-bascik attributes",
    description: "Likely typos in special Bascik attributes that are ignored at build time.",
  },
  "script-mode-conflict": {
    title: "Conflicting script modes",
    description: "A single script tag cannot be both build-time and server-time.",
  },
  "pages-directory": {
    title: "Pages directory issues",
    description: "The configured pages directory must exist, be readable, and contain at least one HTML page.",
  },
  "duplicate-route-resolution": {
    title: "Duplicate route resolution",
    description: "Multiple pages resolve to the same route path.",
  },
  "component-structure-order": {
    title: "Component style and script order",
    description: "Component templates should place styles above markup and scripts below markup.",
  },
  "component-list": {
    title: "Component scan failures",
    description: "Component discovery failed and needs correction before a reliable check run.",
  },
};

/**
 * Format check findings into human-readable console output.
 */
export const formatFindingsHuman = (findings: CheckFindings): string => {
  const sections: string[] = ["bascik --check\n"];

  // Group items by category
  const grouped = new Map<string, CheckFinding[]>();
  for (const item of findings.items) {
    const list = grouped.get(item.category) ?? [];
    list.push(item);
    grouped.set(item.category, list);
  }

  if (findings.items.length === 0) {
    const warnNote = findings.warnings > 0 ? ` (${findings.warnings} warnings)` : "";
    return `bascik --check\n\n✓ ${findings.pagesChecked} page${findings.pagesChecked !== 1 ? "s" : ""} and ${findings.componentsChecked} component${findings.componentsChecked !== 1 ? "s" : ""} checked — no errors${warnNote}`;
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
          .map((loc) => (loc.line !== undefined ? `${loc.filePath}:${loc.line}` : loc.filePath))
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
          .map((loc) => (loc.line !== undefined ? `${loc.filePath}:${loc.line}` : loc.filePath))
          .join(", ");
        section += `  ${item.message} (${locStr})\n`;
      }
    }
    sections.push(section);
  }

  const symbol = findings.errors > 0 ? "✗" : "✓";
  const summary = `${symbol} ${findings.errors} error${findings.errors !== 1 ? "s" : ""}, ${findings.warnings} warning${findings.warnings !== 1 ? "s" : ""}`;
  sections.push(summary);

  return sections.join("\n");
};

export interface CheckJsonOutput {
  errors: number;
  warnings: number;
  pagesChecked: number;
  componentsChecked: number;
  findings: Array<{
    category: string;
    severity: FindingSeverity;
    message: string;
    locations: FindingLocation[];
    suggestion?: string;
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
    findings: findings.items.map((item) => ({
      category: item.category,
      severity: item.severity,
      message: item.message,
      locations: item.locations,
      ...(item.suggestion ? { suggestion: item.suggestion } : {}),
    })),
  };
  return JSON.stringify(output, null, 2);
};
