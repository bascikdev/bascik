import {
  hasCompilationPublisher,
  publishTranspiled,
  trackCompilationWrite,
} from "./compilation-events.ts";
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
 * │  1. SCOPING PIPELINE  (scopeComponentInstance → runScopingPipeline)   │
 * │     Repeated inputs reuse a verified result (scoping-template.ts).    │
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

import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteDistFile, getRelativePath, listPages } from "./file-system.ts";
import { getHttpPath } from "./paths.ts";

import {
  componentsImportingStylesheet,
  invalidateComponentListCache,
  listComponents,
} from "./components.ts";
import { stampDirectiveSources } from "./directive-source.ts";
import { executeBuildScripts } from "./build-scripts.ts";
import { BUILD_ONCE_ATTR_NAME, OPEN_TAG_ATTRS } from "./html-patterns.ts";

import { stdout as colorOut, workerEnvironment } from "./colors.ts";
import { BascikConfig } from "./config.ts";
import { formatDuration } from "./format.ts";
import { logInfo } from "./log.ts";
import { mem } from "./mem.ts";
import { ownershipTracker } from "./ownership.ts";
import type { PageWorkerResult } from "./page-worker.ts";
import {
  executeRoutesScript,
  isDynamicRoute,
  resolveRoutePath,
} from "./routes.ts";
import { serverSidecarRegistry } from "./server-sidecar.ts";
import { generateSitemapFiles } from "./sitemap.ts";
import { filterPagesByOnlyGlobs } from "./targeted-build.ts";
import type {
  ComponentList,
  RouteEntry,
  TranspilePageResult,
} from "./types.ts";
import { WorkerPool } from "./worker-pool.ts";

import {
  PageProcessingError,
  normalizePageError,
  publishBuildError,
  reportComponentLoadFailure,
  reportPageErrors,
} from "./page-diagnostics.ts";
import { resolveInlineStylesHtml } from "./page-minification.ts";
import {
  transpilePage,
  writeTranspiledPage,
  type PageWriteInput,
} from "./page-transpile.ts";
export { recursivelyTranspile } from "./component-expansion.ts";
export {
  PageProcessingAggregateError,
  PageProcessingError,
  findActiveSourceFile,
  getDisplayPath,
  getFilePosition,
} from "./page-diagnostics.ts";
export {
  appendSourceUrl,
  resolveInlineStylesHtml,
  splitTrailingSourceUrl,
} from "./page-minification.ts";
export { transpilePage } from "./page-transpile.ts";

export interface PageJob {
  pagePath: string;
  route: RouteEntry | null;
  relativePagePath: string;
  preCleanedHtml?: string;
  /** `preCleanedHtml` with its build-once scripts already run, shared by every route. */
  onceResolvedHtml?: string;
}

// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const BUILD_ONCE_SCRIPT_RE = new RegExp(
  String.raw`<script\b${OPEN_TAG_ATTRS}\s${BUILD_ONCE_ATTR_NAME}`,
  "i",
);

/**
 * Loads every component for a batch of pages. A failure is reported to the browser and then rethrown, so
 * callers still see it: dev boot must keep failing hard on a broken component.
 *
 * `transpilePage` has its own `listComponents()` call and does not use this. Its callers publish the error
 * themselves (`pageProcessing` reports every failure), so using it there would report each one twice.
 */
const loadComponentList = async () => {
  try {
    return await listComponents();
  } catch (error) {
    reportComponentLoadFailure(error);
    throw error;
  }
};

export const templateToGeneratedRelativePaths = new Map<string, Set<string>>();

export const clearTemplateRoutesCache = (): void => {
  templateToGeneratedRelativePaths.clear();
};

export const expandPageToJobs = async (
  pagePath: string,
): Promise<PageJob[]> => {
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
    rawHtml = stampDirectiveSources(
      (await readFile(pagePath)).toString(),
      pagePath,
    );
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
        await deleteDistFile(staleRel).catch(() => {});
      }
      templateToGeneratedRelativePaths.delete(pagePath);
    }
    // Prompt 101: a template that now emits zero routes is an authoritative
    // rebuild of that owner with an empty output set, so a fresh targeted build
    // prunes its prior outputs. Only in build mode where ownership applies.
    if (BascikConfig.isBuild) {
      ownershipTracker.recordOwner(
        pagePath,
        getRelativePath(pagePath, "pages"),
      );
    }
    return [];
  }

  const currentGenerated = new Set<string>();
  const jobs: PageJob[] = [];
  const baseRelativePath = getRelativePath(pagePath, "pages");
  // Build-once output has no route context, so it is the same for every route:
  // run it here, once per template, instead of once per generated page.
  const onceResolvedHtml = BUILD_ONCE_SCRIPT_RE.test(result.cleanedHtml)
    ? await executeBuildScripts(result.cleanedHtml, pagePath, null, {
        once: true,
      })
    : undefined;

  for (const route of result.routes) {
    const relativePagePath = resolveRoutePath(baseRelativePath, route.params);
    currentGenerated.add(relativePagePath);
    jobs.push({
      pagePath,
      route,
      relativePagePath,
      preCleanedHtml: result.cleanedHtml,
      onceResolvedHtml,
    });
  }

  const prevGenerated = templateToGeneratedRelativePaths.get(pagePath);
  if (prevGenerated) {
    for (const oldRel of prevGenerated) {
      if (!currentGenerated.has(oldRel)) {
        if (!BascikConfig.isBuild) mem.removeByRelativePath(oldRel);
        await deleteDistFile(oldRel).catch(() => {});
      }
    }
  }
  templateToGeneratedRelativePaths.set(pagePath, currentGenerated);

  return jobs;
};

/** The route of a page with any trailing slash removed, so `/blog/` and `/blog` compare equal. */
const stripTrailingRouteSlash = (route: string): string =>
  route.replace(/\/$/, "") || "/";

const pageRoute = (item: string | PageJob): string =>
  stripTrailingRouteSlash(
    getHttpPath(
      typeof item === "string"
        ? getRelativePath(item, "pages")
        : item.relativePagePath,
    ),
  );

/** Partitions page paths or PageJobs into [openPages, otherPages] by active SSE connections. */
export const partitionByOpenPages = (
  pageList: (string | PageJob)[],
): [(string | PageJob)[], (string | PageJob)[]] => {
  const openSet = new Set(mem.openPages);
  if (openSet.size === 0) return [[], pageList];
  const openNormalizedSet = new Set([...openSet].map(stripTrailingRouteSlash));
  const open: (string | PageJob)[] = [];
  const rest: (string | PageJob)[] = [];
  for (const item of pageList) {
    (openNormalizedSet.has(pageRoute(item)) ? open : rest).push(item);
  }
  return [open, rest];
};

/**
 * Splits pages into [open, home, rest] for a dev batch. The pages open in a
 * browser come first, then the home page (`/`), which is the page most often
 * opened next. A build keeps its input order, so build output never depends on
 * this.
 */
const partitionByCompilePriority = <T extends string | PageJob>(
  pageList: T[],
): [T[], T[], T[]] => {
  const [open, rest] = partitionByOpenPages(pageList) as [T[], T[]];
  if (BascikConfig.isBuild) return [open, [], rest];
  const homeIndex = rest.findIndex((item) => pageRoute(item) === "/");
  if (homeIndex < 0) return [open, [], rest];
  return [
    open,
    [rest[homeIndex]],
    [...rest.slice(0, homeIndex), ...rest.slice(homeIndex + 1)],
  ];
};

/**
 * A queue that picks each next page when a worker asks for it, not once up
 * front. A browser that connects while a long batch is already running (a tab
 * reconnecting after a restart) therefore still jumps ahead of the pages that
 * have not started. Order: pages open in a browser, then the home page, then
 * the remaining pages in their original order. A build keeps its input order.
 */
const createCompileQueue = <T extends string | PageJob>(items: T[]) => {
  const entries = items.map((item) => ({ item, route: pageRoute(item) }));
  let homeRemains =
    !BascikConfig.isBuild && entries.some((entry) => entry.route === "/");
  return {
    next(): T | undefined {
      if (entries.length === 0) return undefined;
      let index = -1;
      const open = mem.openPages;
      if (open.length > 0) {
        const openRoutes = new Set(open.map(stripTrailingRouteSlash));
        index = entries.findIndex((entry) => openRoutes.has(entry.route));
      }
      if (index < 0 && homeRemains) {
        index = entries.findIndex((entry) => entry.route === "/");
        if (index < 0) homeRemains = false;
      }
      const [picked] = entries.splice(index < 0 ? 0 : index, 1);
      if (picked.route === "/") homeRemains = false;
      return picked.item;
    },
  };
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

const isCurrentGeneration = (
  absolutePagePath: string,
  generation: number,
): boolean =>
  (pageGenerations.get(pageGenKey(absolutePagePath)) ?? 0) === generation;

// Marks a page deleted so any late in-flight work cannot resurrect it. The next
// enqueue claims a fresh generation above the deleted one.
const bumpPageGeneration = (absolutePagePath: string): void => {
  const key = pageGenKey(absolutePagePath);
  pageGenerations.set(key, (pageGenerations.get(key) ?? 0) + 1);
};

const queueTranspiledPageWrite = (result: PageWriteInput): Promise<void> => {
  const pagePath = result.absolutePagePath;
  const current = pageProcessingQueues.get(pagePath) ?? Promise.resolve();
  const queued = current
    .catch(() => {})
    .then(async () => {
      // Never publish a stale generation to disk: a newer edit may already be
      // in flight, and its content must win regardless of completion order.
      // (The queue is dev-only, so a generation is always present here.)
      if (
        result.generation === undefined ||
        !isCurrentGeneration(pagePath, result.generation)
      ) {
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

/**
 * Join every queued dev page write for one page.
 *
 * The `transpiled` event is published as soon as the page is in the memory
 * store, before the queued disk write runs. A caller that needs the on-disk
 * bytes to be final (a test asserting exact `dist/` content, or a shutdown that
 * must not truncate a write) awaits this rather than assuming publication
 * implies a finished write. Resolves immediately when nothing is queued.
 *
 * A queued write can chain a successor while we await, so drain until the queue
 * for this page is empty instead of awaiting a single snapshot.
 */
export const pageWriteIdle = async (
  absolutePagePath: string,
): Promise<void> => {
  const key = pageGenKey(absolutePagePath);
  const pendingForPage = (): Promise<unknown>[] =>
    [...pageProcessingQueues.entries()]
      .filter(([queuedPath]) => pageGenKey(queuedPath) === key)
      .map(([, write]) => write);
  for (
    let writes = pendingForPage();
    writes.length;
    writes = pendingForPage()
  ) {
    await Promise.all(writes);
  }
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

  if (!componentList) componentList = await loadComponentList();
  if (globalStylesHtml === undefined)
    globalStylesHtml = await resolveInlineStylesHtml();

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
            new Error(
              `Route conflict: "${existing}" and "${input.pagePath}" both produce output path "${input.relativePagePath}".`,
            ),
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

  const [openJobs, homeJobs, restJobs] = partitionByCompilePriority(jobs);

  const results: (TranspilePageResult | null)[] = [];

  const runJob = async (job: PageJob) => {
    const generation = pagesClaimed.get(job.pagePath)!;
    const result = await transpilePage(
      job.pagePath,
      componentList!,
      globalStylesHtml!,
      job.route,
      job.preCleanedHtml,
      { onceResolvedHtml: job.onceResolvedHtml },
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
    const batchResults = await Promise.all(
      batch.map(async (job) => {
        try {
          return await runJob(job);
        } catch (error) {
          pageErrors.push(normalizePageError(job.pagePath, error));
          return null;
        }
      }),
    );
    for (const result of batchResults) {
      if (result) results.push(result);
    }
  };

  // Transpile open pages first, store in memory, and emit transpiled reload event IMMEDIATELY.
  if (openJobs.length > 0) {
    await runJobs(openJobs);
  }

  // The home page is the page most likely to be opened next.
  if (homeJobs.length > 0) {
    await runJobs(homeJobs);
  }

  // Transpile remaining (closed) pages afterwards
  if (restJobs.length > 0) {
    await runJobs(restJobs);
  }

  reportPageErrors(pageErrors);

  return results
    .map((r) => r?.relativePagePath ?? null)
    .filter((p): p is string => p !== null);
};

export const selectivelyProcessPagesForWatchPath = async (
  changedPath?: string,
): Promise<void> => {
  invalidateComponentListCache();
  const [pages, componentList, globalStylesHtml] = await Promise.all([
    listPages(),
    loadComponentList(),
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

/** Pages that use a component whose stylesheet imports `path`, as of the last component listing. */
export const pagesImportingStylesheet = (path: string): string[] => [
  ...new Set(
    componentsImportingStylesheet(path).flatMap((name) =>
      mem.pagesThisComponentIsUsedOn(name),
    ),
  ),
];

/**
 * Rebuild the pages that use a component whose stylesheet imports `path`, for a
 * file that is not otherwise a page or component input (a stylesheet under the
 * pages directory). Does nothing when no component imports it.
 */
export const processPagesImportingStylesheet = async (
  path: string,
): Promise<void> => {
  const pagesToTranspile = pagesImportingStylesheet(path);
  if (pagesToTranspile.length === 0) return;
  invalidateComponentListCache();
  await processPageBatch(pagesToTranspile);
};

export const selectivelyProcessPages = async (path: string): Promise<void> => {
  invalidateComponentListCache();
  const rawFileName = basename(path);
  if (!rawFileName || rawFileName.startsWith(".")) return;
  const componentName = rawFileName.split(".")[0].toLowerCase();
  if (!componentName) return;
  // A stylesheet that is not itself a component's companion still reaches the
  // pages of every component that imports it.
  const pagesToTranspile = [
    ...new Set([
      ...mem.pagesThisComponentIsUsedOn(componentName),
      ...pagesImportingStylesheet(path),
    ]),
  ];
  // Enter the batch immediately so it claims each affected page generation at
  // the component event boundary. Loading components and global styles inside
  // processPageBatch happens only after those claims. Otherwise a newer direct
  // page event can enqueue while these prerequisites load, then be incorrectly
  // superseded when this older component rebuild claims its generation late.
  await processPageBatch(pagesToTranspile);
};

export const processAllPages = async (options?: { useWorkers?: boolean }) => {
  logInfo(colorOut.dim("Starting transpiling..."));
  invalidateComponentListCache();
  const useWorkers =
    options?.useWorkers ?? BascikConfig.pipeline?.workers ?? false;
  const start = performance.now();
  // Parallel processing of pages
  const [pages, componentList, globalStylesHtml] = await Promise.all([
    listPages(),
    loadComponentList(),
    resolveInlineStylesHtml(),
  ]);
  let pageList = pages ?? [];

  if (
    BascikConfig.isBuild &&
    BascikConfig.only &&
    BascikConfig.only.length > 0
  ) {
    pageList = filterPagesByOnlyGlobs(
      pageList,
      BascikConfig.only,
      BascikConfig.directory.pages,
    );
  }

  let relativePaths: string[] = [];

  const expansionErrors: PageProcessingError[] = [];
  const jobBatches = await Promise.all(
    pageList.map(async (pagePath) => {
      try {
        return await expandPageToJobs(pagePath);
      } catch (error) {
        expansionErrors.push(
          normalizePageError(pagePath, error, "expand routes"),
        );
        return [];
      }
    }),
  );
  const allJobs = jobBatches.flat();

  if (useWorkers && allJobs.length > 0) {
    const workerExt = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const workerUrl = new URL(`./page-worker${workerExt}`, import.meta.url);
    const poolSize = Math.min(cpus().length, allJobs.length);
    const pool = new WorkerPool<PageJob, PageWorkerResult | null>(
      fileURLToPath(workerUrl),
      poolSize,
      { componentList, globalStylesHtml },
      // The `transpiled:` line is printed inside the worker, which cannot tell on its own that it has a terminal.
      { env: workerEnvironment() },
    );
    const [openJobs, restJobs] = partitionByOpenPages(allJobs) as [
      PageJob[],
      PageJob[],
    ];
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
        pagesClaimed.set(
          job.pagePath,
          pageGenerations.get(pageGenKey(job.pagePath)) ?? 0,
        );
      }
    }

    // Apply main-thread side effects for one worker result. The page bytes
    // arrived as a transferred ArrayBuffer (prompt 86); wrap them in a Buffer
    // view (no copy) and hand that view to the store and the disk writer.
    // Nothing on this path needs the HTML as a string.
    const runWorkerJob = async (
      job: PageJob,
    ): Promise<PageWorkerResult | null> => {
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
          const pageBytes = Buffer.from(
            distHtmlBytes.buffer,
            distHtmlBytes.byteOffset,
            distHtmlBytes.byteLength,
          );
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
        pageErrors.push(
          normalizePageError(job.pagePath, error, "worker transpile"),
        );
        return null;
      }
    };

    try {
      // Pages already open in a browser finish first, so their reload is not
      // delayed by anything else.
      if (openJobs.length > 0) {
        for (const result of await Promise.all(openJobs.map(runWorkerJob))) {
          if (result) results.push(result);
        }
      }

      // Each lane takes its next page from the queue only when it is free, so
      // the home page is picked before the rest, and a page opened after this
      // batch started still jumps ahead of every page that has not begun. Two
      // jobs per worker keep each worker busy while the main thread stores the
      // previous result.
      const compileQueue = createCompileQueue(restJobs);
      const lanes = Math.min(restJobs.length, poolSize * 2);
      await Promise.all(
        Array.from({ length: lanes }, async () => {
          for (let job = compileQueue.next(); job; job = compileQueue.next()) {
            const result = await runWorkerJob(job);
            if (result) results.push(result);
          }
        }),
      );

      reportPageErrors(pageErrors);
    } finally {
      // Always terminate — otherwise a rejected job leaves worker threads
      // alive and the CLI hangs on exit instead of reporting the failure.
      await pool.terminate();
    }

    relativePaths = results
      .map((r) => r?.relativePagePath ?? null)
      .filter((p): p is string => p !== null);
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
    `\n${colorOut.green(`✓ ${count} page${count !== 1 ? "s" : ""} transpiled`)} in ${colorOut.bold(formatDuration(elapsed))}`,
  );

  if (
    !useWorkers &&
    !BascikConfig.isBuild &&
    elapsed >= 2000 &&
    allJobs.length >= 20 &&
    cpus().length >= 4
  ) {
    logInfo(
      colorOut.yellow(
        `💡 Boot transpilation took ${formatDuration(elapsed)} on a single thread. Consider setting pipeline.workers: true in bascik.config.ts to parallelize across CPU cores.`,
      ),
    );
  }

  return relativePaths;
};

export const pageProcessing = (
  pagePath: string,
  componentList?: ComponentList,
  globalStylesHtml?: string,
): Promise<string | undefined> => {
  // Claim this direct source edit when it is enqueued, before it waits on an
  // older page write or reads source. A broad component rebuild that was
  // observed earlier must not claim ownership after this newer page event and
  // publish stale source over it merely because the direct job was queued.
  const generation = nextPageGeneration(pagePath);
  const current = pageProcessingQueues.get(pagePath) ?? Promise.resolve();
  let resolveAvailable!: (relativePagePath: string | undefined) => void;
  let rejectAvailable!: (error: unknown) => void;
  const available = new Promise<string | undefined>(
    (resolvePromise, rejectPromise) => {
      resolveAvailable = resolvePromise;
      rejectAvailable = rejectPromise;
    },
  );
  const next = current
    .catch(() => {})
    .then(async () => {
      try {
        if (!isDynamicRoute(pagePath)) {
          const result = await transpilePage(
            pagePath,
            componentList,
            globalStylesHtml,
          );
          if (!result) {
            resolveAvailable(undefined);
            return undefined;
          }
          if (isCurrentGeneration(pagePath, generation)) {
            const {
              relativePagePath,
              absolutePagePath,
              distHtml,
              usedComponentsNames,
              fileDependencies,
              cspHashes,
            } = result;
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
        const relativePaths = await processPageBatch(
          jobs,
          componentList,
          globalStylesHtml,
        );
        resolveAvailable(relativePaths[0]);
        return relativePaths[0];
      } catch (error) {
        if (!BascikConfig.isBuild) {
          publishBuildError(normalizePageError(pagePath, error));
        }
        rejectAvailable(error);
        throw error;
      }
    })
    .finally(() => {
      if (pageProcessingQueues.get(pagePath) === next) {
        pageProcessingQueues.delete(pagePath);
      }
    });
  pageProcessingQueues.set(pagePath, next);
  void next.catch(() => {});
  return available;
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
