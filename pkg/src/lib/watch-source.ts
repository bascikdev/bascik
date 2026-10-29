import { basename, resolve, sep } from "node:path";
import { loadChokidar } from "./dev-watcher.ts";
import { BascikConfig } from "./config.ts";
import { eventEmitter, registerShutdownHandler } from "./events.ts";
import { createSourceCycle } from "./source-cycle.ts";
import { execWatchCoversPath, runScript } from "./exec.ts";
import { getExecErrorAction, stopAfterExecFailure } from "./exec-policy.ts";
import { withCompilationPublisher } from "./compilation-events.ts";
import { clearBuildScriptCaches } from "./build-scripts.ts";
import {
  componentsHaveBuildScripts,
  componentsImportingStylesheet,
  invalidateComponentListCache,
} from "./components.ts";
import { mem } from "./mem.ts";
import { processAllPages, processPageBatch, removePage } from "./processing.ts";
import {
  copyStaticAssets,
  copyReplicatePath,
  deleteDistFile,
  deleteDistDir,
} from "./file-system.ts";
import { isInlineStylesheet, isStaticAssetPath } from "./asset-filter.ts";
import { sourceWatchRoot } from "./watch-root.ts";
import { privateDirFor } from "./private-dir.ts";

/** One filesystem observer owns source/exec overlap, including page edits.
 * Outputs are ignored unconditionally. No timestamp or self-write heuristic
 * suppresses legitimate source edits, including edits to a watched script.
 */
export const watchSourceCycles = async (
  invalidateRuntimeModule: (path: string) => void,
  bootCompile?: (compileInitialSources: () => Promise<void>) => Promise<void>,
): Promise<void> => {
  const entries = BascikConfig.pipeline?.exec ?? [];
  const watchPaths = BascikConfig.pipeline?.watchPaths ?? [];
  const execPatterns = entries.flatMap((entry) =>
    entry.watch
      ? Array.isArray(entry.watch)
        ? entry.watch
        : [entry.watch]
      : [],
  );
  const pagesRoot = resolve(BascikConfig.directory.pages);
  const componentRoots = BascikConfig.directory.components.map((root) =>
    resolve(root),
  );
  const outRoot = resolve(BascikConfig.directory.out);
  // Bascik's private build folder beside the output (private-dir.ts) is
  // output too: a watch path over the project root must not see its writes.
  const privateRoot = privateDirFor(outRoot);
  const inside = (path: string, root: string) =>
    path === root || path.startsWith(root + sep);
  const changes = new Map<string, string>();
  const deferred = new Set<string>();
  let booted = false;
  const cycle = createSourceCycle({
    entries,
    run: runScript,
    emitter: eventEmitter,
    // Under the default dev action ('warn') the cycle already reported a
    // build-error and retries on the next edit. Under 'error' the session ends.
    onExecFailure: (error) => {
      if (getExecErrorAction() === "error") stopAfterExecFailure(error);
    },
    compile: async (paths, publish) =>
      withCompilationPublisher(
        publish,
        async () => {
          const batchChanges = new Map(
            paths.map((path) => [path, changes.get(path) ?? "change"]),
          );
          for (const path of paths) changes.delete(path);
          const pages = new Set<string>();
          let all = false;
          let staticAssetsInvalidated = false;
          let shouldInvalidateComponents = false;
          let shouldClearAllBuildCaches = entries.some((entry) => {
            const patterns = entry.watch
              ? Array.isArray(entry.watch)
                ? entry.watch
                : [entry.watch]
              : [];
            return (
              (entry.phase ?? "pre") === "pre" &&
              paths.some((path) => execWatchCoversPath(patterns, path))
            );
          });
          for (const path of paths) {
            const kind = batchChanges.get(path)!;
            const inPages = inside(path, pagesRoot);
            const inComponents = componentRoots.some((root) =>
              inside(path, root),
            );
            const isDirectPageHtmlEdit =
              inPages && path.endsWith(".html") && kind === "change";
            if (inComponents || kind === "addDir" || kind === "unlinkDir") {
              shouldInvalidateComponents = true;
            } else if (
              !isDirectPageHtmlEdit &&
              componentsImportingStylesheet(path).length > 0
            ) {
              shouldInvalidateComponents = true;
            }
            if (isDirectPageHtmlEdit || inComponents) {
              if (!shouldClearAllBuildCaches) clearBuildScriptCaches(path);
            } else {
              shouldClearAllBuildCaches = true;
            }
          }
          // Invalidate input-content memoization once after pre writes. Script
          // result caching remains enabled and rechecks the actual dependency bytes.
          if (shouldClearAllBuildCaches) {
            clearBuildScriptCaches();
          }
          if (shouldInvalidateComponents || shouldClearAllBuildCaches) {
            invalidateComponentListCache();
          }
          // A page with a server-script plan renders component tags from its
          // scripts' output with the manifest of the component list it was
          // stored against (prompt 157, D6). When the list is invalidated by
          // a component input, every such page is rebuilt with the next one,
          // which re-stores it with the new manifest and reloads its open
          // tabs: a component used only in script output, which no page
          // depends on by name, still live-reloads. A cache clear (a watched
          // input or asset) can change a component only through its build
          // script, which may read that file and which only the manifest
          // build ran, so it counts when some component has one; otherwise
          // these pages stay as they are, like any page not depending on it.
          if (
            shouldInvalidateComponents ||
            (shouldClearAllBuildCaches && componentsHaveBuildScripts())
          ) {
            for (const page of mem.pagesWithServerScriptPlan())
              pages.add(resolve(page));
          }
          for (const path of paths) {
            const kind = batchChanges.get(path)!;
            invalidateRuntimeModule(path);
            const inPages = inside(path, pagesRoot);
            const inComponents = componentRoots.some((root) =>
              inside(path, root),
            );
            const extra =
              execWatchCoversPath(watchPaths, path) ||
              execWatchCoversPath(execPatterns, path);
            const dependents = mem.pagesDependentOnFile(path);
            for (const page of dependents) pages.add(resolve(page));
            // Component stylesheets inline their imports, so an imported file
            // reaches the pages of every component that imports it.
            for (const name of componentsImportingStylesheet(path)) {
              for (const page of mem.pagesThisComponentIsUsedOn(name))
                pages.add(resolve(page));
            }
            if (kind === "unlinkDir") {
              if (inPages) {
                await deleteDistDir(path);
              }
              all = true;
            } else if (kind === "addDir" && inPages) {
              // An editor or pipeline can replace a directory atomically. Its
              // nested add events are not guaranteed on every filesystem, so
              // rescan on recreation instead of relying on them for recovery.
              staticAssetsInvalidated = true;
              all = true;
            } else if (inPages && path.endsWith(".html")) {
              if (kind === "unlink") {
                await removePage(path);
                all = true;
              } else if (kind === "add") all = true;
              else pages.add(path);
            } else if (inPages && isInlineStylesheet(path)) {
              all = true;
            } else if (inComponents) {
              if (kind === "add") all = true;
              for (const page of mem.pagesThisComponentIsUsedOn(
                basename(path).split(".")[0].toLowerCase(),
              ))
                pages.add(resolve(page));
            } else if (extra && dependents.length === 0) {
              // External input or watched script with no known page dependencies:
              // conservatively rebuild pages, but never rerun unmatched exec entries.
              all = true;
            }
            if (
              inPages &&
              isStaticAssetPath(path) &&
              !isInlineStylesheet(path) &&
              kind !== "unlinkDir"
            ) {
              if (kind === "unlink") await deleteDistFile(path);
              else await copyReplicatePath(path, BascikConfig.directory.out);
              publish("asset-changed");
            }
          }
          if (staticAssetsInvalidated) await copyStaticAssets();
          if (all) await processAllPages();
          else if (pages.size) await processPageBatch([...pages]);
        },
        { onPageErrors: "throw" },
      ),
  });
  const onBoot = () => {
    booted = true;
    for (const path of deferred) cycle.enqueue(path);
    deferred.clear();
  };
  eventEmitter.once("boot-done", onBoot);
  const chokidar = await loadChokidar();
  const watcher = chokidar.watch(
    [
      ...new Set([
        pagesRoot,
        ...componentRoots,
        ...watchPaths.map(sourceWatchRoot),
        ...execPatterns.map(sourceWatchRoot),
      ]),
    ],
    {
      ignoreInitial: true,
      followSymlinks: true,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
      ignored: (path) =>
        inside(resolve(path), outRoot) || inside(resolve(path), privateRoot),
    },
  );
  watcher.on("all", (kind, changed) => {
    if (!["add", "change", "unlink", "unlinkDir", "addDir"].includes(kind))
      return;
    const path = resolve(changed);
    const owned =
      inside(path, pagesRoot) ||
      componentRoots.some((root) => inside(path, root));
    if (!owned && !execWatchCoversPath([...watchPaths, ...execPatterns], path))
      return;
    changes.set(path, kind);
    if (booted) cycle.enqueue(path);
    else deferred.add(path);
  });
  registerShutdownHandler(async () => {
    cycle.close();
    eventEmitter.removeListener("boot-done", onBoot);
    await watcher.close();
    await cycle.idle();
  });
  // Chokidar 6 reports scan failures as `error` events, and an `error` event
  // without a listener throws, so one listener stays for the watcher's life:
  // the first failure before `ready` rejects boot, every other one is reported.
  await new Promise<void>((resolveReady, reject) => {
    let settled = false;
    watcher.once("ready", () => {
      settled = true;
      resolveReady();
    });
    watcher.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
        return;
      }
      eventEmitter.emit("build-error", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
  const compileInitialSources = async (): Promise<void> => {
    await Promise.all([copyStaticAssets(), processAllPages()]);
  };
  if (bootCompile) {
    await bootCompile(compileInitialSources);
  } else {
    await compileInitialSources();
  }
};
