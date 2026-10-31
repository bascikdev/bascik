import { matchesGlob, relative, resolve } from "node:path";

export const matchesPageGlob = (
  pagePath: string,
  pattern: string,
  pagesDir: string,
): boolean => {
  const absPage = resolve(process.cwd(), pagePath);
  const absPagesDir = resolve(process.cwd(), pagesDir);
  const rel = relative(absPagesDir, absPage).replace(/\\/g, "/");

  return (
    matchesGlob(rel, pattern) || matchesGlob(rel.replace(/^\.?\//, ""), pattern)
  );
};

/**
 * The same glob written relative to `pagesDir`, when `glob` starts with the
 * pages folder itself (`src/pages/blog/**`, `./src/pages/...`, or the
 * absolute path), the common mistake; otherwise undefined.
 */
const pagesRelativeGlob = (
  glob: string,
  pagesDir: string,
): string | undefined => {
  const absPagesDir = resolve(process.cwd(), pagesDir).replace(/\\/g, "/");
  const relPagesDir = relative(process.cwd(), absPagesDir).replace(/\\/g, "/");
  const normalized = glob.replace(/\\/g, "/");
  for (const prefix of [absPagesDir, relPagesDir, `./${relPagesDir}`]) {
    if (prefix && prefix !== "./" && normalized.startsWith(`${prefix}/`)) {
      const rest = normalized.slice(prefix.length + 1);
      if (rest) return rest;
    }
  }
  return undefined;
};

export const filterPagesByOnlyGlobs = (
  pageFiles: string[],
  onlyGlobs: string[],
  pagesDir: string,
): string[] => {
  if (!onlyGlobs || onlyGlobs.length === 0) {
    return pageFiles;
  }

  const matchedSet = new Set<string>();

  for (const glob of onlyGlobs) {
    let globMatchedCount = 0;
    for (const pagePath of pageFiles) {
      if (matchesPageGlob(pagePath, glob, pagesDir)) {
        matchedSet.add(pagePath);
        globMatchedCount++;
      }
    }
    if (globMatchedCount === 0) {
      const suggestion = pagesRelativeGlob(glob, pagesDir);
      throw new Error(
        `[bascik] error: --only "${glob}" matched no pages in "${pagesDir}".` +
          (suggestion
            ? ` Globs are matched relative to directory.pages: use --only "${suggestion}".`
            : ""),
      );
    }
  }

  return pageFiles.filter((p) => matchedSet.has(p));
};
