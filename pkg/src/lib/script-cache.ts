import { readdir, stat, unlink } from "node:fs/promises";
import { matchesGlob, join } from "node:path";
import { BascikConfig } from "./config.ts";

/** Max age for script cache files before pruning (7 days in ms) */
const SCRIPT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const isScriptCacheEnabledForPath = (filePath?: string): boolean => {
  const cacheConfig = BascikConfig.scripts?.cache;
  if (!cacheConfig || cacheConfig.enabled === false) {
    return false;
  }
  if (!filePath) {
    return true;
  }

  const normalized = filePath.replace(/\\/g, "/");

  // Check include list
  if (cacheConfig.include && cacheConfig.include.length > 0) {
    const included = cacheConfig.include.some((pattern) =>
      matchesGlob(normalized, pattern) || matchesGlob(normalized.replace(/^\.?\//, ""), pattern),
    );
    if (!included) return false;
  }

  // Check exclude list
  if (cacheConfig.exclude && cacheConfig.exclude.length > 0) {
    const excluded = cacheConfig.exclude.some((pattern) =>
      matchesGlob(normalized, pattern) || matchesGlob(normalized.replace(/^\.?\//, ""), pattern),
    );
    if (excluded) return false;
  }

  return true;
};

/**
 * Prune disk cache entries older than TTL or exceeding maximum capacity.
 * One-line policy: prune cached JSON files older than 7 days to prevent unbounded directory growth.
 */
export const pruneScriptCache = async (cacheDir: string): Promise<void> => {
  try {
    const files = await readdir(cacheDir);
    const now = Date.now();
    await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const fullPath = join(cacheDir, f);
          try {
            const st = await stat(fullPath);
            if (now - st.mtimeMs > SCRIPT_CACHE_TTL_MS) {
              await unlink(fullPath).catch(() => { });
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
