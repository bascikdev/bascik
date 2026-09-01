/**
 * @module processing
 *
 * Bascik Transpilation Pipeline
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Bascik transforms source HTML into deployable HTML by replacing every custom
 * component tag with its resolved, scoped content.  The pipeline runs in two
 * nested phases:
 *
 * ┌─ PAGE PHASE  (pageProcessing) ─────────────────────────────────────────┐
 * │  1. Read source page HTML file.                                        │
 * │  2. Strip comments, collapse whitespace (minifyHtml).                  │
 * │  3. Extract <body> and <head> inner content separately.                │
 * │  4. Run COMPONENT PHASE on each (recursivelyTranspile).                │
 * │  5. Collect all CSS from used components, deduplicate, inject <style>. │
 * │  6. Optionally inject live-reload SSE script (dev mode only).          │
 * │  7. Reassemble full HTML document.                                     │
 * │  8. Filter build-only / dev-only <script> tags.                        │
 * │  9. Store in memory (dev) and write to dist/ (both modes).             │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ COMPONENT PHASE  (recursivelyTranspile) ──────────────────────────────┐
 * │  Recurses until no custom component tags remain in the HTML string.    │
 * │                                                                        │
 * │  For each component tag found:                                         │
 * │                                                                        │
 * │  1. SCOPING PIPELINE  (buildScopingPipeline → applyTransforms)        │
 * │     Each step is BascikComponent → BascikComponent:                   │
 * │     a. prefixElementAttribute('id')    — scope id attrs + JS refs     │
 * │     b. prefixElementAttribute('name')  — scope name attrs + JS refs   │
 * │     c. prefixElementAttribute('class') — scope class attrs, CSS       │
 * │        classes, element selectors, @keyframes, custom properties      │
 * │     d. namespaceScriptTags             — wrap scripts in IIFEs         │
 * │     (Each step is skipped if disabled in bascik.config.ts.)           │
 * │                                                                        │
 * │  2. TEMPLATE RESOLUTION                                                │
 * │     a. injectProps          — replace data-bascik-prop-* markers      │
 * │     b. replaceNamedSlots    — fill data-bascik-slot="name" zones      │
 * │     c. default slot         — fill data-bascik-slot element              │
 * │        with inner content or template fallback                         │
 * │     d. mergeAttributesOntoRoot — pass-through attrs (aria-*, data-*)  │
 * │                                                                        │
 * │  3. SUBSTITUTION                                                       │
 * │     Replace the original usage tag with the resolved template HTML.   │
 * │     Recurse until no custom tags remain.                               │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * All scoped names follow the pattern:
 *   bascik__<componentName>__<instanceId>__<originalName>
 *
 * When `minify.identifiers` is enabled (default in builds), names are
 * hashed to short hex strings (e.g. `bab12cd3`) for smaller output.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listPages,
  getDirectoryPath,
  getDistPagePath,
  deleteDistFile,
  getRelativePath,
  deepReadDirFlat,
} from "./file-system.ts";
import { getHttpPath } from "./paths.ts";
import { getLiveReloadScript } from "./live-reload.ts";
import {
  listComponents,
  invalidateComponentListCache,
  replaceTag,
  getFirstComponent,
  getTag,
  extractProps,
  injectPropAttributes,
  injectProps,
  extractNamedSlotContent,
  extractDefaultSlotContent,
  replaceNamedSlots,
  replaceDefaultSlots,
  extractInheritableAttributes,
  mergeAttributesOntoRoot,
  maskRawTextContent,
} from "./components.ts";
import { stripPreserveDirectives } from "./shielding.ts";
import { minifyHtml } from "./html-minifier.ts";
import { namespaceScriptTags, prefixElementAttribute } from "./javascript.ts";
import { isJavaScriptScript } from "./script-types.ts";
import { minifyJs } from "./js-minifier.ts";
import { deduplicateCss } from "./styles.ts";
import { minifyCss } from "./css-minifier.ts";
import { executeBuildScripts, collectAllScriptDeps } from "./build-scripts.ts";
import { getUniqueId } from "./names.ts";
import { BascikConfig, shouldLog } from "./config.ts";
import { mem } from "./mem.ts";
import { eventEmitter } from "./events.ts";
import { generateSitemapFiles } from "./sitemap.ts";
import { WorkerPool } from "./worker-pool.ts";
import { isDynamicRoute, resolveRoutePath, executeRoutesScript } from "./routes.ts";
import { formatDuration } from "./format.ts";
import { rewriteCssBasePaths, rewriteHtmlBasePaths, withBasePath } from "./base-path.ts";
import type {
  BascikComponent,
  ComponentList,
  TranspileResult,
  TranspilePageResult,
  RouteEntry,
} from "./types.ts";

export const getFilePosition = (
  filePath: string,
  searchString: string,
  tagName?: string,
): { line: number; character: number } | null => {
  try {
    const content = readFileSync(filePath, "utf8");
    let index = content.indexOf(searchString);
    if (index === -1 && tagName) {
      const regex = new RegExp(`<${tagName}\\b`, "i");
      const match = content.match(regex);
      if (match && match.index !== undefined) {
        index = match.index;
      }
    }
    if (index === -1 && searchString.length > 30) {
      index = content.indexOf(searchString.slice(0, 30));
    }
    if (index !== -1) {
      const prefix = content.slice(0, index);
      const lines = prefix.split(/\r?\n/);
      return {
        line: lines.length,
        character: lines[lines.length - 1].length + 1,
      };
    }
  } catch {
    // Ignore read errors
  }
  return null;
};

const resolveInlineStyles = async (): Promise<string[]> => {
  const inlineStyles = BascikConfig.assets?.inlineStyles;
  if (inlineStyles === true) {
    return (await deepReadDirFlat(BascikConfig.directory.pages, /\.css$/i)).sort();
  }
  if (Array.isArray(inlineStyles)) {
    return inlineStyles;
  }
  return [];
};

/**
 * Resolve the `minify.css` config value to a concrete async minifier
 * function, or `null` when minification is disabled.
 */
const resolveCssMinifier = (): ((code: string) => Promise<string>) | null => {
  const cfg = BascikConfig.minify?.css ?? false;
  if (!cfg) return null;
  const fn = cfg === true ? minifyCss : cfg;
  return async (code: string) => {
    try {
      return await fn(code);
    } catch (err) {
      const behavior = BascikConfig.onMinifyError ?? "error";
      if (behavior === "error") {
        console.error("[bascik] CSS minification failed:", err);
        throw err;
      }
      console.warn("[bascik] CSS minification failed, falling back to unminified CSS:", err);
      return code;
    }
  };
};

export const resolveInlineStylesHtml = async (): Promise<string> => {
  const inlineStyles = await resolveInlineStyles();
  if (!inlineStyles.length) return "";
  const cssMinifier = resolveCssMinifier();
  const sheets = await Promise.all(
    inlineStyles.map(async (filePath) => {
      let css: string;
      try {
        css = (await readFile(filePath)).toString();
      } catch (error) {
        console.warn("[bascik] inlineStyles: could not read %s:", filePath, (error as Error).message);
        return "";
      }
      return cssMinifier ? await cssMinifier(css) : css;
    }),
  );
  const combined = sheets.filter(Boolean).join(" ");
  return combined ? `<style>${combined}</style>` : "";
};

// ─────────────────────────────────────────────────────────────────────────────
// Script minification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the `minify.js` config value to a concrete async minifier
 * function, or `null` when minification is disabled.
 */
const resolveScriptMinifier = (): ((code: string) => Promise<string>) | null => {
  const cfg = BascikConfig.minify?.js ?? false;
  if (!cfg) return null;
  const fn = cfg === true ? minifyJs : cfg;
  return async (code: string) => {
    try {
      return await fn(code);
    } catch (err) {
      const behavior = BascikConfig.onMinifyError ?? "error";
      if (behavior === "error") {
        console.error("[bascik] JS minification failed:", err);
        throw err;
      }
      console.warn("[bascik] JS minification failed, falling back to unminified JS:", err);
      return code;
    }
  };
};

/**
 * Minify the content of every inline `<script>` tag in `html` (excluding
 * external scripts and non-JS types such as application/ld+json).
 */
const minifyScriptTagsInHtml = async (
  html: string,
  minifyFn: (code: string) => string | Promise<string>,
): Promise<string> => {
  const regex = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi;
  const ops: Array<{ index: number; len: number; open: string; code: string; close: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    const [full, open, code, close] = m as unknown as [string, string, string, string];
    // Skip non-JS types (e.g. application/ld+json, text/template)
    if (!isJavaScriptScript(open)) continue;
    // Server scripts run at request time in Node.js — skip them here
    if (/\bdata-bascik-server\b/i.test(open)) continue;
    // Skip external scripts — no inline content to minify
    if (/\bsrc\s*=/i.test(open)) continue;
    ops.push({ index: m.index, len: full.length, open, code, close });
  }
  if (!ops.length) return html;
  const minified = await Promise.all(ops.map(({ code }) => minifyFn(code)));
  let result = html;
  for (let i = ops.length - 1; i >= 0; i--) {
    const { index, len, open, close } = ops[i];
    result = result.slice(0, index) + `${open}${minified[i]}${close}` + result.slice(index + len);
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline utilities
// ─────────────────────────────────────────────────────────────────────────────

/** A function that transforms a component in place and returns it. */
type ComponentTransform = (component: BascikComponent) => BascikComponent;

/**
 * Apply an ordered list of transforms to a component, threading the output of
 * each step as the input to the next — the pipeline pattern.
 */
const applyTransforms = (
  component: BascikComponent,
  transforms: ComponentTransform[],
): BascikComponent => transforms.reduce((c, fn) => fn(c), component);

/**
 * Build the ordered list of attribute/script scoping transforms for this
 * component instance, filtered by the current BascikConfig flags.
 */
const buildScopingPipeline = (instanceId: string): ComponentTransform[] => {
  const skip = BascikConfig.scoping?.preserve ?? ["code"];
  return (
    [
      BascikConfig.scoping?.attributes?.id &&
      ((c: BascikComponent) => prefixElementAttribute(c, "id", instanceId, true, skip)),
      BascikConfig.scoping?.attributes?.name &&
      ((c: BascikComponent) => prefixElementAttribute(c, "name", instanceId, true, skip)),
      BascikConfig.scoping?.attributes?.class &&
      ((c: BascikComponent) =>
        prefixElementAttribute(c, "class", instanceId, BascikConfig.scoping?.deduplicateCss ?? true, skip)),
      BascikConfig.scoping?.scriptBlocks && namespaceScriptTags,
    ] as (ComponentTransform | false)[]
  ).filter((t): t is ComponentTransform => Boolean(t));
};

// ─────────────────────────────────────────────────────────────────────────────
// Core transpile pipeline
// ─────────────────────────────────────────────────────────────────────────────

export const getDisplayPath = (path: string): string => {
  if (BascikConfig.directory?.components && path.includes(BascikConfig.directory.components)) {
    return getRelativePath(path, "components");
  }
  if (BascikConfig.directory?.pages && path.includes(BascikConfig.directory.pages)) {
    return getRelativePath(path, "pages");
  }
  return path;
};

export const findActiveSourceFile = (
  html: string,
  index: number,
  fallback: string,
): string => {
  const substring = html.slice(0, index);
  const regex = /<!--bascik-source-file:(.*?)-->|<!--bascik-source-file-end:(.*?)-->/g;
  const stack: string[] = [];
  let match;
  while ((match = regex.exec(substring)) !== null) {
    if (match[1] !== undefined) {
      stack.push(match[1]);
    } else if (match[2] !== undefined) {
      const idx = stack.lastIndexOf(match[2]);
      if (idx !== -1) {
        stack.splice(idx, 1);
      } else {
        stack.pop();
      }
    }
  }
  return stack[stack.length - 1] || fallback;
};

// Guards against infinite expansion: a component that (transitively) contains
// itself would otherwise loop forever, doubling the HTML string each pass until
// the process runs out of memory.  Two independent tripwires:
//   1. MAX_SUBSTITUTIONS — hard cap on total component substitutions per call.
//   2. MAX_OUTPUT_BYTES  — hard cap on the growing HTML string.
// Both are far beyond any legitimate page (a page with 10 000 component
// instances or 50 MB of markup), so they only fire on runaway recursion.
const MAX_SUBSTITUTIONS = 10_000;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

export class PageProcessingError extends Error {
  readonly pagePath: string;
  readonly stage: string;

  constructor(
    pagePath: string,
    stage: string,
    cause: unknown,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`${stage}: ${causeMessage}`, { cause });
    this.name = "PageProcessingError";
    this.pagePath = pagePath;
    this.stage = stage;
  }
}

export class PageProcessingAggregateError extends AggregateError {
  readonly pageErrors: PageProcessingError[];

  constructor(pageErrors: PageProcessingError[]) {
    const details = pageErrors
      .map(({ pagePath, stage, message }) =>
        `  ${pagePath}\n    ${stage}: ${message.replace(`${stage}: `, "")}`)
      .join("\n");
    super(pageErrors, `Build failed with ${pageErrors.length} page errors:\n${details}`);
    this.name = "PageProcessingAggregateError";
    this.pageErrors = pageErrors;
  }
}

const normalizePageError = (
  pagePath: string,
  error: unknown,
  stage = "transpile page",
): PageProcessingError => error instanceof PageProcessingError
    ? error
    : new PageProcessingError(pagePath, stage, error);

const reportPageErrors = (pageErrors: PageProcessingError[]): void => {
  if (pageErrors.length === 0) return;
  const aggregateError = new PageProcessingAggregateError(pageErrors);
  if (BascikConfig.isBuild) throw aggregateError;
  console.error(aggregateError.message);
};

export const recursivelyTranspile = (
  transpiledHtmlBody: string,
  componentList: ComponentList,
  usedComponents: BascikComponent[] = [],
  filePath?: string,
): TranspileResult => {
  if (filePath && !transpiledHtmlBody.includes("<!--bascik-source-file:")) {
    transpiledHtmlBody = `<!--bascik-source-file:${filePath}-->${transpiledHtmlBody}<!--bascik-source-file-end:${filePath}-->`;
  }

  // Iterative implementation — avoids keeping O(N) copies of the growing HTML
  // string simultaneously on the call stack (each recursive frame held its own
  // copy, leading to multi-GB heap usage on pages with many component instances).
  let substitutions = 0;
  while (true) {
    const masked = maskRawTextContent(transpiledHtmlBody);

    if (
      substitutions >= MAX_SUBSTITUTIONS ||
      transpiledHtmlBody.length > MAX_OUTPUT_BYTES
    ) {
      const partial = getFirstComponent(transpiledHtmlBody, componentList, masked);
      const tag = partial.name ? `<${partial.name}>` : "(unknown)";
      throw new PageProcessingError(
        filePath ?? "unknown file",
        "component expansion",
        new Error(
          `component expansion exceeded safety limits (${substitutions} substitutions). ` +
          `This usually means a component recursively includes itself (e.g. ${tag} ` +
          `contains its own tag, directly or through another component). ` +
          "Recursive components are not supported; restructure to terminate the recursion.",
        ),
      );
    }
    const partial = getFirstComponent(transpiledHtmlBody, componentList, masked);
    if (!partial.name) {
      const cleanedHtml = transpiledHtmlBody
        .replace(/<!--bascik-source-file:[\s\S]*?-->/g, "")
        .replace(/<!--bascik-source-file-end:[\s\S]*?-->/g, "");
      return { transpiledHtmlBody: cleanedHtml, usedComponents };
    }
    // Cast: getFirstComponent merges component list data so all required fields are present
    let component = partial as BascikComponent;

    if (!component.fileContent) {
      const cleanedHtml = transpiledHtmlBody
        .replace(component.content || "", "")
        .replace(/<!--bascik-source-file:[\s\S]*?-->/g, "")
        .replace(/<!--bascik-source-file-end:[\s\S]*?-->/g, "");
      return {
        transpiledHtmlBody: cleanedHtml,
        usedComponents
      };
    }

    let currentStage = "";
    try {
      // One stable ID shared across all attribute-scoping passes for this instance.
      const props = extractProps(component.content);
      component.fileContent = injectPropAttributes(component.fileContent, props);

      // Run the scoping pipeline — each step is `BascikComponent → BascikComponent`.
      const instanceId = getUniqueId(8);
      currentStage = "attribute scoping";
      component = applyTransforms(component, buildScopingPipeline(instanceId));
      component.fileContent = stripPreserveDirectives(component.fileContent);

      currentStage = "prop injection";
      // Inject props — always call so unused data-bascik-prop-* markers are stripped.
      component.fileContent = injectProps(component.fileContent, props);

      currentStage = "slot resolution";
      // Resolve named slots from the usage inner HTML.
      const namedSlots = extractNamedSlotContent(component.innerContent);
      component.fileContent = replaceNamedSlots(component.fileContent, namedSlots);

      // Resolve the default slot: innerContent with named-slot wrappers stripped.
      const defaultSlotContent = extractDefaultSlotContent(component.innerContent);

      // Replace <element data-bascik-slot> default slot markers.
      // Named slots were already handled above by replaceNamedSlots.
      let transpiledTag = replaceDefaultSlots(
        component.fileContent,
        defaultSlotContent,
      );

      currentStage = "attribute inheritance";
      // Merge non-bascik attributes from the usage tag onto the component root element.
      if (BascikConfig.scoping?.inheritAttributes) {
        const inheritableAttrs = extractInheritableAttributes(component.content);
        transpiledTag = mergeAttributesOntoRoot(transpiledTag, inheritableAttrs);
      }

      currentStage = "substitution";
      if (component.fileName) {
        transpiledTag = `<!--bascik-source-file:${component.fileName}-->${transpiledTag}<!--bascik-source-file-end:${component.fileName}-->`;
      }
      transpiledHtmlBody = replaceTag(
        transpiledHtmlBody,
        component.name,
        transpiledTag,
        masked,
      );
      usedComponents.push(component);
      substitutions++;
    } catch (error) {
      const activeSourceFile = findActiveSourceFile(
        transpiledHtmlBody,
        component.index || 0,
        filePath || "",
      );
      let errorMsg = `[bascik] Transpilation failed for component <${component.name}> during ${currentStage}`;
      if (activeSourceFile) {
        const pos = getFilePosition(activeSourceFile, component.content || "", component.name);
        if (pos) {
          errorMsg += ` in "${getDisplayPath(activeSourceFile)}" at (line ${pos.line}, column ${pos.character})`;
        } else {
          errorMsg += ` in "${getDisplayPath(activeSourceFile)}"`;
        }
      }
      if (component.fileName) {
        errorMsg += `\n  Defined in component template: "${getDisplayPath(component.fileName)}"`;
      }
      console.error(`${errorMsg}\n  Error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      if (component.content) {
        transpiledHtmlBody = replaceTag(transpiledHtmlBody, component.name, "", masked);
        substitutions++;
      } else {
        // No content to strip — replacing would be a no-op and the while(true)
        // loop would spin on the same tag forever.  Bail out instead.
        const cleanedHtml = transpiledHtmlBody
          .replace(/<!--bascik-source-file:[\s\S]*?-->/g, "")
          .replace(/<!--bascik-source-file-end:[\s\S]*?-->/g, "");
        return { transpiledHtmlBody: cleanedHtml, usedComponents };
      }
    }
  }
};


export interface PageJob {
  pagePath: string;
  route: RouteEntry | null;
  relativePagePath: string;
  preCleanedHtml?: string;
}

export const templateToGeneratedRelativePaths = new Map<string, Set<string>>();

export const clearTemplateRoutesCache = (): void => {
  templateToGeneratedRelativePaths.clear();
};

export const expandPageToJobs = async (pagePath: string): Promise<PageJob[]> => {
  if (!isDynamicRoute(pagePath)) {
    return [
      {
        pagePath,
        route: null,
        relativePagePath: getRelativePath(pagePath, "pages"),
      },
    ];
  }

  let rawHtml: string;
  try {
    rawHtml = (await readFile(pagePath)).toString();
  } catch (err) {
    console.warn(
      `[bascik] warning: Could not read page file "${pagePath}": ${(err as Error).message}`,
    );
    return [];
  }

  const result = await executeRoutesScript(rawHtml, pagePath);
  if (!result.routes || result.routes.length === 0) {
    const prevGenerated = templateToGeneratedRelativePaths.get(pagePath);
    if (prevGenerated) {
      for (const staleRel of prevGenerated) {
        if (!BascikConfig.isBuild) mem.removeByRelativePath(staleRel);
        await deleteDistFile(staleRel).catch(() => { });
      }
      templateToGeneratedRelativePaths.delete(pagePath);
    }
    return [];
  }

  const currentGenerated = new Set<string>();
  const jobs: PageJob[] = [];
  const baseRelativePath = getRelativePath(pagePath, "pages");

  for (const route of result.routes) {
    const relativePagePath = resolveRoutePath(baseRelativePath, route.params);
    currentGenerated.add(relativePagePath);
    jobs.push({
      pagePath,
      route,
      relativePagePath,
      preCleanedHtml: result.cleanedHtml,
    });
  }

  const prevGenerated = templateToGeneratedRelativePaths.get(pagePath);
  if (prevGenerated) {
    for (const oldRel of prevGenerated) {
      if (!currentGenerated.has(oldRel)) {
        if (!BascikConfig.isBuild) mem.removeByRelativePath(oldRel);
        await deleteDistFile(oldRel).catch(() => { });
      }
    }
  }
  templateToGeneratedRelativePaths.set(pagePath, currentGenerated);

  return jobs;
};

/** Partitions page paths or PageJobs into [openPages, otherPages] by active SSE connections. */
export const partitionByOpenPages = (pageList: (string | PageJob)[]): [(string | PageJob)[], (string | PageJob)[]] => {
  const openSet = new Set(mem.openPages);
  if (openSet.size === 0) return [[], pageList];
  const strip = (p: string) => p.replace(/\/$/, "") || "/";
  const openNormalizedSet = new Set([...openSet].map(strip));
  const open: (string | PageJob)[] = [];
  const rest: (string | PageJob)[] = [];
  for (const item of pageList) {
    const relPath = typeof item === "string" ? getRelativePath(item, "pages") : item.relativePagePath;
    const httpPath = getHttpPath(relPath);
    (openNormalizedSet.has(strip(httpPath)) ? open : rest).push(item);
  }
  return [open, rest];
};

const pageProcessingQueues = new Map<string, Promise<unknown>>();

const writeTranspiledPage = async (result: TranspilePageResult): Promise<void> => {
  const directoryPath = getDirectoryPath(result.relativePagePath);
  try {
    await mkdir(join(BascikConfig.directory.out, directoryPath), { recursive: true });
  } catch (error) {
    throw new PageProcessingError(result.absolutePagePath, "create output directory", error);
  }
  const distPagePath = getDistPagePath(result.relativePagePath);
  try {
    await writeFile(distPagePath, result.distHtml);
  } catch (error) {
    throw new PageProcessingError(result.absolutePagePath, "write output", error);
  }
};

const queueTranspiledPageWrite = (result: TranspilePageResult): Promise<void> => {
  const pagePath = result.absolutePagePath;
  const current = pageProcessingQueues.get(pagePath) ?? Promise.resolve();
  const queued = current
    .catch(() => { })
    .then(() => writeTranspiledPage(result))
    .catch((error) => {
      console.error(`[bascik] Failed to write dev page "${pagePath}":`, error);
    })
    .finally(() => {
      if (pageProcessingQueues.get(pagePath) === queued) {
        pageProcessingQueues.delete(pagePath);
      }
    });
  pageProcessingQueues.set(pagePath, queued);
  return queued;
};

export const processPageBatch = async (
  pageInputs: (string | PageJob)[],
  componentList?: ComponentList,
  globalStylesHtml?: string,
  initialPageErrors: PageProcessingError[] = [],
): Promise<string[]> => {
  const pageErrors = [...initialPageErrors];
  if (pageInputs.length === 0) {
    reportPageErrors(pageErrors);
    return [];
  }
  if (!componentList) componentList = await listComponents();
  if (globalStylesHtml === undefined) globalStylesHtml = await resolveInlineStylesHtml();

  const jobs: PageJob[] = [];
  for (const input of pageInputs) {
    if (typeof input === "string") {
      try {
        const expanded = await expandPageToJobs(input);
        jobs.push(...expanded);
      } catch (error) {
        pageErrors.push(normalizePageError(input, error, "expand routes"));
      }
    } else {
      jobs.push(input);
    }
  }
  if (jobs.length === 0) {
    reportPageErrors(pageErrors);
    return [];
  }

  const [openJobs, restJobs] = partitionByOpenPages(jobs) as [PageJob[], PageJob[]];

  const results: (TranspilePageResult | null)[] = [];

  const runJob = async (job: PageJob) => {
    const result = await transpilePage(
      job.pagePath,
      componentList,
      globalStylesHtml,
      job.route,
      job.preCleanedHtml,
    );
    if (result) {
      if (!BascikConfig.isBuild) {
        await mem.storePage({
          relativePagePath: result.relativePagePath,
          absolutePagePath: result.absolutePagePath,
          pageContent: result.distHtml,
          usedComponentsNames: result.usedComponentsNames,
          fileDependencies: result.fileDependencies,
        });
        void queueTranspiledPageWrite(result);
      }
      eventEmitter.emit("transpiled", { relativePagePath: result.relativePagePath });
    }
    return result;
  };

  const runJobs = async (batch: PageJob[]): Promise<void> => {
    const batchResults = await Promise.all(batch.map(async (job) => {
      try {
        return await runJob(job);
      } catch (error) {
        pageErrors.push(normalizePageError(job.pagePath, error));
        return null;
      }
    }));
    for (const result of batchResults) {
      if (result) results.push(result);
    }
  };

  // Transpile open pages first, store in memory, and emit transpiled reload event IMMEDIATELY.
  if (openJobs.length > 0) {
    await runJobs(openJobs);
  }

  // Transpile remaining (closed) pages afterwards
  if (restJobs.length > 0) {
    await runJobs(restJobs);
  }

  reportPageErrors(pageErrors);

  return results.map((r) => r?.relativePagePath ?? null).filter((p): p is string => p !== null);
};

export const selectivelyProcessPagesForWatchPath = async (changedPath?: string): Promise<void> => {
  invalidateComponentListCache();
  const [pages, componentList, globalStylesHtml] = await Promise.all([
    listPages(),
    listComponents(),
    resolveInlineStylesHtml(),
  ]);
  const pageList = pages ?? [];

  let pagesToProcess = pageList;
  if (changedPath) {
    const dependentPages = mem.pagesDependentOnFile(changedPath);
    if (dependentPages.length > 0) {
      pagesToProcess = dependentPages;
    }
  }

  await processPageBatch(pagesToProcess, componentList, globalStylesHtml);
};

export const selectivelyProcessPages = async (path: string): Promise<void> => {
  invalidateComponentListCache();
  const rawFileName = basename(path);
  if (!rawFileName || rawFileName.startsWith(".")) return;
  const componentName = rawFileName.split(".")[0].toLowerCase();
  if (!componentName) return;
  const pagesToTranspile = mem.pagesThisComponentIsUsedOn(componentName);
  const componentList = await listComponents();
  const globalStylesHtml = await resolveInlineStylesHtml();
  await processPageBatch(pagesToTranspile, componentList, globalStylesHtml);
};

export const processAllPages = async (options?: { useWorkers?: boolean }) => {
  console.log("Starting transpiling...");
  invalidateComponentListCache();
  const useWorkers = options?.useWorkers ?? BascikConfig.pipeline?.workers ?? false;
  const start = performance.now();
  // Parallel processing of pages
  const [pages, componentList, globalStylesHtml] = await Promise.all([
    listPages(),
    listComponents(),
    resolveInlineStylesHtml(),
  ]);
  const pageList = pages ?? [];

  let relativePaths: string[] = [];

  const expansionErrors: PageProcessingError[] = [];
  const jobBatches = await Promise.all(pageList.map(async (pagePath) => {
    try {
      return await expandPageToJobs(pagePath);
    } catch (error) {
      expansionErrors.push(normalizePageError(pagePath, error, "expand routes"));
      return [];
    }
  }));
  const allJobs = jobBatches.flat();

  if (useWorkers && allJobs.length > 0) {
    const workerExt = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const workerUrl = new URL(`./page-worker${workerExt}`, import.meta.url);
    const poolSize = Math.min(cpus().length, allJobs.length);
    const pool = new WorkerPool<PageJob, TranspilePageResult | null>(
      fileURLToPath(workerUrl),
      poolSize,
      { componentList, globalStylesHtml },
    );
    const [openJobs, restJobs] = partitionByOpenPages(allJobs) as [PageJob[], PageJob[]];
    const results: (TranspilePageResult | null)[] = [];
    const pageErrors: PageProcessingError[] = [...expansionErrors];
    try {
      if (openJobs.length > 0) {
        const openResults = await Promise.all(
          openJobs.map(async (job) => {
            try {
              const result = await pool.run(job);
              if (result) {
                if (!BascikConfig.isBuild) {
                  await mem.storePage({
                    relativePagePath: result.relativePagePath,
                    absolutePagePath: result.absolutePagePath,
                    pageContent: result.distHtml,
                    usedComponentsNames: result.usedComponentsNames,
                    fileDependencies: result.fileDependencies,
                  });
                  void queueTranspiledPageWrite(result);
                }
                eventEmitter.emit("transpiled", { relativePagePath: result.relativePagePath });
              }
              return result;
            } catch (error) {
              pageErrors.push(normalizePageError(job.pagePath, error, "worker transpile"));
              return null;
            }
          }),
        );
        for (const result of openResults) {
          if (result) results.push(result);
        }
      }

      if (restJobs.length > 0) {
        const restResults = await Promise.all(
          restJobs.map(async (job) => {
            try {
              const result = await pool.run(job);
              if (result) {
                if (!BascikConfig.isBuild) {
                  await mem.storePage({
                    relativePagePath: result.relativePagePath,
                    absolutePagePath: result.absolutePagePath,
                    pageContent: result.distHtml,
                    usedComponentsNames: result.usedComponentsNames,
                    fileDependencies: result.fileDependencies,
                  });
                  void queueTranspiledPageWrite(result);
                }
                eventEmitter.emit("transpiled", { relativePagePath: result.relativePagePath });
              }
              return result;
            } catch (error) {
              pageErrors.push(normalizePageError(job.pagePath, error, "worker transpile"));
              return null;
            }
          }),
        );
        for (const result of restResults) {
          if (result) results.push(result);
        }
      }

      reportPageErrors(pageErrors);
    } finally {
      // Always terminate — otherwise a rejected job leaves worker threads
      // alive and the CLI hangs on exit instead of reporting the failure.
      await pool.terminate();
    }

    relativePaths = results.map((r) => r?.relativePagePath ?? null).filter((p): p is string => p !== null);
  } else {
    relativePaths = await processPageBatch(
      allJobs,
      componentList,
      globalStylesHtml,
      expansionErrors,
    );
  }

  const count = relativePaths.length;
  const elapsed = performance.now() - start;

  if (BascikConfig.isBuild) {
    await generateSitemapFiles(relativePaths);
  }

  console.log(
    `\n✓ ${count} page${count !== 1 ? "s" : ""} transpiled in ${formatDuration(elapsed)}`,
  );

  return relativePaths;
};

export const pageProcessing = (
  pagePath: string,
  componentList?: ComponentList,
  globalStylesHtml?: string,
): Promise<string | undefined> => {
  const current = pageProcessingQueues.get(pagePath) ?? Promise.resolve();
  let resolveAvailable!: (relativePagePath: string | undefined) => void;
  let rejectAvailable!: (error: unknown) => void;
  const available = new Promise<string | undefined>((resolvePromise, rejectPromise) => {
    resolveAvailable = resolvePromise;
    rejectAvailable = rejectPromise;
  });
  const next = current.catch(() => { }).then(async () => {
    try {
      if (!isDynamicRoute(pagePath)) {
        const result = await transpilePage(pagePath, componentList, globalStylesHtml);
        if (!result) {
          resolveAvailable(undefined);
          return undefined;
        }
        const { relativePagePath, absolutePagePath, distHtml, usedComponentsNames, fileDependencies } = result;
        if (!BascikConfig.isBuild) {
          await mem.storePage({
            relativePagePath,
            absolutePagePath,
            pageContent: distHtml,
            usedComponentsNames,
            fileDependencies,
          });
        }
        eventEmitter.emit("transpiled", { relativePagePath });
        resolveAvailable(relativePagePath);
        if (!BascikConfig.isBuild) {
          await writeTranspiledPage(result);
        }
        return relativePagePath;
      }

      const jobs = await expandPageToJobs(pagePath);
      if (jobs.length === 0) {
        resolveAvailable(undefined);
        return undefined;
      }
      const relativePaths = await processPageBatch(jobs, componentList, globalStylesHtml);
      resolveAvailable(relativePaths[0]);
      return relativePaths[0];
    } catch (error) {
      rejectAvailable(error);
      throw error;
    }
  }).finally(() => {
    if (pageProcessingQueues.get(pagePath) === next) {
      pageProcessingQueues.delete(pagePath);
    }
  });
  pageProcessingQueues.set(pagePath, next);
  void next.catch(() => { });
  return available;
};

export const transpilePage = async (
  pagePath: string,
  componentList?: ComponentList,
  globalStylesHtml?: string,
  route?: RouteEntry | null,
  preCleanedHtml?: string,
): Promise<TranspilePageResult | null> => {
  const start = performance.now();
  const relativePagePath = route
    ? resolveRoutePath(getRelativePath(pagePath, "pages"), route.params)
    : getRelativePath(pagePath, "pages");

  if (!componentList) {
    componentList = await listComponents();
  }

  // Execute <script data-bascik-build> blocks first so that the generated HTML
  // can contain component tags, which will be resolved below.
  let rawHtml: string;
  if (preCleanedHtml !== undefined) {
    rawHtml = preCleanedHtml;
  } else {
    try {
      rawHtml = (await readFile(pagePath)).toString();
      if (isDynamicRoute(pagePath)) {
        const routesResult = await executeRoutesScript(rawHtml, pagePath);
        rawHtml = routesResult.cleanedHtml;
      }
    } catch (err) {
      console.warn(`[bascik] warning: Could not read page file "${pagePath}": ${(err as Error).message}`);
      return null;
    }
  }
  const htmlWithBuildOutput = await executeBuildScripts(rawHtml, pagePath, route);

  // Do NOT minify before component resolution. Minification runs after transpilation
  // so that whitespace-sensitive content (e.g. code inside resolved <pre> blocks
  // from components like <code-block>) is preserved by minifyHtml's <pre> handling.

  // Gets all the text between the <body></body> tags
  const bodyTag = getTag(htmlWithBuildOutput, "body");
  const { innerContent: body } = bodyTag;

  if (!body) {
    throw new PageProcessingError(
      pagePath,
      "validate markup",
      new Error("Page does not contain a non-empty <body> element"),
    );
  }

  let { transpiledHtmlBody, usedComponents } = recursivelyTranspile(
    body,
    componentList,
    [],
    pagePath,
  );

  let bodyPasses = 0;
  while (/<script\b[^>]*\bdata-bascik-build/i.test(transpiledHtmlBody) && bodyPasses < 10) {
    bodyPasses++;
    transpiledHtmlBody = await executeBuildScripts(transpiledHtmlBody, pagePath, route, {
      pageFile: pagePath,
    });
    const nextPass = recursivelyTranspile(
      transpiledHtmlBody,
      componentList,
      usedComponents,
      pagePath,
    );
    transpiledHtmlBody = nextPass.transpiledHtmlBody;
    usedComponents = nextPass.usedComponents;
  }

  // Also transpile the <head> so components can be used there (e.g. shared <meta> tags)
  const headTag = getTag(htmlWithBuildOutput, "head");
  const { innerContent: headRaw } = headTag;
  let {
    transpiledHtmlBody: transpiledHeadContent,
    usedComponents: headUsedComponents,
  } = recursivelyTranspile(headRaw ?? "", componentList, [], pagePath);

  let headPasses = 0;
  while (/<script\b[^>]*\bdata-bascik-build/i.test(transpiledHeadContent) && headPasses < 10) {
    headPasses++;
    transpiledHeadContent = await executeBuildScripts(transpiledHeadContent, pagePath, route, {
      pageFile: pagePath,
    });
    const nextPassHead = recursivelyTranspile(
      transpiledHeadContent,
      componentList,
      headUsedComponents,
      pagePath,
    );
    transpiledHeadContent = nextPassHead.transpiledHtmlBody;
    headUsedComponents = nextPassHead.usedComponents;
  }

  // Warn about any hyphenated tags remaining after transpilation — these have no
  // matching component file and will appear unresolved in the output HTML.
  {
    const unresolved = new Set<string>();
    for (const chunk of [transpiledHtmlBody, transpiledHeadContent]) {
      // Strip <script>, <style>, and <textarea> content so literal text like
      // `<my-tag>` inside JSON-LD or demo strings doesn't produce false warnings.
      const scannable = chunk.replace(
        /<(script|style|textarea)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi,
        "<$1$2></$1>",
      );
      const re = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s\/>]/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(scannable)) !== null) {
        const tag = m[1].toLowerCase();
        unresolved.add(tag);
      }
    }
    if (unresolved.size > 0) {
      console.warn(
        `[bascik] Unresolved component tag${unresolved.size > 1 ? "s" : ""} in "${relativePagePath}": ` +
        `${[...unresolved].map((t) => `<${t}>`).join(", ")} — no matching component file found. ` +
        `Run \`bascik --check\` for a full report.`,
      );
    }
  }

  // Deduplicate CSS — each component's styles included only once even if used many times
  let componentCss = deduplicateCss([...usedComponents, ...headUsedComponents], BascikConfig.scoping?.deduplicateCss ?? true);

  // Read and inline any global stylesheets configured via `inlineStyles`.
  // Global styles are injected before component styles so component rules win.
  if (globalStylesHtml === undefined) {
    globalStylesHtml = await resolveInlineStylesHtml();
  }

  // Component scoping finalizes ID references first. Base paths then leave
  // fragment-only references untouched and run before minification.
  transpiledHtmlBody = rewriteHtmlBasePaths(transpiledHtmlBody, BascikConfig.base);
  transpiledHeadContent = rewriteHtmlBasePaths(transpiledHeadContent, BascikConfig.base);
  globalStylesHtml = rewriteHtmlBasePaths(globalStylesHtml, BascikConfig.base);
  componentCss = rewriteCssBasePaths(componentCss, BascikConfig.base);

  const cssMinifier = resolveCssMinifier();
  const isMinifyHtml = BascikConfig.minify?.html ?? false;

  const formattedComponentCss = cssMinifier ? await cssMinifier(componentCss) : componentCss;

  const componentStyleBlock = formattedComponentCss
    ? `\n    <style>\n    ${formattedComponentCss}\n    </style>`
    : "";
  let transpiledHead = `${transpiledHeadContent}${globalStylesHtml}${componentStyleBlock}`;
  // Compress the entire head (removes newlines, collapses whitespace in inline <style> tags too)

  if (cssMinifier) {
    // Also minify any inline <style> blocks that came from the page source
    const styleBlockRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    const matches: Array<{ full: string; css: string; index: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = styleBlockRegex.exec(transpiledHead)) !== null) {
      matches.push({ full: match[0], css: match[1], index: match.index });
    }
    if (matches.length > 0) {
      let newHead = "";
      let lastIndex = 0;
      for (const m of matches) {
        newHead += transpiledHead.slice(lastIndex, m.index);
        const minifiedCss = await cssMinifier(m.css);
        newHead += `<style>${minifiedCss}</style>`;
        lastIndex = m.index + m.full.length;
      }
      newHead += transpiledHead.slice(lastIndex);
      transpiledHead = newHead;
    }
    transpiledHead = transpiledHead.replace(/\n/g, " ").replace(/\s\s+/g, " ");
  }

  if (!BascikConfig.isBuild) {
    transpiledHtmlBody = `${transpiledHtmlBody}${getLiveReloadScript(withBasePath("/bascik-live-reload", BascikConfig.base))}`;
  }

  // Minify the body AFTER component resolution so that <pre> blocks from resolved
  // components (e.g. <code-block> → <pre><code>…</code></pre>) are preserved intact.
  if (isMinifyHtml) {
    try {
      transpiledHtmlBody = minifyHtml(transpiledHtmlBody);
    } catch (err) {
      const behavior = BascikConfig.onMinifyError ?? "error";
      if (behavior === "error") {
        console.error(`[bascik] HTML minification failed for "${relativePagePath}":`, err);
        throw err;
      }
      console.warn(`[bascik] HTML minification failed for "${relativePagePath}", proceeding unminified:`, err);
    }
  }

  // Minify inline <script> content when configured.
  const jsMinifier = resolveScriptMinifier();
  if (jsMinifier) {
    transpiledHtmlBody = await minifyScriptTagsInHtml(transpiledHtmlBody, jsMinifier);
    transpiledHead = await minifyScriptTagsInHtml(transpiledHead, jsMinifier);
  }

  const replacements = [
    { tag: bodyTag, content: transpiledHtmlBody },
    { tag: headTag, content: transpiledHead },
  ].filter(
    (replacement): replacement is {
      tag: typeof bodyTag & { contentStart: number; closeIndex: number };
      content: string;
    } => replacement.tag.contentStart !== undefined && replacement.tag.closeIndex !== undefined,
  ).sort((a, b) => b.tag.contentStart - a.tag.contentStart);

  let distHtml = htmlWithBuildOutput;
  for (const { tag, content } of replacements) {
    distHtml =
      distHtml.slice(0, tag.contentStart) +
      content +
      distHtml.slice(tag.closeIndex);
  }
  distHtml = rewriteHtmlBasePaths(distHtml, BascikConfig.base);

  const allUsedComponents = [...usedComponents, ...headUsedComponents];

  const fileDependencies = await collectAllScriptDeps(rawHtml);
  for (const comp of allUsedComponents) {
    if (comp.fileContent) {
      const compDeps = await collectAllScriptDeps(comp.fileContent);
      for (const dep of compDeps) {
        if (!fileDependencies.includes(dep)) {
          fileDependencies.push(dep);
        }
      }
    }
  }

  if (BascikConfig.isBuild) {
    await writeTranspiledPage({
      relativePagePath,
      absolutePagePath: pagePath,
      distHtml,
      usedComponentsNames: allUsedComponents.map(({ name }) => name),
      fileDependencies,
    });
  }

  if (BascikConfig.logging?.transpiles !== false) {
    const configLevel = BascikConfig.logging?.level ?? "info";
    if (shouldLog(configLevel, "info")) {
      const elapsed = performance.now() - start;
      console.log(`transpiled: ${relativePagePath} in ${formatDuration(elapsed)}`);
    }
  }

  return {
    relativePagePath,
    absolutePagePath: pagePath,
    distHtml,
    usedComponentsNames: allUsedComponents.map(({ name }) => name),
    fileDependencies,
  };
};

export const removePage = async (absolutePagePath: string): Promise<void> => {
  const relativePagePath = getRelativePath(absolutePagePath, "pages");

  // Memory
  if (!BascikConfig.isBuild) {
    mem.removePage(absolutePagePath);
  }

  const tracked = templateToGeneratedRelativePaths.get(absolutePagePath);
  if (tracked) {
    for (const rel of tracked) {
      await deleteDistFile(rel);
    }
    templateToGeneratedRelativePaths.delete(absolutePagePath);
  } else {
    await deleteDistFile(relativePagePath);
  }
};
