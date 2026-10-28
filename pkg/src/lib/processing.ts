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
  componentsHaveBuildScripts,
  componentsImportingStylesheet,
  invalidateComponentListCache,
  listComponents,
} from "./components.ts";
import { stampDirectiveSources } from "./directive-source.ts";
import { executeBuildScripts } from "./build-scripts.ts";
import { BUILD_ONCE_ATTR_NAME, OPEN_TAG_ATTRS } from "./html-patterns.ts";

import { stdout as colorOut, workerEnvironment } from "./colors.ts";
import { BascikConfig } from "./config.ts";
import {
  addBuildScriptStats,
  createBuildScriptStats,
  formatBuildScriptSummary,
  type BuildScriptStats,
} from "./build-script-stats.ts";
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
import {
  CHILD_WORKER_COUNT_VAR,
  SYSTEM_MAX_CHILD_PROCESSES,
} from "./script-runner.ts";
import {
  serverSidecarRegistry,
  sidecarHasPageEntries,
} from "./server-sidecar.ts";
import {
  pageHasServerScripts,
  sourceHasServerScripts,
} from "./server-scripts.ts";
import {
  buildComponentManifest,
  startComponentManifest,
  type ComponentManifest,
} from "./component-manifest.ts";
import { loadComponentJobs } from "./request-render-node.ts";
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

/**
 * Whether any page's own source has a server or stream script element, so
 * the build can start the manifest before any page has compiled. A page
 * whose server script comes from a component or a build script is caught by
 * {@link startManifestForServerPage} when its result lands. A false positive
 * (an element inside a comment) costs a manifest that is never taken, so it
 * never prints. Never rejects.
 */
const pageSourcesHaveServerScripts = async (
  pagePaths: string[],
): Promise<boolean> => {
  const found = await Promise.all(
    pagePaths.map(async (pagePath) =>
      sourceHasServerScripts(await readFile(pagePath, "utf8").catch(() => "")),
    ),
  );
  return found.includes(true);
};

/**
 * A build page with a server or stream script makes the site need a
 * component manifest (prompt 157, D1): start it now, beside the pages still
 * compiling, rather than after them. The build collects it when it writes
 * its metadata, and its output is held until then.
 */
const startManifestForServerPage = (
  scripts: Record<string, unknown> | undefined,
  componentList: ComponentList,
): void => {
  if (BascikConfig.isBuild && sidecarHasPageEntries(scripts))
    startComponentManifest(componentList, BascikConfig);
};

// ─── Dev component manifest (prompt 157, D6) ─────────────────────────────────
//
// In dev the request-time renderer needs the same manifest `--build` writes to
// dist/.bascik/components.json, built from the component list of the
// publication that stored the page and attached to the page by reference, so
// a request always renders with the manifest its page was built against and
// never a mix of two component versions. Memoized on the ComponentList object:
// one build per publication (every page of a batch shares the list object),
// and a selective batch under an unchanged list reuses it. Built lazily, on
// the first page with a server or stream script, so a site without one never
// runs the component build scripts twice, and a static page is stored without
// waiting for it. The build stages every component server/stream script in
// `serverSidecarRegistry` under its `component_script_*` id as a side effect,
// which is how a request-rendered instance's nested job resolves.
const devComponentManifests = new WeakMap<
  ComponentList,
  Promise<ComponentManifest>
>();

const devComponentManifest = (
  componentList: ComponentList,
  { early = false }: { early?: boolean } = {},
): Promise<ComponentManifest> => {
  let pending = devComponentManifests.get(componentList);
  if (pending && !early) {
    // Started early, before any page asked: a failure is reported to the
    // first page that does, then retried, as a build started by it would be.
    const started = pending;
    started.catch(() => {
      if (devComponentManifests.get(componentList) === started)
        devComponentManifests.delete(componentList);
    });
  }
  if (!pending) {
    // The jobs are resolved from the registry as soon as the build staged
    // them: the ids are stable across versions (name::ordinal) and the next
    // publication re-stages them in the same registry, so a manifest first
    // used after that would pair this template with the next script.
    pending = buildComponentManifest(componentList, BascikConfig).then(
      (manifest) => {
        loadComponentJobs(manifest);
        return manifest;
      },
    );
    devComponentManifests.set(componentList, pending);
    // A failed build is not kept: the next publication retries and reports
    // it again instead of serving pages against a rejection forever. One
    // started early is kept until a page has been told (above).
    const started = pending;
    started.catch(() => {
      if (!early && devComponentManifests.get(componentList) === started)
        devComponentManifests.delete(componentList);
    });
  }
  return pending;
};

/**
 * The manifest to store with a dev page: the publication's manifest when the
 * page carries a server or stream script, nothing otherwise (a static page
 * never renders at request time, so it never waits for the build). Decided
 * exactly, as the stored page's plan is: a page that only mentions the
 * attribute in its text (the docs) builds no manifest.
 */
const devManifestForPage = async (
  componentList: ComponentList,
  html: string | Buffer,
): Promise<ComponentManifest | undefined> =>
  pageHasServerScripts(html)
    ? await devComponentManifest(componentList)
    : undefined;

/**
 * `pages` plus every stored page with a server-script plan (prompt 157, D6).
 * Such a page renders component tags from its scripts' output with the
 * manifest of the component list it was stored against, and no page depends
 * on a component it only meets in script output, so a component input change
 * (a component file, a stylesheet a component imports) rebuilds them all
 * (open or not: a tab opened later must not render the old component); the
 * rebuild re-stores each with the next manifest and reloads its open tabs
 * like any rebuilt page. So does a watched-path edit when some component has
 * a build script: that script may read the edited file, and only the
 * manifest build ran it for a component met in script output.
 */
const withRequestRenderedPages = (pages: string[]): string[] => [
  ...new Set([...pages, ...mem.pagesWithServerScriptPlan()]),
];

export const templateToGeneratedRelativePaths = new Map<string, Set<string>>();

export const clearTemplateRoutesCache = (): void => {
  templateToGeneratedRelativePaths.clear();
};

export const expandPageToJobs = async (
  pagePath: string,
  scriptStats?: BuildScriptStats,
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
        stats: scriptStats,
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
  /** Receives every page's build-script counts, for the boot summary line. */
  scriptStats?: BuildScriptStats,
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
    if (result?.buildScripts && scriptStats)
      addBuildScriptStats(scriptStats, result.buildScripts);
    if (result && isCurrentGeneration(job.pagePath, generation)) {
      if (result.serverScripts) {
        serverSidecarRegistry.recordScripts(result.serverScripts);
        startManifestForServerPage(result.serverScripts, componentList!);
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
          componentManifest: await devManifestForPage(
            componentList!,
            result.distHtml,
          ),
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

  // The remaining pages are drained through the same pick-time queue as the
  // worker path, not started all at once: each lane takes its next page only
  // when it is free, so a tab that connects while this batch is running (the
  // single-thread boot, and every component or stylesheet rebuild regardless
  // of `pipeline.workers`) still jumps ahead of the pages that have not begun.
  // Real parallelism is already bounded by the build-script child semaphore;
  // two lanes per core keep every permit busy while a lane is between
  // scripts, so throughput matches the previous all-at-once start. Results
  // are kept in input order, not completion order, so a build's output never
  // depends on which lane finished first.
  if (restJobs.length > 0) {
    const restResults: (TranspilePageResult | null)[] = restJobs.map(
      () => null,
    );
    const restIndex = new Map(restJobs.map((job, index) => [job, index]));
    const compileQueue = createCompileQueue(restJobs);
    const lanes = Math.min(restJobs.length, Math.max(1, cpus().length) * 2);
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        for (let job = compileQueue.next(); job; job = compileQueue.next()) {
          try {
            restResults[restIndex.get(job)!] = await runJob(job);
          } catch (error) {
            pageErrors.push(normalizePageError(job.pagePath, error));
          }
        }
      }),
    );
    for (const result of restResults) {
      if (result) results.push(result);
    }
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
      // The component list was invalidated above; a component build script
      // may read the edited file, and for a component met only in script
      // output only the manifest build ran it (D6, as in watch-source.ts).
      pagesToProcess = componentsHaveBuildScripts()
        ? withRequestRenderedPages(dependentPages)
        : dependentPages;
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
  await processPageBatch(withRequestRenderedPages(pagesToTranspile));
};

export const selectivelyProcessPages = async (path: string): Promise<void> => {
  invalidateComponentListCache();
  const rawFileName = basename(path);
  if (!rawFileName || rawFileName.startsWith(".")) return;
  const componentName = rawFileName.split(".")[0].toLowerCase();
  if (!componentName) return;
  // A stylesheet that is not itself a component's companion still reaches the
  // pages of every component that imports it.
  const pagesToTranspile = withRequestRenderedPages([
    ...mem.pagesThisComponentIsUsedOn(componentName),
    ...pagesImportingStylesheet(path),
  ]);
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
  // Summed from every page (and the build-once pass of every route template)
  // so the summary can say how much of the phase was build scripts.
  const scriptStats = createBuildScriptStats();
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

  // Read now, acted on once the pages are handed out: the manifest's own
  // work then fills the time the main thread waits on the page workers
  // instead of delaying them.
  const sourcesNeedManifest = pageSourcesHaveServerScripts(pageList);
  const startManifestFromSources = () =>
    void sourcesNeedManifest.then((needed) => {
      if (!needed) return;
      if (BascikConfig.isBuild)
        startComponentManifest(componentList, BascikConfig);
      // Dev: the publication's manifest, which the first server page stored
      // would otherwise start; its failure is reported to that page.
      else devComponentManifest(componentList, { early: true }).catch(() => {});
    });

  let relativePaths: string[] = [];

  const expansionErrors: PageProcessingError[] = [];
  const jobBatches = await Promise.all(
    pageList.map(async (pagePath) => {
      try {
        return await expandPageToJobs(pagePath, scriptStats);
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
    // Every worker thread runs its own child semaphore sized to 1/poolSize of
    // the system child budget, floored at 1 permit. Keeping the pool within
    // that budget (memory-derived, or `BASCIK_MAX_CHILD_PROCESSES`) is what
    // stops a low-memory machine from running cpus().length children at once:
    // with more workers than permits the floor would give each one a child
    // anyway.
    const poolSize = Math.min(
      cpus().length,
      allJobs.length,
      SYSTEM_MAX_CHILD_PROCESSES,
    );
    const pool = new WorkerPool<PageJob, PageWorkerResult | null>(
      fileURLToPath(workerUrl),
      poolSize,
      { componentList, globalStylesHtml },
      {
        env: {
          // The `transpiled:` line is printed inside the worker, which cannot tell on its own that it has a terminal.
          ...(workerEnvironment() ?? process.env),
          [CHILD_WORKER_COUNT_VAR]: String(poolSize),
        },
      },
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
        // The worker counted its own scripts; the summary is printed here.
        if (result?.buildScripts)
          addBuildScriptStats(scriptStats, result.buildScripts);
        if (result && isCurrentGeneration(job.pagePath, generation)) {
          if (result.serverScripts) {
            serverSidecarRegistry.recordScripts(result.serverScripts);
            startManifestForServerPage(result.serverScripts, componentList);
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
              componentManifest: await devManifestForPage(
                componentList,
                pageBytes,
              ),
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
      const compiled = Promise.all(
        Array.from({ length: lanes }, async () => {
          for (let job = compileQueue.next(); job; job = compileQueue.next()) {
            const result = await runWorkerJob(job);
            if (result) results.push(result);
          }
        }),
      );
      startManifestFromSources();
      await compiled;

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
    startManifestFromSources();
    relativePaths = await processPageBatch(
      allJobs,
      componentList,
      globalStylesHtml,
      expansionErrors,
      scriptStats,
    );
  }

  const count = relativePaths.length;
  const elapsed = performance.now() - start;

  if (BascikConfig.isBuild) {
    await generateSitemapFiles(relativePaths);
  }

  // The wall time covers every build-script child process, which no page line
  // includes, so the counts after it are what explain a long phase: all ran
  // means a cold cache (the first dev boot after a build, or a shared helper
  // edited), all cached means the time went elsewhere. Painted only when
  // present: `styleText` wraps even an empty string in escape codes on a TTY.
  const scriptSummary = formatBuildScriptSummary(scriptStats);
  console.log(
    `\n${colorOut.green(`✓ ${count} page${count !== 1 ? "s" : ""} transpiled`)} in ${colorOut.bold(formatDuration(elapsed))}${scriptSummary ? colorOut.dim(scriptSummary) : ""}`,
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
          // Resolved here rather than inside transpilePage so the dev
          // manifest (prompt 157) is built from the same list object the
          // page is; a failure reaches the same catch below either way.
          if (!componentList) componentList = await listComponents();
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
                componentManifest: await devManifestForPage(
                  componentList,
                  distHtml,
                ),
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
