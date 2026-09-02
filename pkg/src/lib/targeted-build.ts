import { matchesGlob, relative, resolve } from "node:path";

export const matchesPageGlob = (pagePath: string, pattern: string, pagesDir: string): boolean => {
  const absPage = resolve(process.cwd(), pagePath);
  const absPagesDir = resolve(process.cwd(), pagesDir);
  const rel = relative(absPagesDir, absPage).replace(/\\/g, "/");

  return matchesGlob(rel, pattern) || matchesGlob(rel.replace(/^\.?\//, ""), pattern);
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
      throw new Error(`[bascik] error: --only "${glob}" matched no pages in "${pagesDir}".`);
    }
  }

  return pageFiles.filter((p) => matchedSet.has(p));
};
