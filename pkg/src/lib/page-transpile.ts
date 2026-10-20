import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getTag, listComponents, maskRawTextContent } from "./components.ts";
import { stampDirectiveSources } from "./directive-source.ts";
import { createExternalTagMatcher } from "./external-components.ts";
import {
  getDirectoryPath,
  getDistPagePath,
  getRelativePath,
} from "./file-system.ts";
import { minifyHtml } from "./html-minifier.ts";
import { BUILD_ATTR_NAME, OPEN_TAG_ATTRS } from "./html-patterns.ts";
import { getLiveReloadScript } from "./live-reload.ts";
import { getHttpPath } from "./paths.ts";

import {
  rewriteCssBasePaths,
  rewriteHtmlBasePaths,
  withBasePath,
} from "./base-path.ts";
import { collectAllScriptDeps, executeBuildScripts } from "./build-scripts.ts";
import { stdout as colorOut } from "./colors.ts";
import { BascikConfig, shouldLog } from "./config.ts";
import { computePageCspHashes, cspHashCollector } from "./csp-hashes.ts";
import { formatDuration } from "./format.ts";
import { manifestCollector } from "./manifest.ts";
import { mem } from "./mem.ts";
import { ownershipTracker, toOutputFileKey } from "./ownership.ts";
import {
  executeRoutesScript,
  isDynamicRoute,
  resolveRoutePath,
} from "./routes.ts";
import {
  extractServerScriptsToSidecar,
  type ServerScriptEntry,
} from "./server-sidecar.ts";
import { deduplicateCss } from "./styles.ts";
import type {
  ComponentList,
  PageCspHashes,
  RouteEntry,
  TranspilePageResult,
} from "./types.ts";
import { transformTypeScriptScriptTags } from "./typescript.ts";

import { recursivelyTranspile } from "./component-expansion.ts";
import {
  PageProcessingError,
  relativePagePathForDiagnostics,
} from "./page-diagnostics.ts";
import {
  minifyScriptTagsInHtml,
  resolveCssMinifier,
  resolveInlineStylesHtml,
  resolveScriptMinifier,
} from "./page-minification.ts";

/**
 * The subset of a page result the disk writer needs. `distHtml` may already be
 * UTF-8 bytes (a buffer transferred from a worker, prompt 86); `writeFile` and
 * the manifest hash both accept bytes directly, so no decode happens here.
 */
export type PageWriteInput = Pick<
  TranspilePageResult,
  "relativePagePath" | "absolutePagePath"
> & {
  distHtml: string | Buffer;
  /** Inline CSP hashes computed from the emitted representation (prompt 100). */
  cspHashes?: PageCspHashes;
  /** Generational guard for dev writes: the write is dropped when superseded. */
  generation?: number;
};

// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const PENDING_BUILD_SCRIPT_RE = new RegExp(
  String.raw`<script\b${OPEN_TAG_ATTRS}\s${BUILD_ATTR_NAME}`,
  "i",
);

// Records missing imports so creating a helper can trigger a page rebuild.
const recordMissingScriptDeps = async (
  rawHtml: string,
  pagePath: string,
): Promise<void> => {
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
export const writeTranspiledPage = async (
  result: PageWriteInput,
): Promise<void> => {
  const directoryPath = getDirectoryPath(result.relativePagePath);
  try {
    await mkdir(join(BascikConfig.directory.out, directoryPath), {
      recursive: true,
    });
  } catch (error) {
    throw new PageProcessingError(
      result.absolutePagePath,
      "create output directory",
      error,
    );
  }
  const distPagePath = getDistPagePath(result.relativePagePath);
  // Encode once for both the write and the manifest hash.
  const distBytes =
    typeof result.distHtml === "string"
      ? Buffer.from(result.distHtml, "utf8")
      : result.distHtml;
  try {
    await writeFile(distPagePath, distBytes);
  } catch (error) {
    throw new PageProcessingError(
      result.absolutePagePath,
      "write output",
      error,
    );
  }
  manifestCollector.recordFile(distPagePath, distBytes);
  cspHashCollector.recordComputed(
    getHttpPath(result.relativePagePath),
    result.cspHashes ?? {
      scripts: [],
      styles: [],
    },
  );
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

export const transpilePage = async (
  pagePath: string,
  componentList?: ComponentList,
  globalStylesHtml?: string,
  route?: RouteEntry | null,
  preCleanedHtml?: string,
  options?: { deferDiskWrite?: boolean },
): Promise<TranspilePageResult | null> => {
  let workMs = 0;
  let seg = performance.now();
  const pause = () => {
    workMs += performance.now() - seg;
  };
  const resume = () => {
    seg = performance.now();
  };

  const relativePagePath = route
    ? resolveRoutePath(getRelativePath(pagePath, "pages"), route.params)
    : getRelativePath(pagePath, "pages");

  if (!componentList) {
    const pending = listComponents();
    pause();
    componentList = await pending;
    resume();
  }

  // Execute <script data-bascik-build> blocks first so that the generated HTML
  // can contain component tags, which will be resolved below.
  let rawHtml: string;
  if (preCleanedHtml !== undefined) {
    rawHtml = preCleanedHtml;
  } else {
    try {
      const pendingRead = readFile(pagePath);
      pause();
      const fileBuf = await pendingRead;
      resume();
      // Directive scripts record where they are before the routes script is removed.
      rawHtml = stampDirectiveSources(fileBuf.toString(), pagePath);
      if (isDynamicRoute(pagePath)) {
        const pendingRoutes = executeRoutesScript(rawHtml, pagePath);
        pause();
        const routesResult = await pendingRoutes;
        resume();
        rawHtml = routesResult.cleanedHtml;
      }
    } catch (err) {
      console.warn(
        `[bascik] warning: Could not read page file "${pagePath}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  let htmlWithBuildOutput: string;
  try {
    const pendingBuild = executeBuildScripts(rawHtml, pagePath, route);
    pause();
    htmlWithBuildOutput = await pendingBuild;
    resume();
  } catch (error) {
    // A failed build may still have attempted to import helpers that do not
    // exist yet. Record those attempted dependencies so the import-root
    // watcher can rebuild this page the moment the missing helper appears.
    const pendingMissing = recordMissingScriptDeps(rawHtml, pagePath);
    pause();
    await pendingMissing;
    resume();
    throw error;
  }

  // Page-authored browser TypeScript. Runs on the page's own markup (after
  // build scripts, whose generated HTML may also carry marked scripts) and
  // before component expansion, so component scripts, which were already
  // transformed and diagnosed in `listComponents`, are not re-inspected here.
  // This is the same pass in dev and build: TypeScript strip first, then
  // scoping, then optional `minify.js`.
  const pendingTs = transformTypeScriptScriptTags(
    htmlWithBuildOutput,
    relativePagePathForDiagnostics(pagePath),
  );
  pause();
  htmlWithBuildOutput = await pendingTs;
  resume();

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
  while (PENDING_BUILD_SCRIPT_RE.test(transpiledHtmlBody) && bodyPasses < 10) {
    bodyPasses++;
    const pendingBodyBuild = executeBuildScripts(
      transpiledHtmlBody,
      pagePath,
      route,
      {
        pageFile: pagePath,
      },
    );
    pause();
    transpiledHtmlBody = await pendingBodyBuild;
    resume();
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
  } = recursivelyTranspile(
    headRaw ?? "",
    componentList,
    [],
    pagePath,
    instanceState,
  );

  let headPasses = 0;
  while (
    PENDING_BUILD_SCRIPT_RE.test(transpiledHeadContent) &&
    headPasses < 10
  ) {
    headPasses++;
    const pendingHeadBuild = executeBuildScripts(
      transpiledHeadContent,
      pagePath,
      route,
      {
        pageFile: pagePath,
      },
    );
    pause();
    transpiledHeadContent = await pendingHeadBuild;
    resume();
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
    const isExternalTag = createExternalTagMatcher(
      BascikConfig.components?.external,
    );
    for (const chunk of [transpiledHtmlBody, transpiledHeadContent]) {
      // Strip HTML comments as well as <script>, <style>, and <textarea> content
      // so literal text like `<my-tag>` inside comments, JSON-LD, or demo strings
      // doesn't produce false unresolved component warnings.
      const scannable = maskRawTextContent(chunk);
      const re = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s\/>]/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(scannable)) !== null) {
        const tag = m[1].toLowerCase();
        if (isExternalTag(tag)) continue;
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
  let componentCss = deduplicateCss(
    [...usedComponents, ...headUsedComponents],
    BascikConfig.scoping?.deduplicateCss ?? true,
  );

  // Read and inline any global stylesheets configured via `inlineStyles`.
  // Global styles are injected before component styles so component rules win.
  if (globalStylesHtml === undefined) {
    const pendingGlobalStyles = resolveInlineStylesHtml();
    pause();
    globalStylesHtml = await pendingGlobalStyles;
    resume();
  }

  // Component scoping finalizes ID references first. Base paths then leave
  // fragment-only references untouched and run before minification.
  transpiledHtmlBody = rewriteHtmlBasePaths(
    transpiledHtmlBody,
    BascikConfig.base,
  );
  transpiledHeadContent = rewriteHtmlBasePaths(
    transpiledHeadContent,
    BascikConfig.base,
  );
  globalStylesHtml = rewriteHtmlBasePaths(globalStylesHtml, BascikConfig.base);
  componentCss = rewriteCssBasePaths(componentCss, BascikConfig.base);

  const cssMinifier = resolveCssMinifier();
  const isMinifyHtml = BascikConfig.minify?.html ?? false;

  let formattedComponentCss: string;
  if (cssMinifier) {
    const pendingCompCss = cssMinifier(componentCss);
    pause();
    formattedComponentCss = await pendingCompCss;
    resume();
  } else {
    formattedComponentCss = componentCss;
  }

  const componentStyleBlock = formattedComponentCss
    ? `\n    <style>\n    ${formattedComponentCss}\n    </style>`
    : "";
  let transpiledHead = `${transpiledHeadContent}${globalStylesHtml}${componentStyleBlock}`;
  // Compress the entire head (removes newlines, collapses whitespace in inline <style> tags too)

  if (cssMinifier) {
    // Also minify any inline <style> blocks that came from the page source,
    // preserving their opening and closing tags (such as media="..." attributes).
    const styleBlockRegex =
      /(<style(?=[\t\n\f\r />])(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/style(?:[\t\n\f\r /][^>]*)?>)/gi;
    const matches: Array<{
      full: string;
      open: string;
      css: string;
      close: string;
      index: number;
    }> = [];
    let match: RegExpExecArray | null;
    while ((match = styleBlockRegex.exec(transpiledHead)) !== null) {
      matches.push({
        full: match[0],
        open: match[1],
        css: match[2],
        close: match[3],
        index: match.index,
      });
    }
    if (matches.length > 0) {
      let newHead = "";
      let lastIndex = 0;
      for (const m of matches) {
        newHead += transpiledHead.slice(lastIndex, m.index);
        const pendingInlineCss = cssMinifier(m.css);
        pause();
        const minifiedCss = await pendingInlineCss;
        resume();
        newHead += `${m.open}${minifiedCss}${m.close}`;
        lastIndex = m.index + m.full.length;
      }
      newHead += transpiledHead.slice(lastIndex);
      transpiledHead = newHead;
    }
  }

  if (isMinifyHtml) {
    try {
      transpiledHead = minifyHtml(transpiledHead);
    } catch (err) {
      const behavior = BascikConfig.onMinifyError ?? "error";
      if (behavior === "error") {
        console.error(
          `[bascik] HTML minification failed for head in "${relativePagePath}":`,
          err,
        );
        throw err;
      }
      console.warn(
        `[bascik] HTML minification failed for head in "${relativePagePath}", proceeding unminified:`,
        err,
      );
    }
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
        console.error(
          `[bascik] HTML minification failed for "${relativePagePath}":`,
          err,
        );
        throw err;
      }
      console.warn(
        `[bascik] HTML minification failed for "${relativePagePath}", proceeding unminified:`,
        err,
      );
    }
  }

  // Minify inline <script> content when configured.
  const jsMinifier = resolveScriptMinifier();
  if (jsMinifier) {
    const pendingBodyJs = minifyScriptTagsInHtml(
      transpiledHtmlBody,
      jsMinifier,
    );
    pause();
    transpiledHtmlBody = await pendingBodyJs;
    resume();

    const pendingHeadJs = minifyScriptTagsInHtml(transpiledHead, jsMinifier);
    pause();
    transpiledHead = await pendingHeadJs;
    resume();
  }

  const replacements = [
    { tag: bodyTag, content: transpiledHtmlBody },
    { tag: headTag, content: transpiledHead },
  ]
    .filter(
      (
        replacement,
      ): replacement is {
        tag: typeof bodyTag & { contentStart: number; closeIndex: number };
        content: string;
      } =>
        replacement.tag.contentStart !== undefined &&
        replacement.tag.closeIndex !== undefined,
    )
    .sort((a, b) => b.tag.contentStart - a.tag.contentStart);

  let distHtml = htmlWithBuildOutput;
  for (const { tag, content } of replacements) {
    distHtml =
      distHtml.slice(0, tag.contentStart) +
      content +
      distHtml.slice(tag.closeIndex);
  }
  distHtml = rewriteHtmlBasePaths(distHtml, BascikConfig.base);
  const serverScripts: Record<string, ServerScriptEntry> = {};
  distHtml = extractServerScriptsToSidecar(
    distHtml,
    relativePagePath,
    serverScripts,
    pagePath,
  );
  // Compute the page's inline CSP hashes here, at the single defined point
  // where `distHtml` holds the page's final emitted representation. Both the
  // serial and worker paths carry these hashes onward; the main thread records
  // them (in `writeTranspiledPage`) without re-decoding the page.
  const cspHashes = computePageCspHashes(distHtml);

  const allUsedComponents = [...usedComponents, ...headUsedComponents];

  const pendingDeps = collectAllScriptDeps(rawHtml, pagePath);
  pause();
  const fileDependencies = await pendingDeps;
  resume();

  // Even on a "successful" transpile the page may reference a helper that does
  // not yet exist (e.g. the harness swallows the import failure). Track it so
  // creating the helper rebuilds the page; replace the page's prior set so
  // deps the page no longer references are reclaimed.
  const pendingMissingDeps = recordMissingScriptDeps(rawHtml, pagePath);
  pause();
  await pendingMissingDeps;
  resume();

  const seenDepComponents = new Set<string>();
  for (const comp of allUsedComponents) {
    if (seenDepComponents.has(comp.name)) continue;
    seenDepComponents.add(comp.name);
    const compContent = comp.scriptDependenciesContent ?? comp.fileContent;
    if (compContent) {
      const componentSourcePath = comp.fileName
        ? resolve(process.cwd(), comp.fileName)
        : undefined;
      const pendingCompDeps = collectAllScriptDeps(
        compContent,
        componentSourcePath,
      );
      pause();
      const compDeps = await pendingCompDeps;
      resume();
      for (const dep of compDeps) {
        if (!fileDependencies.includes(dep)) {
          fileDependencies.push(dep);
        }
      }
    }
  }

  if (BascikConfig.isBuild && !options?.deferDiskWrite) {
    const pendingWrite = writeTranspiledPage({
      relativePagePath,
      absolutePagePath: pagePath,
      distHtml,
      cspHashes,
    });
    pause();
    await pendingWrite;
    resume();
  }

  pause();

  if (BascikConfig.logging?.transpiles !== false) {
    const configLevel = BascikConfig.logging?.level ?? "info";
    if (shouldLog(configLevel, "info")) {
      console.log(
        `${colorOut.green("transpiled:")} ${relativePagePath} ${colorOut.dim(`in ${formatDuration(workMs)}`)}`,
      );
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
