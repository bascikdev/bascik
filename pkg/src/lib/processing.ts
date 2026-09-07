import { publishTranspiled, trackCompilationWrite, hasCompilationPublisher } from "./compilation-events.ts";
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
import { readFileSync, existsSync } from "node:fs";
import { cpus } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listPages,
  getDirectoryPath,
  getDistPagePath,
  deleteDistFile,
  getRelativePath,
  deepReadDirFlat,
} from "./file-system.ts";
import { findComponentRoot } from "./component-roots.ts";
import { getHttpPath } from "./paths.ts";
import { SERVER_ATTR_NAME, STREAM_ATTR_NAME } from "./html-patterns.ts";

// Request-time script directives as whole attribute names (prompt 65 step 0).
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const SERVER_OR_STREAM_SCRIPT_RE = new RegExp(String.raw`\s(?:${SERVER_ATTR_NAME}|${STREAM_ATTR_NAME})`, "i");
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

const annotateComponentScriptSources = (html: string, sourceFile: string): string => {
  const encodedSourceFile = encodeURIComponent(sourceFile);
  return html.replace(
    /<script\b([^>]*\bdata-bascik-(?:build|server)\b[^>]*)>/gi,
    (openTag, attributes: string, offset: number) => {
      const openingLine = html.slice(0, offset).split(/\r?\n/).length +
        openTag.split(/\r?\n/).length - 1;
      const sourceFileAttribute = /\bdata-bascik-source-file=/i.test(attributes)
        ? ""
        : ` data-bascik-source-file="${encodedSourceFile}"`;
      const sourceLineAttribute = /\bdata-bascik-source-line=/i.test(attributes)
        ? ""
        : ` data-bascik-source-line="${openingLine}"`;
      return `<script${attributes}${sourceFileAttribute}${sourceLineAttribute}>`;
    },
  );
};

import { isJavaScriptScript } from "./script-types.ts";
import { minifyJs } from "./js-minifier.ts";
import { deduplicateCss } from "./styles.ts";
import { minifyCss } from "./css-minifier.ts";
import { executeBuildScripts, collectAllScriptDeps } from "./build-scripts.ts";
import { deriveInstanceId } from "./names.ts";
import { BascikConfig, shouldLog } from "./config.ts";
import { mem } from "./mem.ts";
import { eventEmitter } from "./events.ts";
import { generateSitemapFiles } from "./sitemap.ts";
import { WorkerPool } from "./worker-pool.ts";
import type { PageWorkerResult } from "./page-worker.ts";
import { isDynamicRoute, resolveRoutePath, executeRoutesScript } from "./routes.ts";
import { formatDuration } from "./format.ts";
import { rewriteCssBasePaths, rewriteHtmlBasePaths, withBasePath } from "./base-path.ts";
import { filterPagesByOnlyGlobs } from "./targeted-build.ts";
import { manifestCollector } from "./manifest.ts";
import { ownershipTracker, toOutputFileKey } from "./ownership.ts";
import { extractServerScriptsToSidecar, serverSidecarRegistry, type ServerScriptEntry } from "./server-sidecar.ts";
import { cspHashCollector, computePageCspHashes } from "./csp-hashes.ts";
import type {
  BascikComponent,
  ComponentList,
  TranspileResult,
  TranspilePageResult,
  RouteEntry,
  PageCspHashes,
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
    // Server and stream scripts run at request time in Node.js, skip them here
    if (SERVER_OR_STREAM_SCRIPT_RE.test(open)) continue;
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
  if (findComponentRoot(path) !== undefined) {
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

const publishBuildError = (err: PageProcessingError): void => {
  const position = getFilePosition(err.pagePath, err.message, undefined);
  eventEmitter.emit("build-error", {
    message: err.message,
    file: getRelativePath(err.pagePath, "pages"),
    line: position?.line,
    column: position?.character,
  });
};

// Records the dependencies a page tried to use but that do not exist on disk.
// These live in a separate failed-dependency index so a compilation watcher
// can rebuild the page the moment a previously-missing helper is created,
// changed, or removed, without a restart or a full rebuild. Replacing the page's
// entries wholesale on each attempt drops deps the page no longer references.
const recordMissingScriptDeps = async (rawHtml: string, pagePath: string): Promise<void> => {
  if (BascikConfig.isBuild) return;
  try {
    const attempted = await collectAllScriptDeps(rawHtml, pagePath);
    const missing = attempted.filter(
      (dep) => !existsSync(resolve(process.cwd(), dep)),
    );
    mem.recordFailedDependencies(pagePath, missing);
  } catch {
    // dependency collection must never mask the original build error
  }
};

const reportPageErrors = (pageErrors: PageProcessingError[]): void => {
  if (pageErrors.length === 0) return;
  const aggregateError = new PageProcessingAggregateError(pageErrors);
  if (BascikConfig.isBuild || hasCompilationPublisher()) throw aggregateError;

  // One owner publishes located build failures to the SSE layer. The dev
  // browser overlay needs the source file and line; suppressing stack detail
  // is not required in dev, but we still publish a concise located payload.
  for (const err of pageErrors) {
    publishBuildError(err);
  }
  console.error(aggregateError.message);
};

/**
 * Force V8 to materialize `value` as a flat (contiguous) string (prompt 85).
 *
 * Every `replaceTag` splice is `prefix + insert + suffix`, and V8 represents
 * that as a `ConsString` node rather than copying. After hundreds of splices
 * the page is a deep concatenation tree, and the first downstream consumer
 * (regex scan, minifier, `Buffer.from`) pays a synchronous flatten pause.
 *
 * `Buffer.byteLength` hands the string to V8's C++ `String::Flatten` on every
 * call, which rewrites the cons tree in place into a flat sequential string
 * and returns the same string object. Pure-JS probes such as `charCodeAt` or
 * `indexOf` are not reliable here: once TurboFan inlines them they walk the
 * cons tree without flattening it. Byte-neutral; one linear pass at most.
 */
const flattenString = (value: string): string => {
  if (value.length > 0) Buffer.byteLength(value);
  return value;
};

export const recursivelyTranspile = (
  transpiledHtmlBody: string,
  componentList: ComponentList,
  usedComponents: BascikComponent[] = [],
  filePath?: string,
  instanceState?: { ordinalMap: Map<string, number>; issuedIds: Set<string> },
): TranspileResult => {
  if (filePath && !transpiledHtmlBody.includes("<!--bascik-source-file:")) {
    transpiledHtmlBody = `<!--bascik-source-file:${filePath}-->${transpiledHtmlBody}<!--bascik-source-file-end:${filePath}-->`;
  }

  const ordinalMap = instanceState?.ordinalMap ?? new Map<string, number>();
  const issuedIds = instanceState?.issuedIds ?? new Set<string>();

  // Iterative implementation — avoids keeping O(N) copies of the growing HTML
  // string simultaneously on the call stack (each recursive frame held its own
  // copy, leading to multi-GB heap usage on pages with many component instances).
  let substitutions = 0;
  let masked = maskRawTextContent(transpiledHtmlBody);
  // Search cursor (prompt 63). Replacement happens at the FIRST unresolved
  // component, so the prefix before its start is fully resolved and cannot
  // gain new tags; the next search resumes at that start (not its end, so
  // components nested inside the inserted template are still found first).
  // Any operation that edits text outside the known splice resets it to 0.
  let searchFrom = 0;
  while (true) {
    if (
      substitutions >= MAX_SUBSTITUTIONS ||
      transpiledHtmlBody.length > MAX_OUTPUT_BYTES
    ) {
      const partial = getFirstComponent(transpiledHtmlBody, componentList, masked, searchFrom);
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
    const partial = getFirstComponent(transpiledHtmlBody, componentList, masked, searchFrom);
    if (!partial.name) {
      const cleanedHtml = flattenString(
        transpiledHtmlBody
          .replace(/<!--bascik-source-file:[\s\S]*?-->/g, "")
          .replace(/<!--bascik-source-file-end:[\s\S]*?-->/g, ""),
      );
      return { transpiledHtmlBody: cleanedHtml, usedComponents };
    }
    // Cast: getFirstComponent merges component list data so all required fields are present
    let component = partial as BascikComponent;

    if (!component.fileContent) {
      const cleanedHtml = flattenString(
        transpiledHtmlBody
          .replace(component.content || "", "")
          .replace(/<!--bascik-source-file:[\s\S]*?-->/g, "")
          .replace(/<!--bascik-source-file-end:[\s\S]*?-->/g, ""),
      );
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
      if (component.fileName) {
        component.fileContent = annotateComponentScriptSources(
          component.fileContent,
          component.fileName,
        );
      }

      // Run the scoping pipeline — each step is `BascikComponent → BascikComponent`.
      const currentOrdinal = (ordinalMap.get(component.name) ?? 0) + 1;
      ordinalMap.set(component.name, currentOrdinal);
      const instanceId = deriveInstanceId(
        filePath || "page",
        component.name,
        currentOrdinal,
        issuedIds,
      );
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
      const sIdx = (component as any).startIndex;
      const eIdx = (component as any).endIndex;
      transpiledHtmlBody = replaceTag(
        transpiledHtmlBody,
        component.name,
        transpiledTag,
        masked,
        typeof sIdx === "number" && typeof eIdx === "number"
          ? { startIndex: sIdx, endIndex: eIdx }
          : undefined,
      );

      // If the replaced content introduced raw tags (<script>, <style>, <textarea>), re-mask
      const introducedRawTags = /<(?:script|style|textarea)\b/i.test(transpiledTag);
      if (introducedRawTags || typeof sIdx !== "number" || typeof eIdx !== "number") {
        masked = maskRawTextContent(transpiledHtmlBody);
        // A comment or raw-text element opened inside the new content could
        // extend a mask region across the splice boundary only forward, never
        // into the resolved prefix, so resuming at the instance start is still
        // safe; without known indices, be conservative.
        searchFrom = typeof sIdx === "number" ? sIdx : 0;
      } else {
        masked = masked.slice(0, sIdx) + transpiledTag + masked.slice(eIdx);
        searchFrom = sIdx;
      }

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
        masked = maskRawTextContent(transpiledHtmlBody);
        // replaceTag without offsets re-searches from the document start and
        // may have edited text before the cursor; reset conservatively.
        searchFrom = 0;
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
    // Prompt 101: a template that now emits zero routes is an authoritative
    // rebuild of that owner with an empty output set, so a fresh targeted build
    // prunes its prior outputs. Only in build mode where ownership applies.
    if (BascikConfig.isBuild) {
      ownershipTracker.recordOwner(pagePath, getRelativePath(pagePath, "pages"));
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

// ─── Generation ownership ─────────────────────────────────────────────────────
// Every compilation/publication entrypoint for a page claims a monotonically
// increasing generation at enqueue/invalidation time. Side effects (memory
// store, disk write, sidecar record, transpiled reload event) are applied only
// if the job's generation is still the latest for that page. This guarantees a
// stale completion cannot overwrite a newer one, regardless of whether the two
// jobs ran through a batch, the direct page update path, or a worker.
const pageGenerations = new Map<string, number>();

// Canonical ownership key: relative and absolute aliases of the same page must
// share one generation so a stale completion using either form cannot slip past
// a newer one using the other.
const pageGenKey = (absolutePagePath: string): string =>
  resolve(process.cwd(), absolutePagePath);

const nextPageGeneration = (absolutePagePath: string): number => {
  const key = pageGenKey(absolutePagePath);
  const next = (pageGenerations.get(key) ?? 0) + 1;
  pageGenerations.set(key, next);
  return next;
};

const isCurrentGeneration = (absolutePagePath: string, generation: number): boolean =>
  (pageGenerations.get(pageGenKey(absolutePagePath)) ?? 0) === generation;

// Marks a page deleted so any late in-flight work cannot resurrect it. The next
// enqueue claims a fresh generation above the deleted one.
const bumpPageGeneration = (absolutePagePath: string): void => {
  const key = pageGenKey(absolutePagePath);
  pageGenerations.set(key, (pageGenerations.get(key) ?? 0) + 1);
};

/**
 * The subset of a page result the disk writer needs. `distHtml` may already be
 * UTF-8 bytes (a buffer transferred from a worker, prompt 86); `writeFile` and
 * the manifest hash both accept bytes directly, so no decode happens here.
 */
type PageWriteInput = Pick<TranspilePageResult, "relativePagePath" | "absolutePagePath"> & {
  distHtml: string | Buffer;
  /** Inline CSP hashes computed from the emitted representation (prompt 100). */
  cspHashes?: PageCspHashes;
  /** Generational guard for dev writes: the write is dropped when superseded. */
  generation?: number;
};

/**
 * SINGLE OWNER of page artifact accounting. Every page artifact that lands on
 * disk funnels through this function, so serial and worker builds record the
 * manifest and CSP identically regardless of where the page was compiled.
 *
 * Recording happens only AFTER a successful write: a failed `writeFile` throws
 * before `recordFile` runs, so a failed write is never accounted as emitted.
 * The page's inline CSP hashes were computed from the final emitted HTML in
 * `transpilePage`; they are recorded here, at the same defined point, without
 * decoding large HTML solely for bookkeeping.
 */
const writeTranspiledPage = async (result: PageWriteInput): Promise<void> => {
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
  manifestCollector.recordFile(distPagePath, result.distHtml);
  cspHashCollector.recordComputed(getHttpPath(result.relativePagePath), result.cspHashes ?? {
    scripts: [],
    styles: [],
  });
  // Prompt 101: record this page's output into the durable ownership tracker.
  // The dist-relative output key and its HTTP route let the ownership
  // transaction reconcile manifest, CSP, and obsolete-output pruning.
  ownershipTracker.recordOutput(
    result.absolutePagePath,
    getRelativePath(result.absolutePagePath, "pages"),
    toOutputFileKey(distPagePath),
    getHttpPath(result.relativePagePath),
  );
};

const queueTranspiledPageWrite = (result: PageWriteInput): Promise<void> => {
  const pagePath = result.absolutePagePath;
  const current = pageProcessingQueues.get(pagePath) ?? Promise.resolve();
  const queued = current
    .catch(() => { })
    .then(async () => {
      // Never publish a stale generation to disk: a newer edit may already be
      // in flight, and its content must win regardless of completion order.
      // (The queue is dev-only, so a generation is always present here.)
      if (result.generation === undefined || !isCurrentGeneration(pagePath, result.generation)) {
        return;
      }
      await writeTranspiledPage(result);
    })
    .catch((error) => {
      if (hasCompilationPublisher()) throw error;
      console.error(`[bascik] Failed to write dev page "${pagePath}":`, error);
    })
    .finally(() => {
      if (pageProcessingQueues.get(pagePath) === queued) {
        pageProcessingQueues.delete(pagePath);
      }
    });
  pageProcessingQueues.set(pagePath, queued);
  trackCompilationWrite(queued);
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

  // Claim generations eagerly at enqueue time, before any file read. A newer
  // concurrent request for the same page claims a higher generation and
  // supersedes this batch's completions, so an older batch can never overwrite
  // a newer edit that already became visible. Claiming at dispatch time (in
  // runJob) would let a deletion or newer request that runs first take a LOWER
  // number and reverse the ordering.
  const pagesClaimed = new Map<string, number>();
  const claimPage = (pagePath: string): number => {
    let gen = pagesClaimed.get(pagePath);
    if (gen === undefined) {
      gen = nextPageGeneration(pagePath);
      pagesClaimed.set(pagePath, gen);
    }
    return gen;
  };
  for (const input of pageInputs) {
    if (typeof input === "string") {
      claimPage(input);
    } else {
      claimPage(input.pagePath);
    }
  }

  if (!componentList) componentList = await listComponents();
  if (globalStylesHtml === undefined) globalStylesHtml = await resolveInlineStylesHtml();

  const jobs: PageJob[] = [];
  const pathToSource = new Map<string, string>();

  for (const input of pageInputs) {
    if (typeof input === "string") {
      try {
        const expanded = await expandPageToJobs(input);
        for (const job of expanded) {
          const outKey = job.relativePagePath.toLowerCase();
          const existing = pathToSource.get(outKey);
          if (existing && existing !== input) {
            throw new Error(
              `Route conflict: "${existing}" and "${input}" both produce output path "${job.relativePagePath}".`,
            );
          }
          pathToSource.set(outKey, input);
          jobs.push(job);
        }
      } catch (error) {
        pageErrors.push(normalizePageError(input, error, "expand routes"));
      }
    } else {
      const outKey = input.relativePagePath.toLowerCase();
      const existing = pathToSource.get(outKey);
      if (existing && existing !== input.pagePath) {
        pageErrors.push(
          normalizePageError(
            input.pagePath,
            new Error(`Route conflict: "${existing}" and "${input.pagePath}" both produce output path "${input.relativePagePath}".`),
            "expand routes",
          ),
        );
      } else {
        pathToSource.set(outKey, input.pagePath);
        jobs.push(input);
      }
    }
  }
  if (jobs.length === 0) {
    reportPageErrors(pageErrors);
    return [];
  }

  const [openJobs, restJobs] = partitionByOpenPages(jobs) as [PageJob[], PageJob[]];

  const results: (TranspilePageResult | null)[] = [];

  const runJob = async (job: PageJob) => {
    const generation = pagesClaimed.get(job.pagePath)!;
    const result = await transpilePage(
      job.pagePath,
      componentList!,
      globalStylesHtml!,
      job.route,
      job.preCleanedHtml,
    );
    if (result && isCurrentGeneration(job.pagePath, generation)) {
      if (result.serverScripts) {
        serverSidecarRegistry.recordScripts(result.serverScripts);
        const relSource = getRelativePath(job.pagePath, "pages");
        for (const id of Object.keys(result.serverScripts)) {
          ownershipTracker.recordScript(job.pagePath, relSource, id);
        }
      }
      if (!BascikConfig.isBuild) {
        await mem.storePage({
          relativePagePath: result.relativePagePath,
          absolutePagePath: result.absolutePagePath,
          pageContent: result.distHtml,
          usedComponentsNames: result.usedComponentsNames,
          fileDependencies: result.fileDependencies,
        });
        void queueTranspiledPageWrite({
          relativePagePath: result.relativePagePath,
          absolutePagePath: result.absolutePagePath,
          distHtml: result.distHtml,
          cspHashes: result.cspHashes,
          generation,
        });
      }
      publishTranspiled({ relativePagePath: result.relativePagePath });
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
  let pageList = pages ?? [];

  if (BascikConfig.isBuild && BascikConfig.only && BascikConfig.only.length > 0) {
    pageList = filterPagesByOnlyGlobs(pageList, BascikConfig.only, BascikConfig.directory.pages);
  }

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
    const pool = new WorkerPool<PageJob, PageWorkerResult | null>(
      fileURLToPath(workerUrl),
      poolSize,
      { componentList, globalStylesHtml },
    );
    const [openJobs, restJobs] = partitionByOpenPages(allJobs) as [PageJob[], PageJob[]];
    const results: PageWorkerResult[] = [];
    const pageErrors: PageProcessingError[] = [...expansionErrors];
    // A broad worker rebuild captures each page's current generation WITHOUT
    // bumping it, so a concurrent specific page edit (pageProcessing) or a
    // newer batch that bumps a higher generation always supersedes this broad
    // pass. The worker publishes only if its captured generation is still the
    // latest when the result finally lands.
    const pagesClaimed = new Map<string, number>();
    for (const job of allJobs) {
      if (!pagesClaimed.has(job.pagePath)) {
        pagesClaimed.set(job.pagePath, pageGenerations.get(pageGenKey(job.pagePath)) ?? 0);
      }
    }

    // Apply main-thread side effects for one worker result. The page bytes
    // arrived as a transferred ArrayBuffer (prompt 86); wrap them in a Buffer
    // view (no copy) and hand that view to the store and the disk writer.
    // Nothing on this path needs the HTML as a string.
    const runWorkerJob = async (job: PageJob): Promise<PageWorkerResult | null> => {
      try {
        const generation = pagesClaimed.get(job.pagePath)!;
        const result = await pool.run(job);
        if (result && isCurrentGeneration(job.pagePath, generation)) {
          if (result.serverScripts) {
            serverSidecarRegistry.recordScripts(result.serverScripts);
            // Prompt 101: attribute each transferred server/stream script to its
            // owning source page so the ownership transaction can prune scripts
            // removed from a rebuilt owner while retaining untouched owners'.
            const relSource = getRelativePath(job.pagePath, "pages");
            for (const id of Object.keys(result.serverScripts)) {
              ownershipTracker.recordScript(job.pagePath, relSource, id);
            }
          }
          const { distHtmlBytes } = result;
          const pageBytes = Buffer.from(distHtmlBytes.buffer, distHtmlBytes.byteOffset, distHtmlBytes.byteLength);
          if (BascikConfig.isBuild) {
            // The worker deferred the disk write; the main thread is the single
            // owner of artifact publication (prompt 100). Writing here records
            // the manifest and CSP from the exact transferred bytes.
            await writeTranspiledPage({
              relativePagePath: result.relativePagePath,
              absolutePagePath: result.absolutePagePath,
              distHtml: pageBytes,
              cspHashes: result.cspHashes,
            });
          } else {
            await mem.storePage({
              relativePagePath: result.relativePagePath,
              absolutePagePath: result.absolutePagePath,
              pageContent: pageBytes,
              usedComponentsNames: result.usedComponentsNames,
              fileDependencies: result.fileDependencies,
            });
            void queueTranspiledPageWrite({
              relativePagePath: result.relativePagePath,
              absolutePagePath: result.absolutePagePath,
              distHtml: pageBytes,
              cspHashes: result.cspHashes,
              generation,
            });
          }
          publishTranspiled({ relativePagePath: result.relativePagePath });
        }
        return result;
      } catch (error) {
        pageErrors.push(normalizePageError(job.pagePath, error, "worker transpile"));
        return null;
      }
    };

    try {
      if (openJobs.length > 0) {
        for (const result of await Promise.all(openJobs.map(runWorkerJob))) {
          if (result) results.push(result);
        }
      }

      if (restJobs.length > 0) {
        for (const result of await Promise.all(restJobs.map(runWorkerJob))) {
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
        // Claim when this page is about to publish, not when the request was
        // made. A broad worker rebuild that started earlier captured an older
        // snapshot; this specific newer edit bumps past it so it supersedes.
        const generation = nextPageGeneration(pagePath);
        if (isCurrentGeneration(pagePath, generation)) {
          const { relativePagePath, absolutePagePath, distHtml, usedComponentsNames, fileDependencies, cspHashes } = result;
          if (!BascikConfig.isBuild) {
            await mem.storePage({
              relativePagePath,
              absolutePagePath,
              pageContent: distHtml,
              usedComponentsNames,
              fileDependencies,
            });
            void queueTranspiledPageWrite({
              relativePagePath,
              absolutePagePath,
              distHtml,
              cspHashes,
              generation,
            });
          }
          publishTranspiled({ relativePagePath });
          resolveAvailable(relativePagePath);
          return relativePagePath;
        }
        // Superseded by a newer generation: do not publish stale state.
        resolveAvailable(undefined);
        return undefined;
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
      if (!BascikConfig.isBuild) {
        publishBuildError(normalizePageError(pagePath, error));
      }
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
  options?: { deferDiskWrite?: boolean },
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

  let htmlWithBuildOutput: string;
  try {
    htmlWithBuildOutput = await executeBuildScripts(rawHtml, pagePath, route);
  } catch (error) {
    // A failed build may still have attempted to import helpers that do not
    // exist yet. Record those attempted dependencies so the import-root
    // watcher can rebuild this page the moment the missing helper appears.
    await recordMissingScriptDeps(rawHtml, pagePath);
    throw error;
  }

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

  const instanceState = {
    ordinalMap: new Map<string, number>(),
    issuedIds: new Set<string>(),
  };

  let { transpiledHtmlBody, usedComponents } = recursivelyTranspile(
    body,
    componentList,
    [],
    pagePath,
    instanceState,
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
      instanceState,
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
  } = recursivelyTranspile(headRaw ?? "", componentList, [], pagePath, instanceState);

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
      instanceState,
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
  const serverScripts: Record<string, ServerScriptEntry> = {};
  distHtml = extractServerScriptsToSidecar(distHtml, relativePagePath, serverScripts, pagePath);
  // Compute the page's inline CSP hashes here, at the single defined point
  // where `distHtml` holds the page's final emitted representation. Both the
  // serial and worker paths carry these hashes onward; the main thread records
  // them (in `writeTranspiledPage`) without re-decoding the page.
  const cspHashes = computePageCspHashes(distHtml);

  const allUsedComponents = [...usedComponents, ...headUsedComponents];

  const fileDependencies = await collectAllScriptDeps(rawHtml, pagePath);
  // Even on a "successful" transpile the page may reference a helper that does
  // not yet exist (e.g. the harness swallows the import failure). Track it so
  // creating the helper rebuilds the page; replace the page's prior set so
  // deps the page no longer references are reclaimed.
  await recordMissingScriptDeps(rawHtml, pagePath);
  for (const comp of allUsedComponents) {
    const compContent = comp.scriptDependenciesContent ?? comp.fileContent;
    if (compContent) {
      const componentSourcePath = comp.fileName
        ? resolve(process.cwd(), comp.fileName)
        : undefined;
      const compDeps = await collectAllScriptDeps(compContent, componentSourcePath);
      for (const dep of compDeps) {
        if (!fileDependencies.includes(dep)) {
          fileDependencies.push(dep);
        }
      }
    }
  }

  if (BascikConfig.isBuild && !options?.deferDiskWrite) {
    await writeTranspiledPage({
      relativePagePath,
      absolutePagePath: pagePath,
      distHtml,
      cspHashes,
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
    serverScripts,
    cspHashes,
  };
};

export const removePage = async (absolutePagePath: string): Promise<void> => {
  const relativePagePath = getRelativePath(absolutePagePath, "pages");

  // A deletion is a new generation so any in-flight build for this page can
  // no longer publish: a completed-but-superseded job must not resurrect the
  // deleted page in memory, disk, or the reload stream.
  bumpPageGeneration(absolutePagePath);

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
