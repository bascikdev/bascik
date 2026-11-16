/**
 * The dev server when the whole pages folder is removed (`rm -rf src/pages`).
 *
 * Each watcher used to pass the removed root to deleteDistDir, which maps it
 * to the output root and refuses it ("Refusing path outside the configured
 * output directory", with a stack), and every rebuild after that failed on
 * the missing folder. Both watchers (watch.ts and, with exec watch entries,
 * watch-source.ts) now ask `isMissing()` instead: the first time the folder
 * is gone it warns once and clears the pages' output; when it is back it
 * says so, and the caller rebuilds as usual.
 */

import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { BascikConfig, shouldLog } from "./config.ts";
import { clearBuildScriptCaches } from "./build-scripts.ts";
import { eventEmitter } from "./events.ts";
import {
  copiedPageAssetPaths,
  deleteDistFile,
  forgetCopiedPageAsset,
} from "./file-system.ts";
import { mem } from "./mem.ts";
import { removePage } from "./processing.ts";

export interface PagesRootRemoval {
  /** The resolved pages folder. */
  readonly root: string;
  /** True while the pages folder is gone; warns and clears on the first call. */
  isMissing(): boolean;
  /**
   * Run the boot compile. When the folder is removed while it runs, the
   * compile's failure is that removal, not a broken project. A folder
   * missing from the start still fails the boot.
   */
  compileAtBoot(compile: () => Promise<void>): Promise<void>;
  /**
   * Check for the folder every `intervalMs` too, until the returned stop
   * function runs: removing a folder above it (`rm -rf src`), and putting
   * it back, can send the watchers no event at all. `onBack` rebuilds the
   * pages and static files when any check sees the folder again.
   */
  poll(onBack: () => void, intervalMs?: number): () => void;
}

let shared: PagesRootRemoval | undefined;

/**
 * The one tracker for the process: with exec watch entries both watch.ts
 * (its request-time observers) and watch-source.ts ask, and the warning
 * must still print once.
 */
export const createPagesRootRemoval = (): PagesRootRemoval => {
  const root = resolve(BascikConfig.directory.pages);
  if (shared?.root === root) return shared;
  shared = createTracker(root);
  return shared;
};

const createTracker = (root: string): PagesRootRemoval => {
  const display = relative(process.cwd(), root).replace(/\\/g, "/") || ".";
  let removed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let onBack: (() => void) | undefined;

  // Chokidar may report only some of the removed files, or only the root:
  // drop every stored page and copied asset whose source is gone.
  const clearOutput = async (): Promise<void> => {
    const pagePaths = new Set(
      mem
        .pages()
        .map((page) => page.absolutePagePath)
        .filter((pagePath) => !existsSync(pagePath)),
    );
    for (const pagePath of pagePaths) {
      clearBuildScriptCaches(pagePath);
      await removePage(pagePath);
    }
    for (const assetPath of copiedPageAssetPaths()) {
      if (existsSync(assetPath)) continue;
      forgetCopiedPageAsset(assetPath);
      await deleteDistFile(assetPath);
    }
    eventEmitter.emit("asset-changed");
  };

  const isMissing = (): boolean => {
    if (existsSync(root)) {
      if (removed) {
        removed = false;
        if (shouldLog(BascikConfig.logging?.level, "info"))
          console.log(
            `[bascik] pages folder "${display}" is back: rebuilding its pages.`,
          );
        // Whichever check sees it first, the whole folder (its pages and
        // static files) is built again, not only what an event names.
        if (onBack) queueMicrotask(onBack);
      }
      return false;
    }
    if (!removed) {
      removed = true;
      console.warn(
        `[bascik] warning: pages folder "${display}" (directory.pages) was removed. ` +
          `Its pages are no longer served; the dev server builds them again when the folder comes back.`,
      );
      clearOutput().catch((error: unknown) =>
        console.error("[bascik] watch error:", error),
      );
    }
    return true;
  };

  const compileAtBoot = async (compile: () => Promise<void>): Promise<void> => {
    const existedAtStart = existsSync(root);
    try {
      await compile();
    } catch (error) {
      if (existedAtStart && isMissing()) return;
      throw error;
    }
    // Removed after the compile read it, but before the watchers were
    // listening: no event will say so, so look once.
    if (existedAtStart) isMissing();
  };

  const poll = (rebuild: () => void, intervalMs = 1_000): (() => void) => {
    if (timer) return () => {};
    onBack = rebuild;
    timer = setInterval(isMissing, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
      timer = undefined;
      onBack = undefined;
    };
  };

  return { root, isMissing, compileAtBoot, poll };
};
