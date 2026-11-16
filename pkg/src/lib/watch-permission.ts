import { access } from "node:fs/promises";
import { constants, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { warnUnreadableFolder } from "./file-system.ts";

/** The part of a chokidar watcher this module uses. */
export interface RewatchableWatcher {
  add(paths: string | string[]): unknown;
}

/**
 * The folder a watcher's permission error is about, or undefined when the
 * error is not about a folder it cannot read.
 *
 * Linux (inotify) refuses to watch a folder without read permission, so
 * chokidar reports `EACCES` with syscall `watch` and the folder's path. A
 * folder made unreadable while watched shows up as an `lstat` of a path in
 * it instead. macOS watches such a folder and reports nothing.
 */
export const unreadableWatchFolder = (error: unknown): string | undefined => {
  const { code, syscall, path } = (error ?? {}) as NodeJS.ErrnoException;
  if ((code !== "EACCES" && code !== "EPERM") || typeof path !== "string")
    return undefined;
  const folder =
    syscall === "lstat" || syscall === "stat" ? dirname(path) : path;
  try {
    // The folder itself can be stat'ed: only listing it is refused.
    if (!statSync(folder).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return resolve(folder);
};

export interface UnreadableWatchFolders {
  /**
   * Handle a watcher error about an unreadable folder: print the dev
   * server's one warning for the folder, and watch it again once it is
   * readable. Returns false for any other error, which the caller reports.
   */
  handle(watcher: RewatchableWatcher, error: unknown): boolean;
  /** Stop checking the folders. */
  close(): void;
}

export interface UnreadableWatchFoldersOptions {
  /** How often the folders are checked, in milliseconds. */
  intervalMs?: number;
  /**
   * Called once for a folder, one interval after it was watched again, so
   * the caller can rescan it. A watcher with `ignoreInitial` reports none of
   * the files already in a folder it adds, so a file written between
   * `chmod 755` and the new watch (a page, a stylesheet) is never reported.
   */
  onWatchedAgain?: (folder: string) => void;
}

/**
 * Chokidar does not retry a folder it could not watch: on Linux, files added
 * to it after `chmod 755` were never seen. The folders are checked on an
 * interval and added to their watchers again when they can be read.
 */
export const createUnreadableWatchFolders = ({
  intervalMs = 500,
  onWatchedAgain,
}: UnreadableWatchFoldersOptions = {}): UnreadableWatchFolders => {
  const pending = new Map<string, Set<RewatchableWatcher>>();
  // Watched again on the last check: the caller is told on the next one,
  // once the new watch has listed the folder.
  const settling = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let checking = false;

  const check = async (): Promise<void> => {
    if (checking) return;
    checking = true;
    try {
      for (const folder of [...settling]) {
        settling.delete(folder);
        onWatchedAgain?.(folder);
      }
      for (const [folder, watchers] of [...pending]) {
        try {
          await access(folder, constants.R_OK | constants.X_OK);
        } catch (error) {
          // Removed: chokidar reports the folder if it comes back.
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            pending.delete(folder);
          continue;
        }
        pending.delete(folder);
        for (const watcher of watchers) watcher.add(folder);
        settling.add(folder);
      }
    } finally {
      checking = false;
      if (pending.size === 0 && settling.size === 0 && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    }
  };

  return {
    handle(watcher, error) {
      const folder = unreadableWatchFolder(error);
      if (!folder) return false;
      warnUnreadableFolder(folder, error);
      if ((error as NodeJS.ErrnoException).syscall === "watch") {
        const watchers = pending.get(folder) ?? new Set();
        watchers.add(watcher);
        pending.set(folder, watchers);
        if (!timer) {
          timer = setInterval(() => void check(), intervalMs);
          timer.unref?.();
        }
      }
      return true;
    },
    close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      pending.clear();
      settling.clear();
    },
  };
};
