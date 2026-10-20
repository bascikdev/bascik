/**
 * The folder a watch pattern starts in: the pattern itself when it has no
 * wildcard, otherwise the path before its first wildcard segment. Watch glob
 * roots, not literal globs: Chokidar 5 no longer expands globs.
 */
export const sourceWatchRoot = (pattern: string): string => {
  const parts = pattern.replace(/\\/g, "/").split("/");
  const index = parts.findIndex((part) => /[?*[\]{}()!+@]/.test(part));
  return index < 0
    ? pattern
    : parts.slice(0, index).join("/") || (pattern.startsWith("/") ? "/" : ".");
};
