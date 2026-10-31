import { existsSync } from "node:fs";
import type { Stats } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FSWatcher } from "chokidar";
import { loadChokidar } from "./dev-watcher.ts";
import { isComponentSourceFile } from "./components.ts";
import {
  pageProcessing,
  processAllPages,
  processPagesDependentOnFile,
  processPagesImportingStylesheet,
  removePage,
  selectivelyProcessPages,
  selectivelyProcessPagesForWatchPath,
  stopPagePools,
} from "./processing.ts";
import {
  copyReplicatePath,
  copyStaticAssets,
  deleteDistDir,
  deleteDistFile,
} from "./file-system.ts";
import { isInlineStylesheet, isStaticAssetPath } from "./asset-filter.ts";
import { clearBuildScriptCaches } from "./build-scripts.ts";
import { BascikConfig, shouldLog } from "./config.ts";
import { CONFIG_FILE_NAMES, findConfigFile } from "./config-file-names.ts";
import { eventEmitter, registerShutdownHandler } from "./events.ts";
import { apiRouteRegistry } from "./server-api.ts";
import { scriptRegistry } from "./script-registry.ts";
import { getImportRoot } from "./import-root.ts";
import { watchSourceCycles } from "./watch-source.ts";
import { createSourceWatchIgnore, sourceWatchRoot } from "./watch-root.ts";
import { privateDirFor } from "./private-dir.ts";
import { execWatchCoversPath } from "./exec.ts";
import { coalesceRuns } from "./coalesced-run.ts";

export interface WatchFilesOptions {
  bootCompile?: (compileInitialSources: () => Promise<void>) => Promise<void>;
}

const logInfo = (message: string): void => {
  if (shouldLog(BascikConfig.logging?.level, "info")) console.log(message);
};

/** A script file a page can read from source: TypeScript or a Node module. */
const isPageScriptSource = (path: string): boolean =>
  /\.(?:[cm]?ts|mjs|cjs)$/i.test(path) &&
  !/\.d\.[cm]?ts$/i.test(path) &&
  !/\.(?:test|spec)\.[a-z]+$/i.test(path);

export const watchFiles = async (options: WatchFilesOptions = {}) => {
  if (BascikConfig.isBuild) {
    try {
      await Promise.all([copyStaticAssets(), processAllPages()]);
    } catch (error) {
      // Promise.all rejects on the first failure, and the CLI exits right
      // after. When the asset copy fails first, page processing is still
      // running, and its workers may still be loading the compiler, which
      // can abort Node 24 at exit. Stopping them first waits until they have
      // loaded; a failure to stop must not replace the build's error.
      await stopPagePools().catch(() => {});
      throw error;
    }
    return;
  }

  const onWatchError = (err: unknown) =>
    console.error("[bascik] watch error:", err);
  // Adding, deleting or renaming many files at once (a git checkout, an
  // unzip, a script writing pages) fires one watcher event per file, and
  // each of these events rebuilds every page. Run one rebuild at a time and
  // fold the events that arrive meanwhile into one more rebuild after it;
  // overlapping rebuilds of a large site ran out of file handles and memory.
  const rebuildAllPages = coalesceRuns(() => processAllPages(), onWatchError);
  // Request-time modules (`src=` server scripts, their helpers, API routes)
  // are imported by the runtime registry, not by the build, so the page
  // dependency graph knows nothing about them. Any file event under a watched
  // source root therefore advances the runtime identity first; the registry
  // ignores identities neither it nor the dev module graph has seen, so this
  // costs nothing for other files. When the edited file is a helper, the graph
  // also advances every entry that transitively imports it; those entries are
  // named in the log so the author can see what reloads.
  const toRelative = (path: string): string =>
    relative(process.cwd(), path).replace(/\\/g, "/");
  const invalidateRuntimeModule = (path: string): void => {
    if (!scriptRegistry.invalidate(path)) return;
    const changed = toRelative(path);
    const dependents: string[] = [];
    for (const key of scriptRegistry.lastInvalidated()) {
      if (!key.startsWith("file:")) continue;
      let advancedPath: string;
      try {
        advancedPath = fileURLToPath(key);
      } catch {
        continue;
      }
      const rel = toRelative(advancedPath);
      if (rel !== changed) dependents.push(rel);
    }
    dependents.sort();
    logInfo(
      dependents.length
        ? `[bascik] module invalidated: ${changed} (reloads ${dependents.join(", ")})`
        : `[bascik] module invalidated: ${changed}`,
    );
  };
  const chokidar = await loadChokidar();
  const watchers: FSWatcher[] = [];
  // Chokidar 6 reports scan and watch failures (an unreadable folder, EMFILE)
  // as `error` events, and an `error` event without a listener throws, which
  // would end the dev server. Every watcher logs them unless it brings its own.
  const w = <T extends FSWatcher>(
    watcher: T,
    onError: (error: unknown) => void = onWatchError,
  ) => {
    watchers.push(watcher);
    watcher.on("error", onError);
    return watcher;
  };
  registerShutdownHandler(() =>
    Promise.all(watchers.map((watcher) => watcher.close())).then(() => {}),
  );

  const watchOptions: NonNullable<Parameters<typeof chokidar.watch>[1]> = {
    atomic: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 20,
    },
    followSymlinks: false,
    persistent: !BascikConfig.isBuild,
  };
  let compileInitialSources: (() => Promise<void>) | undefined;

  // When exec entries watch sources, one observer owns compilation and exec
  // selection. Independent observers would race and duplicate the same edit.
  if (BascikConfig.pipeline?.exec?.some((entry) => !!entry.watch)) {
    await watchSourceCycles(invalidateRuntimeModule, options.bootCompile);
  } else {
    let initialScanDone = false;
    const handleUnlinkDir = (path: string): void => {
      deleteDistDir(path)
        .then(async () => {
          // When a directory is removed and immediately recreated, a delayed
          // unlinkDir can land after the new directory and its files already
          // exist on disk. Rescan static assets so the recreated files are not
          // left missing in dist/.
          if (initialScanDone && existsSync(path)) {
            await copyStaticAssets();
            eventEmitter.emit("asset-changed");
          }
        })
        .catch(onWatchError);
    };

    // A script source in the pages directory that is never published (a
    // page's `<script src="name.ts">`, a build, routes, server or stream
    // script's `.ts` / `.mjs` src) reaches the pages that read it, as a
    // component's companion does: they are recompiled and reloaded.
    const isUnpublishedScriptSource = (path: string): boolean =>
      isPageScriptSource(path) && !isStaticAssetPath(path);
    const onPageScriptSource = async (path: string): Promise<void> => {
      invalidateRuntimeModule(path);
      if (BascikConfig.isBuild) return;
      clearBuildScriptCaches(path);
      await processPagesDependentOnFile(path);
    };

    // Copy non-page files
    w(
      chokidar
        .watch([BascikConfig.directory.pages], {
          ...watchOptions,
          ignored: (path: string, stats?: Stats): boolean =>
            !!(
              stats?.isFile() &&
              !isInlineStylesheet(path) &&
              !isStaticAssetPath(path) &&
              !isPageScriptSource(path)
            ),
          ignoreInitial: true,
          persistent: !BascikConfig.isBuild,
        })
        .on("add", async (path) => {
          try {
            if (isUnpublishedScriptSource(path)) {
              await onPageScriptSource(path);
            } else if (isInlineStylesheet(path)) {
              if (!BascikConfig.isBuild) {
                await rebuildAllPages();
              }
            } else {
              await copyReplicatePath(path, BascikConfig.directory.out);
              if (!BascikConfig.isBuild) {
                await processPagesImportingStylesheet(path);
                eventEmitter.emit("asset-changed");
              }
            }
          } catch (err) {
            onWatchError(err);
          }
        })
        .on("change", async (path) => {
          try {
            if (isUnpublishedScriptSource(path)) {
              await onPageScriptSource(path);
            } else if (isInlineStylesheet(path)) {
              if (!BascikConfig.isBuild) {
                await rebuildAllPages();
              }
            } else {
              await copyReplicatePath(path, BascikConfig.directory.out);
              // Reload any currently-open page when a static asset changes.
              // A stylesheet a component imports is also inlined into pages.
              if (!BascikConfig.isBuild) {
                await processPagesImportingStylesheet(path);
                eventEmitter.emit("asset-changed");
              }
            }
          } catch (err) {
            onWatchError(err);
          }
        })
        .on("unlink", (path) => {
          const operation = isUnpublishedScriptSource(path)
            ? onPageScriptSource(path)
            : isInlineStylesheet(path)
              ? rebuildAllPages()
              : deleteDistFile(path).then(() =>
                  processPagesImportingStylesheet(path),
                );
          operation.catch(onWatchError);
        })
        .on("unlinkDir", handleUnlinkDir)
        .on("addDir", () => {
          if (!initialScanDone) return;
          // An editor or test can replace a directory faster than Chokidar emits
          // unlinkDir, or create nested subdirectories before their file watches
          // attach. Always rescan static assets when a directory appears after boot.
          copyStaticAssets()
            .then(() => eventEmitter.emit("asset-changed"))
            .catch(onWatchError);
        }),
    );

    // Transpile pages as they change
    compileInitialSources = async (): Promise<void> => {
      await Promise.all([copyStaticAssets(), processAllPages()]);
      initialScanDone = true;
    };
    await new Promise<void>((resolve, reject) => {
      // A failure before `ready` rejects boot; later ones are logged.
      let ready = false;
      w(
        chokidar
          .watch([BascikConfig.directory.pages], {
            ...watchOptions,
            // only watch html files
            ignored: (path: string, stats?: Stats): boolean =>
              !!(stats?.isFile() && !path.endsWith(".html")),
            persistent: !BascikConfig.isBuild,
          })
          .on("add", (_path) => {
            if (initialScanDone) void rebuildAllPages();
          })
          .on("change", (path) => pageProcessing(path).catch(onWatchError))
          .on("unlink", (path: string, _stats?: Stats) => {
            removePage(path)
              .then(() => rebuildAllPages())
              .catch(onWatchError);
          })
          .on("unlinkDir", (path: string, _stats?: Stats) =>
            handleUnlinkDir(path),
          )
          .on("ready", () => {
            ready = true;
            resolve();
          }),
        (error) => {
          if (ready) onWatchError(error);
          else {
            ready = true;
            reject(error);
          }
        },
      );
    });

    if (compileInitialSources && options.bootCompile) {
      await options.bootCompile(compileInitialSources);
    } else if (compileInitialSources) {
      await compileInitialSources();
    }

    // Transpile pages if components change. Every configured root is watched;
    // symlinks are followed here (and only here) so a linked shared directory
    // inside a root triggers rebuilds. Chokidar reports link paths, which is
    // what selectivelyProcessPages expects.
    w(
      chokidar
        .watch([...BascikConfig.directory.components], {
          ...watchOptions,
          followSymlinks: true,
          ignored: (path: string, stats?: Stats): boolean => {
            return !!(stats?.isFile() && !isComponentSourceFile(path));
          },
          ignoreInitial: true,
          persistent: !BascikConfig.isBuild,
        })
        // If you add a component, how will we know what pages to update unless we go and look
        .on("add", async (path) => {
          invalidateRuntimeModule(path);
          try {
            clearBuildScriptCaches(path);
            await rebuildAllPages();
          } catch (err) {
            onWatchError(err);
          }
        })
        // For changes and deletion of components we can be selective
        .on("change", async (path) => {
          invalidateRuntimeModule(path);
          try {
            clearBuildScriptCaches(path);
            await selectivelyProcessPages(path);
          } catch (err) {
            onWatchError(err);
          }
        })
        .on("unlink", async (path) => {
          invalidateRuntimeModule(path);
          try {
            clearBuildScriptCaches(path);
            await selectivelyProcessPages(path);
          } catch (err) {
            onWatchError(err);
          }
        }),
    );

    // Compilation watches are independent of exec.watch and exec completion.
    const watchPaths = BascikConfig.pipeline?.watchPaths ?? [];
    if (!BascikConfig.isBuild && watchPaths.length) {
      // Chokidar (since 4) does not expand globs: watch each glob's folder, then keep
      // only the files a pattern matches.
      const onWatchPathEvent = async (path: string) => {
        if (!execWatchCoversPath(watchPaths, path)) return;
        try {
          clearBuildScriptCaches(path);
          await selectivelyProcessPagesForWatchPath(path);
          eventEmitter.emit("watch-path-processed", { path });
        } catch (err) {
          onWatchError(err);
        }
      };
      const watchPathRoots = [...new Set(watchPaths.map(sourceWatchRoot))];
      const outRoot = resolve(process.cwd(), BascikConfig.directory.out);
      w(
        chokidar
          .watch(watchPathRoots, {
            ...watchOptions,
            // Output writes are never source edits, and a root-level glob
            // must not walk node_modules or .git (watch-root.ts).
            ignored: createSourceWatchIgnore(watchPathRoots, [
              outRoot,
              privateDirFor(outRoot),
            ]),
            ignoreInitial: true,
            persistent: true,
          })
          .on("add", onWatchPathEvent)
          .on("change", onWatchPathEvent)
          .on("unlink", onWatchPathEvent),
      );
    }
  }

  // Import-root watching only invalidates request-time modules. Build-time
  // helpers must be covered by directory.* or pipeline.watchPaths to compile.
  const importRoot = getImportRoot();
  if (!BascikConfig.isBuild && existsSync(importRoot)) {
    const pagesDir = resolve(process.cwd(), BascikConfig.directory.pages);
    const componentRoots = BascikConfig.directory.components.map((root) =>
      resolve(process.cwd(), root),
    );
    // Source watchers own these trees. Stylesheets need no runtime module
    // invalidation; their compilation watches are configured independently.
    const isOwnedByOtherWatcher = (path: string): boolean => {
      const resolvedPath = resolve(process.cwd(), path);
      return (
        resolvedPath === pagesDir ||
        resolvedPath.startsWith(pagesDir + sep) ||
        componentRoots.some(
          (root) =>
            resolvedPath === root || resolvedPath.startsWith(root + sep),
        ) ||
        isInlineStylesheet(path)
      );
    };
    w(
      chokidar
        .watch([importRoot], {
          ...watchOptions,
          ignored: (path: string): boolean => isOwnedByOtherWatcher(path),
          ignoreInitial: true,
          persistent: true,
        })
        .on("add", async (path) => {
          try {
            invalidateRuntimeModule(path);
          } catch (err) {
            onWatchError(err);
          }
        })
        .on("change", async (path) => {
          try {
            invalidateRuntimeModule(path);
          } catch (err) {
            onWatchError(err);
          }
        })
        .on("unlink", async (path) => {
          try {
            invalidateRuntimeModule(path);
          } catch (err) {
            onWatchError(err);
          }
        }),
    );
  }

  // Watch API routes directory in dev mode if it exists or routes are present
  const apiDir = BascikConfig.directory?.api ?? "src/api";
  if (!BascikConfig.isBuild && existsSync(resolve(process.cwd(), apiDir))) {
    w(
      chokidar
        .watch([apiDir], {
          ...watchOptions,
          ignoreInitial: true,
          persistent: true,
        })
        .on("add", async (path) => {
          try {
            await apiRouteRegistry.invalidateFile(path);
            logInfo(
              `[bascik] api route add: ${relative(process.cwd(), path).replace(/\\/g, "/")}`,
            );
            eventEmitter.emit("api-route-changed", { path, type: "add" });
          } catch (err) {
            onWatchError(err);
          }
        })
        .on("change", async (path) => {
          try {
            await apiRouteRegistry.invalidateFile(path);
            logInfo(
              `[bascik] api route change: ${relative(process.cwd(), path).replace(/\\/g, "/")}`,
            );
            eventEmitter.emit("api-route-changed", { path, type: "change" });
          } catch (err) {
            onWatchError(err);
          }
        })
        .on("unlink", async (path) => {
          try {
            await apiRouteRegistry.invalidateFile(path);
            logInfo(
              `[bascik] api route unlink: ${relative(process.cwd(), path).replace(/\\/g, "/")}`,
            );
            eventEmitter.emit("api-route-changed", { path, type: "unlink" });
          } catch (err) {
            onWatchError(err);
          }
        }),
    );
  }

  // Watch the config file to print a restart hint when it is modified: every
  // root config name the loader discovers (shared with config.ts so the lists
  // cannot drift), plus an explicit `--config <path>` when one was passed.
  const explicitConfig = findConfigFile();
  const configCandidates: string[] = [
    ...CONFIG_FILE_NAMES,
    ...(explicitConfig.explicit && explicitConfig.path
      ? [explicitConfig.path]
      : []),
  ];
  if (!BascikConfig.isBuild && !process.env.VITEST) {
    w(
      chokidar
        .watch(configCandidates, {
          ...watchOptions,
          ignoreInitial: true,
        })
        .on("change", (cfgPath) => {
          console.log(
            `\n[bascik] Config file changed: ${cfgPath}. Restart the server to apply configuration changes.`,
          );
        }),
    );
  }
};
