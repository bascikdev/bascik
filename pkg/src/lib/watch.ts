import { existsSync } from "node:fs";
import chokidar from "chokidar";
import type { Stats } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pageProcessing,
  processAllPages,
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
import { BascikConfig, shouldLog } from "./config.ts";
import { eventEmitter, registerShutdownHandler } from "./events.ts";
import { apiRouteRegistry } from "./server-api.ts";
import { scriptRegistry } from "./script-registry.ts";
import { getImportRoot } from "./import-root.ts";
import { watchSourceCycles } from "./watch-source.ts";

export interface WatchFilesOptions {
  bootCompile?: (compileInitialSources: () => Promise<void>) => Promise<void>;
}

const logInfo = (message: string): void => {
  if (shouldLog(BascikConfig.logging?.level, "info")) console.log(message);
};

export const watchFiles = async (options: WatchFilesOptions = {}) => {
  if (BascikConfig.isBuild) {
    await Promise.all([copyStaticAssets(), processAllPages()]);
    return;
  }

  const onWatchError = (err: unknown) => console.error("[bascik] watch error:", err);
  // Request-time modules (`src=` server scripts, their helpers, API routes)
  // are imported by the runtime registry, not by the build, so the page
  // dependency graph knows nothing about them. Any file event under a watched
  // source root therefore advances the runtime identity first; the registry
  // ignores identities neither it nor the dev module graph has seen, so this
  // costs nothing for other files. When the edited file is a helper, the graph
  // also advances every entry that transitively imports it; those entries are
  // named in the log so the author can see what reloads.
  const toRelative = (path: string): string => relative(process.cwd(), path).replace(/\\/g, "/");
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
  let compileInitialSources: (() => Promise<void>) | undefined;

  // When exec entries watch sources, one observer owns compilation and exec
  // selection. Independent observers would race and duplicate the same edit.
  if (BascikConfig.pipeline?.exec?.some(entry => !!entry.watch)) {
    await watchSourceCycles(invalidateRuntimeModule, options.bootCompile);
  } else {
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
  compileInitialSources = async (): Promise<void> => {
    await Promise.all([copyStaticAssets(), processAllPages()]);
    initialScanDone = true;
  };
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
      .on("ready", () => resolve())
      .on("error", reject));
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
      try {
        clearBuildScriptCaches(path);
        await processAllPages();
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
    }));

  // Compilation watches are independent of exec.watch and exec completion.
  const watchPaths = BascikConfig.pipeline?.watchPaths ?? [];
  if (!BascikConfig.isBuild && watchPaths.length) {
    w(chokidar
      .watch(watchPaths, {
        ...watchOptions,
        ignoreInitial: true,
        persistent: true,
      })
      .on("add", async (path) => {
        try {
          clearBuildScriptCaches(path);
          await selectivelyProcessPagesForWatchPath(path);
          eventEmitter.emit("watch-path-processed", { path });
        } catch (err) {
          onWatchError(err);
        }
      })
      .on("change", async (path) => {
        try {
          clearBuildScriptCaches(path);
          await selectivelyProcessPagesForWatchPath(path);
          eventEmitter.emit("watch-path-processed", { path });
        } catch (err) {
          onWatchError(err);
        }
      })
      .on("unlink", async (path) => {
        try {
          clearBuildScriptCaches(path);
          await selectivelyProcessPagesForWatchPath(path);
          eventEmitter.emit("watch-path-processed", { path });
        } catch (err) {
          onWatchError(err);
        }
      }));
  }

  }

  // Import-root watching only invalidates request-time modules. Build-time
  // helpers must be covered by directory.* or pipeline.watchPaths to compile.
  const importRoot = getImportRoot();
  if (!BascikConfig.isBuild && existsSync(importRoot)) {
    const pagesDir = resolve(process.cwd(), BascikConfig.directory.pages);
    const componentRoots = BascikConfig.directory.components.map((root) => resolve(process.cwd(), root));
    // Source watchers own these trees. Stylesheets need no runtime module
    // invalidation; their compilation watches are configured independently.
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
        } catch (err) { onWatchError(err); }
      })
      .on("change", async (path) => {
        try {
          invalidateRuntimeModule(path);
        } catch (err) { onWatchError(err); }
      })
      .on("unlink", async (path) => {
        try {
          invalidateRuntimeModule(path);
        } catch (err) { onWatchError(err); }
      }));
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
