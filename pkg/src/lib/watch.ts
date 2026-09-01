import chokidar from "chokidar";
import type { Stats } from "node:fs";
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
import { BascikConfig } from "./config.ts";
import { eventEmitter, registerShutdownHandler } from "./events.ts";

export const watchFiles = async () => {
  if (BascikConfig.isBuild) {
    await copyStaticAssets();
    await processAllPages();
    return;
  }

  const onWatchError = (err: unknown) => console.error("[bascik] watch error:", err);
  const watchers: ReturnType<typeof chokidar.watch>[] = [];
  const w = <T extends ReturnType<typeof chokidar.watch>>(watcher: T) => { watchers.push(watcher); return watcher; };
  registerShutdownHandler(() => Promise.all(watchers.map(watcher => watcher.close())).then(() => { }));

  // Copy non-page files
  w(chokidar
    .watch([BascikConfig.directory.pages], {
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
        // only watch html files
        ignored: (path: string, stats?: Stats): boolean =>
          !!(stats?.isFile() && !path.endsWith(".html")),
        persistent: !BascikConfig.isBuild,
      })
      .on("add", (path) => {
        if (initialScanDone) processAllPages().catch(onWatchError);
      })
      .on("change", (path) => pageProcessing(path).catch(onWatchError))
      .on("unlink", (path: string, _stats?: Stats) => {
        removePage(path).then(() => processAllPages()).catch(onWatchError);
      })
      .on("unlinkDir", (path: string, _stats?: Stats) => deleteDistDir(path).catch(onWatchError))
      .on("ready", async () => {
        initialScanDone = true;
        try {
          await copyStaticAssets();
          await processAllPages();
          resolve();
        } catch (err) {
          reject(err);
        }
      }));
  });

  // Transpile pages if components change
  w(chokidar
    .watch([BascikConfig.directory.components], {
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
      clearBuildScriptCaches(path);
      processAllPages().catch(onWatchError);
    })
    // For changes and deletion of components we can be selective
    .on("change", async (path) => {
      clearBuildScriptCaches(path);
      selectivelyProcessPages(path).catch(onWatchError);
    })
    .on("unlink", async (path) => {
      clearBuildScriptCaches(path);
      selectivelyProcessPages(path).catch(onWatchError);
    }));

  // Re-transpile all pages when user-specified extra paths change (dev only)
  const watchPaths = BascikConfig.pipeline?.watchPaths ?? [];
  if (!BascikConfig.isBuild && watchPaths.length) {
    w(chokidar
      .watch(watchPaths, {
        ignoreInitial: true,
        persistent: true,
      })
      .on("add", async (path) => {
        clearBuildScriptCaches(path);
        selectivelyProcessPagesForWatchPath(path).catch(onWatchError);
      })
      .on("change", async (path) => {
        clearBuildScriptCaches(path);
        selectivelyProcessPagesForWatchPath(path).catch(onWatchError);
      })
      .on("unlink", async () => {
        clearBuildScriptCaches();
        processAllPages().catch(onWatchError);
      }));
  }

  // Re-transpile all pages when inlined global stylesheets change (dev only)
  const inlineStyles = BascikConfig.assets?.inlineStyles;
  if (!BascikConfig.isBuild && Array.isArray(inlineStyles) && inlineStyles.length) {
    w(chokidar
      .watch(inlineStyles, {
        ignoreInitial: true,
        persistent: true,
      })
      .on("add", async () => processAllPages().catch(onWatchError))
      .on("change", async () => processAllPages().catch(onWatchError))
      .on("unlink", async () => processAllPages().catch(onWatchError)));
  }
};
