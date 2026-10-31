import { isAbsolute, relative, resolve } from "node:path";

/**
 * Glob syntax (minimatch, as `path.matchesGlob` reads it). The extglob
 * operators `@(`, `+(` and `!(` all contain `(`, so a bare `@` or `+` is a
 * literal character, as in a scoped package folder (`node_modules/@milk/ui`)
 * or `c++`; a leading `!` is negation.
 */
export const GLOB_META = /[?*[\]{}()]|^!/;

/**
 * The folder a watch pattern starts in: the pattern itself when it has no
 * wildcard, otherwise the path before its first wildcard segment. Watch glob
 * roots, not literal globs: chokidar (since 4) does not expand globs.
 */
export const sourceWatchRoot = (pattern: string): string => {
  const parts = pattern.replace(/\\/g, "/").split("/");
  const index = parts.findIndex((part) => GLOB_META.test(part));
  return index < 0
    ? pattern
    : parts.slice(0, index).join("/") || (pattern.startsWith("/") ? "/" : ".");
};

/** Folders no source watcher descends into below a watch root. */
const UNWATCHED_FOLDER_NAMES = new Set(["node_modules", ".git"]);

/**
 * The `ignored` function for a watcher over source roots. A path is ignored
 * when it is inside one of `outputRoots` (the output folder and Bascik's
 * private folder: writes there are never source edits), or when a
 * `node_modules` or `.git` folder lies between its watch root and it. The
 * second rule is what keeps a root-level glob (`**\/*.md`, `*.json`, whose
 * root is the project root) from walking every installed package and the
 * repository's object store. It applies only below a root, so a watch root
 * the user named inside node_modules is still watched.
 */
export const createSourceWatchIgnore = (
  watchRoots: readonly string[],
  outputRoots: readonly string[],
): ((path: string) => boolean) => {
  const roots = [...new Set(watchRoots.map((root) => resolve(root)))];
  const outputs = outputRoots.map((root) => resolve(root));
  const relativeInside = (path: string, root: string): string | null => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
      ? rel
      : null;
  };
  return (path: string): boolean => {
    const absolute = resolve(path);
    if (outputs.some((root) => relativeInside(absolute, root) !== null))
      return true;
    // The nearest root decides, so an explicit root inside node_modules wins
    // over the project root that also contains it.
    let nearest: string | null = null;
    for (const root of roots) {
      const rel = relativeInside(absolute, root);
      if (rel !== null && (nearest === null || rel.length < nearest.length))
        nearest = rel;
    }
    if (nearest === null || nearest === "") return false;
    return nearest
      .split(/[\\/]/)
      .some((segment) => UNWATCHED_FOLDER_NAMES.has(segment));
  };
};
