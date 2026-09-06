import { existsSync } from "node:fs";
import chokidar from "chokidar";
import type { Stats } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  pageProcessing,
  processAllPages,
  processPageBatch,
  removePage,
  selectivelyProcessPages,
  selectivelyProcessPagesForWatchPath,
} from "./processing.ts";
import {
  copyReplicatePath,
  copyStaticAssets,
  deleteDistDir,
  deleteDistFile,
} from "./file-system.ts";
import { isInlineStylesheet, isStaticAssetPath } from "./asset-filter.ts";
import { clearBuildScriptCaches } from "./build-scripts.ts";
import { invalidateComponentListCache } from "./components.ts";
import { BascikConfig, shouldLog } from "./config.ts";
import { eventEmitter, registerShutdownHandler } from "./events.ts";
import { apiRouteRegistry } from "./server-api.ts";
import { scriptRegistry } from "./script-registry.ts";
import { mem } from "./mem.ts";
import { getImportRoot } from "./import-root.ts";
import {
  registerExecConsumerFlush,
  setExecProducerWatchGlobs,
  execProducerCovers,
} from "./exec-publication.ts";
import { execWatchCoversPath } from "./exec.ts";
import type { ExecEntry } from "./types.ts";

export const watchFiles = async () => {
  if (BascikConfig.isBuild) {
    await Promise.all([copyStaticAssets(), processAllPages()]);
    return;
  }

  const onWatchError = (err: unknown) => console.error("[bascik] watch error:", err);
  const logInfo = (message: string): void => {
    if (shouldLog(BascikConfig.logging?.level, "info")) console.log(message);
  };
  // Request-time modules (`src=` server scripts, their helpers, API routes)
  // are imported by the runtime registry, not by the build, so the page
  // dependency graph knows nothing about them. Any file event under a watched
  // source root therefore advances the runtime identity first; the registry
  // ignores identities it never loaded, so this costs nothing for other files.
  const invalidateRuntimeModule = (path: string): void => {
    if (scriptRegistry.invalidate(path)) {
      logInfo(`[bascik] module invalidated: ${relative(process.cwd(), path).replace(/\\/g, "/")}`);
    }
  };
  const watchers: ReturnType<typeof chokidar.watch>[] = [];
  const w = <T extends ReturnType<typeof chokidar.watch>>(watcher: T) => { watchers.push(watcher); return watcher; };
  registerShutdownHandler(() => Promise.all(watchers.map(watcher => watcher.close())).then(() => { }));

  const watchOptions: NonNullable<Parameters<typeof chokidar.watch>[1]> = {
    atomic: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 20,
    },
    followSymlinks: false,
    persistent: !BascikConfig.isBuild,
  };

  // Copy non-page files
  w(chokidar
    .watch([BascikConfig.directory.pages], {
      ...watchOptions,
      ignored: (path: string, stats?: Stats): boolean =>
        !!(stats?.isFile() && !isInlineStylesheet(path) && !isStaticAssetPath(path)),
      ignoreInitial: true,
      persistent: !BascikConfig.isBuild,
    })
    .on("add", async (path) => {
      try {
        if (isInlineStylesheet(path)) {
          if (!BascikConfig.isBuild) {
            await processAllPages();
          }
        } else {
          await copyReplicatePath(path, BascikConfig.directory.out);
          if (!BascikConfig.isBuild) {
            eventEmitter.emit("asset-changed");
          }
        }
      } catch (err) { onWatchError(err); }
    })
    .on("change", async (path) => {
      try {
        if (isInlineStylesheet(path)) {
          if (!BascikConfig.isBuild) {
            await processAllPages();
          }
        } else {
          await copyReplicatePath(path, BascikConfig.directory.out);
          // Reload any currently-open page when a static asset changes
          if (!BascikConfig.isBuild) {
            eventEmitter.emit("asset-changed");
          }
        }
      } catch (err) { onWatchError(err); }
    })
    .on("unlink", (path) => {
      const operation = isInlineStylesheet(path)
        ? processAllPages()
        : deleteDistFile(path);
      operation.catch(onWatchError);
    })
    .on("unlinkDir", (path) => deleteDistDir(path).catch(onWatchError)));

  // Transpile pages as they change
  let initialScanDone = false;
  await new Promise<void>((resolve, reject) => {
    w(chokidar
      .watch([BascikConfig.directory.pages], {
        ...watchOptions,
        // only watch html files
        ignored: (path: string, stats?: Stats): boolean =>
          !!(stats?.isFile() && !path.endsWith(".html")),
        persistent: !BascikConfig.isBuild,
      })
      .on("add", (_path) => {
        if (initialScanDone) processAllPages().catch(onWatchError);
      })
      .on("change", (path) => pageProcessing(path).catch(onWatchError))
      .on("unlink", (path: string, _stats?: Stats) => {
        removePage(path).then(() => processAllPages()).catch(onWatchError);
      })
      .on("unlinkDir", (path: string, _stats?: Stats) => deleteDistDir(path).catch(onWatchError))
      .on("ready", () => {
        initialScanDone = true;
        Promise.all([copyStaticAssets(), processAllPages()]).then(() => resolve()).catch(reject);
      }));
  });

  // Transpile pages if components change. Every configured root is watched;
  // symlinks are followed here (and only here) so a linked shared directory
  // inside a root triggers rebuilds. Chokidar reports link paths, which is
  // what selectivelyProcessPages expects.
  w(chokidar
    .watch([...BascikConfig.directory.components], {
      ...watchOptions,
      followSymlinks: true,
      ignored: (path: string, stats?: Stats): boolean => {
        return !!(
          stats?.isFile() && !(path.endsWith(".html") || path.endsWith(".css") || path.endsWith(".js") || path.endsWith(".ts") || path.endsWith(".mjs"))
        );
      },
      ignoreInitial: true,
      persistent: !BascikConfig.isBuild,
    })
    // If you add a component, how will we know what pages to update unless we go and look
    .on("add", async (path) => {
      invalidateRuntimeModule(path);
      clearBuildScriptCaches(path);
      processAllPages().catch(onWatchError);
    })
    // For changes and deletion of components we can be selective
    .on("change", async (path) => {
      invalidateRuntimeModule(path);
      clearBuildScriptCaches(path);
      selectivelyProcessPages(path).catch(onWatchError);
    })
    .on("unlink", async (path) => {
      invalidateRuntimeModule(path);
      clearBuildScriptCaches(path);
      selectivelyProcessPages(path).catch(onWatchError);
    }));

  // Re-transpile all pages when user-specified extra paths change (dev only).
  // A path covered by both `pipeline.watchPaths` and an `exec[].watch` glob is
  // an overlap contract: the exec producer must finish BEFORE the consumer
  // pages re-transpile, otherwise the page compiles against a previous
  // generation. watch.ts registers the consumer flush with the exec
  // publication coordinator and defers overlapped edits to it, so the producer
  // completes first and the coordinator recompiles exactly once.
  const watchPaths = BascikConfig.pipeline?.watchPaths ?? [];
  if (!BascikConfig.isBuild && watchPaths.length) {
    const producerWatchEntries = ((BascikConfig.pipeline?.exec ?? []) as ExecEntry[]).filter(
      (entry) => !!entry.watch,
    );
    setExecProducerWatchGlobs(
      producerWatchEntries.map((entry) =>
        Array.isArray(entry.watch) ? entry.watch : [entry.watch as string],
      ),
    );

    // Consumer recompile for a producer completion: hand every changed path to
    // selectivelyProcessPagesForWatchPath, which re-transpiles only the pages
    // that depend on the produced output (all pages when none tie to it).
    // A producer may have rewritten consumed outputs that the cache key reads
    // via its dependency graph (e.g. `dist/generated.json`); clearing the
    // build-script cache ensures the re-transpiled page re-runs its build
    // script against the freshly produced bytes instead of a stale output.
    // This invalidates a changed input; it does not disable caching.
    registerExecConsumerFlush(async (paths: string[]) => {
      for (const path of paths) {
        clearBuildScriptCaches(path);
      }
      // Produce outputs are not statically known, so invalidate any consumed
      // script cache entry the producer may have rewritten before recompiling.
      clearBuildScriptCaches();
      for (const path of paths) {
        await selectivelyProcessPagesForWatchPath(path);
        eventEmitter.emit("watch-path-processed", { path });
      }
    });

    w(chokidar
      .watch(watchPaths, {
        ...watchOptions,
        ignoreInitial: true,
        persistent: true,
      })
      .on("add", async (path) => {
        try {
          // If a producer covers this path, it owns the recompile: wait for
          // its completion (exec-completed) so the consumer never reads a
          // not-yet-produced generation. Otherwise recompile directly.
          if (execProducerCovers((patterns) => execWatchCoversPath(patterns, path, undefined))) {
            return;
          }
          clearBuildScriptCaches(path);
          await selectivelyProcessPagesForWatchPath(path);
          eventEmitter.emit("watch-path-processed", { path });
        } catch (err) {
          onWatchError(err);
        }
      })
      .on("change", async (path) => {
        try {
          if (execProducerCovers((patterns) => execWatchCoversPath(patterns, path, undefined))) {
            return;
          }
          clearBuildScriptCaches(path);
          await selectivelyProcessPagesForWatchPath(path);
          eventEmitter.emit("watch-path-processed", { path });
        } catch (err) {
          onWatchError(err);
        }
      })
      .on("unlink", async () => {
        clearBuildScriptCaches();
        processAllPages().catch(onWatchError);
      }));
  }

  // Watch the scripts import root in dev mode so files imported by build
  // scripts (via the @/ alias, /, or relative paths) trigger a rebuild.
  // Every event is gated on the dependency graph: only pages that actually
  // import or read the edited file are rebuilt. deliberately NOT using
  // selectivelyProcessPagesForWatchPath here because its all-pages fallback
  // is wrong for the import root, where most files are not script
  // dependencies. processPageBatch emits "transpiled" per page, which the
  // SSE handler already listens for, so no extra reload event is emitted.
  const importRoot = getImportRoot();
  if (!BascikConfig.isBuild && existsSync(importRoot)) {
    const pagesDir = resolve(process.cwd(), BascikConfig.directory.pages);
    const componentRoots = BascikConfig.directory.components.map((root) => resolve(process.cwd(), root));
    // Watchers 2 and 3 already own the pages and components trees; excluding
    // them here avoids double-firing rebuilds. Inlined stylesheets and directory.api
    // are not owned by pages/components watchers, but inlined stylesheets have their
    // own dedicated watcher below so exclude them to avoid redundant processing.
    const isOwnedByOtherWatcher = (path: string): boolean =>
      path === pagesDir || path.startsWith(pagesDir + sep) ||
      componentRoots.some((root) => path === root || path.startsWith(root + sep)) ||
      isInlineStylesheet(path);
    w(chokidar
      .watch([importRoot], {
        ...watchOptions,
        ignored: (path: string): boolean => isOwnedByOtherWatcher(path),
        ignoreInitial: true,
        persistent: true,
      })
      .on("add", async (path) => {
        try {
          invalidateRuntimeModule(path);
          const dependents = mem.pagesDependentOnFile(path);
          if (dependents.length === 0) return;
          clearBuildScriptCaches(path);
          invalidateComponentListCache();
          await processPageBatch(dependents);
        } catch (err) { onWatchError(err); }
      })
      .on("change", async (path) => {
        try {
          invalidateRuntimeModule(path);
          const dependents = mem.pagesDependentOnFile(path);
          if (dependents.length === 0) return;
          clearBuildScriptCaches(path);
          invalidateComponentListCache();
          await processPageBatch(dependents);
        } catch (err) { onWatchError(err); }
      })
      .on("unlink", async (path) => {
        try {
          invalidateRuntimeModule(path);
          // Rebuilding dependents on unlink is correct: the build script
          // import fails and the error surfaces in the overlay instead of
          // silently serving the last good output.
          const dependents = mem.pagesDependentOnFile(path);
          if (dependents.length === 0) return;
          clearBuildScriptCaches(path);
          invalidateComponentListCache();
          await processPageBatch(dependents);
        } catch (err) { onWatchError(err); }
      }));
  }

  // Re-transpile all pages when inlined global stylesheets change (dev only)
  const inlineStyles = BascikConfig.assets?.inlineStyles;
  if (!BascikConfig.isBuild && Array.isArray(inlineStyles) && inlineStyles.length) {
    w(chokidar
      .watch(inlineStyles, {
        ...watchOptions,
        ignoreInitial: true,
        persistent: true,
      })
      .on("add", async () => processAllPages().catch(onWatchError))
      .on("change", async () => processAllPages().catch(onWatchError))
      .on("unlink", async () => processAllPages().catch(onWatchError)));
  }

  // Watch API routes directory in dev mode if it exists or routes are present
  const apiDir = BascikConfig.directory?.api ?? "src/api";
  if (!BascikConfig.isBuild && existsSync(resolve(process.cwd(), apiDir))) {
    w(chokidar
      .watch([apiDir], {
        ...watchOptions,
        ignoreInitial: true,
        persistent: true,
      })
      .on("add", async (path) => {
        try {
          await apiRouteRegistry.invalidateFile(path);
          logInfo(`[bascik] api route add: ${relative(process.cwd(), path).replace(/\\/g, "/")}`);
          eventEmitter.emit("api-route-changed", { path, type: "add" });
        } catch (err) {
          onWatchError(err);
        }
      })
      .on("change", async (path) => {
        try {
          await apiRouteRegistry.invalidateFile(path);
          logInfo(`[bascik] api route change: ${relative(process.cwd(), path).replace(/\\/g, "/")}`);
          eventEmitter.emit("api-route-changed", { path, type: "change" });
        } catch (err) {
          onWatchError(err);
        }
      })
      .on("unlink", async (path) => {
        try {
          await apiRouteRegistry.invalidateFile(path);
          logInfo(`[bascik] api route unlink: ${relative(process.cwd(), path).replace(/\\/g, "/")}`);
          eventEmitter.emit("api-route-changed", { path, type: "unlink" });
        } catch (err) {
          onWatchError(err);
        }
      }));
  }

  // Watch config file to print a restart hint when modified
  const configCandidates = [
    "bascik.config.ts",
    "bascik.config.js",
    "bascik.config.mjs",
  ];
  if (!BascikConfig.isBuild && !process.env.VITEST) {
    w(chokidar
      .watch(configCandidates, {
        ...watchOptions,
        ignoreInitial: true,
      })
      .on("change", (cfgPath) => {
        console.log(`\n[bascik] Config file changed: ${cfgPath}. Restart the server to apply configuration changes.`);
      }));
  }
};
