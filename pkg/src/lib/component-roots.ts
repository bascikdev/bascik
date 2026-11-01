/**
 * @module component-roots
 *
 * One definition of "which configured components directory owns this file."
 *
 * `directory.components` is always a `string[]` of absolute roots after
 * `config.ts` normalizes it. Every consumer that used to test a single
 * directory with `includes(...)` or `startsWith(...)` calls
 * `findComponentRoot` instead, so no consumer can drift toward a
 * first-root-only assumption.
 */
import nodePath, { type PlatformPath } from "node:path";
import { BascikConfig } from "./config.ts";
import { trimTrailingSlashes } from "./slashes.ts";

const toPosix = (path: string): string =>
  trimTrailingSlashes(path.replace(/\\/g, "/"));

/** Configured component roots with forward slashes and no trailing slash. */
export const getComponentRoots = (): string[] => {
  const roots = BascikConfig.directory?.components;
  if (!roots) return [];
  return (Array.isArray(roots) ? roots : [roots]).map(toPosix);
};

/**
 * Return the configured root that contains `filePath`, or `undefined` when no
 * root does. Matching is separator-normalized and boundary-aware: a path under
 * `src/components-shared` does not match the root `src/components`. When roots
 * could both match (which config normalization forbids), the longest wins.
 */
export const findComponentRoot = (filePath: string): string | undefined => {
  const normalized = toPosix(filePath);
  let best: string | undefined;
  for (const root of getComponentRoots()) {
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      if (best === undefined || root.length > best.length) best = root;
    }
  }
  return best;
};

/**
 * Display form for a components root: `components` when the root sits inside
 * the project, otherwise the cwd-relative path (`..`, `../shared/components`)
 * so a user can locate it. The one exception to "never a filesystem-absolute
 * path" is a root on another Windows drive, which no relative path reaches,
 * shown with forward slashes (`D:/shared/components`). `path` is for tests.
 */
export const displayComponentRoot = (
  root: string,
  cwd = process.cwd(),
  path: Pick<PlatformPath, "relative" | "isAbsolute"> = nodePath,
): string => {
  const rel = path.relative(cwd, root);
  if (path.isAbsolute(rel)) return rel.replace(/\\/g, "/");
  const posixRel = rel.replace(/\\/g, "/");
  if (posixRel === ".." || posixRel.startsWith("../")) return posixRel;
  return "components";
};
