import { formatDuration } from "./format.ts";

/**
 * What a page's build scripts cost. The per-page `transpiled:` line reports a
 * page's own compile time with every await excluded, so the child processes
 * that run its build scripts never appear in it; a cold site can show a few
 * seconds of page lines under a summary ten times longer with nothing naming
 * the gap. These counts travel with the page result (across the worker
 * boundary too) so both lines can say what the scripts cost.
 */
export interface BuildScriptStats {
  /** Scripts whose output was not in the cache, so a child process ran. */
  ran: number;
  /** Scripts whose output came from the cache. */
  cached: number;
  /** Wall time spent waiting on the child processes of the scripts that ran. */
  childMs: number;
}

export const createBuildScriptStats = (): BuildScriptStats => ({
  ran: 0,
  cached: 0,
  childMs: 0,
});

/** Folds `part` into `total` in place. */
export const addBuildScriptStats = (
  total: BuildScriptStats,
  part: BuildScriptStats,
): void => {
  total.ran += part.ran;
  total.cached += part.cached;
  total.childMs += part.childMs;
};

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The parenthetical after a page's `in <duration>`: `" (+5.1s in 52 build
 * scripts, 3 cached)"`. Empty when no script ran, so a site without build
 * scripts prints the line it always did. Cache hits are named only when there
 * are any, so a page whose scripts all ran is not told "0 cached".
 */
export const formatPageBuildScriptStats = (stats: BuildScriptStats): string => {
  if (stats.ran === 0) return "";
  const cached = stats.cached > 0 ? `, ${stats.cached} cached` : "";
  return ` (+${formatDuration(stats.childMs)} in ${plural(stats.ran, "build script")}${cached})`;
};

/**
 * The parenthetical after the `✓ N pages transpiled in <duration>` summary:
 * `" (969 build scripts ran, 0 from cache)"`. Empty when the site has no build
 * scripts at all. Both numbers are always printed here, because the pair is
 * what explains a slow phase: all ran means a cold cache, all cached means
 * the time went elsewhere.
 */
export const formatBuildScriptSummary = (stats: BuildScriptStats): string => {
  if (stats.ran === 0 && stats.cached === 0) return "";
  return ` (${plural(stats.ran, "build script")} ran, ${stats.cached} from cache)`;
};
