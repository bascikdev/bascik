import { readdir, stat, unlink } from "node:fs/promises";
import { matchesGlob, join, relative } from "node:path";
import { BascikConfig } from "./config.ts";
import { nativeClock, type FrameworkClock } from "./clock.ts";

/** Max age for script cache files before pruning (7 days in ms) */
const SCRIPT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let lastPruneTime = 0;
const PRUNE_THROTTLE_MS = 60 * 60 * 1000; // prune at most once per hour

export const resetScriptCachePruneThrottle = (): void => {
  lastPruneTime = 0;
  lastTempModulePruneTime = 0;
};

/**
 * The temp module a build or routes script runs from:
 * `build-<ms>-<random>.mjs` / `routes-<ms>-<random>.mjs` (build-scripts.ts,
 * routes.ts). Each is removed when its script finishes; one left behind
 * belongs to a process that was killed mid-script.
 */
const TEMP_MODULE_RE = /^(?:build|routes)-\d+-[a-z0-9]+\.mjs$/;
/** Far longer than any script runs, so a running process keeps its own. */
const TEMP_MODULE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let lastTempModulePruneTime = 0;

/**
 * Remove orphaned build and routes temp modules from `tempDir`
 * (`node_modules/.cache/bascik`), older than a day. Throttled like
 * `pruneScriptCache`; never throws.
 */
export const pruneStaleTempModules = async (
  tempDir: string,
  force = false,
  clock: FrameworkClock = nativeClock,
): Promise<void> => {
  const now = clock.now();
  if (!force && now - lastTempModulePruneTime < PRUNE_THROTTLE_MS) return;
  lastTempModulePruneTime = now;
  try {
    const files = await readdir(tempDir);
    await Promise.all(
      files
        .filter((f) => TEMP_MODULE_RE.test(f))
        .map(async (f) => {
          const fullPath = join(tempDir, f);
          try {
            const st = await stat(fullPath);
            if (now - st.mtimeMs > TEMP_MODULE_MAX_AGE_MS)
              await unlink(fullPath).catch(() => {});
          } catch {
            // Removed meanwhile, or unreadable: leave it.
          }
        }),
    );
  } catch {
    // No cache folder yet, or a mocked file system.
  }
};

export const isScriptCacheEnabledForPath = (filePath?: string): boolean => {
  const cacheConfig = BascikConfig.scripts?.cache;
  if (!cacheConfig || cacheConfig.enabled === false) {
    return false;
  }
  if (!filePath) {
    return true;
  }

  const normalized = filePath.replace(/\\/g, "/");
  const projectRelative = relative(process.cwd(), normalized).replace(
    /\\/g,
    "/",
  );
  const pathsToMatch = [
    normalized,
    normalized.replace(/^\.?\//, ""),
    projectRelative,
  ];
  const matchesPath = (pattern: string): boolean =>
    pathsToMatch.some((path) => matchesGlob(path, pattern));

  // Check include list
  if (cacheConfig.include && cacheConfig.include.length > 0) {
    const included = cacheConfig.include.some(matchesPath);
    if (!included) return false;
  }

  // Check exclude list
  if (cacheConfig.exclude && cacheConfig.exclude.length > 0) {
    const excluded = cacheConfig.exclude.some(matchesPath);
    if (excluded) return false;
  }

  return true;
};

/**
 * Prune disk cache entries older than TTL or exceeding maximum capacity.
 * Forced pruning bypasses only the one-hour throttle, not the retention (TTL) policy.
 */
export const pruneScriptCache = async (
  cacheDir: string,
  force = false,
  clock: FrameworkClock = nativeClock,
): Promise<void> => {
  const now = clock.now();
  if (!force && now - lastPruneTime < PRUNE_THROTTLE_MS) {
    return;
  }
  lastPruneTime = now;
  try {
    const files = await readdir(cacheDir);
    await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const fullPath = join(cacheDir, f);
          try {
            const st = await stat(fullPath);
            if (now - st.mtimeMs > SCRIPT_CACHE_TTL_MS) {
              await unlink(fullPath).catch(() => {});
            }
          } catch {
            // ignore
          }
        }),
    );
  } catch {
    // ignore
  }
};
